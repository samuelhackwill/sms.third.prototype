import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startDiscovery } from '../discovery.mjs';

test('macOS registers only a service with system Bonjour, never a host or proxy',()=>{
  let invocation,killed;
  const child=new EventEmitter();child.kill=signal=>{killed=signal;};
  const discovery=startDiscovery({mdns:true,serviceName:'Phone Wall',port:3101,advertisedHost:'sms-ingestor.local'},{platform:'darwin',spawnProcess:(...args)=>{invocation=args;return child;}});
  assert.deepEqual(invocation,['/usr/bin/dns-sd',['-R','Phone Wall','_phonewall._tcp','local','3101','path=/phone-wall/ws','v=1'],{stdio:'ignore'}]);
  discovery.stop();assert.equal(killed,'SIGTERM');
});

test('system Bonjour registration retries once after process failure and stops cleanly',async()=>{
  const children=[];let errors=0;
  const discovery=startDiscovery({mdns:true,serviceName:'Phone Wall',port:3100},{platform:'darwin',retryMs:5,onError:()=>errors++,spawnProcess:()=>{
    const child=new EventEmitter();child.kill=()=>{};children.push(child);return child;
  }});
  children[0].emit('error',new Error('unavailable'));
  children[0].emit('exit',1);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(children.length,2);assert.equal(errors,1);
  discovery.stop();children[1].emit('exit',0);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(children.length,2);
});

test('disabled Bonjour does not spawn a process',()=>{
  startDiscovery({mdns:false},{spawnProcess:()=>{throw new Error('unexpected spawn');}}).stop();
});
