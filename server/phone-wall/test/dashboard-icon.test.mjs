import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { applyDashboardIcon } from '../../../scripts/phone-wall/dashboard-icon.mjs';

const iconFile=fileURLToPath(new URL('../../../scripts/phone-wall/assets/dashboard.icns',import.meta.url));
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return result.stdout;}
test('dashboard ships a complete ICNS asset',async()=>{
  const bytes=await readFile(iconFile);
  assert.equal(bytes.toString('ascii',0,4),'icns');
  assert.equal(bytes.readUInt32BE(4),bytes.length);
});
test('icon installer refuses unrelated application bundles',async()=>{
  await assert.rejects(applyDashboardIcon({applicationsDir:'/not-used',iconFile,execute:()=> 'another.application'}),/unrelated/);
});
test('macOS dashboard icon is applied atomically and the modified launcher signature is valid',{skip:process.platform!=='darwin'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'phone-wall-icon-'));
  const bundle=join(directory,'Phone Wall Dashboard.app'),plist=join(bundle,'Contents/Info.plist');
  try {
    run('/usr/bin/osacompile',['-o',bundle,'-e','return 1']);
    run('/usr/libexec/PlistBuddy',['-c','Add :CFBundleIdentifier string org.museum.phonewall.dashboard',plist]);
    await applyDashboardIcon({applicationsDir:directory,iconFile});
    assert.equal(run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIconFile',plist]).trim(),'phone-wall-aubergine.icns');
    assert.deepEqual(await readFile(join(bundle,'Contents/Resources/phone-wall-aubergine.icns')),await readFile(iconFile));
    run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
    const before=await readFile(plist);
    await assert.rejects(applyDashboardIcon({applicationsDir:directory,iconFile,execute:(command,args)=>{
      if(command==='/usr/bin/codesign')throw new Error('simulated signing failure');
      return run(command,args);
    }}),/simulated signing failure/);
    assert.deepEqual(await readFile(plist),before);
    run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  }finally{await rm(directory,{recursive:true,force:true});}
});
