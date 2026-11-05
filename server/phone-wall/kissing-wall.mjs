import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ENDPOINT='https://sms-clips.samuel.ovh/api/random-clips?tag=kiss&limit=50';
const MEDIA_HOSTS=new Set(['sms-clips.samuel.ovh','kiss-files.s3.eu-west-par.io.cloud.ovh.net']);
const MAX_CLIP=100*1024*1024, MAX_POOL=10*1024*1024*1024, POOL_COUNT=512, PHONE_POOL_COUNT=24;
const defaults={enabled:false,trim:false,trimStartOffsetSec:1,trimEndOffsetSec:1,revealDurationMs:1200,fadeOutDurationMs:1000};

function validateClip(clip) {
  if(!clip||clip.tag!=='kiss')throw new Error('kissing-api-invalid-clip');
  const url=new URL(clip.media_url);
  if(url.protocol!=='https:'||url.username||url.password||!MEDIA_HOSTS.has(url.hostname)||url.port)throw new Error('kissing-media-host-not-allowed');
  const start=clip.kiss_start_seconds,end=clip.kiss_end_seconds;
  if((start!=null&&(!Number.isFinite(start)||start<0))||(end!=null&&(!Number.isFinite(end)||end<=0))||(start!=null&&end!=null&&end<=start))throw new Error('kissing-api-invalid-trim');
  return {source:url.href,startSec:start??null,endSec:end??null};
}
export function kissClip(payload) {return validateClip(payload?.clips?.[0]);}
export function kissClips(payload) {
  if(!Array.isArray(payload?.clips)||!payload.clips.length||payload.clips.length>50)throw new Error('kissing-api-invalid-clips');
  return [...new Map(payload.clips.map(clip=>{const value=validateClip(clip);return [value.source,value];})).values()];
}

export class KissingWall {
  constructor(store,mediaDir,{fetchImpl=fetch,onChange=()=>{}}={}) {
    this.store=store;this.mediaDir=mediaDir;this.fetch=fetchImpl;this.onChange=onChange;
    store.db.exec(`CREATE TABLE IF NOT EXISTS kissing_settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kissing_clips(source TEXT PRIMARY KEY,hash TEXT NOT NULL,data TEXT NOT NULL,added INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kissing_files(hash TEXT PRIMARY KEY);`);
    const row=store.db.prepare('SELECT data FROM kissing_settings WHERE id=1').get();
    this.settings={...defaults,...(row?JSON.parse(row.data):{})};
    this.busy=false;this.lastError=null;this.closed=false;this.nextRefresh=0;
  }
  async initialize(){
    for(const name of await readdir(this.mediaDir))if(/^kissing-incoming-[a-f0-9-]{36}$/.test(name))await unlink(join(this.mediaDir,name)).catch(()=>{});
  }
  clips() {return this.store.db.prepare('SELECT data FROM kissing_clips ORDER BY added DESC,rowid DESC').all().map(row=>JSON.parse(row.data));}
  snapshot(id,drain=false) {
    const enabled=this.settings.enabled&&!!this.store.snapshot(id)&&this.store.device(id)?.capabilities?.kissingWall===1;
    const clips=this.clips();
    const offset=clips.length?createHash('sha256').update(id).digest().readUInt32BE(0)%clips.length:0;
    const phonePool=[...clips.slice(offset),...clips.slice(0,offset)].slice(0,PHONE_POOL_COUNT);
    return {v:1,...this.settings,enabled,drain,clips:enabled?phonePool.map(({source,...clip})=>clip):[]};
  }
  status() {const clips=this.clips();return {...this.settings,busy:this.busy,clips:clips.length,bytes:clips.reduce((sum,c)=>sum+c.bytes,0),lastError:this.lastError};}
  configure(input) {
    const next={...this.settings};
    for(const key of ['enabled','trim'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')throw new Error('invalid-kissing-setting');next[key]=input[key];}
    for(const [key,max] of [['trimStartOffsetSec',30],['trimEndOffsetSec',30],['revealDurationMs',5000],['fadeOutDurationMs',5000]]){
      if(input[key]!==undefined){if(!Number.isFinite(input[key])||input[key]<0||input[key]>max)throw new Error('invalid-kissing-setting');next[key]=input[key];}
    }
    this.settings=next;
    this.store.db.prepare('INSERT INTO kissing_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next));
  }
  async request(url,signal) {
    // Never follow a remote redirect into a private network or an untrusted host.
    const response=await this.fetch(url,{signal,redirect:'error',headers:{Accept:url===ENDPOINT?'application/json':'video/mp4'}});
    if(!response.ok)throw new Error('kissing-upstream-http-'+response.status);
    return response;
  }
  async refresh() {
    if(this.closed||this.busy)return;
    this.busy=true;this.abort=new AbortController();
    const timeout=setTimeout(()=>this.abort?.abort(),10*60*1000);
    let changed=false,failed=false;
    try {
      const discovered=new Map();let roundsWithoutNew=0;
      for(let round=0;round<20&&roundsWithoutNew<3;round++){
        const response=await this.request(ENDPOINT,this.abort.signal);
        let json='';for await(const chunk of response.body){json+=Buffer.from(chunk).toString('utf8');if(Buffer.byteLength(json)>65536)throw new Error('kissing-api-too-large');}
        const batch=kissClips(JSON.parse(json));
        const before=discovered.size;
        for(const clip of batch)discovered.set(clip.source,clip);
        roundsWithoutNew=discovered.size===before?roundsWithoutNew+1:0;
        if(batch.length<50)break;
      }
      for(const clip of discovered.values()){
        if(this.closed)break;
        try{if(await this.cacheClip(clip))changed=true;}
        catch{failed=true;}
      }
      await this.prune();
      this.lastError=failed?'Some clips could not be cached; retrying later.':null;
    } catch {
      if(!this.closed)this.lastError='Clip source unavailable or invalid; continuing with cached clips.';
    } finally {
      clearTimeout(timeout);this.busy=false;this.nextRefresh=Date.now()+30000;
      if(changed&&!this.closed)this.onChange();
    }
  }
  async cacheClip(clip){
    const known=this.clips().find(c=>c.source===clip.source);
    if(known){
      try{
        const digest=createHash('sha256');for await(const chunk of createReadStream(join(this.mediaDir,known.hash)))digest.update(chunk);
        if(digest.digest('hex')===known.hash)return false;
      }catch{}
      this.store.db.prepare('DELETE FROM kissing_clips WHERE source=?').run(clip.source);
    }
    let temporary;
    try{
      const video=await this.request(clip.source,this.abort.signal);
      if(Number(video.headers.get('content-length'))>MAX_CLIP)throw new Error('kissing-clip-too-large');
      temporary=join(this.mediaDir,'kissing-incoming-'+randomUUID());
      const digest=createHash('sha256');let bytes=0,header=Buffer.alloc(0);
      await pipeline(Readable.fromWeb(video.body),new Transform({transform(chunk,encoding,done){
        bytes+=chunk.length;
        if(bytes>MAX_CLIP)return done(new Error('kissing-clip-too-large'));
        if(header.length<32)header=Buffer.concat([header,chunk.subarray(0,32-header.length)]);
        digest.update(chunk);done(null,chunk);
      }}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
      if(bytes<12||header.toString('ascii',4,8)!=='ftyp')throw new Error('kissing-invalid-mp4');
      const checksum=digest.digest('hex');
      await rename(temporary,join(this.mediaDir,checksum));temporary=null;
      const value={...clip,hash:checksum,bytes};
      this.store.transaction(()=>{
        if(!this.store.asset(checksum))this.store.db.prepare('INSERT OR IGNORE INTO kissing_files VALUES(?)').run(checksum);
        this.store.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?)').run(checksum,'video/mp4',bytes);
        this.store.db.prepare('INSERT OR REPLACE INTO kissing_clips VALUES(?,?,?,?)').run(clip.source,checksum,JSON.stringify(value),Date.now());
      });
      return true;
    }finally{if(temporary)await unlink(temporary).catch(()=>{});}
  }
  async prune() {
    let count=0,bytes=0;
    for(const clip of this.clips()){
      count++;bytes+=clip.bytes;
      if(count<=POOL_COUNT&&bytes<=MAX_POOL)continue;
      this.store.db.prepare('DELETE FROM kissing_clips WHERE source=?').run(clip.source);
    }
    const rows=this.store.db.prepare('SELECT hash FROM kissing_files WHERE hash NOT IN (SELECT hash FROM kissing_clips)').all();
    for(const {hash} of rows){
      if(this.store.db.prepare('SELECT 1 FROM artwork_releases WHERE data LIKE ?').get('%'+hash+'%')||this.store.db.prepare('SELECT 1 FROM configurations WHERE data LIKE ?').get('%'+hash+'%'))continue;
      await unlink(join(this.mediaDir,hash)).catch(()=>{});
      this.store.db.prepare('DELETE FROM assets WHERE hash=?').run(hash);
      this.store.db.prepare('DELETE FROM kissing_files WHERE hash=?').run(hash);
    }
  }
  tick(){if(!this.busy&&Date.now()>=this.nextRefresh)this.pending=this.refresh();}
  async close(){this.closed=true;this.abort?.abort();await this.pending;}
}
