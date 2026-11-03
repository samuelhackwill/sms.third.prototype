import { spawnSync } from 'node:child_process';
import { mkdir,readFile,writeFile,cp,readdir,lstat,rm,rename,mkdtemp } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDashboardIcon } from './dashboard-icon.mjs';

const repository='samuelhackwill/sms.third.prototype',branch='phone-wall-runtime-2';
const root='/Library/Application Support/PhoneWall',label='org.museum.phonewall';
function run(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:8*1024*1024,timeout:180000});
  if(result.error||result.status!==0)throw new Error(`${command} failed: ${result.error?.message??result.stderr?.slice(-2000)??result.status}`);
  return result.stdout;
}
async function regularTree(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(entry.isSymbolicLink())throw new Error('Source links are not supported');
    if(entry.isDirectory())await regularTree(join(directory,entry.name));
  }
}
export async function compatibleSource(source,{nodeMajor=Number(process.versions.node.split('.')[0])}={}) {
  for(const path of ['server/phone-wall','protocol','scripts/phone-wall']) {
    const info=await lstat(join(source,path));
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid update source');
    await regularTree(join(source,path));
  }
  let format;
  try {format=JSON.parse(await readFile(join(source,'server/phone-wall/update-format.json'),'utf8'));}
  catch {throw new Error('Published GitHub source is not updater-ready. Commit and push the current source first. The installation was not changed.');}
  if(format.format!==1||!/^\d+\.\d+\.\d+$/.test(format.version)||!Number.isInteger(format.minimumNodeMajor)||format.minimumNodeMajor<1||format.minimumNodeMajor>nodeMajor)throw new Error('Incompatible update; use a reviewed installer instead');
  for(const path of ['server/phone-wall/package-lock.json','server/phone-wall/index.mjs','server/phone-wall/installation.mjs','server/phone-wall/discovery.mjs','scripts/phone-wall/update-from-github.mjs']) {
    if(!(await lstat(join(source,path))).isFile())throw new Error('Incomplete source update');
  }
  return format;
}
async function download(url,limit) {
  const response=await fetch(url,{headers:{'User-Agent':'Phone-Wall-Updater'},signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`GitHub download failed (${response.status}); the current installation was not changed`);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('Update download exceeds size limit');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function connectedPhones(port,token) {
  try {
    const response=await fetch(`http://127.0.0.1:${port}/phone-wall/api`,{
      headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1000)});
    if(!response.ok)return null;
    return (await response.json()).devices.filter(device=>device.connected).length;
  }catch{return null;}
}
async function stopService() {
  if(spawnSync('/bin/launchctl',['print','system/'+label],{stdio:'ignore'}).status===0)run('/bin/launchctl',['bootout','system/'+label]);
}
function startService(){run('/bin/launchctl',['bootstrap','system',`/Library/LaunchDaemons/${label}.plist`]);}
export async function activateUpdate({directory,candidate,stop,start,backup,healthy}) {
  const app=join(directory,'app'),previous=join(directory,'app.previous');
  await rm(previous,{recursive:true,force:true});
  await stop();
  let swapped=false;
  try {
    await backup();
    await rename(app,previous);
    try {await rename(candidate,app);}catch(error){await rename(previous,app);throw error;}
    swapped=true;await start();
    if(!await healthy())throw new Error('Updated controller did not pass its startup check');
  } catch(error) {
    await stop();
    if(swapped){await rename(app,candidate);await rename(previous,app);}
    await start();
    throw error;
  }
}
async function update() {
  if(process.platform!=='darwin'||process.getuid?.()!==0)throw new Error('Run Update Phone Wall from Applications and approve administrator access');
  const lock=join(root,'update.lock');
  await mkdir(lock); // Exclusive directory prevents concurrent swaps.
  let work;
  try {
    work=await mkdtemp(join(root,'.update-'));
    const ref=JSON.parse((await download(`https://api.github.com/repos/${repository}/git/ref/heads/${branch}`,1024*1024)).toString());
    const commit=ref.object?.sha;
    if(!/^[a-f0-9]{40}$/.test(commit??''))throw new Error('Invalid GitHub commit');
    const archive=join(work,'source.tar.gz');
    await writeFile(archive,await download(`https://codeload.github.com/${repository}/tar.gz/${commit}`,200*1024*1024));
    const entries=run('/usr/bin/tar',['-tzf',archive]).trim().split('\n');
    if(entries.some(path=>path.startsWith('/')||path.split('/').includes('..')))throw new Error('Unsafe archive path');
    if(run('/usr/bin/tar',['-tvzf',archive]).trim().split('\n').some(line=>!['-','d'].includes(line[0])))throw new Error('Archive links/special files are not supported');
    const source=join(work,'source');await mkdir(source);
    run('/usr/bin/tar',['-xzf',archive,'-C',source,'--strip-components','1']);
    const format=await compatibleSource(source),candidate=join(work,'app');
    await mkdir(join(candidate,'server/phone-wall'),{recursive:true,mode:0o755});
    const service=join(candidate,'server/phone-wall');
    for(const name of await readdir(join(source,'server/phone-wall')))
      if(name.endsWith('.mjs')||['public','package.json','package-lock.json','update-format.json'].includes(name))await cp(join(source,'server/phone-wall',name),join(service,name),{recursive:true});
    await cp(join(source,'protocol'),join(candidate,'protocol'),{recursive:true});
    await cp(join(source,'scripts/phone-wall'),join(candidate,'scripts/phone-wall'),{recursive:true});
    await cp(join(root,'app/runtime'),join(candidate,'runtime'),{recursive:true});
    const node=join(candidate,'runtime/bin/node'),npm=join(candidate,'runtime/lib/node_modules/npm/bin/npm-cli.js');
    run(node,[npm,'ci','--omit=dev','--ignore-scripts','--prefix',service]);
    const smokeData=join(work,'smoke-data');
    run(node,['--input-type=module','-e',`const {createController}=await import(${JSON.stringify(join(service,'app.mjs'))});const {app}=await createController({dataDir:${JSON.stringify(smokeData)},adminToken:'update-smoke-private-key-0000000000000000'});try{for(const url of ['/health','/admin/phone-wall']){const r=await app.inject({url});if(r.statusCode!==200)throw new Error('Update validation failed');}}finally{await app.close();}`]);
    await writeFile(join(candidate,'build-info.json'),JSON.stringify({version:format.version,gitCommit:commit,nodeVersion:process.version,updatedAt:new Date().toISOString()},null,2));
    const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));
    const operatorKey=(await readFile(config.adminTokenFile,'utf8')).trim();
    const connectedBefore=await connectedPhones(config.port,operatorKey);
    await activateUpdate({directory:root,candidate,stop:stopService,start:startService,
      backup:async()=>{
        const backup=join(root,'update-backup');await mkdir(backup,{recursive:true,mode:0o700});
        const database=join(root,'data/controller.sqlite'),backupFile=join(backup,'controller.sqlite');
        await rm(backupFile,{force:true});
        run(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(database)});try{db.exec('VACUUM INTO '+"'"+${JSON.stringify(backupFile)}.replaceAll("'","''")+"'");}finally{db.close();}`]);
      },
      healthy:async()=>{
        for(let i=0;i<30;i++){
          try {const response=await fetch(`http://127.0.0.1:${config.port}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok&&(await response.json()).ok===true)return true;}catch{}
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
        return false;
      }});
    if(connectedBefore!==null) {
      let connectedAfter=await connectedPhones(config.port,operatorKey);
      for(let i=0;i<20&&connectedAfter!==null&&connectedAfter<connectedBefore;i++) {
        await new Promise(resolve=>setTimeout(resolve,1000));
        connectedAfter=await connectedPhones(config.port,operatorKey);
      }
      console.log(`Phone connections after update: ${connectedAfter??'unavailable'} / ${connectedBefore} before update.`);
    }
    try {await applyDashboardIcon({iconFile:join(root,'app/scripts/phone-wall/assets/dashboard.icns')});}
    catch(error){throw new Error(`Server updated, but the dashboard icon could not be applied. Run Update Phone Wall again. ${error.message}`);}
    console.log(`Updated to ${format.version} (${commit.slice(0,8)}). Open Phone Wall Dashboard.`);
  } finally {
    if(work)await rm(work,{recursive:true,force:true});
    await rm(lock,{recursive:true,force:true});
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await update();
