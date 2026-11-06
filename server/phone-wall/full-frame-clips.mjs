import { createHash, randomUUID } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { spawnSync, execFile } from 'node:child_process';
import { rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { releaseHash } from './scenes.mjs';

const execFileAsync=promisify(execFile);
const defaults={trim:false,trimStartOffsetSec:1,trimEndOffsetSec:1,revealDurationMs:1200,fadeOutDurationMs:1000};

export function probeVideo(file) {
  const binary=['/opt/homebrew/bin/ffprobe','/usr/local/bin/ffprobe'].find(existsSync);
  if(!binary)throw new Error('full-frame-ffprobe-unavailable');
  const result=spawnSync(binary,['-v','error','-show_entries','format=duration:stream=codec_type,width,height,duration,side_data_list,tags','-of','json',file],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  if(result.status!==0)throw new Error('full-frame-video-probe-failed');
  const data=JSON.parse(result.stdout),stream=data.streams?.find(item=>item.codec_type==='video');
  let width=Number(stream?.width),height=Number(stream?.height);
  const rotation=Number(stream?.side_data_list?.find(item=>Number.isFinite(Number(item.rotation)))?.rotation??stream?.tags?.rotate??0);
  if(Math.abs(rotation)%180===90)[width,height]=[height,width];
  const formatDuration=Number(data.format?.duration),durationSec=formatDuration>0?formatDuration:Number(stream?.duration);
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Number.isFinite(durationSec)||durationSec<0.5||durationSec>600)throw new Error('full-frame-video-metadata-invalid');
  return {width,height,durationMs:Math.round(durationSec*1000)};
}

export function fullFrameDefinition(layout,clip,video,settings=defaults) {
  const slots=layout.slots;
  if(!slots.length)throw new Error('pair-phones-before-full-frame-clips');
  const left=Math.min(...slots.map(slot=>slot.geometry.x)),top=Math.min(...slots.map(slot=>slot.geometry.y));
  const right=Math.max(...slots.map(slot=>slot.geometry.x+slot.geometry.width));
  const bottom=Math.max(...slots.map(slot=>slot.geometry.y+slot.geometry.height));
  const wallWidth=right-left,wallHeight=bottom-top,videoAspect=video.width/video.height;
  const width=Math.max(wallWidth,wallHeight*videoAspect),height=Math.max(wallHeight,wallWidth/videoAspect);
  const frame={x:left-(width-wallWidth)/2,y:top-(height-wallHeight)/2,width,height};
  const fadeIn=Math.min(settings.revealDurationMs??0,video.durationMs/2);
  const fadeOut=Math.min(settings.fadeOutDurationMs??0,video.durationMs/2);
  const elements=[{id:'wall-video',type:'video',asset:clip.hash,frame}];
  if(fadeIn>=16)elements[0].animation={property:'opacity',from:0,to:1,durationMs:fadeIn,delayMs:0,easing:'linear',repeat:false};
  if(fadeOut>=16)elements.push({id:'fade-to-black',type:'rect',frame:{x:left,y:top,width:wallWidth,height:wallHeight},color:'#000000',opacity:0,animation:{property:'opacity',from:0,to:1,durationMs:fadeOut,delayMs:video.durationMs-fadeOut,easing:'linear',repeat:false}});
  return {sceneSchemaVersion:1,artworkId:'full-frame-clips',artworkVersion:releaseHash({hash:clip.hash,layout,frame,settings}),canvas:{width:right,height:bottom},background:'#000000',transition:{type:'cut',durationMs:0},elements};
}

export class FullFrameClips {
  constructor({store,releases,kissing,mediaDir,sessions,probe=probeVideo}) {
    Object.assign(this,{store,releases,kissing,mediaDir,sessions,probe});
    store.db.exec('CREATE TABLE IF NOT EXISTS full_frame_clips(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS full_frame_edits(key TEXT PRIMARY KEY,hash TEXT NOT NULL,duration_ms INTEGER NOT NULL)');
    const saved=store.db.prepare('SELECT data FROM full_frame_clips WHERE id=1').get();
    this.state={enabled:false,current:null,next:null,lastHash:null,error:null,retryAt:0,settings:defaults,...(saved?JSON.parse(saved.data):{})};
    this.state.settings={...defaults,...this.state.settings};
    this.metadata=new Map();
    this.generation=0;this.preparing=null;this.prepared=null;
  }
  save(){this.store.db.prepare('INSERT INTO full_frame_clips(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(this.state));}
  status(){return {...this.state,clips:this.kissing.clips().length,phase:this.state.current?'playing':this.state.next?'preparing':'waiting'};}
  configure(input){
    const next={...this.state.settings};
    if(input.trim!==undefined){if(typeof input.trim!=='boolean')throw new Error('invalid-full-frame-setting');next.trim=input.trim;}
    for(const [key,max] of [['trimStartOffsetSec',30],['trimEndOffsetSec',30],['revealDurationMs',5000],['fadeOutDurationMs',5000]]){
      if(input[key]!==undefined){if(!Number.isFinite(input[key])||input[key]<0||input[key]>max)throw new Error('invalid-full-frame-setting');next[key]=input[key];}
    }
    this.state.settings=next;this.generation++;this.preparing=null;this.prepared=null;this.save();return next;
  }
  async clipForSettings(clip,video,settings){
    if(!settings.trim||clip.startSec==null||clip.endSec==null)return {clip,video};
    const start=Math.max(0,clip.startSec-settings.trimStartOffsetSec);
    const end=Math.min(video.durationMs/1000,clip.endSec+settings.trimEndOffsetSec);
    if(end-start<0.5)return {clip,video};
    const key=releaseHash({hash:clip.hash,start,end});
    const cached=this.store.db.prepare('SELECT hash,duration_ms FROM full_frame_edits WHERE key=?').get(key);
    if(cached&&existsSync(join(this.mediaDir,cached.hash)))return {clip:{...clip,hash:cached.hash},video:{...video,durationMs:cached.duration_ms}};
    const binary=['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg'].find(existsSync);
    if(!binary)throw new Error('full-frame-ffmpeg-unavailable');
    const temporary=join(this.mediaDir,`full-frame-trim-${randomUUID()}.mp4`);
    try{
      await execFileAsync(binary,['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(start),'-i',join(this.mediaDir,clip.hash),'-t',String(end-start),'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',temporary],{timeout:120000,maxBuffer:1024*1024});
      const digest=createHash('sha256');for await(const chunk of createReadStream(temporary))digest.update(chunk);
      const hash=digest.digest('hex'),durationMs=probeVideo(temporary).durationMs;
      await rename(temporary,join(this.mediaDir,hash));
      const bytes=(await stat(join(this.mediaDir,hash))).size;
      this.store.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?)').run(hash,'video/mp4',bytes);
      this.store.db.prepare('INSERT OR REPLACE INTO full_frame_edits VALUES(?,?,?)').run(key,hash,durationMs);
      return {clip:{...clip,hash},video:{...video,durationMs}};
    }finally{await unlink(temporary).catch(()=>{});}
  }
  start(limit=null){
    if(limit!==null&&(!Number.isInteger(limit)||limit<1||limit>100))throw new Error('invalid-full-frame-limit');
    if(!this.kissing.clips().length)throw new Error('no-kissing-clips-cached');
    if(!this.store.current().layout.slots.some(slot=>this.sessions.has(slot.deviceId)))throw new Error('no-paired-phones-online');
    this.generation++;this.preparing=null;this.prepared=null;
    this.state={...this.state,enabled:true,current:null,next:null,error:null,retryAt:0,limit,playedCount:0};this.save();
    return this.tick();
  }
  stop(){
    this.generation++;this.preparing=null;this.prepared=null;
    if(this.state.next){
      const deployment=this.releases.deployment(this.state.next.id);
      if(['preparing','scheduled'].includes(deployment.phase))this.releases.cancel(deployment.id);
    }
    this.state={...this.state,enabled:false,current:null,next:null,error:null,retryAt:0};this.save();
  }
  tick(now=Date.now()){
    if(!this.state.enabled||this.store.current().mode!=='exhibition')return [];
    if(this.state.next){
      const deployment=this.releases.deployment(this.state.next.id);
      if(deployment.phase==='active'){
        this.state.current=this.state.next;this.state.next=null;this.state.playedCount=(this.state.playedCount??0)+1;this.state.error=null;this.save();
      }else if(['failed','cancelled'].includes(deployment.phase)){
        this.state.next=null;this.state.error=deployment.reason??'full-frame-deployment-failed';this.state.retryAt=now+5000;this.save();
      }
    }
    if(this.state.next||now<this.state.retryAt||this.preparing)return [];
    if(this.state.limit!==null&&this.state.limit!==undefined&&(this.state.playedCount??0)>=this.state.limit)return [];
    let endAt=null;
    if(this.state.current){
      const deployment=this.releases.deployment(this.state.current.id);
      endAt=deployment.startAtServerMs+this.state.current.durationMs;
      if(endAt-now>20000)return [];
    }
    const state=this.store.current();
    const targets=state.layout.slots.filter(slot=>this.sessions.has(slot.deviceId)&&!this.releases.snapshot(slot.deviceId).pending&&this.store.device(slot.deviceId)?.capabilities?.sceneSchemaVersions?.includes(1)).map(slot=>slot.deviceId);
    if(!targets.length)return [];
    const clips=this.prepared?[this.prepared.original]:this.kissing.clips().filter(clip=>clip.hash!==this.state.lastHash);
    if(!clips.length)clips.push(...this.kissing.clips());
    if(!this.prepared)for(let index=clips.length-1;index>0;index--){const other=Math.floor(Math.random()*(index+1));[clips[index],clips[other]]=[clips[other],clips[index]];}
    for(const original of clips){
      try{
        let video=this.metadata.get(original.hash);
        if(!video){video=this.probe(join(this.mediaDir,original.hash));this.metadata.set(original.hash,video);}
        let clip=original;
        if(this.prepared){({clip,video}=this.prepared);this.prepared=null;}
        else if(this.state.settings.trim&&original.startSec!=null&&original.endSec!=null){
          const generation=this.generation,settings={...this.state.settings};
          this.preparing=this.clipForSettings(original,video,settings).then(result=>{
            if(generation===this.generation&&this.state.enabled){this.prepared={...result,original};this.state.error=null;this.save();}
          }).catch(error=>{
            if(generation===this.generation){this.state.error=error.message;this.state.retryAt=Date.now()+10000;this.save();}
          }).finally(()=>{if(generation===this.generation)this.preparing=null;});
          return [];
        }
        const definition=fullFrameDefinition(state.layout,clip,video,this.state.settings);
        const release=this.releases.create(definition);
        const deployment=this.releases.deploy(release.id,targets,{delayMs:1500,timeoutMs:120000,startAtServerMs:endAt});
        this.state.next={id:deployment.id,hash:original.hash,durationMs:video.durationMs};
        this.state.lastHash=original.hash;this.state.error=null;this.save();
        return targets;
      }catch(error){this.state.error=error.message;}
    }
    this.state.retryAt=now+10000;this.save();return [];
  }
}
