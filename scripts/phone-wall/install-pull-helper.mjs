import { spawnSync } from 'node:child_process';
import { mkdir,copyFile,writeFile,chmod,chown,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeXml } from './daemon-config.mjs';

const root='/Library/Application Support/PhoneWall';
const label='org.museum.phonewall.pull';
function identity(user,flag){
  const result=spawnSync('/usr/bin/id',[flag,user],{encoding:'utf8'});
  if(result.status!==0)throw new Error('Unknown Mac operator user');
  return Number(result.stdout.trim());
}
export function pullPlist(){
  const entry=join(root,'bin/pull-and-restart.mjs');
  const requests=join(root,'requests');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>${escapeXml(entry)}</string></array>
<key>WatchPaths</key><array><string>${escapeXml(requests)}</string></array>
<key>RunAtLoad</key><false/><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/Library/Logs/PhoneWall/pull.log</string>
<key>StandardErrorPath</key><string>/Library/Logs/PhoneWall/pull.log</string>
</dict></plist>\n`;
}
async function install(){
  if(process.platform!=='darwin'||process.getuid?.()!==0)throw new Error('Run helper installation once as administrator');
  const user=process.argv[2];
  if(!/^[a-z_][a-z0-9_-]*$/.test(user??''))throw new Error('Specify the Mac operator username');
  const uid=identity(user,'-u'),gid=identity(user,'-g');
  const bin=join(root,'bin'),requests=join(root,'requests');
  await mkdir(bin,{recursive:true,mode:0o755});await chmod(bin,0o755);
  await mkdir(requests,{recursive:true,mode:0o700});await chown(requests,uid,gid);await chmod(requests,0o700);
  for(const name of ['pull-and-restart.mjs','request-pull.mjs']){
    const from=fileURLToPath(new URL('./'+name,import.meta.url)),to=join(bin,name);
    await copyFile(from,to+'.next');await chown(to+'.next',0,0);await chmod(to+'.next',0o644);await rename(to+'.next',to);
  }
  const file=`/Library/LaunchDaemons/${label}.plist`;
  await writeFile(file+'.next',pullPlist(),{mode:0o644});
  const lint=spawnSync('/usr/bin/plutil',['-lint',file+'.next'],{encoding:'utf8'});
  if(lint.status!==0)throw new Error(lint.stderr||'Invalid helper plist');
  if(spawnSync('/bin/launchctl',['print',`system/${label}`],{stdio:'ignore'}).status===0)spawnSync('/bin/launchctl',['bootout',`system/${label}`],{stdio:'ignore'});
  await rename(file+'.next',file);
  const boot=spawnSync('/bin/launchctl',['bootstrap','system',file],{encoding:'utf8'});
  if(boot.status!==0)throw new Error(boot.stderr||'Could not start pull helper');
  console.log(`Pull helper installed. Run /usr/local/bin/node ${join(bin,'request-pull.mjs')} as ${user} without sudo.`);
}
if(process.argv[1]===fileURLToPath(import.meta.url))await install();
