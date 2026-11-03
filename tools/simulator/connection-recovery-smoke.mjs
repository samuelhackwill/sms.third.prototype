import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../../server/phone-wall/app.mjs';
import { envelope } from '../../protocol/core.mjs';

const simulator=process.env.PHONE_WALL_SIMULATOR_ID,appBundle=process.env.PHONE_WALL_SIM_APP;
if(!simulator||!appBundle)throw new Error('Set PHONE_WALL_SIMULATOR_ID and PHONE_WALL_SIM_APP; this test uses only an isolated simulator/controller.');
const execute=promisify(execFile),bundleId='org.museum.PhoneWall';
const run=(...args)=>execute('xcrun',['simctl',...args],{timeout:120000});
async function until(fn){const end=Date.now()+60000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Native connection recovery timed out');}
const directory=await mkdtemp(join(tmpdir(),'wall-native-connection-'));
const server=await createController({dataDir:directory,adminToken:'connection-smoke-test-key-00000000000000000'});
let launched=false,watch;
const sockets=new Set(),times=[],timers=[];
try {
  await server.app.listen({host:'127.0.0.1',port:0});
  watch=setInterval(()=>{
    for(const ws of server.sessions.values()){
      if(sockets.has(ws))continue;
      sockets.add(ws);times.push(Date.now());
      if(times.length<=4)timers.push(setTimeout(()=>ws.close(1012,'test-server-restart'),300));
    }
  },10);
  await run('install',simulator,appBundle);
  try{await run('terminate',simulator,bundleId);}catch{}
  await run('launch',simulator,bundleId,'-phoneWallDisableDiscovery','-serverURL',`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`);launched=true;
  await until(()=>times.length===5);
  const intervals=times.slice(1).map((at,index)=>at-times[index]);
  assert.ok(intervals[3]>=2100,`Short-lived welcomes must not reset backoff: ${intervals}`);
  const device=server.store.devices()[0];
  await until(()=>server.store.device(device._id).telemetryAt>=times[4]-100);
  const before=server.store.device(device._id).telemetryAt;
  assert.ok(before-times[4]<2000,'Native app must send health immediately after handshake');
  // A rejected optional/application message must not restart the native socket.
  server.sessions.get(device._id).send(JSON.stringify(envelope('server.error',{code:'unknown-deployment',fatal:false})));
  await until(()=>server.store.device(device._id).telemetryAt>before);
  assert.equal(times.length,5);assert.equal(server.sessions.size,1);
  console.log(`PASS native connection recovery: four forced short-lived sockets, increasing retry intervals ${intervals.join('/')} ms, fifth connection stable through heartbeat and nonfatal error; immediate health report. Hardware/LAN diagnosis remains separate.`);
} finally {
  clearInterval(watch);timers.forEach(clearTimeout);
  if(launched)try{await run('terminate',simulator,bundleId);}catch{}
  await server.app.close();await rm(directory,{recursive:true,force:true});
}
