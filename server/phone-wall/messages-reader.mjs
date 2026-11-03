import { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { stat,realpath,mkdir,readFile,writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration } from './installation.mjs';
import { displayMessage } from './live-ticker.mjs';

const appleEpoch=Date.UTC(2001,0,1);
export function appleDate(value){try{const n=BigInt(typeof value==='number'?Math.trunc(value):value??0);if(n<=0n)return null;const ms=n>1000000000000n?n/1000000n:n*1000n;const date=new Date(appleEpoch+Number(ms));return Number.isFinite(date.getTime())?date.toISOString():null;}catch{return null;}}
function open(path){const db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');return db;}
export async function inspectMessages(path){
  const info=await stat(path),db=open(path);
  try{const statement=db.prepare('SELECT IFNULL(MAX(ROWID),0) AS n FROM message');statement.setReadBigInts(true);return {databaseId:createHash('sha256').update(`${await realpath(path)}:${info.dev}:${info.ino}`).digest('hex'),maxRowId:Number(statement.get().n)};}
  finally{db.close();}
}
export async function decodeAttributedBodies(blobs){
  if(!blobs.length)return [];
  if(process.platform!=='darwin')throw new Error('attributed-decoder-requires-macos');
  // Messages still uses legacy NSArchiver typedstreams; never guess UTF-8 blob offsets.
  const script=`ObjC.import('AppKit');
    var input=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var values=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input,$.NSUTF8StringEncoding)));
    JSON.stringify(values.map(function(item){try{
      var data=$.NSData.alloc.initWithBase64EncodedStringOptions(item.data,0);
      var value=item.keyed?$.NSKeyedUnarchiver.unarchiveObjectWithData(data):$.NSUnarchiver.unarchiveObjectWithData(data);
      return {text:ObjC.unwrap(value.string)};
    }catch(error){return {error:true};}}));`;
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/osascript',['-l','JavaScript','-e',script],{stdio:['pipe','pipe','ignore']});
    let result='',settled=false;
    const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();reject(new Error('attributed-body-decode-failed'));};
    const timer=setTimeout(fail,10000);
    child.on('error',fail);child.stdin.on('error',fail);
    child.stdout.on('data',chunk=>{result+=chunk;if(result.length>4*1024*1024)fail();});
    child.on('close',code=>{
      if(settled)return;
      try{if(code!==0)throw new Error();const values=JSON.parse(result);if(values.length!==blobs.length||values.some(v=>v.error||typeof v.text!=='string'))throw new Error();settled=true;clearTimeout(timer);resolve(values.map(v=>v.text));}catch{fail();}
    });
    child.stdin.end(JSON.stringify(blobs.map(blob=>{const data=Buffer.from(blob);return {data:data.toString('base64'),keyed:data.subarray(0,8).toString()==='bplist00'};})));
  });
}
export async function readMessageBatch(path,cursor,{decode=decodeAttributedBodies,limit=50}={}){
  const db=open(path);let rows;
  try{
    const columns=new Set(db.prepare('PRAGMA table_info(message)').all().map(c=>c.name));
    if(!columns.has('is_from_me')||!columns.has('date'))throw new Error('unsupported-messages-schema');
    const column=(name,fallback)=>columns.has(name)?`"${name}"`:fallback;
    const statement=db.prepare(`SELECT ROWID AS rowId,${column('guid','NULL')} AS guid,${column('text','NULL')} AS text,${column('attributedBody','NULL')} AS body,date,is_from_me,${column('associated_message_type','0')} AS associated,${column('is_system_message','0')} AS system FROM message WHERE ROWID>? ORDER BY ROWID LIMIT ?`);
    statement.setReadBigInts(true);rows=statement.all(BigInt(cursor),limit);
  }finally{db.close();}
  const incoming=rows.filter(row=>Number(row.is_from_me)===0&&Number(row.associated)===0&&Number(row.system)===0);
  const encoded=incoming.filter(row=>!displayMessage(row.text??'')&&row.body?.length);
  if(encoded.some(row=>row.body.length>1024*1024))throw new Error('attributed-body-too-large');
  const decoded=await decode(encoded.map(row=>row.body));
  encoded.forEach((row,index)=>{row.text=decoded[index];});
  let lastRowId=cursor,bytes=0;const records=[];
  for(const row of rows){
    if(incoming.includes(row)){
      const text=displayMessage(row.text??'');
      if(text){
        const item={rowId:Number(row.rowId),id:row.guid?`imessage:${row.guid}`:null,text,receivedAt:appleDate(row.date)};
        const size=Buffer.byteLength(JSON.stringify(item))+256;
        if(bytes+size>48000)break;
        records.push(item);bytes+=size;
      }
    }
    lastRowId=Number(row.rowId);
  }
  return {records,lastRowId};
}
export class MessagesReader {
  constructor({dbPath,sourceId,url,token,decode}){Object.assign(this,{dbPath,sourceId,url,token,decode});}
  async request(payload){
    const response=await fetch(`${this.url}/phone-wall/reader/${this.sourceId}`,{method:payload?'POST':'GET',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(5000)});
    if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(['ticker-queue-capacity','reader-cursor-conflict','reader-disabled'].includes(detail.error)?detail.error:'reader-controller-request-failed');}return response.json();
  }
  async poll(){
    const control=await this.request();
    if(!control.enabled){await this.request({action:'status',code:'paused'});return;}
    try{
      const database=await inspectMessages(this.dbPath),cursor=control.cursor;
      if(!cursor?.database_id||cursor.database_id!==database.databaseId){await this.request({action:'batch',...database,lastRowId:database.maxRowId,baseline:true});return;}
      if(database.maxRowId<cursor.row_id)throw new Error('messages-database-rowids-reset');
      const batch=await readMessageBatch(this.dbPath,cursor.row_id,{decode:this.decode});
      batch.records.forEach(record=>{record.id??=`imessage:${this.sourceId}:${database.databaseId}:${record.rowId}`;});
      await this.request({action:'batch',databaseId:database.databaseId,expectedRowId:cursor.row_id,...batch});
    }catch(error){
      if(error.message==='reader-disabled')return;
      const code=['EACCES','EPERM'].includes(error.code)||/authorization denied|unable to open database/i.test(error.message)?'needs-full-disk-access':error.code==='ENOENT'?'messages-database-not-found':/^attributed|^unsupported|^messages-database-rowids|^ticker-queue-capacity/.test(error.message)?error.message:'messages-read-failed';
      try{await this.request({action:'status',code});}catch{}
      throw new Error(code);
    }
  }
}
async function main(){
  if(process.platform!=='darwin'||process.getuid?.()===0)throw new Error('Run the Messages reader as the logged-in Messages user, not root');
  const directory=join(homedir(),'Library/Application Support/PhoneWallReader');await mkdir(directory,{recursive:true,mode:0o700});
  const file=join(directory,'identity.json');let sourceId;
  try{sourceId=JSON.parse(await readFile(file,'utf8')).sourceId;}catch(error){if(error.code!=='ENOENT')throw error;sourceId=randomUUID();await writeFile(file,JSON.stringify({sourceId}),{mode:0o600,flag:'wx'});}
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(sourceId))throw new Error('invalid-reader-identity');
  let stopped=false,attempt=0,lastError='',wake;
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopped=true;wake?.();});
  while(!stopped){
    try{
      const config=configuration();
      await new MessagesReader({dbPath:process.env.MESSAGES_DB_PATH??join(homedir(),'Library/Messages/chat.db'),sourceId,url:`http://127.0.0.1:${config.port}`,token:config.adminToken}).poll();
      attempt=0;lastError='';
    }catch(error){if(error.message!==lastError){console.error(error.message);lastError=error.message;}attempt++;}
    if(!stopped)await new Promise(resolve=>{const timer=setTimeout(()=>{wake=null;resolve();},Math.min(30000,1000*2**Math.min(attempt,5)));wake=()=>{clearTimeout(timer);wake=null;resolve();};});
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
