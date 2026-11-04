import { readFile,writeFile,rename,rm,mkdir,readdir,lstat,chown,chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonPlist } from './daemon-config.mjs';
import { messagesAgentPlist } from './install-messages-agent.mjs';
import { root,source,run,revision,writeBuildInfo,healthy,stop,start,serviceActive } from './pull-and-restart.mjs';

const label='org.museum.phonewall';
const updateLabel=label+'.update';
const readerLabel=label+'.messages';

async function moveReaders(){
  for(const entry of await readdir('/Users',{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const home=join('/Users',entry.name),file=join(home,'Library/LaunchAgents',readerLabel+'.plist');
    const info=await lstat(file).catch(()=>null);
    if(!info?.isFile())continue;
    const old=await readFile(file,'utf8');
    if(!old.includes('/Library/Application Support/PhoneWall/app/runtime/bin/node'))continue;
    const domain=`gui/${info.uid}`;
    const active=serviceActive(readerLabel,domain);
    if(active)stop(readerLabel,domain);
    try{
      const temp=file+'.next';
      await writeFile(temp,messagesAgentPlist(home),{mode:0o600});
      await chown(temp,info.uid,info.gid);await chmod(temp,0o600);
      await rename(temp,file);
      if(active)start(readerLabel,domain,file);
    }catch(error){
      await writeFile(file,old,{mode:0o600});
      await chown(file,info.uid,info.gid);
      if(active&&!serviceActive(readerLabel,domain))start(readerLabel,domain,file);
      throw error;
    }
  }
}
async function setup(){
  if(process.platform!=='darwin'||process.getuid?.()!==0)throw new Error('Run setup as administrator');
  const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));
  if(!Number.isInteger(config.port))throw new Error('Invalid controller port');
  if(!await healthy(config.port))throw new Error('Existing controller is not healthy');
  if(!await lstat(source).catch(()=>null)){
    run('/usr/bin/git',['clone','--branch','phone-wall-runtime-2','--single-branch','https://github.com/samuelhackwill/sms.third.prototype.git',source],{timeout:180000});
  }
  if(run('/usr/bin/git',['-C',source,'branch','--show-current'])!=='phone-wall-runtime-2')throw new Error('Unexpected deployment branch');
  await writeBuildInfo(revision());
  run('/usr/local/bin/node',['/usr/local/lib/node_modules/npm/bin/npm-cli.js','ci','--omit=dev','--ignore-scripts','--prefix',join(source,'server/phone-wall')],{timeout:180000});
  const daemon=`/Library/LaunchDaemons/${label}.plist`;
  const old=await readFile(daemon,'utf8');
  const next=daemonPlist(root,join(root,'config.json'),'/Library/Logs/PhoneWall');
  await writeFile(daemon+'.next',next,{mode:0o644});
  run('/usr/bin/plutil',['-lint',daemon+'.next']);
  stop(updateLabel);
  await rm(`/Library/LaunchDaemons/${updateLabel}.plist`,{force:true});
  stop(label);
  try{
    await rename(daemon+'.next',daemon);
    start(label);
    if(!await healthy(config.port))throw new Error('Checkout controller did not become healthy');
  }catch(error){
    stop(label);
    await writeFile(daemon,old,{mode:0o644});
    start(label);
    throw error;
  }
  try{await moveReaders();}catch(error){console.warn(`Messages reader migration needs attention: ${error.message}`);}
  console.log(`Controller now runs from ${source} at ${revision().slice(0,8)}. Pull changes with sudo /usr/local/bin/node ${join(source,'scripts/phone-wall/pull-and-restart.mjs')}. GitHub polling is off.`);
}
if(process.argv[1]===fileURLToPath(import.meta.url))await setup();
