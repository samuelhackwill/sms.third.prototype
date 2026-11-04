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
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('live recovery timed out');
}

test('a failed live artwork asks a phone to clear its cache once before retrying',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wall-live-recovery-'));
  const key='live-recovery-operator-secret-00000000000';
  const server=await createController({dataDir:directory,adminToken:key});
  await server.app.listen({host:'127.0.0.1',port:0});
  const ws=new WebSocket(`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`);
  t.after(async()=>{ws.terminate();await server.app.close();await rm(directory,{recursive:true,force:true});});
  const messages=[];
  ws.on('message',raw=>messages.push(JSON.parse(raw)));
  const deviceId=randomUUID(),token=randomBytes(32).toString('hex');
  ws.on('open',()=>ws.send(JSON.stringify(envelope('client.hello',{
    deviceId,token,bootSessionId:randomUUID(),runtimeVersion:'2.0',appVersion:'2.4.1',
    capabilities:{sceneSchemaVersions:[1],liveTicker:1},
  }))));
  await until(()=>messages.some(m=>m.type==='server.welcome'));
  const state=server.store.current();
  state.layout.slots=[{deviceId,slotIndex:0,geometry:{x:0,y:0,width:375,height:667}}];
  const headers={authorization:`Bearer ${key}`};
  const configure=await server.app.inject({url:'/phone-wall/api',method:'POST',headers,payload:{action:'configure',config:state,expectedRevision:state.revision}});
  assert.equal(configure.statusCode,200,configure.body);
  const start=await server.app.inject({url:'/phone-wall/api',method:'POST',headers,payload:{action:'barthes.start'}});
  assert.equal(start.statusCode,200,start.body);
  await until(()=>messages.some(m=>m.type==='state.snapshot'&&m.payload.artwork?.pending));
  const pending=messages.findLast(m=>m.type==='state.snapshot'&&m.payload.artwork?.pending).payload.artwork.pending;
  const code='artwork-asset-or-storage-unavailable-nscocoaerrordomain-4';
  const error=envelope('artwork.status',{deploymentId:pending.deploymentId,releaseId:pending.releaseId,status:'error',code});
  ws.send(JSON.stringify(error));
  await until(()=>messages.some(m=>m.type==='command'&&m.payload.name==='clearCache'));
  ws.send(JSON.stringify(error));
  await until(()=>server.store.errors().filter(e=>e.record.code===code).length===2);
  assert.equal(messages.filter(m=>m.type==='command'&&m.payload.name==='clearCache').length,1);
  assert.equal(server.ticker.playbackMode,'barthes');
});
