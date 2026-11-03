import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testTextDefinition } from '../test-text.mjs';
import { validateDefinition } from '../scenes.mjs';
import { createController } from '../app.mjs';
import { SimulatedClient } from '../simulated-client.mjs';

const until=async fn=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('test-text timeout');};
test('test text uses scene v1, one right-to-left pass per occupied row with staggered starts',()=>{
  const layout={rows:6,columns:5,slots:[0,1,5,7].map(slotIndex=>({deviceId:`device-000${slotIndex}`,slotIndex,geometry:{x:slotIndex%5*375,y:Math.floor(slotIndex/5)*667,width:375,height:667}}))};
  const definition=validateDefinition(testTextDefinition(layout));
  assert.equal(definition.elements.length,2);
  assert.deepEqual(definition.elements.map(e=>e.animation.delayMs),[0,750]);
  for(const element of definition.elements){assert.equal(element.text,'Bla bla bla');assert.equal(element.animation.repeat,false);assert.ok(element.animation.to<element.animation.from);}
  assert.throws(()=>testTextDefinition({rows:6,columns:5,slots:[]}),/pair-phones/);
});

test('test text prepares online paired phones, skips offline records and resumes exhibition',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-wall-text-')),key='operator-test-text-key-000000000000000000';
  const server=await createController({dataDir:dir,adminToken:key});
  await server.app.listen({host:'127.0.0.1',port:0});
  const phone=new SimulatedClient(`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`);
  t.after(async()=>{phone.stop();await server.app.close();await rm(dir,{recursive:true,force:true});});
  const request=input=>server.app.inject({method:'POST',url:'/phone-wall/api',headers:{authorization:`Bearer ${key}`},payload:input});
  const rejected=await server.app.inject({method:'POST',url:'/phone-wall/api',payload:{action:'test.text'}});
  assert.equal(rejected.statusCode,401);
  assert.equal((await request({action:'test.text'})).statusCode,400);
  phone.connect();await until(()=>phone.welcome);
  server.store.register({deviceId:'offline-device-0001',token:'a'.repeat(64),bootSessionId:'offline-session-0001',runtimeVersion:'2.0',capabilities:{sceneSchemaVersions:[1]}});
  const state=server.store.current();
  state.layout.slots=[phone.identity.deviceId,'offline-device-0001'].map((deviceId,slotIndex)=>({deviceId,slotIndex,geometry:{x:slotIndex*375,y:0,width:375,height:667}}));
  server.store.commit(state,state.revision);
  await request({action:'pairing.start'});
  assert.equal((await request({action:'test.text'})).statusCode,400);
  await request({action:'pairing.stop'});
  const response=await request({action:'test.text'});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().online,1);assert.equal(response.json().offline,1);
  await until(()=>phone.activeArtwork?.release.definition.artworkId==='operator-test-text');
  assert.equal(server.store.current().mode,'exhibition');
  assert.equal(phone.pairing.paired,true);
});
