(() => {
  const state = window.PHONE_WALL;
  const parameters = state.parameters;
  const digitFont = 'Arial, Helvetica, sans-serif';
  let text = parameters.text.replace(/[\r\n]+/g, ' ');
  const viewport = state.viewport || state.geometry;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Serif text');
  canvas.style.cssText = 'display:block;width:100vw;height:100vh';
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#000';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Test text canvas is unavailable');
  let rows = [], ratio, sx, sy, run = parameters.live && state.preview ? state.liveRun : null, lastAck = 0;
  if(run)text=run.text;
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
    const bands = parameters.live ? (run ? [run.band] : []) : parameters.rows;
    rows = bands.filter(row => row.top < viewport.y + viewport.height && row.top + row.height > viewport.y).map(row => {
      const probe = metrics(100), available = row.height * 0.97;
      let size = Math.min(row.height * 4, available / Math.max(1, probe.ascent + probe.descent) * 100);
      let ink = metrics(size);
      if (ink.ascent + ink.descent > available) {
        size *= available / (ink.ascent + ink.descent);
        ink = metrics(size);
      }
      if (parameters.live && run?.effect === 'flash') {
        const availableWidth = (row.right - row.left) * 0.9;
        if (ink.width > availableWidth) {
          size *= availableWidth / ink.width;
          ink = metrics(size);
        }
      }
      let digitPair = null;
      if (parameters.live && run?.effect === 'flash' && run.targets?.length) {
        const digits = text.replace(/\D/g, '');
        if (digits.length >= run.targets.length * 2) {
          const column = Math.max(0, Math.min(run.targets.length - 1,
            Math.floor((viewport.x + viewport.width / 2 - row.left) / (row.right - row.left) * run.targets.length)));
          const pair = digits.slice(column * 2, column * 2 + 2);
          context.font = `100px ${digitFont}`;
          const measured = context.measureText(pair);
          digitPair = {text: pair, width: measured.width,
            ascent: measured.actualBoundingBoxAscent || 80,
            descent: measured.actualBoundingBoxDescent || 20};
        }
      }
      return {...row, width: ink.width, font: `${size}px ${parameters.fontFamily}`, digitPair,
        baseline: row.top + (row.height - ink.ascent - ink.descent) / 2 + ink.ascent};
    });
  }
  resize();
  window.addEventListener('resize', resize);
  if (parameters.live && !state.preview) {
    PhoneWall.onTicker(snapshot => {
      const next = snapshot.enabled ? snapshot.runs[0] || null : null;
      const changed = next?.id !== run?.id;
      run = next;
      if (changed) { text = run?.text || ''; lastAck = 0; resize(); }
    });
  }
  PhoneWall.onFrame(elapsedSeconds => {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, window.innerWidth, window.innerHeight);
    context.setTransform(ratio * sx, 0, 0, ratio * sy, -viewport.x * ratio * sx, -viewport.y * ratio * sy);
    if (parameters.live && run?.phase === 'preparing') {
      if (!state.preview && rows[0] && Date.now() - lastAck > 2000) { PhoneWall.readyRow(run.id,rows[0].width); lastAck = Date.now(); }
      return;
    }
    for (const row of rows) {
      const elapsed = parameters.live ? Date.now() + state.clockOffsetMs - (run?.startAtServerMs || Infinity) : elapsedSeconds * 1000 - row.delayMs;
      if (elapsed < 0) continue;
      const flashing = parameters.live && run?.effect === 'flash';
      if (flashing && elapsed % 700 >= 500) continue;
      if (flashing && row.digitPair) {
        const pair = row.digitPair;
        context.save();
        context.beginPath();
        context.rect(viewport.x, row.top, viewport.width, row.height);
        context.clip();
        context.translate(viewport.x + viewport.width / 2, row.top + row.height / 2);
        context.scale(viewport.width * 0.94 / pair.width, row.height * 0.96 / (pair.ascent + pair.descent));
        context.font = `100px ${digitFont}`;
        context.fillStyle = parameters.color;
        context.fillText(pair.text, -pair.width / 2, (pair.ascent - pair.descent) / 2);
        context.restore();
        continue;
      }
      const x = flashing ? row.left + (row.right - row.left - row.width) / 2 : row.right - elapsed / 1000 * (parameters.live ? run.speed : parameters.speed);
      if (parameters.live && !flashing && !state.preview && x + row.width < row.left && Date.now() - lastAck > 2000) { PhoneWall.completeRow(run.id); lastAck = Date.now(); }
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
