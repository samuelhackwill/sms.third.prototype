import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createController } from '../../server/phone-wall/app.mjs';

const simulator=process.env.PHONE_WALL_SIMULATOR_ID,appBundle=process.env.PHONE_WALL_SIM_APP;
if(!simulator||!appBundle)throw new Error('Set PHONE_WALL_SIMULATOR_ID and PHONE_WALL_SIM_APP. This uses a simulator only. Requires ffmpeg.');
const exec=promisify(execFile),bundleId='org.museum.PhoneWall';
const run=(...args)=>exec('xcrun',['simctl',...args],{timeout:120000});
async function until(fn){const end=Date.now()+45000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Native kissing smoke timed out');}
const directory=await mkdtemp(join(tmpdir(),'wall-native-kiss-')),output=resolve('.data/kissing-wall-smoke');
const key='native-kissing-smoke-secret-0000000000000000';
let server,launched=false,online=true,index=0;
const videos=[],events=[];
async function start(port=0){
  const result=await createController({dataDir:join(directory,'wall'),adminToken:key,kissingOptions:{fetchImpl:async url=>{
    if(!online)throw new Error('simulated WAN outage');
    if(url.includes('/api/')){index=(index+1)%2;return Response.json({clips:[{tag:'kiss',media_url:`https://kiss-files.s3.eu-west-par.io.cloud.ovh.net/${index}.mp4`,kiss_start_seconds:1,kiss_end_seconds:3}]});}
    return new Response(videos[url.endsWith('/0.mp4')?0:1]);
  }}});
  const update=result.store.updateDevice.bind(result.store);
  result.store.updateDevice=(id,patch)=>{if(patch.kissingStatus)events.push(patch.kissingStatus);return update(id,patch);};
  await result.app.listen({host:'127.0.0.1',port});console.log('Isolated controller port:',result.app.server.address().port);return result;
}
async function request(payload){const r=await server.app.inject({url:'/phone-wall/api',method:'POST',headers:{authorization:'Bearer '+key},payload});assert.equal(r.statusCode,200,r.body);return r.json();}
try {
  await mkdir(output,{recursive:true});
  for(const color of ['red','blue']){
    const file=join(directory,color+'.mp4');
    await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${color}:s=240x426:r=30:d=5`,'-f','lavfi','-i','sine=frequency=440:duration=5','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-movflags','+faststart',file]);
    videos.push(await readFile(file));
  }
  server=await start();
  await server.kissing.refresh();await server.kissing.refresh();assert.equal(server.kissing.clips().length,2);
  const port=server.app.server.address().port;
  await run('install',simulator,appBundle);
  try{await run('terminate',simulator,bundleId);}catch{}
  await run('launch',simulator,bundleId,'-phoneWallDisableDiscovery','-serverURL',`ws://127.0.0.1:${port}/phone-wall/ws`);launched=true;
  console.log('Native app launched; waiting for registration/playback.');
  await until(()=>server.store.devices().length===1);
  const phone=server.store.devices()[0];
  await request({action:'pair',code:phone.pairingCode,slotIndex:0,geometry:{x:0,y:0,width:375,height:667}});
  await request({action:'kissing.start',settings:{trim:true,trimStartOffsetSec:0,trimEndOffsetSec:0,revealDurationMs:100,fadeOutDurationMs:100}});
  await until(()=>new Set(events.filter(e=>e.status==='playing').map(e=>e.hash)).size===2);
  assert.ok(events.filter(e=>e.status==='playing').every(e=>e.audio));
  assert.ok(events.some(e=>e.status==='ended'));
  await request({action:'mode',mode:'night'});
  await new Promise(resolve=>setTimeout(resolve,500));
  const count=events.filter(e=>e.status==='ended').length;
  await new Promise(resolve=>setTimeout(resolve,3000));assert.equal(events.filter(e=>e.status==='ended').length,count);
  await request({action:'command',name:'resume'});
  await until(()=>events.filter(e=>e.status==='ended').length>count);
  online=false;await server.kissing.refresh();assert.equal(server.kissing.clips().length,2);
  await server.app.close();server=null;
  // A cold app launch with no controller must still play the cached last-good pool.
  await run('terminate',simulator,bundleId);await run('launch',simulator,bundleId,'-phoneWallDisableDiscovery');
  let colored=false;
  for(let attempt=0;attempt<10&&!colored;attempt++){
    await new Promise(resolve=>setTimeout(resolve,700));
    const image=join(output,'offline-native-video.png');await run('io',simulator,'screenshot','--type=png',image);
    const {stdout}=await exec('ffmpeg',['-hide_banner','-loglevel','error','-i',image,'-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'});
    colored=Math.max(stdout[0],stdout[2])>100&&Math.abs(stdout[0]-stdout[2])>70;
  }
  assert.ok(colored,'Cached video must actually render after a cold launch with server absent');
  server=await start(port);await until(()=>server.sessions.has(phone._id));
  const played=events.filter(e=>e.status==='playing').length;
  await until(()=>events.filter(e=>e.status==='playing').length>played);
  await request({action:'kissing.stop'});await until(()=>server.store.device(phone._id).kissingStatus?.status==='stopped');
  console.log('PASS native kissing: two local H.264/AAC clips advance independently, audio enabled, trim/fades, night/resume, WAN loss, cold offline launch visibly renders cached video, server restart reconnects, stop acknowledged. Physical iOS 15 / speaker output NOT TESTED.');
} catch(error) {
  console.error('Native kissing diagnostics:',JSON.stringify({events:events.slice(-15),devices:server?.store.devices().map(d=>({capabilities:d.capabilities,status:d.kissingStatus,telemetry:d.telemetry,lastError:d.lastError}))}));
  if(launched)try{await run('io',simulator,'screenshot','--type=png',join(output,'failure.png'));}catch{}
  throw error;
} finally {
  if(launched)try{await run('terminate',simulator,bundleId);}catch{}
  if(server)await server.app.close();await rm(directory,{recursive:true,force:true});
}
