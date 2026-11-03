import { createController } from "./app.mjs";
import { configuration } from './installation.mjs';
import { startDiscovery } from './discovery.mjs';

process.umask(0o077);
const config=configuration();
const {port,host}=config;
const { app } = await createController({
  dataDir: config.dataDir,
  adminToken: config.adminToken,
  logger: true,
});
await app.listen({ host, port });
const discovery=startDiscovery(config,{onError:()=>
  app.log.warn('bonjour-registration-unavailable; retrying; fallback address remains available')});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    discovery.stop();
    await app.close();
  });
