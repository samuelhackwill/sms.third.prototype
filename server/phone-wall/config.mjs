import { defaultState, scheduledMode, validId } from "../../protocol/core.mjs";
import { randomUUID } from "node:crypto";
import { validateTestText } from './test-text.mjs';

export function initialConfig() {
  const value = defaultState();
  delete value._id;
  return {
    ...value,
    installationId: randomUUID(),
    layout: { ...value.layout, slots: [] },
    groups: {},
    overrides: {},
    schedule: null,
  };
}
const finite = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
export function validateConfig(config) {
  if (!config || Buffer.byteLength(JSON.stringify(config)) > 48000)
    throw new Error("configuration-too-large");
  if (!["exhibition", "night", "blackout"].includes(config.mode))
    throw new Error("invalid-mode");
  if (!finite(config.brightness, 0, 1) || !finite(config.nightBrightness, 0, 1))
    throw new Error("invalid-brightness");
  if(config.testTextSpeed!==undefined&&!finite(config.testTextSpeed,20,1000))throw new Error('invalid-test-text-speed');
  if(config.testText!==undefined)validateTestText(config.testText);
  const { rows, columns, slots, gap } = config.layout ?? {};
  if (
    ![rows, columns].every((n) => Number.isInteger(n) && n > 0 && n <= 30) ||
    rows * columns > 100 ||
    !finite(gap, 0, 10000) ||
    !Array.isArray(slots)
  )
    throw new Error("invalid-layout");
  const ids = new Set(),
    positions = new Set();
  for (const slot of slots) {
    if (
      !validId(slot.deviceId) ||
      ids.has(slot.deviceId) ||
      positions.has(slot.slotIndex) ||
      !Number.isInteger(slot.slotIndex) ||
      slot.slotIndex < 0 ||
      slot.slotIndex >= rows * columns
    )
      throw new Error("invalid-slot");
    const g = slot.geometry;
    if (
      !g ||
      !["x", "y", "width", "height"].every((k) => finite(g[k], 0, 100000)) ||
      !g.width ||
      !g.height
    )
      throw new Error("invalid-geometry");
    ids.add(slot.deviceId);
    positions.add(slot.slotIndex);
  }
  validateScene(config.scene);
  if (!validId(config.installationId))
    throw new Error("invalid-installation-id");
  if (!Number.isInteger(config.layoutRevision) || config.layoutRevision < 0)
    throw new Error("invalid-layout-revision");
  if (
    config.overrides &&
    (Array.isArray(config.overrides) || typeof config.overrides !== "object")
  )
    throw new Error("invalid-overrides");
  for (const [id, patch] of Object.entries(config.overrides ?? {})) {
    if (
      !validId(id) ||
      !patch ||
      Object.keys(patch).some((k) => !["mode", "scene"].includes(k))
    )
      throw new Error("invalid-override");
    if (patch.mode && !["exhibition", "blackout", "night"].includes(patch.mode))
      throw new Error("invalid-mode");
    if (patch.scene) validateScene(patch.scene);
  }
  if (
    !config.groups ||
    Array.isArray(config.groups) ||
    Object.entries(config.groups).some(
      ([key, ids]) =>
        !/^[\w -]{1,40}$/.test(key) ||
        !Array.isArray(ids) ||
        ids.some((id) => !validId(id)),
    )
  )
    throw new Error("invalid-groups");
  if (config.schedule) scheduledMode(config.schedule);
  return config;
}
export function validateScene(scene) {
  if (
    !scene ||
    !["test", "text", "solid", "ticker", "image", "video", "web"].includes(
      scene.kind,
    ) ||
    typeof scene.id !== "string" ||
    scene.id.length > 100 ||
    typeof scene.text !== "string" ||
    scene.text.length > 2000 ||
    !finite(scene.startAtServerMs, 0, 1e16) ||
    !finite(scene.speed, 0, 10000)
  )
    throw new Error("invalid-scene");
  if (
    ["image", "video", "web"].includes(scene.kind) &&
    !/^[a-f0-9]{64}$/.test(scene.hash)
  )
    throw new Error("invalid-media-hash");
  if (scene.color !== undefined && !/^#[a-fA-F0-9]{6}$/.test(scene.color))
    throw new Error("invalid-color");
  if (scene.fontSize !== undefined && !finite(scene.fontSize, 8, 300))
    throw new Error("invalid-font-size");
  return scene;
}
export function timelinePosition(scene, width, textWidth, now) {
  return (
    width -
    (((Math.max(0, now - scene.startAtServerMs) / 1000) * scene.speed) %
      (width + textWidth))
  );
}
