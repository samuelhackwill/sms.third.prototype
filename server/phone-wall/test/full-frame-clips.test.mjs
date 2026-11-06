import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../app.mjs';
import { fullFrameDefinition } from '../full-frame-clips.mjs';
import { SimulatedClient } from '../simulated-client.mjs';

const key='full-frame-test-operator-key-0000000000000';
async function until(check){const end=Date.now()+8000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('full-frame-timeout');}

test('a landscape clip covers the whole tall matrix and stays centered',()=>{
  const layout={columns:2,rows:2,slots:[0,1,2,3].map(index=>({deviceId:`phone-${index}`,slotIndex:index,geometry:{x:index%2*375,y:Math.floor(index/2)*667,width:375,height:667}}))};
  const scene=fullFrameDefinition(layout,{hash:'a'.repeat(64)},{width:1920,height:1080,durationMs:2000});
  const frame=scene.elements[0].frame;
  assert.equal(scene.elements.length,2);
  assert.equal(scene.elements[0].type,'video');
  assert.equal(scene.elements[0].animation.durationMs,1000);
  assert.equal(scene.elements[1].id,'fade-to-black');
  assert.equal(scene.elements[1].animation.delayMs,1000);
  assert.ok(frame.x<=0&&frame.x+frame.width>=750);
  assert.ok(frame.y<=0&&frame.y+frame.height>=1334);
  assert.ok(Math.abs(frame.width/frame.height-1920/1080)<0.001);
});

test('desktop action cycles cached clips across connected phones and Stop resumes text',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-wall-full-frame-'));
  const server=await createController({dataDir:dir,adminToken:key,fullFrameOptions:{probe:()=>({width:1920,height:1080,durationMs:3000})},kissingOptions:{fetchImpl:async()=>{throw new Error('offline');}}});
  await server.app.listen({host:'127.0.0.1',port:0});
  const endpoint=`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`;
  const clients=[new SimulatedClient(endpoint),new SimulatedClient(endpoint)];
  t.after(async()=>{clients.forEach(client=>client.stop());await server.app.close();await rm(dir,{recursive:true,force:true});});
  clients.forEach(client=>client.connect());await until(()=>clients.every(client=>client.welcome));
  const state=server.store.current();state.layout.rows=1;state.layout.columns=2;
  state.layout.slots=clients.map((client,index)=>({deviceId:client.identity.deviceId,slotIndex:index,geometry:{x:index*375,y:0,width:375,height:667}}));
  server.store.commit(state,state.revision);
  for(let index=0;index<2;index++){
    const hash=String(index+1).repeat(64),source=`https://example.test/${index}.mp4`;
    server.store.db.prepare('INSERT INTO assets VALUES(?,?,?)').run(hash,'video/mp4',100);
    server.store.db.prepare('INSERT INTO kissing_clips VALUES(?,?,?,?)').run(source,hash,JSON.stringify({source,hash,bytes:100}),Date.now()+index);
  }
  const request=async action=>{const response=await server.app.inject({method:'POST',url:'/phone-wall/api',headers:{authorization:`Bearer ${key}`},payload:{action}});assert.equal(response.statusCode,200,response.body);return response.json();};
  await request('full-frame.start');
  await until(()=>server.fullFrame.state.current&&clients.every(client=>client.activeArtwork?.release?.definition?.artworkId==='full-frame-clips'));
  const first=server.fullFrame.state.current.hash,firstDeployment=server.releases.deployment(server.fullFrame.state.current.id);
  await until(()=>server.fullFrame.state.current?.hash!==first);
  const secondDeployment=server.releases.deployment(server.fullFrame.state.current.id);
  assert.equal(secondDeployment.startAtServerMs-firstDeployment.startAtServerMs,3000);
  assert.ok(clients.every(client=>client.activeArtwork?.release?.definition?.artworkId==='full-frame-clips'));
  await request('full-frame.stop');
  assert.equal(server.fullFrame.state.enabled,false);
  assert.equal(server.ticker.playbackMode,'barthes');
});

test('kiss-only setting caches an accurate trimmed clip on the controller',async t=>{
  const ffmpeg='/opt/homebrew/bin/ffmpeg';
  if(spawnSync(ffmpeg,['-version'],{stdio:'ignore'}).status!==0){t.skip('ffmpeg unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'phone-wall-full-frame-trim-'));
  const server=await createController({dataDir:dir,adminToken:key,kissingOptions:{fetchImpl:async()=>{throw new Error('offline');}}});
  t.after(async()=>{await server.app.close();await rm(dir,{recursive:true,force:true});});
  const source=join(dir,'source.mp4');
  const made=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x64:r=10:d=2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  assert.equal(made.status,0);
  const hash=createHash('sha256').update(await readFile(source)).digest('hex');
  await writeFile(join(dir,'media',hash),await readFile(source));
  const clip={hash,startSec:0.5,endSec:1.5};
  const settings={trim:true,trimStartOffsetSec:0,trimEndOffsetSec:0};
  const first=await server.fullFrame.clipForSettings(clip,{width:64,height:64,durationMs:2000},settings);
  const second=await server.fullFrame.clipForSettings(clip,{width:64,height:64,durationMs:2000},settings);
  assert.equal(first.clip.hash,second.clip.hash);
  assert.notEqual(first.clip.hash,hash);
  assert.ok(first.video.durationMs>=900&&first.video.durationMs<=1100);
});
