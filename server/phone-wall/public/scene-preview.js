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
const digitFont = 'Arial, Helvetica, sans-serif';
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
      if (p.effect === 'flash') {
        const availableWidth = (row.right - row.left) * 0.9;
        if (ink.width > availableWidth) {
          size *= availableWidth / ink.width; ink = metrics(size);
        }
      }
      let digitPair = null;
      if (p.effect === 'flash' && p.phoneCount) {
        const digits = text.replace(/\D/g, '');
        if (digits.length >= p.phoneCount * 2) {
          const column = Math.max(0, Math.min(p.phoneCount - 1,
            Math.floor((g.x + g.width / 2 - row.left) / (row.right - row.left) * p.phoneCount)));
          const pair = digits.slice(column * 2, column * 2 + 2);
          c.font = `100px ${digitFont}`;
          const measured = c.measureText(pair);
          digitPair = {text: pair, width: measured.width,
            ascent: measured.actualBoundingBoxAscent || 80,
            descent: measured.actualBoundingBoxDescent || 20};
        }
      }
      return { ...row, width: ink.width, font: `${size}px ${p.fontFamily}`, digitPair,
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
    const rowElapsed = elapsed - row.delayMs;
    const flashing = p.effect === 'flash';
    if (flashing && rowElapsed >= 0 && rowElapsed % 700 >= 500) { inProgress = true; continue; }
    if (flashing && row.digitPair && rowElapsed >= 0) {
      const pair = row.digitPair;
      visible = true; inProgress = true;
      c.save(); c.beginPath(); c.rect(g.x, row.top, g.width, row.height); c.clip();
      c.translate(g.x + g.width / 2, row.top + row.height / 2);
      c.scale(g.width * 0.94 / pair.width, row.height * 0.96 / (pair.ascent + pair.descent));
      c.font = `100px ${digitFont}`; c.fillStyle = p.color;
      c.fillText(pair.text, -pair.width / 2, (pair.ascent - pair.descent) / 2);
      c.restore();
      continue;
    }
    const x = flashing ? row.left + (row.right - row.left - row.width) / 2 : row.right - rowElapsed / 1000 * p.speed;
    if (flashing || rowElapsed < 0 || x + row.width >= row.left) inProgress = true;
    if (rowElapsed < 0 || x > g.x + g.width || x + row.width < g.x) continue;
    visible = true;
    c.save(); c.beginPath(); c.rect(row.left, row.top, row.right - row.left, row.height); c.clip();
    c.font = row.font; c.fillStyle = p.color;
    c.fillText(cached.text, x, row.baseline); c.restore();
  }
  c.restore();
  return visible ? 'Displaying test text' : inProgress ? 'Waiting for text to reach this phone' : 'Test finished · send a new test to replay';
}
export function drawLiveText(c, definition, geometry, run, now) {
  if (!run || run.phase !== 'playing' || !Number.isFinite(run.startAtServerMs)) {
    c.fillStyle = '#000';
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    return run ? 'Preparing live text' : 'Waiting for incoming text';
  }
  const preview = {
    background: '#000',
    parameters: {
      ...definition.parameters,
      text: run.text,
      speed: run.speed,
      effect: run.effect,
      phoneCount: run.targets.length,
      rows: [{...run.band, delayMs: 0}],
    },
  };
  drawTestText(c, preview, geometry, now - run.startAtServerMs);
  return definition.parameters.color === '#00ff00' ? 'Roland Barthes text' : 'Incoming SMS text';
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
