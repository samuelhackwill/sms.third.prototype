import { createController } from "./app.mjs";
import { configuration } from './installation.mjs';
import { startDiscovery } from './discovery.mjs';
import { prepareInstallation } from './reset.mjs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const config=configuration();
const {port,host}=config;
const dataDir=config.dataDir??join(dirname(fileURLToPath(import.meta.url)),'../../.data/phone-wall');
const buildInfo=await readFile(join(dirname(fileURLToPath(import.meta.url)),'../../build-info.json'),'utf8').then(JSON.parse).catch(error=>{
  if(error.code==='ENOENT')return null;
  throw error;
});
const prepared=await prepareInstallation(dataDir,buildInfo?.gitCommit??buildInfo?.version);
const { app } = await createController({
  dataDir,
  adminToken: config.adminToken,
  logger: true,
  requestReset: async()=>{
    discovery.stop();
    await app.close();
    process.exit(0);
  },
});
await app.listen({ host, port });
const discovery=startDiscovery(config,{onError:()=>
  app.log.warn('bonjour-registration-unavailable; retrying; fallback address remains available')});
if(prepared.reset)app.log.warn('phone-wall-installation-data-reset');
else if(prepared.connectionsCleared)app.log.info({devices:prepared.connectionsCleared},'phone-wall-connection-state-cleared-after-update');
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    discovery.stop();
    await app.close();
  });
