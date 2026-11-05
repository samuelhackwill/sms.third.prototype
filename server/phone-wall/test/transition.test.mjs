import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createController } from '../app.mjs';
import { envelope } from '../../../protocol/core.mjs';

async function until(predicate){
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('transition message timed out');
}

test('manual SMS transition reaches every row with one shared start time',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wall-transition-'));
  const key='transition-operator-secret-000000000000';
  const server=await createController({dataDir:directory,adminToken:key});
  await server.app.listen({host:'127.0.0.1',port:0});
  const clients=Array.from({length:2},()=>({id:randomUUID(),token:randomBytes(32).toString('hex'),messages:[]}));
  const endpoint=`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`;
  for(const client of clients){
    client.ws=new WebSocket(endpoint);
    client.ws.on('open',()=>client.ws.send(JSON.stringify(envelope('client.hello',{
      deviceId:client.id,token:client.token,bootSessionId:randomUUID(),runtimeVersion:'2.0',appVersion:'2.4.5',
      capabilities:{sceneSchemaVersions:[1],liveTicker:1,transitionOverlay:1},
    }))));
    client.ws.on('message',raw=>client.messages.push(JSON.parse(raw)));
  }
  t.after(async()=>{clients.forEach(client=>client.ws.terminate());await server.app.close();await rm(directory,{recursive:true,force:true});});
  await until(()=>clients.every(client=>client.messages.some(message=>message.type==='server.welcome')));
  const state=server.store.current();
  state.mode='exhibition';
  state.layout.rows=2;state.layout.columns=1;
  state.layout.slots=clients.map((client,index)=>({deviceId:client.id,slotIndex:index,geometry:{x:0,y:index*667,width:375,height:667}}));
  const headers={authorization:`Bearer ${key}`};
  const configure=await server.app.inject({url:'/phone-wall/api',method:'POST',headers,payload:{action:'configure',config:state,expectedRevision:state.revision}});
  assert.equal(configure.statusCode,200,configure.body);
  const revision=server.store.current().revision;
  const response=await server.app.inject({url:'/phone-wall/api',method:'POST',headers,payload:{action:'transition.sms'}});
  assert.equal(response.statusCode,200,response.body);
  await until(()=>clients.every(client=>client.messages.some(message=>message.type==='transition.play')));
  const payloads=clients.map(client=>client.messages.find(message=>message.type==='transition.play').payload);
  assert.deepEqual(payloads.map(payload=>payload.row.row),[0,1]);
  assert.ok(payloads.every(payload=>payload.kind==='sms-hearts'&&payload.id===payloads[0].id&&payload.startAtServerMs===payloads[0].startAtServerMs));
  assert.deepEqual(payloads.map(payload=>payload.slot.y),[0,667]);
  assert.equal(server.store.current().revision,revision);
});
