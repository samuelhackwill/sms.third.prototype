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
export function routerBackground(externalId){
  const sender=String(externalId).replace(/^tenda:/,'').split(':')[0];
  const seed=Number(sender.replace(/\D/g,'').slice(-4).padStart(4,'0'));
  return `hsl(${seed*137%360}, ${45+seed%16}%, ${14+Math.floor(seed/16)%8}%)`;
}
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
      INSERT OR IGNORE INTO router_state(id,initialized) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS router_archive(external_id TEXT PRIMARY KEY,sender TEXT NOT NULL,router_id TEXT,text TEXT NOT NULL,received_at TEXT,archived_at INTEGER NOT NULL,delete_attempt_at INTEGER,deleted_at INTEGER);
      CREATE INDEX IF NOT EXISTS router_archive_pending ON router_archive(deleted_at,delete_attempt_at,archived_at);
      CREATE TABLE IF NOT EXISTS curated_messages(id TEXT PRIMARY KEY,text TEXT NOT NULL,received_at TEXT,selected INTEGER NOT NULL DEFAULT 0);`);
    if(!this.db.prepare('PRAGMA table_info(curated_messages)').all().some(column=>column.name==='selected'))this.db.exec('ALTER TABLE curated_messages ADD COLUMN selected INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(router_state)').all().some(column=>column.name==='enabled'))this.db.exec('ALTER TABLE router_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(router_state)').all().some(column=>column.name==='detail_initialized'))this.db.exec('ALTER TABLE router_state ADD COLUMN detail_initialized INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(ticker_settings)').all().some(column=>column.name==='mode'))this.db.exec("ALTER TABLE ticker_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'messages'");
    if(!this.db.prepare('PRAGMA table_info(ticker_settings)').all().some(column=>column.name==='barthes_cursor'))this.db.exec('ALTER TABLE ticker_settings ADD COLUMN barthes_cursor INTEGER NOT NULL DEFAULT 0');
    for(const [name,definition] of [['custom_a',"TEXT NOT NULL DEFAULT ''"],['custom_b',"TEXT NOT NULL DEFAULT ''"],['curated_next_at','INTEGER NOT NULL DEFAULT 0'],['curated_injection_enabled','INTEGER NOT NULL DEFAULT 0'],['curated_second_enabled','INTEGER NOT NULL DEFAULT 0']])if(!this.db.prepare('PRAGMA table_info(ticker_settings)').all().some(column=>column.name===name))this.db.exec(`ALTER TABLE ticker_settings ADD COLUMN ${name} ${definition}`);
    if(!this.db.prepare('PRAGMA table_info(ticker_messages)').all().some(column=>column.name==='source'))this.db.exec("ALTER TABLE ticker_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'messages'");
    if(!this.db.prepare('PRAGMA table_info(ticker_messages)').all().some(column=>column.name==='target_row'))this.db.exec('ALTER TABLE ticker_messages ADD COLUMN target_row INTEGER');
    this.db.prepare("DELETE FROM ticker_messages WHERE source='curated-click'").run();
    // Playback acknowledgments from a previous process cannot establish current readiness.
    this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE status IN ('preparing','playing')").run();
    if(!this.curatedInjectionEnabled)this.db.prepare("DELETE FROM ticker_messages WHERE source='curated' AND status!='completed'").run();
    if(!this.curatedSecondEnabled)this.db.prepare("DELETE FROM ticker_messages WHERE source='custom' AND target_row=1 AND status!='completed'").run();
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
      const archive=this.db.prepare('INSERT OR IGNORE INTO router_archive(external_id,sender,router_id,text,received_at,archived_at) VALUES(?,?,?,?,?,?)');
      const stillOnRouter=this.db.prepare('UPDATE router_archive SET deleted_at=NULL,delete_attempt_at=NULL WHERE external_id=? AND deleted_at IS NOT NULL AND deleted_at<?');
      const insert=this.db.prepare("INSERT OR IGNORE INTO ticker_messages(external_id,text,received_at,source) VALUES(?,?,?,'router')");
      let inserted=0,baselined=0;
      for(const record of records){
        if(typeof record.id!=='string'||!record.id||record.id.length>512||typeof record.text!=='string')throw new Error('invalid-router-record');
        const id='tenda:'+record.id;
        const sender=typeof record.sender==='string'?record.sender:record.id.split(':')[0];
        const routerId=record.routerId==null?null:String(record.routerId);
        const receivedAt=typeof record.receivedAt==='string'?record.receivedAt.slice(0,40):null;
        archive.run(id,sender,routerId,record.text,receivedAt,Date.now());
        stillOnRouter.run(id,Date.now()-30000);
        if(!seen.run(id).changes)continue;
        if(!initialized||detailBaseline&&(!catchupAfter||!record.receivedAt||Date.parse(record.receivedAt)<catchupAfter)){baselined++;continue;}
        const message=displayMessage(record.text);
        if(message)inserted+=insert.run(id,message,receivedAt).changes;
      }
      if(!initialized)this.db.prepare('UPDATE router_state SET initialized=1 WHERE id=1').run();
      if(detailBaseline)this.db.prepare('UPDATE router_state SET detail_initialized=1 WHERE id=1').run();
      return {inserted,baselined,baseline:!initialized,detailBaseline};
    });
  }
  pendingRouterDeletes(limit=100){return this.db.prepare('SELECT external_id AS externalId,sender,router_id AS routerId,text,received_at AS receivedAt FROM router_archive WHERE router_id IS NOT NULL AND deleted_at IS NULL AND (delete_attempt_at IS NULL OR delete_attempt_at<?) ORDER BY archived_at LIMIT ?').all(Date.now()-15000,limit);}
  markRouterDeleteAttempt(ids){const update=this.db.prepare('UPDATE router_archive SET delete_attempt_at=? WHERE external_id=? AND deleted_at IS NULL');this.store.transaction(()=>{for(const id of ids)update.run(Date.now(),id);});}
  markRouterDeleted(ids){const update=this.db.prepare('UPDATE router_archive SET deleted_at=? WHERE external_id=? AND deleted_at IS NULL');this.store.transaction(()=>{for(const id of ids)update.run(Date.now(),id);});}
  start(){this.requeue(true);this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes' OR source IN ('custom','curated','curated-click') AND status!='completed'").run();this.db.prepare("UPDATE ticker_settings SET enabled=1,mode='messages' WHERE id=1").run();}
  get customTexts(){const row=this.db.prepare('SELECT custom_a,custom_b FROM ticker_settings WHERE id=1').get();return [row.custom_a,row.custom_b];}
  get curatedInjectionEnabled(){return this.db.prepare('SELECT curated_injection_enabled FROM ticker_settings WHERE id=1').get().curated_injection_enabled===1;}
  get curatedSecondEnabled(){return this.db.prepare('SELECT curated_second_enabled FROM ticker_settings WHERE id=1').get().curated_second_enabled===1;}
  isCuratedPriorityRow(row){return this.playbackMode==='curated'&&(row===0||row===1&&this.curatedSecondEnabled);}
  setCuratedSecond(enabled){
    if(typeof enabled!=='boolean')throw new Error('invalid-curated-second-setting');
    this.store.transaction(()=>{
      this.db.prepare('UPDATE ticker_settings SET curated_second_enabled=? WHERE id=1').run(enabled?1:0);
      if(!enabled)this.db.prepare("DELETE FROM ticker_messages WHERE source='custom' AND target_row=1 AND status!='completed'").run();
      if(enabled&&this.playbackMode==='curated')for(const run of this.runs().filter(run=>run.source==='router'&&run.row===1))this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE seq=?").run(run.seq);
    });
    return this.curatedSecondEnabled;
  }
  setCuratedInjection(enabled){
    if(typeof enabled!=='boolean')throw new Error('invalid-curated-injection-setting');
    this.store.transaction(()=>{
      this.db.prepare('UPDATE ticker_settings SET curated_injection_enabled=?,curated_next_at=? WHERE id=1').run(enabled?1:0,Date.now());
      if(!enabled)this.db.prepare("DELETE FROM ticker_messages WHERE source='curated' AND status!='completed'").run();
    });
    return this.curatedInjectionEnabled;
  }
  startCurated(texts=this.customTexts){
    if(!Array.isArray(texts)||texts.length!==2||texts.some(text=>typeof text!=='string'||text.length>500))throw new Error('invalid-custom-messages');
    const clean=texts.map(text=>displayMessage(text));
    this.store.transaction(()=>{
      this.requeue(true);
      this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes' OR source IN ('custom','curated','curated-click') AND status!='completed'").run();
      this.db.prepare("UPDATE ticker_settings SET enabled=1,mode='curated',custom_a=?,custom_b=?,curated_next_at=? WHERE id=1").run(...clean,Date.now()+20000);
    });
  }
  setCuratedTexts(texts){
    if(this.playbackMode!=='curated'||!this.enabled)throw new Error('curated-mode-not-running');
    if(!Array.isArray(texts)||texts.length!==2||texts.some(text=>typeof text!=='string'||text.length>500))throw new Error('invalid-custom-messages');
    const clean=texts.map(text=>displayMessage(text));
    this.store.transaction(()=>{
      this.db.prepare('UPDATE ticker_settings SET custom_a=?,custom_b=? WHERE id=1').run(...clean);
      this.db.prepare("DELETE FROM ticker_messages WHERE source='custom' AND status!='completed'").run();
    });
    return this.customTexts;
  }
  stopCurated(){
    this.db.prepare("DELETE FROM ticker_messages WHERE source IN ('custom','curated','curated-click') AND status!='completed'").run();
    this.db.prepare("UPDATE ticker_settings SET enabled=0,mode='messages' WHERE id=1").run();
  }
  importCurated(records){
    if(!Array.isArray(records)||records.length>100)throw new Error('invalid-curated-batch');
    return this.store.transaction(()=>{
      const insert=this.db.prepare('INSERT OR IGNORE INTO curated_messages(id,text,received_at) VALUES(?,?,?)');
      let inserted=0;
      for(const record of records){
        if(typeof record.id!=='string'||!record.id||record.id.length>512||typeof record.text!=='string')throw new Error('invalid-curated-record');
        const text=displayMessage(record.text);
        if(text)inserted+=insert.run(record.id,text,typeof record.receivedAt==='string'?record.receivedAt.slice(0,40):null).changes;
      }
      return {inserted};
    });
  }
  curatedMessages(){return this.db.prepare('SELECT id,text,received_at AS receivedAt,selected FROM curated_messages ORDER BY received_at DESC,id DESC LIMIT 2000').all();}
  toggleCurated(id){
    if(typeof id!=='string'||!id||id.length>512)throw new Error('invalid-curated-id');
    if(!this.db.prepare('UPDATE curated_messages SET selected=1-selected WHERE id=?').run(id).changes)throw new Error('unknown-curated-message');
    return this.db.prepare('SELECT selected FROM curated_messages WHERE id=?').get(id).selected===1;
  }
  startBarthes(){
    sentences();
    this.store.transaction(()=>{
      this.requeue(true);
      this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes' OR source IN ('custom','curated','curated-click') AND status!='completed'").run();
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
  refillCurated(now=Date.now()){
    if(!this.enabled||this.playbackMode!=='curated')return;
    const rows=liveRows(this.store.current().layout).slice(0,2);
    const settings=this.db.prepare('SELECT custom_a,custom_b,curated_next_at,curated_injection_enabled FROM ticker_settings WHERE id=1').get();
    const insert=this.db.prepare('INSERT INTO ticker_messages(external_id,text,source,target_row) VALUES(?,?,?,?)');
    for(const band of rows){
      if(band.row===1&&!this.curatedSecondEnabled)continue;
      const text=band.row===0?settings.custom_a:settings.custom_b;
      if(!text||this.db.prepare("SELECT 1 FROM ticker_messages WHERE source='custom' AND target_row=? AND status IN ('queued','preparing','playing') LIMIT 1").get(band.row))continue;
      insert.run('custom:'+randomUUID(),text,'custom',band.row);
    }
    if(settings.curated_injection_enabled&&now>=settings.curated_next_at){
      const waiting=this.db.prepare("SELECT 1 FROM ticker_messages WHERE source='curated' AND status IN ('queued','preparing','playing') LIMIT 1").get();
      const message=this.db.prepare('SELECT text FROM curated_messages WHERE selected=1 ORDER BY RANDOM() LIMIT 1').get();
      if(message&&!waiting)insert.run('curated:'+randomUUID(),message.text,'curated',null);
      this.db.prepare('UPDATE ticker_settings SET curated_next_at=? WHERE id=1').run(now+20000+Math.floor(Math.random()*15000));
    }
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
    if(this.enabled&&allowed)this.refillCurated(now);
    const state=this.store.current(),rows=liveRows(state.layout);let changed=false;
    for(const run of this.runs()){
      const row=rows.find(row=>row.row===run.row);
      if(!row||JSON.stringify(row)!==JSON.stringify(run.band)||run.targets.some(id=>!ready.has(id))||now>=run.deadline||run.source==='router'&&this.isCuratedPriorityRow(run.row)||(run.source!=='router'&&(!this.enabled||!allowed))){
        this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE seq=?").run(run.seq);changed=true;
      }
    }
    let active=this.runs(),busy=new Set(active.map(run=>run.row));
    const urgent=this.db.prepare("SELECT seq,external_id FROM ticker_messages WHERE source='router' AND status='queued' ORDER BY seq DESC LIMIT 1").get();
    if(urgent){
      const band=rows.find(row=>!this.isCuratedPriorityRow(row.row)&&!active.some(run=>run.row===row.row&&run.source==='router')&&row.targets.every(id=>ready.has(id)));
      if(band){
        const interrupted=active.find(run=>run.row===band.row);
        if(interrupted)this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE seq=?").run(interrupted.seq);
        this.save({seq:urgent.seq,id:randomUUID(),row:band.row,band,targets:band.targets,ready:{},done:[],phase:'preparing',effect:this.playbackMode==='curated'?'sms-sweep':undefined,backgroundColor:routerBackground(urgent.external_id),speed:state.testTextSpeed??240,startAtServerMs:null,deadline:now+30000},'preparing');
        changed=true;active=this.runs();busy=new Set(active.map(run=>run.row));
      }
    }
    if(this.enabled&&allowed&&this.playbackMode==='curated'&&this.curatedInjectionEnabled){
      for(let index=0;index<2;index++){
        const message=this.db.prepare("SELECT seq,source FROM ticker_messages WHERE source='curated' AND status='queued' ORDER BY seq LIMIT 1").get();
        if(!message)break;
        const band=rows.find(row=>row.row>=2&&row.targets.every(id=>ready.has(id))&&!active.some(run=>run.row===row.row&&(run.source==='router'||run.source==='curated')));
        if(!band)break;
        const interrupted=active.find(run=>run.row===band.row);
        if(interrupted)this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE seq=?").run(interrupted.seq);
        this.save({seq:message.seq,id:randomUUID(),row:band.row,band,targets:band.targets,ready:{},done:[],phase:'preparing',speed:state.testTextSpeed??240,startAtServerMs:null,deadline:now+30000},'preparing');
        changed=true;active=this.runs();busy=new Set(active.map(run=>run.row));
      }
    }
    for(const band of rows){
      if(busy.has(band.row)||!band.targets.every(id=>ready.has(id)))continue;
      if(this.playbackMode==='curated'){
        if(band.row>1||band.row===1&&!this.curatedSecondEnabled||!this.enabled||!allowed)continue;
        const message=this.db.prepare("SELECT seq FROM ticker_messages WHERE source='custom' AND target_row=? AND status='queued' ORDER BY seq LIMIT 1").get(band.row);
        if(!message)continue;
        this.save({seq:message.seq,id:randomUUID(),row:band.row,band,targets:band.targets,ready:{},done:[],phase:'preparing',effect:band.row===0?'flash':undefined,speed:state.testTextSpeed??240,startAtServerMs:null,deadline:now+30000},'preparing');
        busy.add(band.row);changed=true;continue;
      }
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
        run.deadline=run.effect==='flash'?Number.MAX_SAFE_INTEGER:run.startAtServerMs+(run.band.right-run.band.left+Math.max(...Object.values(run.ready)))/run.speed*1000+30000;
      }
      this.save(run,run.phase);return true;
    }
    if(type==='ticker.done'&&run.phase==='playing'&&run.effect!=='flash'){
      const earliest=run.startAtServerMs+(run.band.right-run.band.left+run.ready[deviceId])/run.speed*1000-500;
      if(now<earliest)return false;
      if(!run.done.includes(deviceId))run.done.push(deviceId);
      if(run.targets.every(id=>run.done.includes(id))){
        if(['custom','curated','curated-click'].includes(run.source))this.db.prepare('DELETE FROM ticker_messages WHERE seq=?').run(run.seq);
        else this.db.prepare("UPDATE ticker_messages SET status='completed',run=NULL,completed_at=? WHERE seq=?").run(now,run.seq);
      }
      else this.save(run,'playing');
      return true;
    }
    return false;
  }
  status(){return {enabled:this.enabled,mode:this.playbackMode,customTexts:this.customTexts,curatedSecondEnabled:this.curatedSecondEnabled,curatedInjectionEnabled:this.curatedInjectionEnabled,curatedCount:this.db.prepare('SELECT COUNT(*) AS n FROM curated_messages').get().n,curatedSelected:this.db.prepare('SELECT COUNT(*) AS n FROM curated_messages WHERE selected=1').get().n,queued:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE status='queued' AND (source=? OR ?='curated' AND source='custom')").get(this.playbackMode,this.playbackMode).n,routerQueued:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source='router' AND status='queued'").get().n,routerSeen:this.db.prepare('SELECT COUNT(*) AS n FROM router_seen').get().n,routerArchive:this.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(deleted_at IS NULL AND router_id IS NOT NULL),0) AS pending,COALESCE(SUM(deleted_at IS NULL AND router_id IS NULL),0) AS missingId,COALESCE(SUM(deleted_at IS NOT NULL),0) AS deleted FROM router_archive').get(),routerMessages:this.db.prepare("SELECT status,COUNT(*) AS n FROM ticker_messages WHERE source='router' GROUP BY status").all(),active:this.runs(),completed:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source=? AND status='completed'").get(this.playbackMode).n,readers:this.db.prepare('SELECT * FROM ticker_sources').all()};}
}
