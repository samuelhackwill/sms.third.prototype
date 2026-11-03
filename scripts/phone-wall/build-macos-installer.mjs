import { spawnSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,copyFile,cp,rm,chmod,readdir } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDashboardIcon } from './dashboard-icon.mjs';

if(process.platform!=='darwin')throw new Error('Build this macOS installer on a Mac.');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const version=process.env.PHONE_WALL_PACKAGE_VERSION??'2.4.3';
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid package version');
const output=resolve(process.env.PHONE_WALL_PACKAGE_OUTPUT??join(repo,'.data/distribution'));
const scratch=join(repo,'.data','installer-build-'+randomUUID()),payload=join(scratch,'payload'),scripts=join(scratch,'scripts');
const app=join(payload,'Library/Application Support/PhoneWall/app');
function run(command,args,options={}){const result=spawnSync(command,args,{stdio:'inherit',...options});if(result.status!==0)throw new Error(`${command} failed (${result.status})`);}
async function fetchBytes(url){const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`Download failed: ${url} (${response.status})`);return Buffer.from(await response.arrayBuffer());}
async function nativeAddons(path){for(const item of await readdir(path,{withFileTypes:true})){if(item.isDirectory())await nativeAddons(join(path,item.name));else if(item.name.endsWith('.node'))throw new Error('Native addon found; cross-built package requires an ARM-native dependency build.');}}
try {
  await mkdir(app,{recursive:true});await mkdir(scripts,{recursive:true});await mkdir(output,{recursive:true});
  const releases=JSON.parse((await fetchBytes('https://nodejs.org/dist/index.json')).toString());
  const nodeVersion=process.env.PHONE_WALL_NODE_VERSION??releases.find(r=>r.version.startsWith('v24.')&&r.lts)?.version;
  if(!/^v24\.\d+\.\d+$/.test(nodeVersion??''))throw new Error('Expected a stable Node 24 release');
  const filename=`node-${nodeVersion}-darwin-arm64.tar.gz`,base=`https://nodejs.org/dist/${nodeVersion}/`;
  const sums=(await fetchBytes(base+'SHASUMS256.txt')).toString();
  const expected=sums.split('\n').find(line=>line.trim().endsWith(' '+filename))?.trim().split(/\s+/)[0];
  if(!/^[a-f0-9]{64}$/.test(expected??''))throw new Error('Missing official Node checksum');
  const cache=join(repo,'.data/installer-cache');await mkdir(cache,{recursive:true});const archive=join(cache,filename);
  let bytes;try{bytes=await readFile(archive);}catch{bytes=await fetchBytes(base+filename);}
  if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Node archive checksum mismatch; refusing to package');
  await writeFile(archive,bytes,{mode:0o600});
  const unpacked=join(scratch,'node');await mkdir(unpacked);run('/usr/bin/tar',['-xzf',archive,'-C',unpacked,'--strip-components','1']);
  await mkdir(join(app,'runtime/bin'),{recursive:true});await copyFile(join(unpacked,'bin/node'),join(app,'runtime/bin/node'));await chmod(join(app,'runtime/bin/node'),0o755);await copyFile(join(unpacked,'LICENSE'),join(app,'runtime/LICENSE'));
  await cp(join(unpacked,'lib/node_modules/npm'),join(app,'runtime/lib/node_modules/npm'),{recursive:true});
  const service=join(app,'server/phone-wall');await mkdir(service,{recursive:true});
  for(const name of await readdir(join(repo,'server/phone-wall'))){if(name.endsWith('.mjs')||['public','package.json','package-lock.json','update-format.json'].includes(name))await cp(join(repo,'server/phone-wall',name),join(service,name),{recursive:true});}
  run(process.platform==='win32'?'npm.cmd':'npm',['ci','--omit=dev','--prefix',service,'--ignore-scripts']);
  await nativeAddons(join(service,'node_modules'));
  await cp(join(repo,'protocol'),join(app,'protocol'),{recursive:true});
  const helpers=join(app,'scripts/phone-wall');await mkdir(join(helpers,'installer'),{recursive:true});
  await copyFile(join(repo,'scripts/phone-wall/supervise.mjs'),join(helpers,'supervise.mjs'));
  await copyFile(join(repo,'scripts/phone-wall/update-from-github.mjs'),join(helpers,'update-from-github.mjs'));
  await copyFile(join(repo,'scripts/phone-wall/dashboard-icon.mjs'),join(helpers,'dashboard-icon.mjs'));
  await copyFile(join(repo,'scripts/phone-wall/install-messages-agent.mjs'),join(helpers,'install-messages-agent.mjs'));
  await cp(join(repo,'scripts/phone-wall/assets'),join(helpers,'assets'),{recursive:true});
  for(const name of ['configure.mjs','open-dashboard.sh'])await copyFile(join(repo,'scripts/phone-wall/installer',name),join(helpers,'installer',name));
  for(const name of ['preinstall','postinstall']){await copyFile(join(repo,'scripts/phone-wall/installer',name),join(scripts,name));await chmod(join(scripts,name),0o755);}
  const applications=join(payload,'Applications');await mkdir(applications,{recursive:true});
  const dashboard=join(applications,'Phone Wall Dashboard.app');
  run('/usr/bin/osacompile',['-o',dashboard,'-e','do shell script ("/bin/bash " & quoted form of "/Library/Application Support/PhoneWall/app/scripts/phone-wall/installer/open-dashboard.sh")']);
  run('/usr/libexec/PlistBuddy',['-c','Add :CFBundleIdentifier string org.museum.phonewall.dashboard',join(dashboard,'Contents/Info.plist')]);
  await applyDashboardIcon({applicationsDir:applications,iconFile:join(repo,'scripts/phone-wall/assets/dashboard.icns')});
  const updater=join(applications,'Update Phone Wall.app');
  run('/usr/bin/osacompile',['-o',updater,'-e','set resultText to do shell script (quoted form of "/Library/Application Support/PhoneWall/app/runtime/bin/node" & " " & quoted form of "/Library/Application Support/PhoneWall/app/scripts/phone-wall/update-from-github.mjs") with administrator privileges','-e','display dialog resultText buttons {"OK"} default button "OK"','-e','do shell script ("/usr/bin/open " & quoted form of "/Applications/Phone Wall Dashboard.app")']);
  run('/usr/libexec/PlistBuddy',['-c','Add :CFBundleIdentifier string org.museum.phonewall.updater',join(updater,'Contents/Info.plist')]);
  run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',updater]);
  const metadata={version,nodeVersion,architecture:'arm64',nodeArchiveSha256:expected,discovery:'macOS system Bonjour; current system hostname',defaultPort:3100,builtAt:new Date().toISOString()};
  await writeFile(join(app,'build-info.json'),JSON.stringify(metadata,null,2)+'\n');
  const component=join(scratch,'controller.pkg');
  run('/usr/bin/pkgbuild',['--root',payload,'--scripts',scripts,'--identifier','org.museum.phonewall','--version',version,'--install-location','/',component]);
  const resources=join(scratch,'resources');await mkdir(resources);
  await writeFile(join(resources,'welcome.html'),`<html><body style="font-family:Georgia"><h1>Phone Wall — sms-ingestor</h1><p>Installs the controller on an Apple Silicon Mac mini. Node and dependencies are included; no Terminal, Git or internet setup is needed on the Mac mini.</p><p>A background daemon starts at boot and restarts after failure. Existing Meteor projects, databases and iPhones are not changed. An administrator password is required once.</p></body></html>`);
  await writeFile(join(resources,'finish.html'),`<html><body style="font-family:Georgia"><h1>Ready</h1><p>Open <b>Phone Wall Dashboard</b> in Applications. The controller already runs in the background and starts automatically at boot, before login.</p><p>Control contains Pair / Position and Send Test Text. Existing tools remain under Advanced. Future server updates: open <b>Update Phone Wall</b> in Applications to fetch committed code from the phone-wall-runtime-2 GitHub branch. Administrator approval and internet are required only for updating. The branch must contain updater-ready code; local edits are not downloaded until committed and pushed.</p><p>The dashboard app signs in locally without typing a key. Local Mac users in the staff group are authorized to operate it. Phones discover the <b>Phone Wall</b> service through macOS Bonjour using the Mac's current hostname.</p><p>No device supervision or erasure was performed.</p></body></html>`);
  const distribution=join(scratch,'distribution.xml');
  await writeFile(distribution,`<?xml version="1.0"?><installer-gui-script minSpecVersion="1"><title>Phone Wall — sms-ingestor</title><welcome file="welcome.html"/><conclusion file="finish.html"/><options customize="never" require-scripts="true"/><domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/><choices-outline><line choice="controller"/></choices-outline><choice id="controller" visible="false"><pkg-ref id="org.museum.phonewall"/></choice><pkg-ref id="org.museum.phonewall" version="${version}" onConclusion="none">controller.pkg</pkg-ref></installer-gui-script>`);
  const artifact=join(output,`Phone-Wall-sms-ingestor-${version}-arm64.pkg`),identity=process.env.PHONE_WALL_INSTALLER_IDENTITY;
  run('/usr/bin/productbuild',['--distribution',distribution,'--package-path',scratch,'--resources',resources,...(identity?['--sign',identity]:[]),artifact]);
  await writeFile(artifact+'.build-info.json',JSON.stringify(metadata,null,2)+'\n');
  console.log(`Installer built: ${artifact}\nSigning: ${identity?'Developer ID Installer':'unsigned (requires one-time macOS approval)'}`);
}finally{await rm(scratch,{recursive:true,force:true});}
