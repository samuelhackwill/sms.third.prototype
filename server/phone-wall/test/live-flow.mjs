import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firefox } from 'playwright';
import { createController } from '../app.mjs';
import { SimulatedClient } from '../simulated-client.mjs';
import { MessagesReader } from '../messages-reader.mjs';
import { envelope } from '../../../protocol/core.mjs';

async function until(fn){const end=Date.now()+40000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Live ticker browser flow timed out');}
const directory=await mkdtemp(join(tmpdir(),'wall-live-flow-')),key='browser-live-flow-secret-00000000000000000';
const server=await createController({dataDir:join(directory,'wall'),adminToken:key});
await server.app.listen({host:'127.0.0.1',port:0});const base=`http://127.0.0.1:${server.app.server.address().port}`;
const phones=Array.from({length:2},()=>new SimulatedClient(base.replace('http','ws')+'/phone-wall/ws'));
const source=new DatabaseSync(join(directory,'chat.db'));source.exec('CREATE TABLE message(ROWID INTEGER PRIMARY KEY,guid TEXT,text TEXT,date INTEGER,is_from_me INTEGER)');
const insert=source.prepare('INSERT INTO message(guid,text,date,is_from_me) VALUES(?,?,?,0)');insert.run('old','Old history',1);
let browser;
try {
  const request=async input=>{const response=await server.app.inject({method:'POST',url:'/phone-wall/api',headers:{authorization:`Bearer ${key}`},payload:input});assert.equal(response.statusCode,200,response.body);return response.json();};
  phones.forEach(phone=>phone.connect());await until(()=>phones.every(phone=>phone.welcome));
  const state=server.store.current();state.testTextSpeed=1000;state.layout.columns=1;state.layout.rows=2;
  state.layout.slots=phones.map((phone,index)=>({deviceId:phone.identity.deviceId,slotIndex:index,geometry:{x:0,y:index*667,width:375,height:667}}));
  await request({action:'configure',config:state,expectedRevision:state.revision});
  const capabilities=server.store.device(phones[0].identity.deviceId).capabilities;
  server.store.updateDevice(phones[0].identity.deviceId,{capabilities:{...capabilities,liveTicker:0}});
  const upgrade=await server.app.inject({url:'/phone-wall/api',method:'POST',headers:{authorization:`Bearer ${key}`},payload:{action:'live.start'}});
  assert.equal(upgrade.statusCode,400);assert.equal(server.ticker.enabled,false);
  server.store.updateDevice(phones[0].identity.deviceId,{capabilities});
  await request({action:'live.start'});await until(()=>phones.every(phone=>phone.activeArtwork?.release.definition.artworkId==='live-ticker'));
  browser=await firefox.launch({headless:true,...(process.env.PHONE_WALL_BROWSER_EXECUTABLE?{executablePath:process.env.PHONE_WALL_BROWSER_EXECUTABLE}:{})});
  const seen=new Map(),errors=[],external=[],pages=[];
  for(const phone of phones){
    const page=await browser.newPage({viewport:{width:375,height:667}});pages.push(page);
    page.on('pageerror',error=>errors.push(error.message));
    await page.exposeFunction('nativeTickerBridge',(type,payload)=>phone.ws.send(JSON.stringify(envelope(type,payload))));
    await page.addInitScript(()=>{window.PHONE_WALL_TICKER_BRIDGE=(type,payload)=>window.nativeTickerBridge(type,payload);});
    phone.on('ticker',snapshot=>{
      for(const run of snapshot.runs)seen.set(run.id,{seq:run.seq,row:run.row});
      page.evaluate(value=>window.PhoneWall?.receiveTicker?.(value),snapshot).catch(()=>{});
    });
    await page.route('**/*',route=>{if(!route.request().url().startsWith(base+'/')){external.push(route.request().url());return route.abort();}return route.continue();});
    const active=phone.activeArtwork,geometry=active.release.layout.slots.find(slot=>slot.deviceId===phone.identity.deviceId).geometry;
    const context={...active.release.definition,deviceId:phone.identity.deviceId,geometry,viewport:geometry,clockOffsetMs:0,startAtServerMs:active.startAtServerMs,playing:true,ticker:phone.ticker};
    await page.goto(base+`/artwork-preview/${active.releaseId}/index.html#`+encodeURIComponent(Buffer.from(JSON.stringify(context)).toString('base64')));
  }
  const reader=new MessagesReader({dbPath:join(directory,'chat.db'),sourceId:'browser-reader-0001',url:base,token:key});
  await reader.poll();
  for(let index=1;index<=3;index++)insert.run(`live-${index}`,'I',1);
  await reader.poll();await until(()=>server.ticker.status().completed===3);
  const order=[...seen.values()].sort((a,b)=>a.seq-b.seq);
  assert.deepEqual(order.map(run=>run.seq),[1,2,3]);assert.deepEqual(order.slice(0,2).map(run=>run.row),[0,1]);
  assert.equal(server.ticker.status().queued,0);
  await pages[0].reload();await pages[0].evaluate(value=>window.PhoneWall.receiveTicker(value),phones[0].ticker);insert.run('after-reconnect','I',1);await reader.poll();await until(()=>server.ticker.status().completed===4);
  await request({action:'live.pause'});insert.run('while-paused','I',1);await reader.poll();assert.equal(server.ticker.status().completed,4);
  await request({action:'live.start'});await reader.poll();await until(()=>server.ticker.status().completed===5);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS live flow: read-only iMessage fixture → durable FIFO → two actual web renderers via native bridge stand-in → row completion, reconnect, pause/catch-up; no WAN requests');
}finally{
  await browser?.close();phones.forEach(phone=>phone.stop());await server.app.close();source.close();await rm(directory,{recursive:true,force:true});
}
