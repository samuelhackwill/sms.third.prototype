import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { releaseHash } from './scenes.mjs';

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

export function fullFrameDefinition(layout,clip,video) {
  const slots=layout.slots;
  if(!slots.length)throw new Error('pair-phones-before-full-frame-clips');
  const left=Math.min(...slots.map(slot=>slot.geometry.x)),top=Math.min(...slots.map(slot=>slot.geometry.y));
  const right=Math.max(...slots.map(slot=>slot.geometry.x+slot.geometry.width));
  const bottom=Math.max(...slots.map(slot=>slot.geometry.y+slot.geometry.height));
  const wallWidth=right-left,wallHeight=bottom-top,videoAspect=video.width/video.height;
  const width=Math.max(wallWidth,wallHeight*videoAspect),height=Math.max(wallHeight,wallWidth/videoAspect);
  const frame={x:left-(width-wallWidth)/2,y:top-(height-wallHeight)/2,width,height};
  return {sceneSchemaVersion:1,artworkId:'full-frame-clips',artworkVersion:releaseHash({hash:clip.hash,layout,frame}),canvas:{width:right,height:bottom},background:'#000000',transition:{type:'cut',durationMs:0},elements:[{id:'wall-video',type:'video',asset:clip.hash,frame}]};
}

export class FullFrameClips {
  constructor({store,releases,kissing,mediaDir,sessions,probe=probeVideo}) {
    Object.assign(this,{store,releases,kissing,mediaDir,sessions,probe});
    store.db.exec('CREATE TABLE IF NOT EXISTS full_frame_clips(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
    const saved=store.db.prepare('SELECT data FROM full_frame_clips WHERE id=1').get();
    this.state=saved?JSON.parse(saved.data):{enabled:false,current:null,next:null,lastHash:null,error:null,retryAt:0};
    this.metadata=new Map();
  }
  save(){this.store.db.prepare('INSERT INTO full_frame_clips(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(this.state));}
  status(){return {...this.state,clips:this.kissing.clips().length,phase:this.state.current?'playing':this.state.next?'preparing':'waiting'};}
  start(){
    if(!this.kissing.clips().length)throw new Error('no-kissing-clips-cached');
    if(!this.store.current().layout.slots.some(slot=>this.sessions.has(slot.deviceId)))throw new Error('no-paired-phones-online');
    this.state={enabled:true,current:null,next:null,lastHash:this.state.lastHash??null,error:null,retryAt:0};this.save();
    return this.tick();
  }
  stop(){
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
        this.state.current=this.state.next;this.state.next=null;this.state.error=null;this.save();
      }else if(['failed','cancelled'].includes(deployment.phase)){
        this.state.next=null;this.state.error=deployment.reason??'full-frame-deployment-failed';this.state.retryAt=now+5000;this.save();
      }
    }
    if(this.state.next||now<this.state.retryAt)return [];
    let remaining=0;
    if(this.state.current){
      const deployment=this.releases.deployment(this.state.current.id);
      remaining=deployment.startAtServerMs+this.state.current.durationMs-now;
      if(remaining>20000)return [];
    }
    const state=this.store.current();
    const targets=state.layout.slots.filter(slot=>this.sessions.has(slot.deviceId)&&!this.releases.snapshot(slot.deviceId).pending&&this.store.device(slot.deviceId)?.capabilities?.sceneSchemaVersions?.includes(1)).map(slot=>slot.deviceId);
    if(!targets.length)return [];
    const clips=this.kissing.clips().filter(clip=>clip.hash!==this.state.lastHash);
    if(!clips.length)clips.push(...this.kissing.clips());
    for(let index=clips.length-1;index>0;index--){const other=Math.floor(Math.random()*(index+1));[clips[index],clips[other]]=[clips[other],clips[index]];}
    for(const clip of clips){
      try{
        let video=this.metadata.get(clip.hash);
        if(!video){video=this.probe(join(this.mediaDir,clip.hash));this.metadata.set(clip.hash,video);}
        const definition=fullFrameDefinition(state.layout,clip,video);
        const release=this.releases.create(definition);
        const deployment=this.releases.deploy(release.id,targets,{delayMs:Math.max(1000,Math.min(30000,Math.round(remaining)||1500)),timeoutMs:120000});
        this.state.next={id:deployment.id,hash:clip.hash,durationMs:video.durationMs};
        this.state.lastHash=clip.hash;this.state.error=null;this.save();
        return targets;
      }catch(error){this.state.error=error.message;}
    }
    this.state.retryAt=now+10000;this.save();return [];
  }
}
