import { Bonjour } from "bonjour-service";
import { createController } from "./app.mjs";

process.umask(0o077);
const port = Number(process.env.PORT ?? 3000),
  host = process.env.HOST ?? "0.0.0.0";
const { app } = await createController({
  dataDir: process.env.PHONE_WALL_DATA_DIR,
  adminToken: process.env.PHONE_WALL_ADMIN_TOKEN,
  logger: true,
});
await app.listen({ host, port });
const bonjour =
  process.env.PHONE_WALL_MDNS === "false"
    ? null
    : new Bonjour({}, () =>
        app.log.warn(
          "bonjour-network-error; fallback address remains available",
        ),
      );
const service = bonjour?.publish({
  name: process.env.PHONE_WALL_NAME ?? "Phone Wall",
  type: "phonewall",
  port,
  txt: { path: "/phone-wall/ws", v: "1" },
});
service?.on("error", () =>
  app.log.warn("bonjour-advertisement-unavailable; use fallback address"),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    service?.stop();
    bonjour?.destroy();
    await app.close();
  });
