export const MAX_BYTES = 65536;
export const MODES = ["exhibition", "night", "blackout"];
export function envelope(
  type,
  payload,
  revision = 0,
  messageId = crypto.randomUUID(),
) {
  return {
    v: 1,
    type,
    messageId,
    wallId: "main",
    revision,
    serverTimeMs: Date.now(),
    payload,
  };
}
export function decode(raw) {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("message-too-large");
  const m = JSON.parse(raw);
  if (
    m.v !== 1 ||
    typeof m.type !== "string" ||
    typeof m.messageId !== "string" ||
    m.messageId.length > 128 ||
    !m.payload ||
    typeof m.payload !== "object" ||
    Array.isArray(m.payload)
  )
    throw new Error("invalid-envelope");
  return m;
}
export function validId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(id);
}
export function backoff(attempt, random = Math.random) {
  return (
    Math.min(30000, 500 * 2 ** Math.min(attempt, 8)) * (0.5 + random() * 0.5)
  );
}
export function clockOffset(samples) {
  const best = samples
    .filter((s) => s.received >= s.sent)
    .sort((a, b) => a.received - a.sent - (b.received - b.sent))[0];
  return best ? best.server - (best.sent + best.received) / 2 : 0;
}
export function applySnapshot(current, next) {
  if (!Number.isInteger(next.revision) || next.revision < 0)
    throw new Error("invalid-revision");
  return current && current.revision > next.revision ? current : next;
}
export function defaultState() {
  return {
    _id: "main",
    revision: 1,
    layoutRevision: 1,
    mode: "blackout",
    brightness: 0.6,
    nightBrightness: 0,
    scene: {
      id: "test",
      kind: "test",
      text: "PHONE WALL",
      speed: 100,
      startAtServerMs: Date.now() + 1500,
    },
    layout: { rows: 6, columns: 5, gap: 0 },
    heartbeatSeconds: 12,
    fallback: "dark",
  };
}
export function status(lastSeen, now = Date.now()) {
  const age = now - new Date(lastSeen).getTime();
  return age < 25000 ? "online" : age < 60000 ? "stale" : "offline";
}
export function scheduledMode(schedule, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: schedule.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const minute =
    Number(parts.find((p) => p.type === "hour").value) * 60 +
    Number(parts.find((p) => p.type === "minute").value);
  const start = schedule.startMinute,
    end = schedule.endMinute;
  if (
    ![start, end].every((n) => Number.isInteger(n) && n >= 0 && n < 1440) ||
    start === end
  )
    throw new Error("invalid-hours");
  return (
    start < end
      ? minute >= start && minute < end
      : minute >= start || minute < end
  )
    ? "exhibition"
    : "night";
}
