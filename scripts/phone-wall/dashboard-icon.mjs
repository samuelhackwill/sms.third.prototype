import { spawnSync } from 'node:child_process';
import { cp,copyFile,mkdtemp,rename,rm,utimes } from 'node:fs/promises';
import { join } from 'node:path';

export async function applyDashboardIcon({applicationsDir='/Applications',iconFile,execute=run}={}) {
  const bundle=join(applicationsDir,'Phone Wall Dashboard.app');
  const identifier=execute('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',join(bundle,'Contents/Info.plist')]).trim();
  if(identifier!=='org.museum.phonewall.dashboard')throw new Error('Refusing to modify an unrelated dashboard app');
  const staging=await mkdtemp(join(applicationsDir,'.phone-wall-icon-'));
  const candidate=join(staging,'updated.app'),backup=join(staging,'previous.app');
  try {
    await cp(bundle,candidate,{recursive:true});
    await copyFile(iconFile,join(candidate,'Contents/Resources/phone-wall-aubergine.icns'));
    execute('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIconFile phone-wall-aubergine.icns',join(candidate,'Contents/Info.plist')]);
    execute('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',candidate]);
    execute('/usr/bin/codesign',['--verify','--deep','--strict',candidate]);
    await rename(bundle,backup);
    try {await rename(candidate,bundle);}catch(error){await rename(backup,bundle);throw error;}
    const now=new Date();await utimes(bundle,now,now);
    // Refresh LaunchServices without restarting Finder or the Dock.
    spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',['-f',bundle],{stdio:'ignore',timeout:10000});
  } finally {await rm(staging,{recursive:true,force:true});}
}
function run(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});
  if(result.error||result.status!==0)throw new Error(`Dashboard icon update failed: ${result.error?.message??result.stderr}`);
  return result.stdout;
}
