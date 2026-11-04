import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const serviceLabel='org.museum.phonewall';
export function escapeXml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
export function daemonPlist(root,configFile,logDir) {
  const app=join(root,'source');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel}</string><key>ProgramArguments</key><array><string>${escapeXml('/usr/local/bin/node')}</string><string>${escapeXml(join(app,'scripts/phone-wall/supervise.mjs'))}</string></array>
<key>UserName</key><string>_phonewall</string><key>GroupName</key><string>_phonewall</string><key>WorkingDirectory</key><string>${escapeXml(join(app,'server/phone-wall'))}</string>
<key>EnvironmentVariables</key><dict><key>PHONE_WALL_CONFIG_FILE</key><string>${escapeXml(configFile)}</string><key>PHONE_WALL_ENTRY</key><string>${escapeXml(join(app,'server/phone-wall/index.mjs'))}</string><key>PHONE_WALL_LOG_DIR</key><string>${escapeXml(logDir)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}
export function freePort(port) { return new Promise(resolve=>{const server=createServer();server.once('error',()=>resolve(false));server.listen(port,'0.0.0.0',()=>server.close(()=>resolve(true)));}); }
function regularFile(path){if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()))throw new Error('Unsafe installation file: '+path);}
export async function configureInstallation({root='/Library/Application Support/PhoneWall',logDir='/Library/Logs/PhoneWall',daemonDir='/Library/LaunchDaemons',available=freePort}={}) {
  mkdirSync(root,{recursive:true,mode:0o755});mkdirSync(logDir,{recursive:true,mode:0o750});mkdirSync(daemonDir,{recursive:true});
  const configFile=join(root,'config.json'),keyFile=join(root,'operator.key');regularFile(configFile);regularFile(keyFile);
  const prior=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):{};
  const choices=[...(Number.isInteger(prior.port)&&prior.port>=1024&&prior.port<=65535?[prior.port]:[]),...Array.from({length:11},(_,i)=>3100+i)];
  let port;for(const candidate of [...new Set(choices)])if(await available(candidate)){port=candidate;break;}
  if(!port)throw new Error('No available Phone Wall port (3100–3110). Existing services have not been stopped.');
  if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32).toString('hex')+'\n',{mode:0o640,flag:'wx'});
  if(!/^[a-f0-9]{64}$/.test(readFileSync(keyFile,'utf8').trim()))throw new Error('Existing operator key is invalid; refusing to replace it.');
  const config={port,bindAddress:'0.0.0.0',dataDir:join(root,'data'),adminTokenFile:keyFile,mdns:true,serviceName:'Phone Wall'};
  writeFileSync(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o644});chmodSync(configFile,0o644);
  const plist=join(daemonDir,serviceLabel+'.plist');regularFile(plist);writeFileSync(plist,daemonPlist(root,configFile,logDir),{mode:0o644});chmodSync(plist,0o644);
  return {configFile,keyFile,plist,port};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.getuid?.()!==0)throw new Error('Run daemon configuration as administrator.');
  const result=await configureInstallation();console.log(`Phone Wall configured on port ${result.port}. Operator key retained locally.`);
}
