import { spawnSync } from 'node:child_process';
import { readFile,writeFile,rm,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root='/Library/Application Support/PhoneWall';
export const source=join(root,'source');
const label='org.museum.phonewall';
const reader='org.museum.phonewall.messages';

export function run(command,args,{timeout=180000}={}) {
  const result=spawnSync(command,args,{encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  if(result.error||result.status!==0)throw new Error(`${command} failed: ${result.error?.message??result.stderr?.trim()??result.status}`);
  return result.stdout.trim();
}
export function revision(){return run('/usr/bin/git',['-C',source,'rev-parse','HEAD']);}
export function serviceActive(name,domain='system'){
  return spawnSync('/bin/launchctl',['print',`${domain}/${name}`],{stdio:'ignore'}).status===0;
}
export function stop(name,domain='system'){
  if(serviceActive(name,domain))run('/bin/launchctl',['bootout',`${domain}/${name}`]);
}
export function start(name,domain='system',file=`/Library/LaunchDaemons/${name}.plist`){
  let last;
  for(let attempt=0;attempt<6;attempt++){
    try{return run('/bin/launchctl',['bootstrap',domain,file]);}
    catch(error){last=error;spawnSync('/bin/sleep',['1']);}
  }
  throw last;
}
export async function healthy(port){
  for(let attempt=0;attempt<45;attempt++){
    try{
      const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1500)});
      if(response.ok&&(await response.json()).ok===true)return true;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return false;
}
export async function writeBuildInfo(commit){
  const format=JSON.parse(await readFile(join(source,'server/phone-wall/update-format.json'),'utf8'));
  if(format.format!==1||format.minimumNodeMajor>Number(process.versions.node.split('.')[0]))throw new Error('Incompatible controller source');
  await writeFile(join(source,'build-info.json'),JSON.stringify({version:format.version,gitCommit:commit,nodeVersion:process.version,updatedAt:new Date().toISOString()},null,2)+'\n');
}
export async function restartReaders(){
  const {readdir,lstat}=await import('node:fs/promises');
  for(const entry of await readdir('/Users',{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const file=join('/Users',entry.name,'Library/LaunchAgents',reader+'.plist');
    const info=await lstat(file).catch(()=>null);
    if(!info?.isFile())continue;
    const domain=`gui/${info.uid}`;
    if(serviceActive(reader,domain))run('/bin/launchctl',['kickstart','-k',`${domain}/${reader}`]);
  }
}
async function pull(){
  if(process.platform!=='darwin'||process.getuid?.()!==0)throw new Error('Run as administrator');
  const lock=join(root,'pull.lock');
  await mkdir(lock);
  try{
    const current=revision();
    if(run('/usr/bin/git',['-C',source,'status','--porcelain','--untracked-files=no']))throw new Error('Deployment checkout has local changes');
    const branch=run('/usr/bin/git',['-C',source,'branch','--show-current']);
    if(branch!=='phone-wall-runtime-2')throw new Error('Unexpected deployment branch');
    run('/usr/bin/git',['-C',source,'fetch','origin','phone-wall-runtime-2']);
    const next=run('/usr/bin/git',['-C',source,'rev-parse','FETCH_HEAD']);
    if(next===current){console.log(`Already current at ${current.slice(0,8)}.`);return;}
    if(run('/usr/bin/git',['-C',source,'merge-base',current,next])!==current)throw new Error('Remote branch did not advance from installed commit');
    const beforeLock=await readFile(join(source,'server/phone-wall/package-lock.json'));
    run('/usr/bin/git',['-C',source,'merge','--ff-only',next]);
    let stopped=false;
    let afterLock;
    try{
      afterLock=await readFile(join(source,'server/phone-wall/package-lock.json'));
      if(afterLock&&!beforeLock.equals(afterLock))run('/usr/local/bin/node',['/usr/local/lib/node_modules/npm/bin/npm-cli.js','ci','--omit=dev','--ignore-scripts','--prefix',join(source,'server/phone-wall')]);
      await writeBuildInfo(next);
      const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));
      stop(label);stopped=true;start(label);
      if(!await healthy(config.port))throw new Error('Updated controller did not become healthy');
      try{await restartReaders();}catch(error){console.warn(`Messages reader restart deferred: ${error.message}`);}
      console.log(`Pulled ${next.slice(0,8)} and restarted controller and Messages reader.`);
    }catch(error){
      if(stopped)stop(label);
      run('/usr/bin/git',['-C',source,'reset','--hard',current]);
      await writeBuildInfo(current);
      if(afterLock&&!beforeLock.equals(afterLock))run('/usr/local/bin/node',['/usr/local/lib/node_modules/npm/bin/npm-cli.js','ci','--omit=dev','--ignore-scripts','--prefix',join(source,'server/phone-wall')]);
      if(stopped){start(label);await healthy(JSON.parse(await readFile(join(root,'config.json'),'utf8')).port);}
      throw error;
    }
  }finally{await rm(lock,{recursive:true,force:true});}
}
async function main(){
  const requestFile=join(root,'requests/pull.json');
  const statusFile=join(root,'pull-status.json');
  let request;
  for(let attempt=0;attempt<5;attempt++){
    try{request=JSON.parse(await readFile(requestFile,'utf8'));break;}
    catch{await new Promise(resolve=>setTimeout(resolve,100));}
  }
  const id=/^[a-f0-9-]{36}$/.test(request?.id??'')?request.id:null;
  const status=await readFile(statusFile,'utf8').then(JSON.parse).catch(()=>null);
  if(id&&status?.id===id)return;
  const report=async(state,detail)=>{if(id)await writeFile(statusFile,JSON.stringify({id,state,detail,at:new Date().toISOString()})+'\n',{mode:0o644});};
  await report('running',null);
  try{await pull();await report('complete',revision());}
  catch(error){await report('error',error.message);throw error;}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
