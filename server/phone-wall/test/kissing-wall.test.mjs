import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access,writeFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createController } from '../app.mjs';
import { kissClip } from '../kissing-wall.mjs';
import { SimulatedClient } from '../simulated-client.mjs';
import { envelope } from '../../../protocol/core.mjs';

const key='kissing-test-operator-key-0000000000000000';
const source='https://kiss-files.s3.eu-west-par.io.cloud.ovh.net/clips/test.mp4';
const metadata={clips:[{tag:'kiss',media_url:source,kiss_start_seconds:2,kiss_end_seconds:4}]};
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(40)]);
async function until(fn){const end=Date.now()+15000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('kissing test timed out');}
const request=(server,payload)=>server.app.inject({method:'POST',url:'/phone-wall/api',headers:{authorization:'Bearer '+key},payload});

test('legacy kissing metadata preserves trim points and rejects unsafe media URLs',()=>{
  assert.deepEqual(kissClip(metadata),{source,startSec:2,endSec:4});
  for(const media_url of ['http://127.0.0.1/private','https://example.org/a.mp4','https://user:secret@sms-clips.samuel.ovh/a','https://sms-clips.samuel.ovh:999/a'])assert.throws(()=>kissClip({clips:[{...metadata.clips[0],media_url}]}));
  assert.throws(()=>kissClip({clips:[{...metadata.clips[0],kiss_end_seconds:1}]}));
  assert.throws(()=>kissClip({clips:[]}));
});

test('Mac caches a checksummed clip once, survives upstream failure/restart and validates settings',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wall-kissing-cache-'));let online=true,calls=0;
  const fetchImpl=async(url,options)=>{calls++;assert.equal(options.redirect,'error');if(!online)throw new Error('offline');return url.includes('/api/')?Response.json(metadata):new Response(mp4);};
  let server=await createController({dataDir:directory,adminToken:key,kissingOptions:{fetchImpl}});
  t.after(async()=>{await server.app.close();await rm(directory,{recursive:true,force:true});});
  await server.kissing.refresh();assert.equal(calls,2);
  const clip=server.kissing.clips()[0];assert.equal(clip.hash,createHash('sha256').update(mp4).digest('hex'));assert.equal(clip.startSec,2);
  assert.deepEqual(await readFile(join(directory,'media',clip.hash)),mp4);
  await server.kissing.refresh();assert.equal(calls,3);assert.equal(server.kissing.status().clips,1);
  await writeFile(join(directory,'media',clip.hash),'corrupt');
  await server.kissing.refresh();assert.deepEqual(await readFile(join(directory,'media',clip.hash)),mp4);
  online=false;await server.kissing.refresh();assert.equal(server.kissing.status().clips,1);assert.ok(server.kissing.lastError);
  assert.throws(()=>server.kissing.configure({fadeOutDurationMs:-1}));assert.throws(()=>server.kissing.configure({trim:'yes'}));
  server.kissing.configure({enabled:true,trim:true,revealDurationMs:400});
  await server.app.close();server=await createController({dataDir:directory,adminToken:key,kissingOptions:{fetchImpl}});
  assert.equal(server.kissing.settings.enabled,true);assert.equal(server.kissing.settings.trim,true);assert.equal(server.kissing.clips()[0].hash,clip.hash);
  assert.equal((await server.app.inject('/phone-wall/media/'+clip.hash)).statusCode,401);
});

test('rejects broken/oversized downloads without publishing assets or leaking staging files',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wall-kissing-bad-'));let bad=new Response('<html>Not video</html>');
  const server=await createController({dataDir:directory,adminToken:key,kissingOptions:{fetchImpl:async url=>url.includes('/api/')?Response.json(metadata):bad}});
  t.after(async()=>{await server.app.close();await rm(directory,{recursive:true,force:true});});
  await server.kissing.refresh();assert.equal(server.kissing.status().clips,0);assert.ok(server.kissing.lastError);
  bad=new Response(mp4,{headers:{'content-length':String(101*1024*1024)}});
  await server.kissing.refresh();assert.equal(server.kissing.status().clips,0);
  assert.ok((await readdir(join(directory,'media'))).every(name=>!name.startsWith('kissing-incoming-')));
});

test('rotating pool is bounded without deleting generic uploads or referenced artwork',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wall-kissing-budget-'));let n=0;
  const server=await createController({dataDir:directory,adminToken:key,kissingOptions:{fetchImpl:async url=>{
    if(url.includes('/api/'))return Response.json({clips:[{...metadata.clips[0],media_url:source+'?n='+n++}]});
    return new Response(Buffer.concat([mp4,Buffer.from(url)]));
  }}});
  t.after(async()=>{await server.app.close();await rm(directory,{recursive:true,force:true});});
  await server.kissing.refresh();const first=server.kissing.clips()[0];
  await server.kissing.refresh();const referenced=server.kissing.clips()[0];
  server.releases.create({sceneSchemaVersion:1,artworkId:'retained-video',artworkVersion:'1',canvas:{width:375,height:667},background:'#000000',transition:{type:'cut',durationMs:0},elements:[{id:'video',type:'video',asset:referenced.hash,frame:{x:0,y:0,width:375,height:667}}]});
  const generic='d'.repeat(64);server.store.db.prepare('INSERT INTO assets VALUES(?,?,?)').run(generic,'video/mp4',3);await writeFile(join(directory,'media',generic),'abc');
  for(let i=0;i<25;i++)await server.kissing.refresh();
  assert.equal(server.kissing.clips().length,24);assert.equal(server.store.asset(first.hash),undefined);
  assert.ok(server.store.asset(referenced.hash));await access(join(directory,'media',referenced.hash));
  assert.equal((await readFile(join(directory,'media',generic))).toString(),'abc');
});

test('30 independent phones receive local clip pools, report playback, reconnect and obey mode/source changes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wall-kissing-flow-'));
  const server=await createController({dataDir:directory,adminToken:key,kissingOptions:{fetchImpl:async url=>url.includes('/api/')?Response.json(metadata):new Response(mp4)}});
  await server.app.listen({host:'127.0.0.1',port:0});
  const clients=Array.from({length:30},()=>new SimulatedClient(`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`));
  t.after(async()=>{clients.forEach(c=>c.stop());await server.app.close();await rm(directory,{recursive:true,force:true});});
  clients.forEach(c=>c.connect());await until(()=>clients.every(c=>c.welcome));
  const state=server.store.current();state.layout.slots=clients.map((c,i)=>({deviceId:c.identity.deviceId,slotIndex:i,geometry:{x:i%5*375,y:Math.floor(i/5)*667,width:375,height:667}}));
  assert.equal((await request(server,{action:'configure',config:state,expectedRevision:state.revision})).statusCode,200);
  const id=clients[0].identity.deviceId,device=server.store.device(id);
  server.store.updateDevice(id,{capabilities:{...device.capabilities,kissingWall:0}});
  assert.equal((await request(server,{action:'kissing.start'})).statusCode,400);assert.equal(server.kissing.settings.enabled,false);
  server.store.updateDevice(id,{capabilities:device.capabilities});
  assert.equal((await request(server,{action:'kissing.start',settings:{trim:true}})).statusCode,200);
  await until(()=>clients.every(c=>c.state?.kissing?.enabled&&c.state.kissing.clips.length===1));
  assert.equal(server.ticker.enabled,false);
  assert.ok(clients.every(c=>!JSON.stringify(c.state.kissing).includes('https:')));
  const clip=clients[0].state.kissing.clips[0];
  const download=await server.app.inject({url:'/phone-wall/media/'+clip.hash,headers:{authorization:'Bearer '+clients[0].identity.token,range:'bytes=0-11'}});
  assert.equal(download.statusCode,206);assert.deepEqual(download.rawPayload,mp4.subarray(0,12));
  clients[0].ws.send(JSON.stringify(envelope('kissing.status',{status:'playing',hash:clip.hash,audio:true})));
  await until(()=>server.store.device(id).kissingStatus?.audio===true);
  clients[0].ws.terminate();await until(()=>clients[0].connections===2&&clients[0].state.kissing.enabled);
  await request(server,{action:'mode',mode:'night'});await until(()=>clients.every(c=>c.state.mode==='night'));assert.equal(server.kissing.settings.enabled,true);
  await request(server,{action:'command',name:'resume'});await until(()=>clients.every(c=>c.state.mode==='exhibition'));
  await request(server,{action:'kissing.settings',settings:{fadeOutDurationMs:500}});await until(()=>clients.every(c=>c.state.kissing.fadeOutDurationMs===500));
  await request(server,{action:'test.text',text:'Back to text'});await until(()=>clients.every(c=>!c.state.kissing.enabled));
  assert.equal((await request(server,{action:'kissing.settings',settings:{enabled:true}})).statusCode,400);
  await access(join(directory,'media',clip.hash));
});
