import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../../server/phone-wall/app.mjs';

const simulator=process.env.PHONE_WALL_SIMULATOR_ID,appBundle=process.env.PHONE_WALL_SIM_APP;
if(process.platform!=='darwin'||!simulator||!appBundle)throw new Error('Set PHONE_WALL_SIMULATOR_ID (booted simulator) and PHONE_WALL_SIM_APP (unsigned simulator .app). This test changes that simulator app cache, never physical phones.');
const execute=promisify(execFile),bundleId='org.museum.PhoneWall';
const run=(...args)=>execute('xcrun',['simctl',...args],{timeout:120000});
async function until(fn){const deadline=Date.now()+45000;while(Date.now()<deadline){if(fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Native renderer smoke test timed out');}
const directory=await mkdtemp(join(tmpdir(),'phone-wall-native-'));
const output=resolve(dirname(fileURLToPath(import.meta.url)),'../../.data/native-render-smoke');
const key='native-render-smoke-local-key-000000000000';
const {app,store}=await createController({dataDir:directory,adminToken:key});
let launched=false;
try {
  await mkdir(output,{recursive:true});
  await app.listen({host:'127.0.0.1',port:0});
  const request=async input=>{
    const response=await app.inject({url:'/phone-wall/api',method:'POST',headers:{authorization:`Bearer ${key}`},payload:input});
    assert.equal(response.statusCode,200,response.body);return response.json();
  };
  await run('install',simulator,appBundle);
  try{await run('terminate',simulator,bundleId);}catch{}
  await run('launch',simulator,bundleId,'-serverURL',`ws://127.0.0.1:${app.server.address().port}/phone-wall/ws`);
  launched=true;
  await until(()=>store.devices().length===1);
  const device=store.devices()[0],size=device.capabilities;
  await request({action:'pair',code:device.pairingCode,slotIndex:0,geometry:{x:0,y:0,width:size.width,height:size.height}});
  await request({action:'mode',mode:'exhibition'});
  const definition={sceneSchemaVersion:1,artworkId:'native-emoji-smoke',artworkVersion:String(Date.now()),canvas:{width:size.width,height:size.height},background:'#000000',transition:{type:'cut',durationMs:0},elements:[{
    id:'emoji',type:'text',text:'🍆 ❤️ 👍🏽\n👩🏽‍🔧 🇫🇷\n👨‍👩‍👧‍👦 1️⃣',fontSize:56,color:'#ffffff',frame:{x:12,y:80,width:size.width-24,height:size.height-100}}]};
  const {release}=await request({action:'release.create',definition});
  const {deployment}=await request({action:'release.deploy',releaseId:release.id,deviceIds:[device._id],delayMs:1000});
  await until(()=>store.device(device._id).artworkStatus?.deploymentId===deployment.id&&store.device(device._id).artworkStatus.status==='displayed');
  await until(()=>store.device(device._id).telemetry?.displayLinkFps>0);
  assert.equal(store.device(device._id).telemetry.targetFps,60);
  await run('io',simulator,'screenshot','--type=png',join(output,'emoji-static.png'));
  const moving=await request({action:'test.text',text:'🍆 ❤️ 👍🏽',speed:120});
  await until(()=>store.device(device._id).artworkStatus?.deploymentId===moving.deployment.id&&store.device(device._id).artworkStatus.status==='displayed');
  await new Promise(resolve=>setTimeout(resolve,3000));
  await run('io',simulator,'screenshot','--type=png',join(output,'emoji-moving.png'));
  await until(()=>store.device(device._id).telemetry?.currentSceneId===moving.deployment.releaseId);
  const telemetry=store.device(device._id).telemetry;
  let liveCompleted=false;
  if(process.env.PHONE_WALL_SMOKE_LIVE==='1'){
    const state=store.current();store.commit({...state,testTextSpeed:1000},state.revision);
    await request({action:'live.start'});
    const sourceId='native-smoke-reader-0001',databaseId='a'.repeat(64);
    const post=async payload=>{const response=await app.inject({url:'/phone-wall/reader/'+sourceId,method:'POST',headers:{authorization:`Bearer ${key}`},payload});assert.equal(response.statusCode,200,response.body);};
    await post({action:'batch',databaseId,baseline:true,lastRowId:0});
    await post({action:'batch',databaseId,expectedRowId:0,lastRowId:1,records:[{rowId:1,id:'native-smoke-message',text:'I'}]});
    await until(()=>store.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE status='completed'").get().n===1);
    liveCompleted=true;
  }
  await writeFile(join(output,'report.json'),JSON.stringify({targetFps:telemetry.targetFps,observedDisplayLinkFps:telemetry.displayLinkFps,liveCompleted,scope:'Simulator callbacks only; not physical 6s frame delivery',screenshots:['emoji-static.png','emoji-moving.png']},null,2));
  console.log(`PASS native simulator: emoji scenes prepared/displayed, requested ${telemetry.targetFps} fps, observed ~${Math.round(telemetry.displayLinkFps)} callbacks/s. Screenshots: ${output}`);
  if(liveCompleted)console.log('PASS live message: controller FIFO → native WebSocket → cached WebView bridge → measured readiness/completion → row freed');
}finally{
  if(launched)try{await run('terminate',simulator,bundleId);}catch{}
  await app.close();await rm(directory,{recursive:true,force:true});
}
