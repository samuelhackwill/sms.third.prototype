import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { LiveTicker,routerBackground } from '../live-ticker.mjs';
import { parseTendaInbox,parseTendaConversation } from '../tenda-reader.mjs';

test('router parser includes every incoming note and skips sent notes',()=>{
  const records=parseTendaInbox(JSON.stringify({smsList:{phoneList:[{phone:'123',note:[{id:3,time:30,content:'Third',isSend:false},{id:2,time:20,content:'Second',isSend:0},{id:1,time:10,content:'Sent',isSend:true}]}]}}));
  assert.deepEqual(records.map(record=>record.text),['Second','Third']);
  const detail=parseTendaConversation(JSON.stringify({smsPhoneList:[{id:1,time:10,content:'First',isSend:0},{id:2,time:20,content:'Second',isSend:0},{id:3,time:30,content:'Sent',isSend:1}]}),'123');
  assert.deepEqual(detail.map(record=>record.text),['First','Second']);
});

test('SMS background depends on the sender’s last four digits and stays dark',()=>{
  assert.equal(routerBackground('tenda:0612345678:one'),routerBackground('tenda:+33 6 12 34 56 78:two'));
  assert.notEqual(routerBackground('tenda:0612345678:one'),routerBackground('tenda:0612345679:one'));
  for(const suffix of ['0000','5678','9999']){
    const color=routerBackground(`tenda:06${suffix}:one`);
    assert.match(color,/^hsl\(\d{1,3}, \d{2}%, (1\d|2[01])%\)$/);
  }
});

test('router baseline stays silent; new SMS interrupts Barthes and plays while ambient ticker is paused',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wall-router-'));
  const store=new Store(join(dir,'controller.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const ids=Array.from({length:4},(_,i)=>`router-phone-${i}`);
  ids.forEach(id=>store.register({deviceId:id,token:id+'x'.repeat(64),bootSessionId:'router-fixture-0001'}));
  const state=store.current();state.mode='exhibition';state.layout.rows=2;state.layout.columns=2;
  state.layout.slots=ids.map((deviceId,index)=>({deviceId,slotIndex:index,geometry:{x:index%2*375,y:Math.floor(index/2)*667,width:375,height:667}}));
  store.commit(state,state.revision);
  const ticker=new LiveTicker(store);
  ticker.enableRouter();
  assert.equal(ticker.messagesEnabled,false);
  assert.equal(ticker.ingestRouter([{id:'old',text:'Already in router'}]).inserted,0);
  ticker.startBarthes();ticker.tick(new Set(ids),true,1000);
  assert.equal(ticker.runs().filter(run=>run.source==='barthes').length,2);
  assert.equal(ticker.ingestRouter([{id:'old',text:'Already in router'},{id:'0612345678:new',text:'New SMS'}]).inserted,1);
  ticker.tick(new Set(ids),true,2000);
  assert.equal(ticker.runs().find(run=>run.source==='router').row,0);
  assert.equal(ticker.runs().find(run=>run.source==='router').backgroundColor,routerBackground('tenda:0612345678:new'));
  assert.equal(ticker.snapshot(ids[0]).runs[0].text,'New SMS');
  ticker.pause();ticker.tick(new Set(ids),false,3000);
  assert.equal(ticker.runs().filter(run=>run.source==='barthes').length,0);
  assert.equal(ticker.runs().find(run=>run.source==='router').text,'New SMS');
  assert.equal(ticker.ingestRouter([{id:'newer',text:'Second SMS'}]).inserted,1);
  ticker.tick(new Set(ids),false,4000);
  assert.equal(ticker.snapshot(ids[0]).enabled,true);
  assert.ok(ticker.runs().some(run=>run.source==='router'&&run.text==='Second SMS'));
  const now=Date.now();
  ticker.ingestRouter([{id:'dated',text:'Recent',receivedAt:new Date(now).toISOString()}]);
  const catchup=ticker.ingestRouter([
    {id:'historical',text:'Old history',receivedAt:new Date(now-60*60*1000).toISOString()},
    {id:'missed',text:'Missed in same conversation',receivedAt:new Date(now-2*60*1000).toISOString()},
  ],{detailed:true});
  assert.equal(catchup.inserted,1);
  assert.equal(catchup.baselined,1);
  assert.equal(ticker.ingestRouter([{id:'missed',text:'Missed in same conversation'}],{detailed:true}).inserted,0);
});

test('new SMS waits when every row already shows SMS, so the first message is not restarted',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wall-router-repeat-'));
  const store=new Store(join(dir,'controller.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const ids=['sms-phone-0','sms-phone-1'];
  ids.forEach(id=>store.register({deviceId:id,token:id+'x'.repeat(64),bootSessionId:'router-fixture-0002'}));
  const state=store.current();state.mode='exhibition';state.layout.rows=1;state.layout.columns=2;
  state.layout.slots=ids.map((deviceId,index)=>({deviceId,slotIndex:index,geometry:{x:index*375,y:0,width:375,height:667}}));
  store.commit(state,state.revision);
  const ticker=new LiveTicker(store);ticker.enableRouter();ticker.ingestRouter([]);
  ticker.ingestRouter([{id:'first',text:'First'}]);
  ticker.tick(new Set(ids),true,1000);
  const first=ticker.runs()[0];
  ticker.ingestRouter([{id:'second',text:'Second'}]);
  ticker.tick(new Set(ids),true,2000);
  assert.equal(ticker.runs()[0].id,first.id);
  assert.equal(ticker.status().routerQueued,1);
  for(const id of ids)ticker.acknowledge(id,{type:'ticker.ready',runId:first.id,width:100},3000);
  for(const id of ids)ticker.acknowledge(id,{type:'ticker.done',runId:first.id},100000);
  ticker.tick(new Set(ids),true,100000);
  assert.equal(ticker.runs()[0].text,'Second');
});
