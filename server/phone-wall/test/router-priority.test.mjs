import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../store.mjs';
import { LiveTicker,routerBackground } from '../live-ticker.mjs';
import { parseTendaInbox,parseTendaConversation,TendaReader } from '../tenda-reader.mjs';

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

test('selected message rotation and color sweep stack independently',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wall-archive-replay-'));
  const store=new Store(join(dir,'controller.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const ids=Array.from({length:20},(_,i)=>`archive-phone-${i}`);
  ids.forEach(id=>store.register({deviceId:id,token:id+'x'.repeat(64),bootSessionId:'archive-replay-0001'}));
  const state=store.current();state.layout.rows=4;state.layout.columns=5;
  state.layout.slots=ids.map((deviceId,index)=>({deviceId,slotIndex:index,geometry:{x:index%5*375,y:Math.floor(index/5)*667,width:375,height:667}}));
  store.commit(state,state.revision);
  const ticker=new LiveTicker(store);
  store.db.prepare('INSERT INTO router_archive(external_id,sender,router_id,text,archived_at,deleted_at) VALUES(?,?,?,?,?,?)').run('tenda:0612345678:7','0612345678','7','Old SMS',Date.now()-180000,Date.now()-60000);
  store.db.prepare('INSERT INTO router_archive(external_id,sender,router_id,text,archived_at,deleted_at) VALUES(?,?,?,?,?,?)').run('tenda:0612349999:8','0612349999','8','Another old SMS',Date.now()-180000,Date.now()-60000);
  ticker.setSpeedRange('curated',300,300);ticker.setArchiveDensity(6);ticker.setArchiveReplay(true);ticker.setCuratedInjection(true);
  ticker.startCurated(['1234567890','']);ticker.tick(new Set(ids),true);
  assert.equal(ticker.runs().some(run=>run.source==='curated'),false);
  assert.equal(ticker.curatedMessages().filter(message=>message.source==='sms').length,2);
  ticker.toggleCurated('sms:tenda:0612345678:7');
  ticker.toggleCurated('sms:tenda:0612349999:8');
  ticker.tick(new Set(ids),true);
  const replay=ticker.runs().find(run=>run.source==='curated'&&run.text==='Old SMS');
  assert.ok([1,2,3].includes(replay?.row));
  assert.equal(replay?.text,'Old SMS');
  assert.equal(replay?.effect,'sms-sweep');
  assert.equal(replay?.backgroundColor,routerBackground('tenda:0612345678:7'));
  assert.equal(replay?.speed,300);
  assert.deepEqual(ticker.runs().filter(run=>run.source==='curated').map(run=>run.row).sort(),[1,2]);
  ticker.toggleCurated('sms:tenda:0612345678:7');
  ticker.tick(new Set(ids),true);
  assert.equal(ticker.runs().some(run=>run.source==='curated'&&run.text==='Old SMS'),false);
  ticker.setArchiveReplay(false);
  ticker.tick(new Set(ids),true);
  assert.equal(ticker.runs().find(run=>run.source==='curated')?.effect,undefined);
});

test('ten concurrent senders are archived fully before exact router messages are deleted',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wall-router-cleanup-'));
  const store=new Store(join(dir,'controller.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const ticker=new LiveTicker(store);ticker.enableRouter();ticker.ingestRouter([],{detailed:true});
  const notes=new Map(),records=[];
  for(let index=0;index<10;index++){
    const sender=`061234${String(index).padStart(4,'0')}`,note={id:index+1,time:1800000000,content:'L'.repeat(180),isSend:0};
    notes.set(sender,[note]);
    records.push(...parseTendaConversation(JSON.stringify({smsPhoneList:[note]}),sender));
  }
  assert.throws(()=>ticker.ingestRouter([...records,{id:null,text:'invalid'}],{detailed:true}),/invalid-router-record/);
  assert.equal(ticker.status().routerArchive.total,0);
  assert.equal(ticker.ingestRouter(records,{detailed:true}).inserted,10);
  store.db.prepare('UPDATE router_archive SET archived_at=?').run(Date.now()-121000);
  assert.equal(ticker.status().routerQueued,10);
  assert.equal(ticker.status().routerArchive.pending,10);
  assert.equal(store.db.prepare('SELECT text FROM router_archive LIMIT 1').get().text.length,180);
  assert.ok(store.db.prepare("SELECT text FROM ticker_messages WHERE source='router' LIMIT 1").get().text.length<180);
  const deleted=[];
  const reader=new TendaReader({config:{baseUrl:'http://example.invalid'},onRecords:()=>{},pendingDeletes:limit=>ticker.pendingRouterDeletes(limit),onDeleteAttempt:ids=>ticker.markRouterDeleteAttempt(ids),onDeleteConfirmed:ids=>ticker.markRouterDeleted(ids)});
  reader.cookies='test';
  reader.module=async({phone})=>JSON.stringify({smsPhoneList:notes.get(phone)??[]});
  reader.deleteMessages=async(sender,ids)=>{
    deleted.push({sender,ids});
    if(sender===records[0].sender)notes.get(sender).push({id:999,time:1800000001,content:'New during cleanup',isSend:0});
    notes.set(sender,notes.get(sender).filter(note=>!ids.includes(note.id)));
  };
  for(let index=0;index<10;index++){await reader.cleanup();clearTimeout(reader.deleteTimer);}
  reader.stop();
  assert.equal(deleted.length,10);
  assert.ok(deleted.every(batch=>batch.ids.length===1));
  assert.ok(deleted.every(batch=>typeof batch.ids[0]==='number'));
  assert.equal(ticker.status().routerArchive.deleted,10);
  assert.equal(ticker.status().routerQueued,10);
  assert.equal(notes.get(records[0].sender)[0].id,999);
});

test('router success response does not count as deleted while the message remains',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wall-router-confirm-'));
  const store=new Store(join(dir,'controller.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const ticker=new LiveTicker(store);ticker.enableRouter();ticker.ingestRouter([],{detailed:true});
  const sender='0612345678',note={id:5,time:1800000000,content:'Still there',isSend:0};
  ticker.ingestRouter(parseTendaConversation(JSON.stringify({smsPhoneList:[note]}),sender),{detailed:true});
  store.db.prepare('UPDATE router_archive SET archived_at=?').run(Date.now()-121000);
  const reader=new TendaReader({config:{baseUrl:'http://example.invalid'},onRecords:()=>{},pendingDeletes:limit=>ticker.pendingRouterDeletes(limit),onDeleteAttempt:ids=>ticker.markRouterDeleteAttempt(ids),onDeleteConfirmed:ids=>ticker.markRouterDeleted(ids)});
  reader.cookies='test';reader.module=async()=>JSON.stringify({smsPhoneList:[note]});reader.deleteMessages=async()=>{};
  await reader.cleanup();reader.stop();
  assert.equal(ticker.status().routerArchive.pending,1);
  assert.equal(ticker.status().routerArchive.deleted,0);
  assert.equal(reader.deleteError,'router-delete-unconfirmed');
});

test('a new text in an old thread is archived before cleanup and blocks deletion',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wall-router-race-'));
  const store=new Store(join(dir,'controller.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const ticker=new LiveTicker(store);ticker.enableRouter();ticker.ingestRouter([],{detailed:true});
  const sender='0612345678',first={id:5,time:1800000000,content:'First',isSend:0},second={id:6,time:1800000001,content:'Second',isSend:0};
  ticker.ingestRouter(parseTendaConversation(JSON.stringify({smsPhoneList:[first]}),sender),{detailed:true});
  store.db.prepare('UPDATE router_archive SET archived_at=?').run(Date.now()-121000);
  const reader=new TendaReader({config:{baseUrl:'http://example.invalid'},onRecords:records=>ticker.ingestRouter(records,{detailed:true}),pendingDeletes:limit=>ticker.pendingRouterDeletes(limit),onDeleteAttempt:ids=>ticker.markRouterDeleteAttempt(ids),onDeleteConfirmed:ids=>ticker.markRouterDeleted(ids)});
  reader.cookies='test';reader.module=async()=>JSON.stringify({smsPhoneList:[first,second]});
  let deletes=0;reader.deleteMessages=async()=>{deletes++;};
  await reader.cleanup();reader.stop();
  assert.equal(deletes,0);
  assert.equal(ticker.status().routerArchive.total,2);
  assert.equal(ticker.status().routerArchive.deleted,0);
  assert.equal(ticker.status().routerMessages.find(row=>row.status==='queued')?.n,2);
});

test('a reused router ID with different content becomes a new message',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wall-router-id-'));
  const store=new Store(join(dir,'controller.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const ticker=new LiveTicker(store);ticker.enableRouter();ticker.ingestRouter([],{detailed:true});
  const sender='0612345678';
  const first=parseTendaConversation(JSON.stringify({smsPhoneList:[{id:5,time:1800000000,content:'First',isSend:0}]}),sender);
  const second=parseTendaConversation(JSON.stringify({smsPhoneList:[{id:5,time:1800000001,content:'Second',isSend:0}]}),sender);
  assert.equal(ticker.ingestRouter(first,{detailed:true}).inserted,1);
  assert.equal(ticker.ingestRouter(second,{detailed:true}).inserted,1);
  assert.equal(ticker.ingestRouter(second,{detailed:true}).inserted,0);
  assert.equal(ticker.status().routerArchive.total,2);
});

test('router delete uses the per-message request from the Tenda web UI',async t=>{
  let request;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    request={method:req.method,path:req.url,body:JSON.parse(body)};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({errCode:0}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const reader=new TendaReader({config:{baseUrl:`http://127.0.0.1:${server.address().port}`},onRecords:()=>{}});
  reader.cookies='test';
  await reader.deleteMessages('0612345678',[12,13]);
  assert.deepEqual(request,{method:'POST',path:'/goform/setModules',body:{delSmsList:{phone:'0612345678',idList:[12,13]}}});
});

test('router baseline stays silent; new SMS waits for Barthes and plays before ambient text resumes',async t=>{
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
  const ambient=ticker.runs().find(run=>run.row===0);
  assert.equal(ticker.ingestRouter([{id:'old',text:'Already in router'},{id:'0612345678:new',text:'New SMS'}]).inserted,1);
  ticker.tick(new Set(ids),true,2000);
  assert.equal(ticker.runs().find(run=>run.row===0).id,ambient.id);
  assert.equal(ticker.status().routerQueued,1);
  for(const id of ambient.targets)ticker.acknowledge(id,{type:'ticker.ready',runId:ambient.id,width:300},3000);
  for(const id of ambient.targets)ticker.acknowledge(id,{type:'ticker.done',runId:ambient.id},10000);
  ticker.tick(new Set(ids),true,11000);
  assert.equal(ticker.runs().find(run=>run.source==='router').row,0);
  assert.equal(ticker.runs().find(run=>run.source==='router').backgroundColor,routerBackground('tenda:0612345678:new'));
  assert.equal(ticker.snapshot(ids[0]).runs[0].text,'New SMS');
  ticker.pause();ticker.tick(new Set(ids),false,12000);
  assert.equal(ticker.runs().filter(run=>run.source==='barthes').length,0);
  assert.equal(ticker.runs().find(run=>run.source==='router').text,'New SMS');
  assert.equal(ticker.ingestRouter([{id:'newer',text:'Second SMS'}]).inserted,1);
  ticker.tick(new Set(ids),false,13000);
  assert.equal(ticker.snapshot(ids[0]).enabled,true);
  assert.equal(ticker.status().routerQueued,1);
  assert.equal(ticker.runs().some(run=>run.source==='router'&&run.text==='Second SMS'),false);
  ticker.tick(new Set(ids),true,14000);
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
  ticker.ingestRouter([{id:'third',text:'Third'}]);
  ticker.tick(new Set(ids),true,2000);
  assert.equal(ticker.runs()[0].id,first.id);
  assert.equal(ticker.status().routerQueued,2);
  for(const id of ids)ticker.acknowledge(id,{type:'ticker.ready',runId:first.id,width:100},3000);
  for(const id of ids)ticker.acknowledge(id,{type:'ticker.done',runId:first.id},100000);
  ticker.tick(new Set(ids),true,100000);
  assert.equal(ticker.runs()[0].text,'Second');
  const second=ticker.runs()[0];
  for(const id of ids)ticker.acknowledge(id,{type:'ticker.ready',runId:second.id,width:100},101000);
  for(const id of ids)ticker.acknowledge(id,{type:'ticker.done',runId:second.id},200000);
  ticker.tick(new Set(ids),true,200000);
  assert.equal(ticker.runs()[0].text,'Third');
});
