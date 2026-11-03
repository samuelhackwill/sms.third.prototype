(() => {
  const state = window.PHONE_WALL;
  const parameters = state.parameters;
  const text = parameters.text.replace(/[\r\n]+/g, ' ');
  const viewport = state.viewport || state.geometry;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Red serif test text');
  canvas.style.cssText = 'display:block;width:100vw;height:100vh';
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#000';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Test text canvas is unavailable');
  let rows = [], ratio, sx, sy;
  function metrics(size) {
    context.font = `${size}px ${parameters.fontFamily}`;
    const measured = context.measureText(text);
    const hasInk = Number.isFinite(measured.actualBoundingBoxAscent) && Number.isFinite(measured.actualBoundingBoxDescent) && measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent > 0;
    return {
      width: Math.max(measured.width, measured.actualBoundingBoxRight || 0),
      ascent: hasInk ? measured.actualBoundingBoxAscent : size * 0.8,
      descent: hasInk ? measured.actualBoundingBoxDescent : size * 0.2,
    };
  }
  function resize() {
    ratio = Math.min(2, window.devicePixelRatio || 1);
    sx = window.innerWidth / viewport.width;
    sy = window.innerHeight / viewport.height;
    canvas.width = Math.max(1, Math.round(window.innerWidth * ratio));
    canvas.height = Math.max(1, Math.round(window.innerHeight * ratio));
    context.textBaseline = 'alphabetic';
    rows = parameters.rows.filter(row => row.top < viewport.y + viewport.height && row.top + row.height > viewport.y).map(row => {
      const probe = metrics(100), available = row.height * 0.97;
      let size = Math.min(row.height * 4, available / Math.max(1, probe.ascent + probe.descent) * 100);
      let ink = metrics(size);
      if (ink.ascent + ink.descent > available) {
        size *= available / (ink.ascent + ink.descent);
        ink = metrics(size);
      }
      return {...row, width: ink.width, font: `${size}px ${parameters.fontFamily}`,
        baseline: row.top + (row.height - ink.ascent - ink.descent) / 2 + ink.ascent};
    });
  }
  resize();
  window.addEventListener('resize', resize);
  PhoneWall.onFrame(elapsedSeconds => {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, window.innerWidth, window.innerHeight);
    context.setTransform(ratio * sx, 0, 0, ratio * sy, -viewport.x * ratio * sx, -viewport.y * ratio * sy);
    for (const row of rows) {
      const elapsed = elapsedSeconds * 1000 - row.delayMs;
      if (elapsed < 0) continue;
      const x = row.right - elapsed / 1000 * parameters.speed;
      if (x > viewport.x + viewport.width || x + row.width < viewport.x) continue;
      context.save();
      context.beginPath();
      context.rect(row.left, row.top, row.right - row.left, row.height);
      context.clip();
      context.font = row.font;
      context.fillStyle = parameters.color;
      context.fillText(text, x, row.baseline);
      context.restore();
    }
  });
})();
