import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { prepareInstallation } from '../reset.mjs';

const key='installation-reset-test-key-000000000000000000';
async function until(fn,timeout=12000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    try {if(await fn())return;} catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('timed-out');
}

test('new build clears stale connection metadata and preserves pairing credentials',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-wall-build-reset-'));
  try {
    const store=new Store(join(dir,'controller.sqlite'));
    const id='00000000-0000-4000-8000-000000000001';
    store.register({deviceId:id,token:'device-secret-000000000000000000000000',bootSessionId:id});
    store.updateDevice(id,{connectionIssue:{reason:'stale'},telemetryAt:123,lastDisconnect:{reason:'stale'}});
    const original=store.device(id);
    store.close();
    assert.equal((await prepareInstallation(dir,'build-one')).connectionsCleared,1);
    const reopened=new Store(join(dir,'controller.sqlite'));
    assert.equal(reopened.device(id).tokenHash,original.tokenHash);
    assert.equal(reopened.device(id).pairingCode,original.pairingCode);
    assert.equal(reopened.device(id).connectionIssue,undefined);
    assert.equal(reopened.device(id).bootSessionId,undefined);
    reopened.close();
    assert.equal((await prepareInstallation(dir,'build-one')).connectionsCleared,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('authenticated reset restarts into an empty installation',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-wall-full-reset-'));
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  let child;
  const start=()=>{child=spawn(process.execPath,[new URL('../index.mjs',import.meta.url).pathname],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',PHONE_WALL_MDNS:'false',PHONE_WALL_DATA_DIR:dir,PHONE_WALL_ADMIN_TOKEN:key},stdio:'ignore'});};
  t.after(async()=>{if(child?.exitCode===null){child.kill();await once(child,'exit');}await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  const headers={Authorization:`Bearer ${key}`};
  start();
  await until(async()=>(await fetch(base+'/health')).ok);
  const before=await (await fetch(base+'/phone-wall/api',{headers})).json();
  await writeFile(join(dir,'old-media'),'stale');
  assert.equal((await fetch(base+'/phone-wall/reset',{method:'POST'})).status,401);
  const response=await fetch(base+'/phone-wall/reset',{method:'POST',headers});
  assert.equal(response.status,200);
  assert.equal((await response.json()).ok,true);
  await once(child,'exit');
  start();
  await until(async()=>(await fetch(base+'/health')).ok);
  const after=await (await fetch(base+'/phone-wall/api',{headers})).json();
  assert.notEqual(after.state.installationId,before.state.installationId);
  assert.deepEqual(after.devices,[]);
  await assert.rejects(stat(join(dir,'old-media')),{code:'ENOENT'});
  assert.equal((await readFile(join(dir,'.reset-installation'),'utf8').catch(()=>null)),null);
});
