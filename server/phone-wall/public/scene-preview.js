export function animationValue(a, elapsedMs) {
  const elapsed = Math.max(0, elapsedMs - (a.delayMs ?? 0));
  let t = a.repeat
    ? (elapsed % a.durationMs) / a.durationMs
    : Math.min(1, elapsed / a.durationMs);
  if (a.easing === "easeInOut") t = t * t * (3 - 2 * t);
  return a.from + (a.to - a.from) * t;
}

export function hasTestTextPreview(definition) {
  return definition?.artworkId === 'operator-test-text' &&
    typeof definition.parameters?.text === 'string' && Array.isArray(definition.parameters.rows) &&
    definition.elements.some(e => e.type === 'web');
}

const testTextMetrics = new WeakMap();
// Match artwork/test-text.js in logical wall coordinates, without a WebView per tile.
function drawTestText(c, definition, g, elapsed) {
  const p = definition.parameters;
  let cached = testTextMetrics.get(c);
  const key = cached?.definition === definition && cached?.geometry === g ? cached.key : JSON.stringify([p, g]);
  if (cached?.key !== key) {
    const text = p.text.replace(/[\r\n]+/g, ' ');
    const metrics = size => {
      c.font = `${size}px ${p.fontFamily}`;
      const m = c.measureText(text);
      const hasInk = Number.isFinite(m.actualBoundingBoxAscent) && Number.isFinite(m.actualBoundingBoxDescent) && m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0;
      return { width: Math.max(m.width, m.actualBoundingBoxRight || 0),
        ascent: hasInk ? m.actualBoundingBoxAscent : size * 0.8,
        descent: hasInk ? m.actualBoundingBoxDescent : size * 0.2 };
    };
    const rows = p.rows.filter(row => row.top < g.y + g.height && row.top + row.height > g.y).map(row => {
      const probe = metrics(100), available = row.height * 0.97;
      let size = Math.min(row.height * 4, available / Math.max(1, probe.ascent + probe.descent) * 100);
      let ink = metrics(size);
      if (ink.ascent + ink.descent > available) {
        size *= available / (ink.ascent + ink.descent); ink = metrics(size);
      }
      return { ...row, width: ink.width, font: `${size}px ${p.fontFamily}`,
        baseline: row.top + (row.height - ink.ascent - ink.descent) / 2 + ink.ascent };
    });
    cached = { key, text, rows }; testTextMetrics.set(c, cached);
  }
  cached.definition = definition; cached.geometry = g;
  let inProgress = false, visible = false;
  c.save();
  c.scale(c.canvas.width / g.width, c.canvas.height / g.height);
  c.fillStyle = definition.background; c.fillRect(0, 0, g.width, g.height);
  c.translate(-g.x, -g.y); c.textBaseline = 'alphabetic';
  for (const row of cached.rows) {
    const rowElapsed = elapsed - row.delayMs, x = row.right - rowElapsed / 1000 * p.speed;
    if (rowElapsed < 0 || x + row.width >= row.left) inProgress = true;
    if (rowElapsed < 0 || x > g.x + g.width || x + row.width < g.x) continue;
    visible = true;
    c.save(); c.beginPath(); c.rect(row.left, row.top, row.right - row.left, row.height); c.clip();
    c.font = row.font; c.fillStyle = p.color; c.fillText(cached.text, x, row.baseline); c.restore();
  }
  c.restore();
  return visible ? 'Displaying test text' : inProgress ? 'Waiting for text to reach this phone' : 'Test finished · send a new test to replay';
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
  if (hasTestTextPreview(definition)) return drawTestText(c, definition, g, now - startAt);
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
