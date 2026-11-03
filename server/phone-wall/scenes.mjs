import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
const schema = JSON.parse(
  readFileSync(
    new URL("../../protocol/scene-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const schemaValid = new Ajv2020({ strict: false }).compile(schema);

const bounded = (x, min, max) => Number.isFinite(x) && x >= min && x <= max;
const color = (x) => typeof x === "string" && /^#[\da-f]{6}$/i.test(x);
const digest = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",")}}`;
  return JSON.stringify(value);
}
export function releaseHash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function validateDefinition(scene) {
  if (
    !scene ||
    Buffer.byteLength(JSON.stringify(scene)) > 32000 ||
    scene.sceneSchemaVersion !== 1
  )
    throw new Error("unsupported-scene-schema");
  if (!schemaValid(scene)) throw new Error("invalid-scene-schema");
  if (
    typeof scene.artworkId !== "string" ||
    !/^[-\w]{1,80}$/.test(scene.artworkId) ||
    typeof scene.artworkVersion !== "string" ||
    !scene.artworkVersion.length ||
    scene.artworkVersion.length > 80
  )
    throw new Error("invalid-artwork-version");
  if (
    !bounded(scene.canvas?.width, 1, 100000) ||
    !bounded(scene.canvas?.height, 1, 100000) ||
    !color(scene.background)
  )
    throw new Error("invalid-canvas");
  if (
    !["cut", "fade"].includes(scene.transition?.type) ||
    !bounded(scene.transition?.durationMs, 0, 5000)
  )
    throw new Error("invalid-transition");
  if (
    !Array.isArray(scene.elements) ||
    scene.elements.length < 1 ||
    scene.elements.length > 32
  )
    throw new Error("invalid-elements");
  const ids = new Set();
  for (const e of scene.elements) {
    if (
      typeof e.id !== "string" ||
      !/^[-\w]{1,60}$/.test(e.id) ||
      ids.has(e.id) ||
      !["text", "rect", "ticker", "image", "video", "web"].includes(e.type)
    )
      throw new Error("invalid-element");
    ids.add(e.id);
    if (
      !e.frame ||
      !["x", "y", "width", "height"].every((k) =>
        bounded(e.frame[k], k === "x" || k === "y" ? -100000 : 1, 100000),
      )
    )
      throw new Error("invalid-element-frame");
    if (e.color !== undefined && !color(e.color))
      throw new Error("invalid-element-color");
    if (e.opacity !== undefined && !bounded(e.opacity, 0, 1))
      throw new Error("invalid-opacity");
    if (e.rotation !== undefined && !bounded(e.rotation, -3600, 3600))
      throw new Error("invalid-rotation");
    if (
      ["text", "ticker"].includes(e.type) &&
      (typeof e.text !== "string" ||
        e.text.length > 2000 ||
        !bounded(e.fontSize, 8, 300))
    )
      throw new Error("invalid-element-text");
    if (e.type === "ticker" && !bounded(e.speed, 0, 10000))
      throw new Error("invalid-ticker-speed");
    if (["image", "video", "web"].includes(e.type) && !digest(e.asset))
      throw new Error("invalid-element-asset");
    if (e.animation) {
      const a = e.animation;
      if (
        !["x", "y", "opacity", "rotation"].includes(a.property) ||
        !bounded(a.from, -100000, 100000) ||
        !bounded(a.to, -100000, 100000) ||
        !bounded(a.durationMs, 16, 3600000) ||
        !bounded(a.delayMs ?? 0, 0, 3600000) ||
        !["linear", "easeInOut"].includes(a.easing) ||
        typeof a.repeat !== "boolean"
      )
        throw new Error("invalid-animation");
      if (
        a.property === "opacity" &&
        (!bounded(a.from, 0, 1) || !bounded(a.to, 0, 1))
      )
        throw new Error("invalid-animation-opacity");
    }
  }
  if (
    scene.elements.filter((e) => e.type === "web").length > 1 ||
    scene.elements.filter((e) => e.type === "video").length > 2
  )
    throw new Error("renderer-budget-exceeded");
  if (
    scene.resources &&
    (!Array.isArray(scene.resources) ||
      scene.resources.length > 32 ||
      new Set(scene.resources.map((r) => r.name)).size !==
        scene.resources.length ||
      scene.resources.some(
        (r) =>
          !digest(r.hash) ||
          !/^[-\w]+\.(png|jpg|mp4|js)$/.test(r.name) ||
          ["art.js", "pixi.js"].includes(r.name),
      ))
  )
    throw new Error("invalid-resources");
  if (
    scene.parameters &&
    (typeof scene.parameters !== "object" || Array.isArray(scene.parameters))
  )
    throw new Error("invalid-artwork-parameters");
  return scene;
}
export function animationValue(animation, elapsedMs) {
  const elapsed = Math.max(0, elapsedMs - (animation.delayMs ?? 0));
  let t = animation.repeat
    ? (elapsed % animation.durationMs) / animation.durationMs
    : Math.min(1, elapsed / animation.durationMs);
  if (animation.easing === "easeInOut") t = t * t * (3 - 2 * t);
  return animation.from + (animation.to - animation.from) * t;
}
