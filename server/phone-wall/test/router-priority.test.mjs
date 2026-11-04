import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { LiveTicker } from '../live-ticker.mjs';
import { parseTendaInbox } from '../tenda-reader.mjs';

test('router parser includes every incoming note and skips sent notes',()=>{
  const records=parseTendaInbox(JSON.stringify({smsList:{phoneList:[{phone:'123',note:[{id:3,time:30,content:'Third',isSend:false},{id:2,time:20,content:'Second',isSend:0},{id:1,time:10,content:'Sent',isSend:true}]}]}}));
  assert.deepEqual(records.map(record=>record.text),['Second','Third']);
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
  assert.deepEqual(ticker.ingestRouter([{id:'old',text:'Already in router'}]),{inserted:0,baseline:true});
  ticker.startBarthes();ticker.tick(new Set(ids),true,1000);
  assert.equal(ticker.runs().filter(run=>run.source==='barthes').length,2);
  assert.equal(ticker.ingestRouter([{id:'old',text:'Already in router'},{id:'new',text:'New SMS'}]).inserted,1);
  ticker.tick(new Set(ids),true,2000);
  assert.equal(ticker.runs().find(run=>run.source==='router').row,0);
  assert.equal(ticker.snapshot(ids[0]).runs[0].text,'New SMS');
  ticker.pause();ticker.tick(new Set(ids),false,3000);
  assert.equal(ticker.runs().filter(run=>run.source==='barthes').length,0);
  assert.equal(ticker.runs().find(run=>run.source==='router').text,'New SMS');
  assert.equal(ticker.ingestRouter([{id:'newer',text:'Second SMS'}]).inserted,1);
  ticker.tick(new Set(ids),false,4000);
  assert.equal(ticker.snapshot(ids[0]).enabled,true);
  assert.ok(ticker.runs().some(run=>run.source==='router'&&run.text==='Second SMS'));
});
