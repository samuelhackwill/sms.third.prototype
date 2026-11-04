import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);

export function parseTendaInbox(raw) {
  const data=JSON.parse(raw);
  if(data.errCode===1000)return [];
  const list=data.smsList?.phoneList;
  if(!Array.isArray(list))throw new Error('router-inbox-invalid');
  const records=[];
  for(const entry of list){
    for(const note of entry.note??[]){
      if(note.isSend===true||note.isSend===1||note.isSend==='1')continue;
      const sender=String(entry.phone??''),body=String(note.content??'');
      const stamp=Number(note.time)||0;
      const key=note.id!=null?`${sender}:${note.id}`:`${sender}:${stamp}:${body}`;
      records.push({id:key,text:body,receivedAt:stamp>0?new Date(stamp*1000).toISOString():null,stamp});
    }
  }
  return records.sort((a,b)=>a.stamp-b.stamp);
}

export class TendaReader {
  constructor({config,onRecords,onStatus}){this.config=config;this.onRecords=onRecords;this.onStatus=onStatus;this.stopped=false;this.timer=null;this.cookies='';}
  start(){this.poll();return this;}
  stop(){this.stopped=true;clearTimeout(this.timer);}
  async login(){
    const {createHash}=await import('node:crypto');
    const base=this.config.baseUrl.replace(/\/$/,'');
    const response=await fetch(`${base}/login/Auth`,{method:'POST',headers:{'content-type':'application/json',referer:`${base}/index.html`,origin:base,'x-requested-with':'XMLHttpRequest'},body:JSON.stringify({username:this.config.username,password:createHash('md5').update(this.config.password).digest('hex')}),signal:AbortSignal.timeout(10000)});
    if(!response.ok||(await response.json()).errCode!==0)throw new Error('router-login-failed');
    this.cookies=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  }
  async inbox(){
    const base=this.config.baseUrl.replace(/\/$/,'');
    const query=new URLSearchParams({rand:String(Date.now()),currentPage:'1',pageSizes:String(this.config.pageSize),modules:'smsList'});
    const {stdout}=await execFileAsync('/usr/bin/curl',['-sS','--max-time','20',`${base}/goform/getModules?${query}`,'-H',`Referer: ${base}/index.html`,'-H','X-Requested-With: XMLHttpRequest','-H',`Cookie: ${this.cookies}`,'-H','User-Agent: Mozilla/5.0','-H','Accept: application/json, text/plain, */*'],{encoding:'buffer',maxBuffer:4*1024*1024});
    const raw=Buffer.isBuffer(stdout)?stdout:Buffer.from(stdout);
    let text=new TextDecoder('utf-8',{fatal:true});
    try{return parseTendaInbox(text.decode(raw));}
    catch(error){if(!(error instanceof TypeError))throw error;text=new TextDecoder('gbk');return parseTendaInbox(text.decode(raw));}
  }
  async poll(){
    if(this.stopped)return;
    try{
      await this.login();
      const records=await this.inbox();
      if(!this.stopped){await this.onRecords(records);this.onStatus?.({status:'reading',at:Date.now(),count:records.length});}
    }catch(error){this.onStatus?.({status:'error',at:Date.now(),code:/^router-[a-z-]+$/.test(error.message)?error.message:'router-poll-failed'});}
    if(!this.stopped)this.timer=setTimeout(()=>this.poll(),Math.max(500,this.config.pollIntervalSeconds*1000));
  }
}
