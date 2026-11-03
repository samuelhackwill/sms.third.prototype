import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { LiveTicker,displayMessage } from '../live-ticker.mjs';

async function fixture(t,count=4){
  const directory=await mkdtemp(join(tmpdir(),'wall-fifo-')),store=new Store(join(directory,'controller.sqlite'));
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const ids=Array.from({length:count},(_,i)=>`phone-fixture-${i}`);
  ids.forEach(id=>store.register({deviceId:id,token:id+'x'.repeat(64),bootSessionId:'session-fixture-0001'}));
  const state=store.current();state.mode='exhibition';state.layout.rows=Math.ceil(count/2);state.layout.columns=2;
  state.layout.slots=ids.map((deviceId,index)=>({deviceId,slotIndex:index,geometry:{x:index%2*375,y:Math.floor(index/2)*667,width:375,height:667}}));store.commit(state,state.revision);
  const ticker=new LiveTicker(store);ticker.reader('reader-fixture-0001');
  ticker.ingest({sourceId:'reader-fixture-0001',databaseId:'a'.repeat(64),baseline:true,lastRowId:0});
  const ingest=(records,lastRowId=records.at(-1)?.rowId)=>ticker.ingest({sourceId:'reader-fixture-0001',databaseId:'a'.repeat(64),expectedRowId:ticker.source('reader-fixture-0001').row_id,lastRowId,records});
  return {store,ticker,ids,ingest};
}
test('FIFO dispatch fills free rows, waits for every phone, completes and frees only that row',async t=>{
  const {ticker,ids,ingest}=await fixture(t);ticker.start();
  ingest([1,2,3].map(rowId=>({rowId,id:`incoming-${rowId}`,text:`Message ${rowId}`})));
  ticker.tick(new Set(ids),true,1000);
  let runs=ticker.runs();assert.deepEqual(runs.map(run=>[run.seq,run.row]),[[1,0],[2,1]]);assert.equal(ticker.status().queued,1);
  const first=runs[0];ticker.acknowledge(ids[0],{type:'ticker.ready',runId:first.id,width:500},1000);
  assert.equal(ticker.acknowledge('foreign-device',{type:'ticker.ready',runId:first.id,width:500},1000),false);
  assert.equal(ticker.runs()[0].phase,'preparing');
  ticker.acknowledge(ids[1],{type:'ticker.ready',runId:first.id,width:600},1000);
  assert.equal(ticker.runs()[0].startAtServerMs,2000);
  assert.equal(ticker.acknowledge(ids[0],{type:'ticker.done',runId:first.id},2100),false);
  for(const id of first.targets)ticker.acknowledge(id,{type:'ticker.done',runId:first.id},10000);
  assert.equal(ticker.status().completed,1);
  ticker.tick(new Set(ids),true,10000);
  assert.deepEqual(ticker.runs().map(run=>[run.seq,run.row]),[[2,1],[3,0]]);
  assert.equal(ticker.acknowledge(ids[0],{type:'ticker.done',runId:first.id},10000),false);
});
test('offline rows do not block other rows; pause/restart/timeouts preserve unfinished messages',async t=>{
  const {ticker,store,ids,ingest}=await fixture(t);ticker.start();
  ingest([1,2].map(rowId=>({rowId,id:`incoming-${rowId}`,text:'Hello ❤️'})));
  ticker.tick(new Set(ids.slice(2)),true,1000);assert.equal(ticker.runs()[0].row,1);assert.equal(ticker.runs()[0].seq,1);
  ticker.pause();assert.equal(ticker.runs().length,0);assert.equal(ticker.status().queued,2);
  ticker.start();ticker.tick(new Set(ids),true,2000);const old=ticker.runs()[0].id;
  ticker.tick(new Set(ids),true,33000);assert.notEqual(ticker.runs()[0].id,old);
  const restarted=new LiveTicker(store);assert.equal(restarted.status().queued,2);assert.equal(restarted.enabled,true);
  restarted.tick(new Set(ids),false);assert.equal(restarted.runs().length,0);
});
test('reader polls without an operator start and a restart resumes message playback',async t=>{
  const {ticker,store,ingest}=await fixture(t);
  assert.equal(ticker.enabled,true);
  assert.equal(ticker.messagesEnabled,true);
  assert.equal(ingest([{rowId:1,id:'auto-message',text:'Automatic'}]).inserted,1);
  ticker.pause();
  assert.equal(ticker.messagesEnabled,true);
  const restarted=new LiveTicker(store);
  assert.equal(restarted.enabled,true);
  assert.equal(restarted.status().queued,1);
});
test('reader cursor and deduplication commit atomically, including skipped database rows',async t=>{
  const {ticker,ingest}=await fixture(t);
  assert.equal(ingest([{rowId:1,id:'guid-one',text:'First 🍆'}]).inserted,1);
  assert.equal(ingest([{rowId:2,id:'guid-one',text:'First 🍆'}],3).inserted,0);
  assert.equal(ticker.source('reader-fixture-0001').row_id,3);
  assert.throws(()=>ingest([{rowId:4,id:'guid-two',text:'Second'},{rowId:5,id:'guid-three',text:123}]),/invalid-message/);
  assert.equal(ticker.source('reader-fixture-0001').row_id,3);assert.equal(ticker.status().queued,1);
  assert.throws(()=>ticker.ingest({sourceId:'reader-fixture-0001',databaseId:'a'.repeat(64),expectedRowId:1,lastRowId:4,records:[]}),/cursor-conflict/);
  assert.equal(ingest([],7).cursor,7);
});
test('incoming display clamp preserves joined emoji and ignores attachment-only/invisible content',()=>{
  assert.equal(displayMessage('\uFFFC\n\u200d'),'');
  assert.equal(displayMessage('👩🏽‍🔧'.repeat(101)).endsWith('[...]'),true);
  assert.ok(displayMessage('👩🏽‍🔧'.repeat(101)).length<=500);
  assert.equal(displayMessage(' Hi\nthere ❤️ '),'Hi there ❤️');
});
test('queue capacity rejects the whole batch and does not advance the reader cursor',async t=>{
  const {ticker,store,ingest}=await fixture(t);
  store.transaction(()=>{const insert=store.db.prepare('INSERT INTO ticker_messages(external_id,text) VALUES(?,?)');for(let index=0;index<10000;index++)insert.run(`fixture-${index}`,'I');});
  assert.throws(()=>ingest([{rowId:1,id:'beyond-capacity',text:'Keep this in source'}]),/ticker-queue-capacity/);
  assert.equal(ticker.source('reader-fixture-0001').row_id,0);assert.equal(ticker.status().queued,10000);
});
test('Roland Barthes mode queues archived sentences at fast speeds and preserves incoming messages',async t=>{
  const {ticker,store,ids,ingest}=await fixture(t);
  ingest([{rowId:1,id:'saved-message',text:'Keep this message'}]);
  ticker.startBarthes();
  assert.equal(ticker.playbackMode,'barthes');
  assert.equal(ticker.status().queued,12);
  assert.match(store.db.prepare("SELECT text FROM ticker_messages WHERE source='barthes' ORDER BY seq LIMIT 1").get().text,/Comment est fait ce livre/);
  assert.equal(ticker.messagesEnabled,true);
  ticker.tick(new Set(ids),true,1000);
  const runs=ticker.runs();
  assert.equal(runs.length,2);
  assert.ok(runs.every(run=>run.speed>=1000&&run.speed<=6000));
  assert.equal(ticker.status().queued,12);
  assert.equal(store.db.prepare('SELECT barthes_cursor FROM ticker_settings WHERE id=1').get().barthes_cursor,14);
  const restarted=new LiveTicker(store);
  assert.equal(restarted.playbackMode,'barthes');
  assert.equal(restarted.status().queued,14);
  restarted.stopBarthes();
  assert.equal(restarted.enabled,false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source='barthes'").get().n,0);
  restarted.start();
  assert.equal(restarted.status().queued,1);
  assert.equal(restarted.messagesEnabled,true);
});
