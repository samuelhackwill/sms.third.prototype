import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../app.mjs';
import { SimulatedClient } from '../simulated-client.mjs';

async function until(predicate){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}
  throw new Error('transition timed out');
}

test('manual SMS transition uses the existing live web artwork on alternating rows',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wall-transition-'));
  const key='transition-operator-secret-000000000000';
  const server=await createController({dataDir:directory,adminToken:key});
  await server.app.listen({host:'127.0.0.1',port:0});
  const endpoint=`ws://127.0.0.1:${server.app.server.address().port}/phone-wall/ws`;
  const clients=[new SimulatedClient(endpoint),new SimulatedClient(endpoint)];
  t.after(async()=>{clients.forEach(client=>client.stop());await server.app.close();await rm(directory,{recursive:true,force:true});});
  clients.forEach(client=>client.connect());
  await until(()=>clients.every(client=>client.welcome));
  const state=server.store.current();
  state.mode='exhibition';state.layout.rows=2;state.layout.columns=1;
  state.layout.slots=clients.map((client,index)=>({deviceId:client.identity.deviceId,slotIndex:index,geometry:{x:0,y:index*667,width:375,height:667}}));
  const headers={authorization:`Bearer ${key}`};
  const action=async payload=>{
    const result=await server.app.inject({url:'/phone-wall/api',method:'POST',headers,payload});
    assert.equal(result.statusCode,200,result.body);
    return result.json();
  };
  await action({action:'configure',config:state,expectedRevision:state.revision});
  await action({action:'barthes.start'});
  await until(()=>clients.every(client=>{
    const active=server.releases.snapshot(client.identity.deviceId).active;
    return active?.release.definition.artworkId==='live-ticker'&&server.releases.deployment(active.deploymentId).targets[client.identity.deviceId]?.status==='displayed';
  }));
  server.ticker.stopBarthes();
  assert.equal(server.ticker.enabled,false);
  const revision=server.store.current().revision;
  await action({action:'transition.settings',settings:{blinkCount:4,scrollSpeed:2,blinkSpeed:2}});
  const result=await action({action:'transition.sms'});
  await until(()=>clients.every(client=>client.ticker?.transition?.id===result.id));
  assert.deepEqual(clients[0].ticker.transition.rows.map(row=>row.row),[0,1]);
  assert.deepEqual(clients[0].ticker.transition.rows.map(row=>row.cells.map(cell=>cell.width)),[[375],[375]]);
  assert.equal(clients[0].ticker.transition.startAtServerMs,clients[1].ticker.transition.startAtServerMs);
  assert.deepEqual(clients[0].ticker.transition.settings,{blinkCount:4,scrollSpeed:2,blinkSpeed:2});
  assert.equal(clients[0].ticker.transition.durationMs,1225);
  assert.equal(server.store.current().revision,revision);
});
