import { mkdir,readFile,writeFile,rename,lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { escapeXml } from './daemon-config.mjs';

export function messagesAgentPlist(home,root='/Library/Application Support/PhoneWall') {
  const app=join(root,'source'),label='org.museum.phonewall.messages';
  return `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${escapeXml(join(root,'app/runtime/bin/node'))}</string><string>${escapeXml(join(root,'app/scripts/phone-wall/supervise.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${escapeXml(join(app,'server/phone-wall'))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>LimitLoadToSessionType</key><string>Aqua</string>
<key>EnvironmentVariables</key><dict><key>PHONE_WALL_CONFIG_FILE</key><string>${escapeXml(join(root,'config.json'))}</string><key>PHONE_WALL_ENTRY</key><string>${escapeXml(join(app,'server/phone-wall/messages-reader.mjs'))}</string><key>PHONE_WALL_LOG_DIR</key><string>${escapeXml(join(home,'Library/Logs/PhoneWallReader'))}</string></dict></dict></plist>\n`;
}
async function install() {
  if(process.platform!=='darwin'||process.getuid?.()===0)throw new Error('Install the Messages reader as the logged-in user');
  const home=homedir(),directory=join(home,'Library/LaunchAgents'),label='org.museum.phonewall.messages',file=join(directory,label+'.plist');
  await mkdir(directory,{recursive:true});await mkdir(join(home,'Library/Logs/PhoneWallReader'),{recursive:true,mode:0o700});
  const plist=messagesAgentPlist(home);
  try{if((await lstat(file)).isSymbolicLink()||!(await readFile(file,'utf8')).includes('/Library/Application Support/PhoneWall/app/runtime/bin/node'))throw new Error('An independently configured reader exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  await writeFile(file+'.tmp',plist,{mode:0o600});await rename(file+'.tmp',file);
  const domain='gui/'+process.getuid(),service=domain+'/'+label;
  if(spawnSync('/bin/launchctl',['print',service],{stdio:'ignore'}).status===0) {
    const result=spawnSync('/bin/launchctl',['kickstart','-k',service],{stdio:'ignore'});if(result.status!==0)throw new Error('reader-restart-failed');
  }else{
    const result=spawnSync('/bin/launchctl',['bootstrap',domain,file],{stdio:'ignore'});if(result.status!==0)throw new Error('reader-install-failed');
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await install();
