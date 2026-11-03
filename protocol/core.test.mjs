import test from "node:test";
import assert from "node:assert/strict";
import {
  decode,
  envelope,
  applySnapshot,
  clockOffset,
  backoff,
  status,
  validId,
  scheduledMode,
} from "./core.mjs";
test("valid envelopes round trip and reject invalid or oversized input", () => {
  assert.equal(decode(JSON.stringify(envelope("client.hello", {}))).v, 1);
  for (const raw of ["{", "{}", "x".repeat(65537), JSON.stringify({ v: 2 })])
    assert.throws(() => decode(raw));
});
test("older snapshots cannot replace newer state", () => {
  const current = { revision: 9 };
  assert.equal(applySnapshot(current, { revision: 8 }), current);
  assert.equal(applySnapshot(current, { revision: 10 }).revision, 10);
  assert.throws(() => applySnapshot(current, { revision: -1 }));
});
test("clock estimator favors low RTT", () =>
  assert.equal(
    clockOffset([
      { sent: 0, received: 100, server: 1000 },
      { sent: 100, received: 110, server: 125 },
    ]),
    20,
  ));
test("backoff caps and status ages", () => {
  assert.equal(
    backoff(100, () => 1),
    30000,
  );
  assert.equal(
    backoff(0, () => 0),
    250,
  );
  assert.equal(status(new Date(0), 61000), "offline");
  assert.equal(status(new Date(0), 26000), "stale");
  assert.equal(validId("$bad"), false);
});
test("schedules use wall timezone including DST and overnight hours", () => {
  const s = { timeZone: "Europe/Paris", startMinute: 540, endMinute: 1260 };
  assert.equal(
    scheduledMode(s, new Date("2026-11-02T08:00:00Z")),
    "exhibition",
  );
  assert.equal(
    scheduledMode(s, new Date("2026-07-02T07:00:00Z")),
    "exhibition",
  );
  assert.equal(scheduledMode(s, new Date("2026-11-02T20:00:00Z")), "night");
  assert.equal(
    scheduledMode(
      { ...s, startMinute: 1260, endMinute: 360 },
      new Date("2026-11-02T23:00:00Z"),
    ),
    "exhibition",
  );
  assert.throws(() => scheduledMode({ ...s, timeZone: "bad-zone" }));
});
