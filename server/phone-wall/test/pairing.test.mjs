import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../app.mjs';
import { SimulatedClient } from '../simulated-client.mjs';
import { PairingSession } from '../pairing.mjs';
import { envelope } from '../../../protocol/core.mjs';

async function until(fn){const deadline=Date.now()+10000;while(Date.now()<deadline){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('pairing test timeout');}
test('30 phones tap in physical order, duplicate taps, partial stop, reconnect and auto-complete',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'phone-wall-pairing-'));
  const key='pairing-test-operator-secret-000000000000';
  const server=await createController({dataDir:directory,adminToken:key});
  await server.app.listen({host:'127.0.0.1',port:0});
  const endpoint=`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`;
  const phones=Array.from({length:30},()=>new SimulatedClient(endpoint));
  t.after(async()=>{phones.forEach(phone=>phone.stop());await server.app.close();await rm(directory,{recursive:true,force:true});});
  const request=async input=>{
    const response=await server.app.inject({url:'/phone-wall/api',method:input?'POST':'GET',headers:{authorization:`Bearer ${key}`},...(input?{payload:input}:{})});
    assert.equal(response.statusCode,200,response.body);return response.json();
  };
  const unauthorized=await server.app.inject({url:'/phone-wall/api',method:'POST',payload:{action:'pairing.start'}});
  assert.equal(unauthorized.statusCode,401);
  phones.forEach(phone=>phone.connect());await until(()=>phones.every(phone=>phone.welcome&&phone.pairing));
  await request({action:'pairing.start'});await until(()=>phones.every(phone=>phone.pairing.active));
  const sessionId=phones[0].pairing.sessionId;
  const tap=(phone,id=sessionId)=>phone.ws.send(JSON.stringify(envelope('pairing.tap',{sessionId:id})));
  tap(phones[4]);tap(phones[4]);await until(()=>phones[4].pairing.slotIndex===0);
  tap(phones[2]);await until(()=>phones[2].pairing.slotIndex===1);
  assert.equal((await request()).pairing.count,2);
  const beforeReconnect=phones[4].connections;
  phones[4].ws.terminate();await until(()=>phones[4].connections>beforeReconnect&&phones[4].pairing.slotIndex===0);
  await request({action:'pairing.stop'});await until(()=>phones.every(phone=>!phone.pairing.active));
  const partial=(await request()).state;
  assert.equal(partial.layout.slots.length,2);
  tap(phones[3]);await until(()=>phones[3].pairing.error==='pairing-session-expired');
  assert.equal((await request()).state.revision,partial.revision);
  const restarted=await request({action:'pairing.start'});
  await until(()=>phones.every(phone=>phone.pairing.active&&phone.pairing.sessionId===restarted.pairing.sessionId));
  const ordered=[...phones].reverse();
  for(let index=0;index<ordered.length;index++){
    tap(ordered[index],restarted.pairing.sessionId);
    await until(()=>ordered[index].pairing.count===index+1);
  }
  const final=await request();assert.equal(final.pairing.active,false);assert.equal(final.pairing.count,30);
  assert.equal(final.state.layout.slots.length,30);
  tap(ordered[29],restarted.pairing.sessionId);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await request()).state.revision,final.state.revision);
  assert.equal(ordered[29].pairing.error,undefined);
  for(let index=0;index<ordered.length;index++){
    const slot=final.state.layout.slots.find(slot=>slot.deviceId===ordered[index].identity.deviceId);
    assert.equal(slot.slotIndex,index);assert.equal(slot.geometry.x,(index%5)*375);assert.equal(slot.geometry.y,Math.floor(index/5)*667);
  }
  const fresh=new PairingSession(server.store);
  assert.equal(fresh.status().active,false);assert.equal(server.store.current().layout.slots.length,30);
  fresh.start();fresh.session.expiresAt=Date.now()-1;assert.equal(fresh.expire(),true);assert.equal(fresh.status().active,false);
});
