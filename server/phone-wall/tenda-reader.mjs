import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const outgoing=note=>[true,1,'1','true'].includes(note.isSend);
function record(sender,note){
  const body=String(note.content??''),stamp=Number(note.time)||0;
  const key=note.id!=null?`${sender}:${note.id}`:`${sender}:${stamp}:${body}`;
  return {id:key,sender,routerId:note.id!=null?String(note.id):null,routerIdRaw:note.id??null,text:body,receivedAt:stamp>0?new Date(stamp*1000).toISOString():null,stamp};
}

export function parseTendaInboxDetailed(raw) {
  const data=JSON.parse(raw);
  if(data.errCode===1000)return {records:[],stats:{emptyResponse:true,threads:0,notes:0,incoming:0,uniqueIds:0,blankBodies:0}};
  const list=data.smsList?.phoneList;
  if(!Array.isArray(list))throw new Error('router-inbox-invalid');
  const records=[];
  let notes=0,blankBodies=0;
  for(const entry of list){
    for(const note of entry.note??[]){
      notes++;
      if(outgoing(note))continue;
      const item=record(String(entry.phone??''),note);
      if(!item.text.trim())blankBodies++;
      records.push(item);
    }
  }
  records.sort((a,b)=>a.stamp-b.stamp);
  return {records,stats:{emptyResponse:false,threads:list.length,notes,incoming:records.length,uniqueIds:new Set(records.map(record=>record.id)).size,blankBodies}};
}
export const parseTendaInbox=raw=>parseTendaInboxDetailed(raw).records;
export function parseTendaConversation(raw,sender){
  const notes=JSON.parse(raw).smsPhoneList;
  if(!Array.isArray(notes))throw new Error('router-conversation-invalid');
  return notes.filter(note=>!outgoing(note)).map(note=>record(sender,note)).sort((a,b)=>a.stamp-b.stamp);
}

export class TendaReader {
  constructor({config,onRecords,onStatus,pendingDeletes=()=>[],onDeleteAttempt=()=>{},onDeleteConfirmed=()=>{}}){this.config=config;this.onRecords=onRecords;this.onStatus=onStatus;this.pendingDeletes=pendingDeletes;this.onDeleteAttempt=onDeleteAttempt;this.onDeleteConfirmed=onDeleteConfirmed;this.stopped=false;this.timer=null;this.deleteTimer=null;this.cookies='';this.failures=0;this.threads=new Map();this.lastFullRefresh=0;this.lastLoginAt=0;this.deleteError=null;}
  start(){this.poll();return this;}
  stop(){this.stopped=true;clearTimeout(this.timer);clearTimeout(this.deleteTimer);}
  async login(){
    const {createHash}=await import('node:crypto');
    const base=this.config.baseUrl.replace(/\/$/,'');
    const response=await fetch(`${base}/login/Auth`,{method:'POST',headers:{'content-type':'application/json',referer:`${base}/index.html`,origin:base,'x-requested-with':'XMLHttpRequest'},body:JSON.stringify({username:this.config.username,password:createHash('md5').update(this.config.password).digest('hex')}),signal:AbortSignal.timeout(10000)});
    if(!response.ok||(await response.json()).errCode!==0)throw new Error('router-login-failed');
    this.cookies=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
    this.lastLoginAt=Date.now();
  }
  async module(parameters){
    const base=this.config.baseUrl.replace(/\/$/,'');
    const query=new URLSearchParams({rand:String(Date.now()),...parameters});
    const {stdout}=await execFileAsync('/usr/bin/curl',['-sS','--max-time','20',`${base}/goform/getModules?${query}`,'-H',`Referer: ${base}/index.html`,'-H','X-Requested-With: XMLHttpRequest','-H',`Cookie: ${this.cookies}`,'-H','User-Agent: Mozilla/5.0','-H','Accept: application/json, text/plain, */*'],{encoding:'buffer',maxBuffer:4*1024*1024});
    const raw=Buffer.isBuffer(stdout)?stdout:Buffer.from(stdout);
    let text=new TextDecoder('utf-8',{fatal:true});
    try{return text.decode(raw);}
    catch(error){if(!(error instanceof TypeError))throw error;text=new TextDecoder('gbk');return text.decode(raw);}
  }
  async deleteMessages(sender,ids){
    const base=this.config.baseUrl.replace(/\/$/,'');
    const {stdout}=await execFileAsync('/usr/bin/curl',['-sS','--max-time','10',`${base}/goform/setModules`,'-X','POST','-H',`Referer: ${base}/index.html`,'-H','X-Requested-With: XMLHttpRequest','-H',`Cookie: ${this.cookies}`,'-H','Content-Type: application/json; charset=UTF-8','-H','Accept: application/json, text/plain, */*','--data-binary',JSON.stringify({delSmsList:{phone:sender,idList:ids}})],{encoding:'utf8',maxBuffer:1024*1024});
    if(Number(JSON.parse(stdout).errCode)!==0)throw new Error('router-delete-rejected');
  }
  async cleanup(){
    if(this.stopped)return;
    try{
      const batch=await this.pendingDeletes(100);
      if(batch.length&&this.cookies){
        const sender=batch[0].sender;
        const before=parseTendaConversation(await this.module({phone:sender,modules:'smsPhoneList'}),sender);
        await this.onRecords(before,{detailed:true});
        const refreshed=await this.pendingDeletes(100);
        const items=refreshed.filter(item=>item.sender===sender);
        if(!items.length){this.deleteError=null;return;}
        this.onDeleteAttempt(items.map(item=>item.externalId));
        const matches=items.map(item=>({item,note:before.find(note=>note.routerId===item.routerId&&note.text===item.text&&note.receivedAt===item.receivedAt)})).filter(match=>match.note);
        const missing=items.filter(item=>!matches.some(match=>match.item===item));
        if(missing.length)this.onDeleteConfirmed(missing.map(item=>item.externalId));
        if(matches.length){
          await this.deleteMessages(sender,matches.map(match=>match.note.routerIdRaw));
          const after=parseTendaConversation(await this.module({phone:sender,modules:'smsPhoneList'}),sender);
          await this.onRecords(after,{detailed:true});
          const targetIds=new Set(matches.map(({note})=>note.id));
          if(before.some(note=>!targetIds.has(note.id)&&!after.some(remaining=>remaining.id===note.id))){
            this.deletionDisabled=true;
            throw new Error('router-delete-removed-other-messages');
          }
          const confirmed=matches.filter(({item})=>!after.some(note=>note.routerId===item.routerId&&note.text===item.text&&note.receivedAt===item.receivedAt));
          if(confirmed.length)this.onDeleteConfirmed(confirmed.map(({item})=>item.externalId));
          if(confirmed.length!==matches.length)throw new Error('router-delete-unconfirmed');
        }
        this.deleteError=null;
      }
    }catch(error){this.deleteError=/^router-[a-z-]+$/.test(error.message)?error.message:'router-delete-failed';}
  }
  async inbox(){
    const raw=await this.module({currentPage:'1',pageSizes:String(this.config.pageSize),modules:'smsList'});
    const overview=parseTendaInboxDetailed(raw);
    if(overview.stats.emptyResponse)return {records:[],stats:overview.stats,detailed:false};
    const entries=JSON.parse(raw).smsList.phoneList;
    const fullRefresh=Date.now()-this.lastFullRefresh>=30000;
    const changed=entries.filter(entry=>entry.phone&&(fullRefresh||this.threads.get(String(entry.phone))!==JSON.stringify(entry.note??[])));
    const records=[];
    for(const entry of changed){
      const sender=String(entry.phone);
      records.push(...parseTendaConversation(await this.module({phone:sender,modules:'smsPhoneList'}),sender));
    }
    records.sort((a,b)=>a.stamp-b.stamp);
    for(const entry of changed)this.threads.set(String(entry.phone),JSON.stringify(entry.note??[]));
    if(fullRefresh)this.lastFullRefresh=Date.now();
    return {records,stats:{emptyResponse:false,threads:entries.length,overviewNotes:overview.stats.notes,overviewIncoming:overview.stats.incoming,overviewOutgoing:overview.stats.notes-overview.stats.incoming,detailThreads:changed.length,detailNotes:records.length,incoming:records.length,uniqueIds:new Set(records.map(item=>item.id)).size,blankBodies:records.filter(item=>!item.text.trim()).length,idTypes:{number:records.filter(item=>typeof item.routerIdRaw==='number').length,string:records.filter(item=>typeof item.routerIdRaw==='string').length}},detailed:true};
  }
  async poll(){
    if(this.stopped)return;
    let phase='login';
    try{
      if(!this.cookies)await this.login();
      phase='inbox';
      const {records,stats,detailed}=await this.inbox();
      if(stats.emptyResponse&&Date.now()-(this.lastNonempty?.at??0)>30000&&Date.now()-this.lastLoginAt>60000)this.cookies='';
      phase='ingest';
      if(!this.stopped){const ingestion=await this.onRecords(records,{detailed});this.failures=0;if(records.length)this.lastNonempty={at:Date.now(),...stats};if(!this.deletionDisabled)await this.cleanup();this.onStatus?.({status:'reading',at:Date.now(),count:records.length,stats,inserted:ingestion?.inserted??0,baselined:ingestion?.baselined??0,lastNonempty:this.lastNonempty,deleteError:this.deleteError});}
    }catch(error){
      if(phase==='inbox')this.cookies='';
      this.failures++;
      this.onStatus?.({status:'error',at:Date.now(),code:/^router-[a-z-]+$/.test(error.message)?error.message:`router-${phase}-failed`});
    }
    if(!this.stopped)this.timer=setTimeout(()=>this.poll(),this.failures?Math.min(60000,5000*2**Math.min(this.failures-1,4)):Math.max(500,this.config.pollIntervalSeconds*1000));
  }
}
