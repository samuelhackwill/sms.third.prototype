import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const barthesFile=new URL('./public/artwork/barthes-sentences.ndjson',import.meta.url);
let barthesSentences;
function sentences() {
  if(!barthesSentences) {
    barthesSentences=readFileSync(barthesFile,'utf8').split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line)).map(record=>record.text?.trim()).filter(Boolean);
    if(!barthesSentences.length)throw new Error('barthes-source-empty');
  }
  return barthesSentences;
}
const barthesSpeed=()=>1000+Math.floor(Math.random()*5001);
export function displayMessage(text) {
  if(typeof text!=='string')throw new Error('invalid-message-text');
  const clean=text.replace(/[\r\n]+/g,' ').replace(/[\p{Cc}\uFFFC]/gu,'').trim();
  if(!clean.replace(/\p{Default_Ignorable_Code_Point}/gu,'').trim())return '';
  let result='';const parts=[...segmenter.segment(clean)];
  for(const {segment} of parts.slice(0,100)){if(result.length+segment.length>490)break;result+=segment;}
  return result.length<clean.length?result+'[...]':result;
}
export function liveRows(layout) {
  const groups=new Map();
  for(const slot of layout.slots){const row=Math.floor(slot.slotIndex/layout.columns);if(!groups.has(row))groups.set(row,[]);groups.get(row).push(slot);}
  return [...groups].sort(([a],[b])=>a-b).map(([row,slots])=>({row,targets:slots.map(s=>s.deviceId).sort(),left:Math.min(...slots.map(s=>s.geometry.x)),right:Math.max(...slots.map(s=>s.geometry.x+s.geometry.width)),top:Math.min(...slots.map(s=>s.geometry.y)),height:Math.min(...slots.map(s=>s.geometry.height))}));
}
export class LiveTicker {
  constructor(store) {
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ticker_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL);
      INSERT OR IGNORE INTO ticker_settings(id,enabled) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS ticker_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,external_id TEXT NOT NULL UNIQUE,text TEXT NOT NULL,received_at TEXT,status TEXT NOT NULL DEFAULT 'queued',run TEXT,completed_at INTEGER);
      CREATE INDEX IF NOT EXISTS ticker_waiting ON ticker_messages(status,seq);
      CREATE TABLE IF NOT EXISTS ticker_sources(id TEXT PRIMARY KEY,database_id TEXT,row_id INTEGER,status TEXT,last_seen INTEGER,error TEXT);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS router_seen(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS router_state(id INTEGER PRIMARY KEY CHECK(id=1),initialized INTEGER NOT NULL);
      INSERT OR IGNORE INTO router_state(id,initialized) VALUES(1,0);`);
    if(!this.db.prepare('PRAGMA table_info(router_state)').all().some(column=>column.name==='enabled'))this.db.exec('ALTER TABLE router_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(router_state)').all().some(column=>column.name==='detail_initialized'))this.db.exec('ALTER TABLE router_state ADD COLUMN detail_initialized INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(ticker_settings)').all().some(column=>column.name==='mode'))this.db.exec("ALTER TABLE ticker_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'messages'");
    if(!this.db.prepare('PRAGMA table_info(ticker_settings)').all().some(column=>column.name==='barthes_cursor'))this.db.exec('ALTER TABLE ticker_settings ADD COLUMN barthes_cursor INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(ticker_messages)').all().some(column=>column.name==='source'))this.db.exec("ALTER TABLE ticker_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'messages'");
    // Playback acknowledgments from a previous process cannot establish current readiness.
    this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE status IN ('preparing','playing')").run();
    this.db.prepare("UPDATE ticker_settings SET enabled=1 WHERE mode='messages'").run();
  }
  get enabled(){return this.db.prepare('SELECT enabled FROM ticker_settings WHERE id=1').get().enabled===1;}
  get playbackMode(){return this.db.prepare('SELECT mode FROM ticker_settings WHERE id=1').get().mode;}
  get messagesEnabled(){return this.db.prepare('SELECT enabled FROM router_state WHERE id=1').get().enabled===0;}
  enableRouter(){
    this.db.prepare('UPDATE router_state SET enabled=1 WHERE id=1').run();
    this.db.prepare("DELETE FROM ticker_messages WHERE source='messages' AND status!='completed'").run();
    this.db.prepare("UPDATE ticker_sources SET status='disabled',error=NULL").run();
  }
  ingestRouter(records,{detailed=false}={}){
    if(!Array.isArray(records)||records.length>10000)throw new Error('invalid-router-batch');
    return this.store.transaction(()=>{
      const routerState=this.db.prepare('SELECT initialized,detail_initialized FROM router_state WHERE id=1').get();
      const initialized=routerState.initialized===1;
      const detailBaseline=detailed&&routerState.detail_initialized===0;
      const latest=this.db.prepare("SELECT MAX(received_at) AS at FROM ticker_messages WHERE source='router'").get().at;
      const catchupAfter=latest?Date.parse(latest)-10*60*1000:null;
      const seen=this.db.prepare('INSERT OR IGNORE INTO router_seen(id) VALUES(?)');
      const insert=this.db.prepare("INSERT OR IGNORE INTO ticker_messages(external_id,text,received_at,source) VALUES(?,?,?,'router')");
      let inserted=0,baselined=0;
      for(const record of records){
        if(typeof record.id!=='string'||!record.id||record.id.length>512||typeof record.text!=='string')throw new Error('invalid-router-record');
        const id='tenda:'+record.id;
        if(!seen.run(id).changes)continue;
        if(!initialized||detailBaseline&&(!catchupAfter||!record.receivedAt||Date.parse(record.receivedAt)<catchupAfter)){baselined++;continue;}
        const message=displayMessage(record.text);
        if(message)inserted+=insert.run(id,message,typeof record.receivedAt==='string'?record.receivedAt.slice(0,40):null).changes;
      }
      if(!initialized)this.db.prepare('UPDATE router_state SET initialized=1 WHERE id=1').run();
      if(detailBaseline)this.db.prepare('UPDATE router_state SET detail_initialized=1 WHERE id=1').run();
      return {inserted,baselined,baseline:!initialized,detailBaseline};
    });
  }
  start(){this.requeue(true);this.db.prepare("UPDATE ticker_settings SET enabled=1,mode='messages' WHERE id=1").run();}
  startBarthes(){
    sentences();
    this.store.transaction(()=>{
      this.requeue(true);
      this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes'").run();
      this.db.prepare("UPDATE ticker_settings SET enabled=1,mode='barthes',barthes_cursor=0 WHERE id=1").run();
    });
    this.refillBarthes();
  }
  stopBarthes(){if(this.playbackMode==='barthes')this.store.transaction(()=>{this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes'").run();this.db.prepare("UPDATE ticker_settings SET enabled=0,mode='messages',barthes_cursor=0 WHERE id=1").run();});}
  pause(){this.db.prepare('UPDATE ticker_settings SET enabled=0 WHERE id=1').run();return this.requeue(true);}
  requeue(ambientOnly=false){return this.db.prepare(`UPDATE ticker_messages SET status='queued',run=NULL WHERE status IN ('preparing','playing') ${ambientOnly?"AND source!='router'":''}`).run().changes>0;}
  source(id){return this.db.prepare('SELECT * FROM ticker_sources WHERE id=?').get(id)??null;}
  reader(id,status='connected',error=null){this.db.prepare('INSERT INTO ticker_sources(id,status,last_seen,error) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,last_seen=excluded.last_seen,error=excluded.error').run(id,status,Date.now(),error);return {enabled:this.messagesEnabled,cursor:this.source(id)};}
  refillBarthes(){
    if(!this.enabled||this.playbackMode!=='barthes')return;
    const source=sentences();
    this.store.transaction(()=>{
      const queued=this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source='barthes' AND status='queued'").get().n;
      let cursor=this.db.prepare('SELECT barthes_cursor FROM ticker_settings WHERE id=1').get().barthes_cursor;
      const insert=this.db.prepare("INSERT INTO ticker_messages(external_id,text,source) VALUES(?,?,'barthes')");
      for(let i=queued;i<12;i++){
        insert.run(`barthes-${cursor}`,source[cursor%source.length]);cursor++;
      }
      this.db.prepare('UPDATE ticker_settings SET barthes_cursor=? WHERE id=1').run(cursor);
    });
  }
  ingest({sourceId,databaseId,expectedRowId,lastRowId,baseline=false,records=[]}) {
    if(!/^[a-f0-9]{64}$/.test(databaseId??'')||!Number.isSafeInteger(lastRowId)||lastRowId<0||!Array.isArray(records)||records.length>200)throw new Error('invalid-reader-batch');
    return this.store.transaction(()=>{
      const source=this.source(sourceId);
      if(baseline){
        if(records.length||source?.database_id===databaseId&&source.row_id!==null)throw new Error('invalid-reader-baseline');
      }else if(!source||source.database_id!==databaseId||source.row_id!==expectedRowId||lastRowId<expectedRowId)throw new Error('reader-cursor-conflict');
      let row=expectedRowId??0,inserted=0;
      const pending=this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source='messages' AND status IN ('queued','preparing','playing')").get().n;
      for(const record of records){
        if(!Number.isSafeInteger(record.rowId)||record.rowId<=row||record.rowId>lastRowId||typeof record.id!=='string'||!record.id||record.id.length>512)throw new Error('invalid-reader-record');
        row=record.rowId;const text=displayMessage(record.text);
        if(text)inserted+=this.db.prepare('INSERT OR IGNORE INTO ticker_messages(external_id,text,received_at) VALUES(?,?,?)').run(record.id,text,typeof record.receivedAt==='string'?record.receivedAt.slice(0,40):null).changes;
        if(pending+inserted>10000)throw new Error('ticker-queue-capacity');
      }
      this.db.prepare("INSERT INTO ticker_sources VALUES(?,?,?,'reading',?,NULL) ON CONFLICT(id) DO UPDATE SET database_id=excluded.database_id,row_id=excluded.row_id,status='reading',last_seen=excluded.last_seen,error=NULL").run(sourceId,databaseId,lastRowId,Date.now());
      return {inserted,cursor:lastRowId};
    });
  }
  runs(){return this.db.prepare("SELECT seq,text,source,run FROM ticker_messages WHERE status IN ('preparing','playing') ORDER BY seq").all().map(row=>({...JSON.parse(row.run),seq:row.seq,text:row.text,source:row.source}));}
  snapshot(deviceId){const runs=this.runs().filter(run=>run.targets.includes(deviceId));return {enabled:this.enabled||runs.some(run=>run.source==='router'),runs};}
  save(run,status){const {seq,text,...data}=run;this.db.prepare('UPDATE ticker_messages SET status=?,run=? WHERE seq=?').run(status,JSON.stringify(data),seq);}
  tick(ready,allowed=true,now=Date.now()) {
    if(this.enabled&&allowed)this.refillBarthes();
    const state=this.store.current(),rows=liveRows(state.layout);let changed=false;
    for(const run of this.runs()){
      const row=rows.find(row=>row.row===run.row);
      if(!row||JSON.stringify(row)!==JSON.stringify(run.band)||run.targets.some(id=>!ready.has(id))||now>=run.deadline||(run.source!=='router'&&(!this.enabled||!allowed))){
        this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE seq=?").run(run.seq);changed=true;
      }
    }
    let active=this.runs(),busy=new Set(active.map(run=>run.row));
    const urgent=this.db.prepare("SELECT seq FROM ticker_messages WHERE source='router' AND status='queued' ORDER BY seq DESC LIMIT 1").get();
    if(urgent){
      let band=rows.find(row=>!active.some(run=>run.row===row.row&&run.source==='router')&&row.targets.every(id=>ready.has(id)));
      if(!band&&!rows.some(row=>!active.some(run=>run.row===row.row&&run.source==='router'))){
        const oldest=active.filter(run=>run.source==='router'&&run.seq<urgent.seq&&run.targets.every(id=>ready.has(id))).sort((a,b)=>a.seq-b.seq)[0];
        band=rows.find(row=>row.row===oldest?.row);
      }
      if(band){
        const interrupted=active.find(run=>run.row===band.row);
        if(interrupted)this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE seq=?").run(interrupted.seq);
        this.save({seq:urgent.seq,id:randomUUID(),row:band.row,band,targets:band.targets,ready:{},done:[],phase:'preparing',speed:state.testTextSpeed??240,startAtServerMs:null,deadline:now+30000},'preparing');
        changed=true;active=this.runs();busy=new Set(active.map(run=>run.row));
      }
    }
    for(const band of rows){
      if(busy.has(band.row)||!band.targets.every(id=>ready.has(id)))continue;
      const message=this.db.prepare("SELECT seq,source FROM ticker_messages WHERE status='queued' AND (source='router' OR (source=? AND ?)) ORDER BY CASE WHEN source='router' THEN 0 ELSE 1 END,seq LIMIT 1").get(this.playbackMode,this.enabled&&allowed?1:0);
      if(!message)break;
      this.save({seq:message.seq,id:randomUUID(),row:band.row,band,targets:band.targets,ready:{},done:[],phase:'preparing',speed:message.source==='barthes'?barthesSpeed():state.testTextSpeed??240,startAtServerMs:null,deadline:now+30000},'preparing');
      busy.add(band.row);changed=true;
    }
    if(changed)this.refillBarthes();
    return changed;
  }
  acknowledge(deviceId,{type,runId,width},now=Date.now()) {
    const run=this.runs().find(run=>run.id===runId&&run.targets.includes(deviceId));
    if(!run)return false;
    if(type==='ticker.ready'&&run.phase==='preparing'){
      if(!Number.isFinite(width)||width<=0||width>1000000)throw new Error('invalid-ticker-width');
      run.ready[deviceId]=width;
      if(run.targets.every(id=>run.ready[id])){
        run.phase='playing';run.startAtServerMs=now+1000;
        run.deadline=run.startAtServerMs+(run.band.right-run.band.left+Math.max(...Object.values(run.ready)))/run.speed*1000+30000;
      }
      this.save(run,run.phase);return true;
    }
    if(type==='ticker.done'&&run.phase==='playing'){
      const earliest=run.startAtServerMs+(run.band.right-run.band.left+run.ready[deviceId])/run.speed*1000-500;
      if(now<earliest)return false;
      if(!run.done.includes(deviceId))run.done.push(deviceId);
      if(run.targets.every(id=>run.done.includes(id)))this.db.prepare("UPDATE ticker_messages SET status='completed',run=NULL,completed_at=? WHERE seq=?").run(now,run.seq);
      else this.save(run,'playing');
      return true;
    }
    return false;
  }
  status(){return {enabled:this.enabled,mode:this.playbackMode,queued:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source=? AND status='queued'").get(this.playbackMode).n,routerQueued:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source='router' AND status='queued'").get().n,routerSeen:this.db.prepare('SELECT COUNT(*) AS n FROM router_seen').get().n,routerMessages:this.db.prepare("SELECT status,COUNT(*) AS n FROM ticker_messages WHERE source='router' GROUP BY status").all(),active:this.runs(),completed:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source=? AND status='completed'").get(this.playbackMode).n,readers:this.db.prepare('SELECT * FROM ticker_sources').all()};}
}
