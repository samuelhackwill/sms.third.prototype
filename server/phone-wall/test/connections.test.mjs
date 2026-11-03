import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createController } from '../app.mjs';
import { envelope } from '../../../protocol/core.mjs';
import { powerReading } from '../public/device-health.js';

async function until(fn){const end=Date.now()+8000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('connection regression timeout');}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'wall-connections-'));
  const server=await createController({dataDir:directory,adminToken:'connection-regression-secret-000000000000000'});
  await server.app.listen({host:'127.0.0.1',port:0});
  const sockets=[];
  function phone(identity={deviceId:randomUUID(),token:randomBytes(32).toString('hex')},bootSessionId=randomUUID()){
    const ws=new WebSocket(`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`),messages=[];
    const send=(type,payload)=>ws.send(JSON.stringify(envelope(type,payload)));
    ws.on('open',()=>send('client.hello',{...identity,bootSessionId,capabilities:{},appVersion:'test'}));
    ws.on('message',raw=>messages.push(JSON.parse(raw)));ws.on('error',()=>{});sockets.push(ws);
    return {ws,messages,send,identity,bootSessionId};
  }
  t.after(async()=>{sockets.forEach(ws=>ws.terminate());await server.app.close();await rm(directory,{recursive:true,force:true});});
  return {...server,phone};
}

test('stale cached-artwork and unsupported feature messages report errors without disconnecting the phone',async t=>{
  const server=await fixture(t),phone=server.phone();
  await until(()=>phone.messages.some(m=>m.type==='server.welcome'));
  assert.deepEqual(phone.messages.find(m=>m.type==='server.welcome').payload.features,{liveTicker:1,kissingWall:1});
  phone.send('artwork.status',{deploymentId:randomUUID(),status:'ready',releaseId:'a'.repeat(64)});
  await until(()=>phone.messages.some(m=>m.type==='server.error'));
  assert.equal(phone.messages.find(m=>m.type==='server.error').payload.fatal,false);
  phone.send('future.optional-feature',{});
  phone.send('client.heartbeat',{battery:0.4,charging:false});phone.send('time.request',{sent:123});
  await until(()=>phone.messages.some(m=>m.type==='time.response'));
  assert.equal(phone.ws.readyState,WebSocket.OPEN);assert.equal(server.sessions.size,1);
  assert.equal(server.store.device(phone.identity.deviceId).connectionIssue.reason,'unsupported-message');
  assert.ok(server.store.device(phone.identity.deviceId).telemetryAt);
  const headers={authorization:'Bearer connection-regression-secret-000000000000000'};
  const debug=await server.app.inject({url:'/phone-wall/api',method:'POST',headers,payload:{action:'debug',enabled:true}});
  assert.equal(debug.statusCode,200);
  const dashboard=(await server.app.inject({url:'/phone-wall/api',headers})).json();
  assert.equal(dashboard.state.debugEnabled,true);
  assert.ok(dashboard.errors.some(entry=>entry.deviceId===phone.identity.deviceId&&entry.record.code==='unsupported-message'));
});

test('two boot sessions sharing a device ID cannot evict each other or mix power readings',async t=>{
  const server=await fixture(t),first=server.phone();
  await until(()=>first.messages.some(m=>m.type==='server.welcome'));
  first.send('client.heartbeat',{charging:false,battery:0.6});
  await until(()=>server.store.device(first.identity.deviceId).telemetryAt);
  const clone=server.phone(first.identity);
  await until(()=>clone.messages.some(m=>m.type==='server.error'));
  assert.equal(clone.messages.find(m=>m.type==='server.error').payload.code,'device-identity-conflict');
  assert.equal(first.ws.readyState,WebSocket.OPEN);assert.equal(server.sessions.size,1);
  assert.equal(server.store.device(first.identity.deviceId).telemetry.charging,false);
  assert.equal(server.store.device(first.identity.deviceId).bootSessionId,first.bootSessionId);
  assert.equal(server.store.device(first.identity.deviceId).connectionIssue.reason,'device-identity-conflict');
  first.ws.terminate();await until(()=>!server.sessions.has(first.identity.deviceId));
  const restart=server.phone(first.identity);await until(()=>restart.messages.some(m=>m.type==='server.welcome'));
});

test('socket replacement in the same boot ignores old-socket telemetry and records fatal protocol errors',async t=>{
  const server=await fixture(t),first=server.phone();await until(()=>first.messages.some(m=>m.type==='server.welcome'));
  first.send('client.heartbeat',{charging:true,battery:0.6});await until(()=>server.store.device(first.identity.deviceId).telemetryAt);
  const oldSocket=server.sessions.get(first.identity.deviceId);
  const replacement=server.phone(first.identity,first.bootSessionId);await until(()=>replacement.messages.some(m=>m.type==='server.welcome'));
  replacement.send('client.heartbeat',{charging:null,battery:-1});
  await until(()=>server.store.device(first.identity.deviceId).telemetry.charging===null);
  oldSocket.emit('message',Buffer.from(JSON.stringify(envelope('client.heartbeat',{charging:true,battery:0.9}))));
  assert.equal(server.store.device(first.identity.deviceId).telemetry.charging,null);
  replacement.ws.send('{broken');await until(()=>replacement.messages.some(m=>m.type==='server.error'));
  assert.equal(replacement.messages.find(m=>m.type==='server.error').payload.fatal,true);
  await until(()=>!server.sessions.has(first.identity.deviceId));
  assert.equal(server.store.device(first.identity.deviceId).lastDisconnect.code,1008);
});

test('socket reconnect never turns old charging data into a fresh measurement',()=>{
  const now=100000,device={connected:true,lastSeenAt:new Date(now).toISOString(),telemetry:{charging:true,battery:0.9},telemetryAt:now-60000};
  assert.equal(powerReading(device,now).stale,true);
  assert.equal(powerReading({...device,telemetryAt:undefined},now).stale,true);
  assert.equal(powerReading({...device,telemetryAt:now},now).stale,false);
  assert.equal(powerReading({...device,connected:false,telemetryAt:now},now).stale,true);
  assert.equal(powerReading({...device,telemetry:{charging:null,battery:-1}},now).source,'No data');
});
