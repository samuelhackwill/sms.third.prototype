export function animationValue(a, elapsedMs) {
  const elapsed = Math.max(0, elapsedMs - (a.delayMs ?? 0));
  let t = a.repeat
    ? (elapsed % a.durationMs) / a.durationMs
    : Math.min(1, elapsed / a.durationMs);
  if (a.easing === "easeInOut") t = t * t * (3 - 2 * t);
  return a.from + (a.to - a.from) * t;
}
export function drawArtwork(
  context,
  definition,
  geometry,
  startAt,
  now,
  index,
) {
  const c = context,
    g = geometry,
    elapsed = Math.max(0, now - startAt);
  c.save();
  c.scale(c.canvas.width / g.width, c.canvas.height / g.height);
  c.fillStyle = definition.background;
  c.fillRect(0, 0, g.width, g.height);
  c.translate(-g.x, -g.y);
  for (const e of definition.elements) {
    c.save();
    let x = e.frame.x,
      y = e.frame.y,
      alpha = e.opacity ?? 1,
      rotation = e.rotation ?? 0;
    if (e.animation) {
      const v = animationValue(e.animation, elapsed);
      if (e.animation.property === "x") x = v;
      if (e.animation.property === "y") y = v;
      if (e.animation.property === "opacity") alpha = v;
      if (e.animation.property === "rotation") rotation = v;
    }
    c.font = `${e.fontSize ?? 48}px monospace`;
    c.textBaseline = "top";
    c.fillStyle = e.color ?? "#fff";
    c.globalAlpha = alpha;
    if (e.type === "ticker") {
      const w = c.measureText(e.text).width;
      x += e.frame.width - (((elapsed / 1000) * e.speed) % (e.frame.width + w));
    }
    c.translate(x, y);
    c.rotate((rotation * Math.PI) / 180);
    if (e.type === "rect") c.fillRect(0, 0, e.frame.width, e.frame.height);
    else if (["text", "ticker"].includes(e.type))
      c.fillText(
        (e.text ?? "").replaceAll("{deviceId}", `virtual-${index}`),
        0,
        0,
        e.frame.width,
      );
    else {
      c.strokeStyle = e.color ?? "#7b9d92";
      c.strokeRect(0, 0, e.frame.width, e.frame.height);
      c.font = "22px monospace";
      c.fillText(`${e.type} ${(e.asset ?? "").slice(0, 8)}`, 10, 15);
    }
    c.restore();
  }
  c.restore();
}
