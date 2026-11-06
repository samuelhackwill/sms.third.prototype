import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { repairArchivedSms } from './sms-encoding.mjs';
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
const randomSpeed=(min,max)=>min+Math.floor(Math.random()*(max-min+1));
export function routerBackground(externalId){
  const sender=String(externalId).replace(/^(?:tenda|archive):/,'').split(':')[0];
  const seed=Number(sender.replace(/\D/g,'').slice(-4).padStart(4,'0'));
  const hue=seed*137%360,saturation=72+seed%12;
  let lightness=40+Math.floor(seed/12)%5;
  const luminance=()=>{
    const s=saturation/100,l=lightness/100,a=s*Math.min(l,1-l);
    const channel=n=>{
      const k=(n+hue/30)%12,value=l-a*Math.max(-1,Math.min(k-3,9-k,1));
      return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;
    };
    return 0.2126*channel(0)+0.7152*channel(8)+0.0722*channel(4);
  };
  while(lightness>20&&luminance()>0.18)lightness--;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
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
    this.store=store;this.db=store.db;this.libraryGeneration=randomUUID();this.transition=null;
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
      CREATE INDEX IF NOT EXISTS router_archive_sender_recent ON router_archive(sender,archived_at);
      CREATE INDEX IF NOT EXISTS router_archive_sender_id ON router_archive(sender,router_id);
      CREATE TABLE IF NOT EXISTS archive_replay_history(external_id TEXT PRIMARY KEY,last_queued_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS curated_messages(id TEXT PRIMARY KEY,text TEXT NOT NULL,received_at TEXT,selected INTEGER NOT NULL DEFAULT 0);`);
    if(!this.db.prepare('PRAGMA table_info(curated_messages)').all().some(column=>column.name==='selected'))this.db.exec('ALTER TABLE curated_messages ADD COLUMN selected INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(router_archive)').all().some(column=>column.name==='selected'))this.db.exec('ALTER TABLE router_archive ADD COLUMN selected INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(router_state)').all().some(column=>column.name==='enabled'))this.db.exec('ALTER TABLE router_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(router_state)').all().some(column=>column.name==='detail_initialized'))this.db.exec('ALTER TABLE router_state ADD COLUMN detail_initialized INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(ticker_settings)').all().some(column=>column.name==='mode'))this.db.exec("ALTER TABLE ticker_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'messages'");
    if(!this.db.prepare('PRAGMA table_info(ticker_settings)').all().some(column=>column.name==='barthes_cursor'))this.db.exec('ALTER TABLE ticker_settings ADD COLUMN barthes_cursor INTEGER NOT NULL DEFAULT 0');
    for(const [name,definition] of [['custom_a',"TEXT NOT NULL DEFAULT ''"],['custom_b',"TEXT NOT NULL DEFAULT ''"],['curated_next_at','INTEGER NOT NULL DEFAULT 0'],['curated_injection_enabled','INTEGER NOT NULL DEFAULT 0'],['curated_second_enabled','INTEGER NOT NULL DEFAULT 0'],['archive_replay_enabled','INTEGER NOT NULL DEFAULT 0'],['live_alert_enabled','INTEGER NOT NULL DEFAULT 0'],['transition_blinks','INTEGER NOT NULL DEFAULT 2'],['transition_scroll_speed','REAL NOT NULL DEFAULT 1'],['transition_blink_speed','REAL NOT NULL DEFAULT 1'],['archive_density','INTEGER NOT NULL DEFAULT 1'],['barthes_min_speed','INTEGER NOT NULL DEFAULT 1000'],['barthes_max_speed','INTEGER NOT NULL DEFAULT 6000'],['curated_min_speed','INTEGER NOT NULL DEFAULT 240'],['curated_max_speed','INTEGER NOT NULL DEFAULT 240']])if(!this.db.prepare('PRAGMA table_info(ticker_settings)').all().some(column=>column.name===name))this.db.exec(`ALTER TABLE ticker_settings ADD COLUMN ${name} ${definition}`);
    if(!this.db.prepare('PRAGMA table_info(ticker_messages)').all().some(column=>column.name==='source'))this.db.exec("ALTER TABLE ticker_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'messages'");
    this.db.exec("CREATE INDEX IF NOT EXISTS ticker_source_status ON ticker_messages(source,status,seq)");
    if(!this.db.prepare('PRAGMA table_info(ticker_messages)').all().some(column=>column.name==='target_row'))this.db.exec('ALTER TABLE ticker_messages ADD COLUMN target_row INTEGER');
    for(const name of ['origin_id','color_seed'])if(!this.db.prepare('PRAGMA table_info(ticker_messages)').all().some(column=>column.name===name))this.db.exec(`ALTER TABLE ticker_messages ADD COLUMN ${name} TEXT`);
    const repairArchive=this.db.prepare('UPDATE router_archive SET text=? WHERE external_id=?');
    const repairTicker=this.db.prepare("UPDATE ticker_messages SET text=? WHERE source='router' AND external_id=?");
    for(const row of this.db.prepare('SELECT external_id AS id,text FROM router_archive').all()){
      const fixed=repairArchivedSms(row.text);
      if(fixed!==row.text){repairArchive.run(fixed,row.id);repairTicker.run(displayMessage(fixed),row.id);}
    }
    const first=this.db.prepare('SELECT custom_a FROM ticker_settings WHERE id=1').get().custom_a;
    if(first.length>10){const digits=first.replace(/\D/g,'');this.db.prepare('UPDATE ticker_settings SET custom_a=? WHERE id=1').run(digits.length>=10?digits.slice(0,10):first.slice(0,10));}
    this.db.prepare("DELETE FROM ticker_messages WHERE source='curated-click'").run();
    this.db.prepare("DELETE FROM ticker_messages WHERE source IN ('archive','curated') AND status!='completed'").run();
    // Playback acknowledgments from a previous process cannot establish current readiness.
    this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE status IN ('preparing','playing')").run();
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
        const baseId='tenda:'+record.id;
        const sender=typeof record.sender==='string'?record.sender:record.id.split(':')[0];
        const routerId=record.routerId==null?null:String(record.routerId);
        const receivedAt=typeof record.receivedAt==='string'?record.receivedAt.slice(0,40):null;
        const prior=this.db.prepare('SELECT text,received_at AS receivedAt FROM router_archive WHERE external_id=?').get(baseId);
        const exact=routerId===null?null:this.db.prepare('SELECT external_id AS id FROM router_archive WHERE sender=? AND router_id=? AND text=? AND received_at IS ? LIMIT 1').get(sender,routerId,record.text,receivedAt);
        const id=exact?.id??(prior&&(prior.text!==record.text||prior.receivedAt!=null&&receivedAt!=null&&prior.receivedAt!==receivedAt)?`${baseId}:${createHash('sha256').update(JSON.stringify([receivedAt,record.text])).digest('hex').slice(0,16)}`:baseId);
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
  pendingRouterDeletes(limit=100){const now=Date.now();return this.db.prepare('SELECT a.external_id AS externalId,a.sender,a.router_id AS routerId,a.text,a.received_at AS receivedAt FROM router_archive a WHERE a.router_id IS NOT NULL AND a.deleted_at IS NULL AND a.archived_at<? AND (a.delete_attempt_at IS NULL OR a.delete_attempt_at<?) AND NOT EXISTS (SELECT 1 FROM router_archive recent WHERE recent.sender=a.sender AND recent.archived_at>=?) ORDER BY a.archived_at LIMIT ?').all(now-120000,now-15000,now-120000,limit);}
  markRouterDeleteAttempt(ids){const update=this.db.prepare('UPDATE router_archive SET delete_attempt_at=? WHERE external_id=? AND deleted_at IS NULL');this.store.transaction(()=>{for(const id of ids)update.run(Date.now(),id);});}
  markRouterDeleted(ids){const update=this.db.prepare('UPDATE router_archive SET deleted_at=? WHERE external_id=? AND deleted_at IS NULL');this.store.transaction(()=>{for(const id of ids)update.run(Date.now(),id);});}
  start(){this.requeue(true);this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes' OR source IN ('custom','curated','curated-click','archive') AND status!='completed'").run();this.db.prepare("UPDATE ticker_settings SET enabled=1,mode='messages' WHERE id=1").run();}
  get customTexts(){const row=this.db.prepare('SELECT custom_a,custom_b FROM ticker_settings WHERE id=1').get();return [row.custom_a,row.custom_b];}
  get curatedInjectionEnabled(){return this.db.prepare('SELECT curated_injection_enabled FROM ticker_settings WHERE id=1').get().curated_injection_enabled===1;}
  get archiveReplayEnabled(){return this.db.prepare('SELECT archive_replay_enabled FROM ticker_settings WHERE id=1').get().archive_replay_enabled===1;}
  get liveAlertEnabled(){return this.db.prepare('SELECT live_alert_enabled FROM ticker_settings WHERE id=1').get().live_alert_enabled===1;}
  setLiveAlert(enabled){if(typeof enabled!=='boolean')throw new Error('invalid-live-alert-setting');this.db.prepare('UPDATE ticker_settings SET live_alert_enabled=? WHERE id=1').run(enabled?1:0);return this.liveAlertEnabled;}
  get transitionSettings(){const row=this.db.prepare('SELECT transition_blinks,transition_scroll_speed,transition_blink_speed FROM ticker_settings WHERE id=1').get();return {blinkCount:row.transition_blinks,scrollSpeed:row.transition_scroll_speed,blinkSpeed:row.transition_blink_speed};}
  setTransitionSettings({blinkCount,scrollSpeed,blinkSpeed}){
    if(!Number.isInteger(blinkCount)||blinkCount<0||blinkCount>100||!Number.isFinite(scrollSpeed)||scrollSpeed<0.25||scrollSpeed>4||!Number.isFinite(blinkSpeed)||blinkSpeed<0.25||blinkSpeed>4)throw new Error('invalid-transition-settings');
    this.db.prepare('UPDATE ticker_settings SET transition_blinks=?,transition_scroll_speed=?,transition_blink_speed=? WHERE id=1').run(blinkCount,scrollSpeed,blinkSpeed);
    return this.transitionSettings;
  }
  get archiveDensity(){return this.db.prepare('SELECT archive_density FROM ticker_settings WHERE id=1').get().archive_density;}
  get speedRanges(){const s=this.db.prepare('SELECT barthes_min_speed,barthes_max_speed,curated_min_speed,curated_max_speed FROM ticker_settings WHERE id=1').get();return {barthes:{min:s.barthes_min_speed,max:s.barthes_max_speed},curated:{min:s.curated_min_speed,max:s.curated_max_speed}};}
  speedFor(mode){const {min,max}=this.speedRanges[mode];return randomSpeed(min,max);}
  setSpeedRange(mode,min,max){
    if(!['barthes','curated'].includes(mode)||!Number.isInteger(min)||!Number.isInteger(max)||min<20||max>6000||min>max)throw new Error('invalid-speed-range');
    this.db.prepare(`UPDATE ticker_settings SET ${mode}_min_speed=?,${mode}_max_speed=? WHERE id=1`).run(min,max);
    return this.speedRanges[mode];
  }
  setArchiveReplay(enabled){
    if(typeof enabled!=='boolean')throw new Error('invalid-archive-replay-setting');
    this.store.transaction(()=>{this.db.prepare('UPDATE ticker_settings SET archive_replay_enabled=? WHERE id=1').run(enabled?1:0);this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE source='curated' AND status IN ('preparing','playing')").run();});
    return this.archiveReplayEnabled;
  }
  setArchiveDensity(value){if(!Number.isInteger(value)||value<1||value>6)throw new Error('invalid-archive-density');this.db.prepare('UPDATE ticker_settings SET archive_density=? WHERE id=1').run(value);return this.archiveDensity;}
  get curatedSecondEnabled(){return this.db.prepare('SELECT curated_second_enabled FROM ticker_settings WHERE id=1').get().curated_second_enabled===1;}
  isCuratedPriorityRow(row){return this.playbackMode==='curated'&&(row===0||row===1&&this.curatedSecondEnabled);}
  setCuratedSecond(enabled){
    if(typeof enabled!=='boolean')throw new Error('invalid-curated-second-setting');
    this.store.transaction(()=>{
      this.db.prepare('UPDATE ticker_settings SET curated_second_enabled=? WHERE id=1').run(enabled?1:0);
      if(!enabled)this.db.prepare("DELETE FROM ticker_messages WHERE source='custom' AND target_row=1 AND status!='completed'").run();
      if(enabled&&this.playbackMode==='curated')for(const run of this.runs().filter(run=>run.source!=='custom'&&run.row===1))this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE seq=?").run(run.seq);
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
      this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes' OR source IN ('custom','curated','curated-click','archive') AND status!='completed'").run();
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
    this.db.prepare("DELETE FROM ticker_messages WHERE source IN ('custom','curated','curated-click','archive') AND status!='completed'").run();
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
  curatedMessages(){return this.db.prepare("SELECT id,text,receivedAt,selected,source,sender FROM (SELECT id,text,received_at AS receivedAt,selected,'messages' AS source,NULL AS sender,received_at AS sortAt FROM curated_messages UNION ALL SELECT 'sms:'||external_id AS id,text,received_at AS receivedAt,selected,'sms' AS source,sender,COALESCE(received_at,datetime(archived_at/1000,'unixepoch')) AS sortAt FROM router_archive) ORDER BY sortAt DESC,id DESC LIMIT 2000").all();}
  toggleCurated(id){
    if(typeof id!=='string'||!id||id.length>512)throw new Error('invalid-curated-id');
    if(id.startsWith('sms:'))return this.store.transaction(()=>{
      const archiveId=id.slice(4);
      if(!this.db.prepare('UPDATE router_archive SET selected=1-selected WHERE external_id=?').run(archiveId).changes)throw new Error('unknown-curated-message');
      const selected=this.db.prepare('SELECT selected,sender FROM router_archive WHERE external_id=?').get(archiveId);
      if(!selected.selected)this.db.prepare("DELETE FROM ticker_messages WHERE source='curated' AND origin_id=?").run(id);
      return selected.selected===1;
    });
    if(!this.db.prepare('UPDATE curated_messages SET selected=1-selected WHERE id=?').run(id).changes)throw new Error('unknown-curated-message');
    const selected=this.db.prepare('SELECT selected FROM curated_messages WHERE id=?').get(id).selected===1;
    if(!selected)this.db.prepare("DELETE FROM ticker_messages WHERE source='curated' AND origin_id=?").run(`messages:${id}`);
    return selected;
  }
  startBarthes(){
    sentences();
    this.store.transaction(()=>{
      this.requeue(true);
      this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes' OR source IN ('custom','curated','curated-click','archive') AND status!='completed'").run();
      this.db.prepare("UPDATE ticker_settings SET enabled=1,mode='barthes',barthes_cursor=0 WHERE id=1").run();
    });
    this.refillBarthes();
  }
  stopBarthes(){if(this.playbackMode==='barthes')this.store.transaction(()=>{this.db.prepare("DELETE FROM ticker_messages WHERE source='barthes'").run();this.db.prepare("UPDATE ticker_settings SET enabled=0,mode='messages',barthes_cursor=0 WHERE id=1").run();});}
  pause(){this.db.prepare('UPDATE ticker_settings SET enabled=0 WHERE id=1').run();return this.requeue(true);}
  retireCuratedFlash(){
    let changed=false;
    for(const run of this.runs().filter(run=>run.source==='custom'&&run.effect==='flash')){
      this.db.prepare('DELETE FROM ticker_messages WHERE seq=?').run(run.seq);changed=true;
    }
    return changed;
  }
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
    if(!settings.curated_injection_enabled)return;
    const eligible=liveRows(this.store.current().layout).filter(row=>!this.isCuratedPriorityRow(row.row));
    const limit=this.archiveDensity===6?eligible.length:Math.min(this.archiveDensity,eligible.length);
    const occupied=this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source='curated' AND status IN ('queued','preparing','playing')").get().n;
    const busy=new Set(this.runs().map(run=>run.row));
    const target=Math.min(limit,occupied+eligible.filter(row=>!busy.has(row.row)).length);
    const queue=this.db.prepare("INSERT INTO ticker_messages(external_id,text,source,origin_id,color_seed) VALUES(?,?,'curated',?,?)");
    const remember=this.db.prepare('INSERT INTO archive_replay_history(external_id,last_queued_at) VALUES(?,?) ON CONFLICT(external_id) DO UPDATE SET last_queued_at=excluded.last_queued_at');
    for(let i=occupied;i<target;i++){
      const message=this.db.prepare("SELECT p.id,p.text,p.seed FROM (SELECT 'messages:'||id AS id,text,id AS seed FROM curated_messages WHERE selected=1 UNION ALL SELECT 'sms:'||external_id AS id,text,sender AS seed FROM router_archive WHERE selected=1 AND deleted_at IS NOT NULL AND archived_at<?) p LEFT JOIN archive_replay_history h ON h.external_id=p.id WHERE NOT EXISTS (SELECT 1 FROM ticker_messages t WHERE t.source='curated' AND t.origin_id=p.id AND t.status IN ('queued','preparing','playing')) ORDER BY COALESCE(h.last_queued_at,0),RANDOM() LIMIT 1").get(now-120000);
      if(!message)break;
      const text=displayMessage(message.text);
      if(!text)break;
      const seed=message.id.startsWith('sms:')?message.seed:String(createHash('sha256').update(message.id).digest().readUInt16BE(0)%10000).padStart(4,'0');
      queue.run('curated:'+randomUUID(),text,message.id,seed);
      remember.run(message.id,now);
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
  dispatchState(){
    const mode=this.playbackMode;
    return {
      active:this.runs(),
      routerQueued:!!this.db.prepare("SELECT 1 FROM ticker_messages WHERE status='queued' AND source='router' LIMIT 1").get(),
      queued:!!this.db.prepare("SELECT 1 FROM ticker_messages WHERE status='queued' AND (source=? OR ?='curated' AND source IN ('custom','archive')) LIMIT 1").get(mode,mode),
    };
  }
  snapshot(deviceId){const runs=this.runs().filter(run=>run.targets.includes(deviceId));return {enabled:this.enabled||runs.some(run=>run.source==='router'),alertEnabled:this.liveAlertEnabled,runs,transition:this.transition&&Date.now()<this.transition.startAtServerMs+this.transition.durationMs?this.transition:null};}
  save(run,status){const {seq,text,...data}=run;this.db.prepare('UPDATE ticker_messages SET status=?,run=? WHERE seq=?').run(status,JSON.stringify(data),seq);}
  tick(ready,allowed=true,now=Date.now(),dispatch=true) {
    const canStart=allowed&&dispatch;
    if(this.enabled&&canStart)this.refillBarthes();
    if(this.enabled&&canStart)this.refillCurated(now);
    const state=this.store.current(),rows=liveRows(state.layout);let changed=false;
    for(const run of this.runs()){
      const row=rows.find(row=>row.row===run.row);
      if(!row||JSON.stringify(row)!==JSON.stringify(run.band)||run.targets.some(id=>!ready.has(id))||run.effect==='flash'&&row.targets.some(id=>ready.has(id)&&!run.targets.includes(id))||now>=run.deadline||['router','curated'].includes(run.source)&&this.isCuratedPriorityRow(run.row)||(run.source!=='router'&&(!this.enabled||!allowed))){
        this.db.prepare("UPDATE ticker_messages SET status='queued',run=NULL WHERE seq=?").run(run.seq);changed=true;
      }
    }
    let active=this.runs(),busy=new Set(active.map(run=>run.row));
    for(const band of rows.filter(row=>canStart&&!this.isCuratedPriorityRow(row.row)&&!busy.has(row.row)&&row.targets.some(id=>ready.has(id)))){
      const urgent=this.db.prepare("SELECT seq,external_id FROM ticker_messages WHERE source='router' AND status='queued' ORDER BY seq LIMIT 1").get();
      if(!urgent)break;
      this.save({seq:urgent.seq,id:randomUUID(),row:band.row,band,targets:band.targets.filter(id=>ready.has(id)),ready:{},done:[],phase:'preparing',effect:this.playbackMode==='curated'?'sms-sweep':undefined,backgroundColor:routerBackground(urgent.external_id),speed:this.playbackMode==='curated'?this.speedFor('curated'):state.testTextSpeed??240,startAtServerMs:null,deadline:now+30000},'preparing');
      changed=true;active=this.runs();busy=new Set(active.map(run=>run.row));
    }
    if(this.enabled&&canStart&&this.playbackMode==='curated'&&this.curatedInjectionEnabled){
      for(const band of rows.filter(row=>!this.isCuratedPriorityRow(row.row)&&!busy.has(row.row)&&row.targets.some(id=>ready.has(id)))){
        const message=this.db.prepare("SELECT seq,color_seed AS colorSeed FROM ticker_messages WHERE source='curated' AND status='queued' ORDER BY seq LIMIT 1").get();
        if(!message)break;
        this.save({seq:message.seq,id:randomUUID(),row:band.row,band,targets:band.targets.filter(id=>ready.has(id)),ready:{},done:[],phase:'preparing',effect:this.archiveReplayEnabled?'sms-sweep':undefined,backgroundColor:this.archiveReplayEnabled?routerBackground(`tenda:${message.colorSeed??'0000'}`):undefined,speed:this.speedFor('curated'),startAtServerMs:null,deadline:now+30000},'preparing');
        changed=true;active=this.runs();busy=new Set(active.map(run=>run.row));
      }
    }
    for(const band of rows){
      if(busy.has(band.row)||!band.targets.some(id=>ready.has(id)))continue;
      if(this.playbackMode==='curated'){
        if(band.row>1||band.row===1&&!this.curatedSecondEnabled||!this.enabled||!canStart)continue;
        const message=this.db.prepare("SELECT seq FROM ticker_messages WHERE source='custom' AND target_row=? AND status='queued' ORDER BY seq LIMIT 1").get(band.row);
        if(!message)continue;
        this.save({seq:message.seq,id:randomUUID(),row:band.row,band,targets:band.targets.filter(id=>ready.has(id)),ready:{},done:[],phase:'preparing',effect:band.row===0?'flash':undefined,speed:this.speedFor('curated'),startAtServerMs:null,deadline:now+30000},'preparing');
        busy.add(band.row);changed=true;continue;
      }
      const message=this.db.prepare("SELECT seq,source FROM ticker_messages WHERE status='queued' AND ((source='router' AND ?) OR (source=? AND ?)) ORDER BY CASE WHEN source='router' THEN 0 ELSE 1 END,seq LIMIT 1").get(canStart?1:0,this.playbackMode,this.enabled&&canStart?1:0);
      if(!message)break;
      this.save({seq:message.seq,id:randomUUID(),row:band.row,band,targets:band.targets.filter(id=>ready.has(id)),ready:{},done:[],phase:'preparing',speed:message.source==='barthes'?this.speedFor('barthes'):state.testTextSpeed??240,startAtServerMs:null,deadline:now+30000},'preparing');
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
        if(['custom','curated','curated-click','archive'].includes(run.source))this.db.prepare('DELETE FROM ticker_messages WHERE seq=?').run(run.seq);
        else this.db.prepare("UPDATE ticker_messages SET status='completed',run=NULL,completed_at=? WHERE seq=?").run(now,run.seq);
      }
      else this.save(run,'playing');
      return true;
    }
    return false;
  }
  status(){return {enabled:this.enabled,mode:this.playbackMode,liveAlertEnabled:this.liveAlertEnabled,libraryGeneration:this.libraryGeneration,customTexts:this.customTexts,curatedSecondEnabled:this.curatedSecondEnabled,curatedInjectionEnabled:this.curatedInjectionEnabled,archiveReplayEnabled:this.archiveReplayEnabled,archiveDensity:this.archiveDensity,speedRanges:this.speedRanges,archivePlaying:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source='archive' AND status IN ('queued','preparing','playing')").get().n,curatedCount:this.db.prepare('SELECT (SELECT COUNT(*) FROM curated_messages)+(SELECT COUNT(*) FROM router_archive) AS n').get().n,curatedSelected:this.db.prepare('SELECT (SELECT COUNT(*) FROM curated_messages WHERE selected=1)+(SELECT COUNT(*) FROM router_archive WHERE selected=1) AS n').get().n,queued:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE status='queued' AND (source=? OR ?='curated' AND source IN ('custom','archive'))").get(this.playbackMode,this.playbackMode).n,routerQueued:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source='router' AND status='queued'").get().n,routerSeen:this.db.prepare('SELECT COUNT(*) AS n FROM router_seen').get().n,routerArchive:this.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(deleted_at IS NULL AND router_id IS NOT NULL),0) AS pending,COALESCE(SUM(deleted_at IS NULL AND router_id IS NULL),0) AS missingId,COALESCE(SUM(deleted_at IS NOT NULL),0) AS deleted FROM router_archive').get(),routerMessages:this.db.prepare("SELECT status,COUNT(*) AS n FROM ticker_messages WHERE source='router' GROUP BY status").all(),active:this.runs(),completed:this.db.prepare("SELECT COUNT(*) AS n FROM ticker_messages WHERE source=? AND status='completed'").get(this.playbackMode).n,readers:this.db.prepare('SELECT * FROM ticker_sources').all()};}
}
