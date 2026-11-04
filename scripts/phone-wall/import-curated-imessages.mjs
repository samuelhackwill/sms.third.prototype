import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspectMessages,readMessageBatch,decodeAttributedBodies } from '../../server/phone-wall/messages-reader.mjs';

const root='/Library/Application Support/PhoneWall';
const config=JSON.parse(await readFile(process.env.PHONE_WALL_CONFIG_FILE??join(root,'config.json'),'utf8'));
const token=(await readFile(config.adminTokenFile,'utf8')).trim();
const dbPath=process.env.MESSAGES_DB_PATH??join(homedir(),'Library/Messages/chat.db');
const {maxRowId}=await inspectMessages(dbPath);
const decode=async blobs=>{
  try{return await decodeAttributedBodies(blobs);}
  catch{
    const texts=[];
    for(const blob of blobs)texts.push((await decodeAttributedBodies([blob]).catch(()=>['']))[0]);
    return texts;
  }
};
let cursor=0,imported=0;
while(cursor<maxRowId){
  const batch=await readMessageBatch(dbPath,cursor,{decode,limit:50});
  if(batch.lastRowId<=cursor)throw new Error('messages-import-stalled');
  const records=batch.records.map(record=>({id:record.id??`imessage:local:${record.rowId}`,text:record.text,receivedAt:record.receivedAt}));
  if(records.length){
    const response=await fetch(`http://127.0.0.1:${config.port}/phone-wall/curated/import`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({records}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`curated-import-http-${response.status}`);
    imported+=(await response.json()).inserted;
  }
  cursor=batch.lastRowId;
}
console.log(`Imported ${imported} incoming Messages texts into the curated library.`);
