import { copyFile,readFile,writeFile,rename,rm,stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeXml } from './daemon-config.mjs';

const root='/Library/Application Support/PhoneWall';
const label='org.museum.phonewall.update';

export function updaterPlist(base=root) {
  const app=join(base,'app');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escapeXml(join(app,'runtime/bin/node'))}</string><string>${escapeXml(join(app,'scripts/phone-wall/supervise.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${escapeXml(join(app,'server/phone-wall'))}</string>
<key>EnvironmentVariables</key><dict><key>PHONE_WALL_ENTRY</key><string>${escapeXml(join(app,'scripts/phone-wall/update-from-github.mjs'))}</string><key>PHONE_WALL_LOG_DIR</key><string>/Library/Logs/PhoneWall</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer><key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

function run(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});
  if(result.error||result.status!==0)throw new Error(`${command} failed: ${result.error?.message??result.stderr?.trim()??result.status}`);
  return result.stdout.trim();
}

async function removeLauncher(path,identifier) {
  const plist=join(path,'Contents/Info.plist');
  if(!await stat(plist).then(value=>value.isFile()).catch(()=>false))return;
  if(run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',plist])!==identifier)throw new Error(`Refusing to remove an unrelated app at ${path}`);
  await rm(path,{recursive:true});
}

async function setup() {
  if(process.platform!=='darwin'||process.getuid?.()!==0)throw new Error('Run headless setup once as administrator');
  const app=join(root,'app'),daemon='/Library/LaunchDaemons/'+label+'.plist';
  for(const name of ['runtime/bin/node','scripts/phone-wall/supervise.mjs','server/phone-wall/index.mjs']){
    if(!await stat(join(app,name)).then(value=>value.isFile()).catch(()=>false))throw new Error(`Existing Node controller missing ${name}`);
  }
  const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535)throw new Error('Invalid controller port');
  const response=await fetch(`http://127.0.0.1:${config.port}/health`,{signal:AbortSignal.timeout(5000)});
  if(!response.ok||(await response.json()).ok!==true)throw new Error('Controller must be healthy before migration');
  const source=fileURLToPath(new URL('./update-from-github.mjs',import.meta.url));
  await copyFile(source,join(app,'scripts/phone-wall/update-from-github.mjs'));
  await writeFile(daemon+'.next',updaterPlist(),{mode:0o644});
  run('/usr/bin/plutil',['-lint',daemon+'.next']);
  if(spawnSync('/bin/launchctl',['print','system/'+label],{stdio:'ignore'}).status===0)run('/bin/launchctl',['bootout','system/'+label]);
  await rename(daemon+'.next',daemon);
  run('/bin/launchctl',['bootstrap','system',daemon]);
  await removeLauncher('/Applications/Phone Wall Dashboard.app','org.museum.phonewall.dashboard');
  await removeLauncher('/Applications/Update Phone Wall.app','org.museum.phonewall.updater');
  console.log(`Node controller stays on at boot. Dashboard: http://127.0.0.1:${config.port}/admin/phone-wall. GitHub updates are checked every five minutes.`);
}

if(process.argv[1]===fileURLToPath(import.meta.url))await setup();
