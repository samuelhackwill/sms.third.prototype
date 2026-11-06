(() => {
  const state = window.PHONE_WALL;
  const parameters = state.parameters;
  const digitFont = 'Arial, Helvetica, sans-serif';
  const sweepStepMs = 120, sweepFadeMs = 260;
  const clamp = value => Math.max(0, Math.min(1, value));
  const emojiPattern = /[\u00A9\u00AE\u203C\u2049\u2122\u2139\u{1F000}-\u{1FAFF}\u2600-\u27BF\u20E3]/u;
  const segmenter = Intl.Segmenter ? new Intl.Segmenter('und', {granularity:'grapheme'}) : null;
  const emojiCache = new Map();
  const segments = value => segmenter ? [...segmenter.segment(value)].map(part => part.segment) : Array.from(value);
  function tintedEmoji(ctx, glyph, color, backgroundColor) {
    const key = `${ctx.font}|${glyph}|${backgroundColor || color}`;
    if (emojiCache.has(key)) return emojiCache.get(key);
    const measured = ctx.measureText(glyph), size = parseFloat(ctx.font) || 100;
    const left = Math.ceil(Math.max(0, measured.actualBoundingBoxLeft || 0)) + 4;
    const top = Math.ceil(Math.max(measured.actualBoundingBoxAscent || 0, size * 0.9)) + 4;
    const width = Math.ceil(Math.max(measured.width, measured.actualBoundingBoxRight || 0) + left + 4);
    const height = top + Math.ceil(Math.max(measured.actualBoundingBoxDescent || 0, size * 0.25)) + 4;
    const tile = document.createElement('canvas'); tile.width = width; tile.height = height;
    const ink = tile.getContext('2d'); ink.font = ctx.font; ink.textBaseline = 'alphabetic';
    const hue = /^hsl\(\s*([\d.]+)/i.exec(backgroundColor || '')?.[1];
    let tint;
    if (hue !== undefined) {
      ink.fillStyle = `hsl(${hue}, 85%, 75%)`;
      ink.fillRect(0, 0, 1, 1);
      tint = ink.getImageData(0, 0, 1, 1).data.slice(0, 3);
      ink.clearRect(0, 0, 1, 1);
    }
    ink.fillText(glyph, left, top);
    if (tint) {
      const image = ink.getImageData(0, 0, width, height);
      for (let i = 0; i < image.data.length; i += 4) {
        if (!image.data[i + 3]) continue;
        const luminance = (0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]) / 255;
        const shade = 0.68 + 0.32 * luminance;
        for (let channel = 0; channel < 3; channel++) image.data[i + channel] = Math.round(tint[channel] * shade);
        image.data[i + 3] = Math.min(255, Math.round(image.data[i + 3] * 1.4));
      }
      ink.putImageData(image, 0, 0);
    } else {
      ink.globalCompositeOperation = 'source-in'; ink.fillStyle = color; ink.fillRect(0, 0, width, height);
    }
    const result = {tile, left, top, advance:measured.width};
    if (emojiCache.size >= 8) emojiCache.delete(emojiCache.keys().next().value);
    emojiCache.set(key, result);
    return result;
  }
  function drawColoredText(ctx, value, x, baseline, textColor, backgroundColor = null) {
    let cursor = x, plain = '';
    const flush = () => {if (!plain) return; ctx.fillStyle = textColor; ctx.fillText(plain, cursor, baseline); cursor += ctx.measureText(plain).width; plain = '';};
    for (const part of segments(value)) {
      if (!emojiPattern.test(part)) {plain += part; continue;}
      flush();
      const glyph = tintedEmoji(ctx, part, textColor, backgroundColor);
      ctx.drawImage(glyph.tile, cursor - glyph.left, baseline - glyph.top);
      cursor += glyph.advance;
    }
    flush();
  }
  let text = parameters.text.replace(/[\r\n]+/g, ' ');
  const viewport = state.viewport || state.geometry;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Wall text');
  canvas.style.cssText = 'display:block;width:100vw;height:100vh';
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#000';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Test text canvas is unavailable');
  let rows = [], ratio, sx, sy, run = parameters.live && state.preview ? state.liveRun : null, lastAck = 0;
  let transition = state.ticker?.transition || null;
  const incomingStyle = () => parameters.curatedMode && run?.effect === 'sms-sweep';
  function sweepTiming(row, elapsed) {
    const count = run.band.targets.length;
    const column = Math.max(0, Math.min(count - 1,
      Math.floor((viewport.x + viewport.width / 2 - row.left) / (row.right - row.left) * count)));
    const fromRight = count - 1 - column;
    const introMs = (count - 1) * sweepStepMs + sweepFadeMs;
    const travelMs = (row.right - row.left + row.width) / run.speed * 1000;
    const outroStart = introMs + travelMs;
    return {introMs,doneAt:outroStart + introMs,
      backgroundAlpha:Math.min(clamp((elapsed - fromRight * sweepStepMs) / sweepFadeMs),
        clamp((outroStart + fromRight * sweepStepMs + sweepFadeMs - elapsed) / sweepFadeMs))};
  }
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
      if (parameters.live && run?.effect === 'flash' && run.band.targets.length) {
        const digits = text.replace(/\D/g, '');
        if (digits.length >= run.band.targets.length * 2) {
          const column = Math.max(0, Math.min(run.band.targets.length - 1,
            Math.floor((viewport.x + viewport.width / 2 - row.left) / (row.right - row.left) * run.band.targets.length)));
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
      transition = snapshot.transition || null;
      const next = snapshot.enabled ? snapshot.runs[0] || null : null;
      const changed = next?.id !== run?.id;
      run = next;
      if (changed) { text = run?.text || ''; lastAck = 0; resize(); }
    });
  }
  function drawTransition(serverNow) {
    if (!transition) return false;
    const elapsed = serverNow - transition.startAtServerMs;
    const scrollMs = 850 / transition.settings.scrollSpeed;
    const blinkPeriodMs = 200 / transition.settings.blinkSpeed;
    const blinkEndMs = scrollMs + transition.settings.blinkCount * blinkPeriodMs;
    if (elapsed < 0 || elapsed >= transition.durationMs) return false;
    const blinking = elapsed >= scrollMs && elapsed < blinkEndMs && (elapsed - scrollMs) % blinkPeriodMs >= blinkPeriodMs * 0.55;
    const alpha = blinking ? 0 : elapsed >= blinkEndMs ? Math.max(0, (transition.durationMs - elapsed) / 400) : 1;
    const glyphs = ['\u2764\uFE0F', 'S', 'M', 'S', '\u2764\uFE0F'];
    context.fillStyle = '#000000';
    context.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
    for (const row of transition.rows) {
      if (row.top >= viewport.y + viewport.height || row.top + row.height <= viewport.y) continue;
      context.save();
      context.beginPath();context.rect(row.left,row.top,row.right-row.left,row.height);context.clip();
      context.globalAlpha = alpha;
      const offset = (row.row % 2 === 0 ? -1 : 1) * (row.right-row.left) * (1-Math.min(1,elapsed/scrollMs));
      const cells = row.cells || [];
      const first = Math.max(0, Math.floor((cells.length-glyphs.length)/2));
      for(let index=0;index<Math.min(cells.length,glyphs.length);index++){
        const cell=cells[first+index],glyph=glyphs[index];
        context.save();
        context.font='100px Arial, Helvetica, sans-serif';
        const ink=context.measureText(glyph);
        const ascent=ink.actualBoundingBoxAscent||80,descent=ink.actualBoundingBoxDescent||20;
        context.translate(cell.x+cell.width/2+offset,cell.y+cell.height*0.01);
        context.scale(cell.width*0.9/Math.max(1,ink.width),cell.height*0.98/(ascent+descent));
        drawColoredText(context,glyph,-ink.width/2,ascent,row.color||'#ff0000');
        context.restore();
      }
      context.restore();
    }
    return true;
  }
  PhoneWall.onFrame(elapsedSeconds => {
    const now = Date.now();
    const incoming = incomingStyle();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, window.innerWidth, window.innerHeight);
    const sweep = incoming && run?.effect === 'sms-sweep';
    const elapsed = now + state.clockOffsetMs - (run?.startAtServerMs || Infinity);
    const timing = sweep && rows[0] && run.phase === 'playing' ? sweepTiming(rows[0], elapsed) : null;
    const backgroundAlpha = incoming ? sweep ? timing?.backgroundAlpha ?? 0 : 1 : 0;
    if (backgroundAlpha > 0) {
      context.save();
      context.globalAlpha = backgroundAlpha;
      context.fillStyle = run.backgroundColor || '#15202b';
      context.fillRect(0, 0, window.innerWidth, window.innerHeight);
      context.restore();
    }
    context.setTransform(ratio * sx, 0, 0, ratio * sy, -viewport.x * ratio * sx, -viewport.y * ratio * sy);
    if (drawTransition(now + state.clockOffsetMs)) return;
    if (parameters.live && run?.phase === 'preparing') {
      if (!state.preview && rows[0] && Date.now() - lastAck > 2000) { PhoneWall.readyRow(run.id,rows[0].width); lastAck = Date.now(); }
      return;
    }
    for (const row of rows) {
      const rowElapsed = parameters.live ? elapsed : elapsedSeconds * 1000 - row.delayMs;
      const textElapsed = sweep ? rowElapsed - timing.introMs : rowElapsed;
      if (textElapsed < 0) continue;
      const flashing = parameters.live && run?.effect === 'flash';
      if (flashing && rowElapsed % 700 >= 500) continue;
      if (flashing && row.digitPair) {
        const pair = row.digitPair;
        context.save();
        context.beginPath();
        context.rect(viewport.x, row.top, viewport.width, row.height);
        context.clip();
        context.translate(viewport.x + viewport.width / 2, row.top + row.height / 2);
        context.scale(viewport.width * 0.94 / pair.width, row.height * 0.96 / (pair.ascent + pair.descent));
        context.font = `100px ${digitFont}`;
        context.fillStyle = incomingStyle() ? '#ffffff' : parameters.color;
        context.fillText(pair.text, -pair.width / 2, (pair.ascent - pair.descent) / 2);
        context.restore();
        continue;
      }
      const x = flashing ? row.left + (row.right - row.left - row.width) / 2 : row.right - textElapsed / 1000 * (parameters.live ? run.speed : parameters.speed);
      if (parameters.live && !flashing && !state.preview && (sweep ? rowElapsed >= timing.doneAt : x + row.width < row.left) && Date.now() - lastAck > 2000) { PhoneWall.completeRow(run.id); lastAck = Date.now(); }
      if (x > viewport.x + viewport.width || x + row.width < viewport.x) continue;
      context.save();
      context.beginPath();
      context.rect(row.left, row.top, row.right - row.left, row.height);
      context.clip();
      context.font = row.font;
      const textColor = incoming ? '#ffffff' : parameters.color;
      drawColoredText(context, text, x, row.baseline, textColor, incoming ? run.backgroundColor : null);
      context.restore();
    }
  });
})();
