import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const resetMarker = '.reset-installation';
const buildMarker = '.network-build';

export async function requestInstallationReset(dataDir) {
  await writeFile(join(dataDir, resetMarker), String(Date.now()), {mode:0o600});
}

export async function prepareInstallation(dataDir, build) {
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const entries=await readdir(dataDir);
  if(entries.includes(resetMarker)) {
    for(const entry of entries) if(entry!==resetMarker) await rm(join(dataDir,entry),{recursive:true,force:true});
    await rm(join(dataDir,resetMarker));
    if(build)await writeFile(join(dataDir,buildMarker),build,{mode:0o600});
    return {reset:true,connectionsCleared:0};
  }
  if(!build)return {reset:false,connectionsCleared:0};
  const previous=await readFile(join(dataDir,buildMarker),'utf8').catch(error=>{
    if(error.code==='ENOENT')return null;
    throw error;
  });
  if(previous===build)return {reset:false,connectionsCleared:0};
  let connectionsCleared=0;
  if(entries.includes('controller.sqlite')) {
    const db=new DatabaseSync(join(dataDir,'controller.sqlite'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const update=db.prepare('UPDATE devices SET data=? WHERE id=?');
      for(const row of db.prepare('SELECT id,data FROM devices').all()) {
        const device=JSON.parse(row.data);
        for(const field of ['bootSessionId','connectionIssue','lastDisconnect','lastSeenAt','telemetry','telemetryAt'])delete device[field];
        update.run(JSON.stringify(device),row.id);
        connectionsCleared++;
      }
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK');throw error; }
    finally {db.close();}
  }
  await writeFile(join(dataDir,buildMarker),build,{mode:0o600});
  return {reset:false,connectionsCleared};
}
