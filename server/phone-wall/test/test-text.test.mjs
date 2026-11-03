import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testTextDefinition,estimateTestTextWidth,validateTestText } from '../test-text.mjs';
import { validateDefinition } from '../scenes.mjs';
import { createController } from '../app.mjs';
import { SimulatedClient } from '../simulated-client.mjs';
import { envelope } from '../../../protocol/core.mjs';

const until=async fn=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('test-text timeout');};
test('emoji clusters, skin tones, flags, keycaps and combining accents are not split into code units',()=>{
  const clusters=['🍆','❤️','👍🏽','👩🏽‍🔧','🇫🇷','1️⃣','👨‍👩‍👧‍👦','e\u0301'];
  for(const text of clusters){
    assert.equal(estimateTestTextWidth(text,100),170);
    assert.equal(validateTestText(text.repeat(120)),text.repeat(120).length<=500?text.repeat(120):undefined);
  }
});
test('test text uses scene v1, one right-to-left pass per occupied row with staggered starts',()=>{
  const layout={rows:6,columns:5,slots:[0,1,5,7].map(slotIndex=>({deviceId:`device-000${slotIndex}`,slotIndex,geometry:{x:slotIndex%5*375,y:Math.floor(slotIndex/5)*667,width:375,height:667}}))};
  const definition=validateDefinition(testTextDefinition(layout));
  assert.equal(definition.elements.length,2);
  assert.deepEqual(definition.elements.map(e=>e.animation.delayMs),[0,750]);
  for(const element of definition.elements){assert.equal(element.text,'Bla bla bla');assert.equal(element.animation.repeat,false);assert.ok(element.animation.to<element.animation.from);}
  assert.throws(()=>testTextDefinition({rows:6,columns:5,slots:[]}),/pair-phones/);
  const slower=testTextDefinition(layout,{speed:120});
  assert.equal(slower.parameters.speed,120);
  for(let index=0;index<definition.elements.length;index++){
    assert.ok(Math.abs(slower.elements[index].animation.durationMs-definition.elements[index].animation.durationMs*2)<=1);
    assert.equal(slower.elements[index].animation.delayMs,definition.elements[index].animation.delayMs);
  }
  for(const speed of [0,-1,19,1001,NaN,Infinity,'120'])assert.throws(()=>testTextDefinition(layout,{speed}),/speed-must-be/);
  assert.doesNotThrow(()=>testTextDefinition(layout,{speed:20}));
  assert.doesNotThrow(()=>testTextDefinition(layout,{speed:1000}));
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
  const previous=server.store.current().revision;
  assert.equal((await request({action:'test.text',speed:0})).statusCode,400);
  assert.equal(server.store.current().revision,previous);
  const emoji='Bonjour 🍆 ❤️ 👍🏽 👩🏽‍🔧 🇫🇷 👨‍👩‍👧‍👦';
  const response=await request({action:'test.text',speed:120,text:emoji});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().online,1);assert.equal(response.json().offline,1);
  await until(()=>phone.activeArtwork?.release.definition.artworkId==='operator-test-text');
  assert.equal(server.store.current().mode,'exhibition');
  assert.equal(server.store.current().testTextSpeed,120);
  assert.equal(phone.activeArtwork.release.definition.parameters.speed,120);
  assert.equal(phone.activeArtwork.release.definition.parameters.text,emoji);
  assert.equal(phone.activeArtwork.release.definition.elements[0].text,emoji);
  assert.equal(server.store.current().testText,emoji);
  phone.ws.send(JSON.stringify(envelope('client.heartbeat',{displayLinkFps:59.7,targetFps:60})));
  await until(()=>server.store.device(phone.identity.deviceId).telemetry?.displayLinkFps===59.7);
  assert.equal(server.store.device(phone.identity.deviceId).telemetry.targetFps,60);
  const repeated=await request({action:'test.text'});
  assert.equal(repeated.statusCode,200,repeated.body);
  assert.equal(server.releases.release(repeated.json().deployment.releaseId).definition.parameters.speed,120);
  assert.equal(server.releases.release(repeated.json().deployment.releaseId).definition.parameters.text,emoji);
  assert.equal(phone.pairing.paired,true);
});
