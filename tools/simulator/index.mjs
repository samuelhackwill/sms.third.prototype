import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { SimulatedClient } from "../../server/phone-wall/simulated-client.mjs";

const endpoint =
  process.env.PHONE_WALL_URL ?? "ws://127.0.0.1:3000/phone-wall/ws";
const count = Number(process.env.PHONE_WALL_COUNT ?? 30);
if (!Number.isInteger(count) || count < 1 || count > 100)
  throw new Error("count must be 1–100");
await mkdir(".data", { recursive: true });
let identities;
try {
  identities = JSON.parse(await readFile(".data/simulator.json", "utf8"));
} catch {
  identities = [];
}
while (identities.length < count)
  identities.push({
    deviceId: randomUUID(),
    token: randomBytes(32).toString("hex"),
  });
await writeFile(".data/simulator.json", JSON.stringify(identities), {
  mode: 0o600,
});
const clients = identities.slice(0, count).map((identity, index) => {
  const client = new SimulatedClient(endpoint, identity);
  client.on("welcome", (p) =>
    console.log(
      `Phone ${index}: ${p.paired ? "paired" : `pairing code ${p.pairingCode}`}`,
    ),
  );
  client.on("protocolError", (code) =>
    console.error(`Phone ${index}: ${code}`),
  );
  client.connect();
  return client;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => clients.forEach((c) => c.stop()));
