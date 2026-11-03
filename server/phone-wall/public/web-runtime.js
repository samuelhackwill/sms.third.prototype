(() => {
  if (!window.PHONE_WALL) {
    try {
      const raw = decodeURIComponent(location.hash.slice(1));
      window.PHONE_WALL = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
        ),
      );
    } catch {
      window.PHONE_WALL = {
        parameters: { speed: 100 },
        geometry: { x: 0, y: 0, width: innerWidth, height: innerHeight },
        clockOffsetMs: 0,
        startAtServerMs: Date.now(),
        playing: true,
      };
    }
  }
  const callbacks = [];
  window.PhoneWall ??= {
    onFrame: (fn) => callbacks.push(fn),
    asset: (name) => name,
    ready: () => {},
  };
  function frame() {
    const s = window.PHONE_WALL,
      now = Date.now() + (s.clockOffsetMs || 0);
    if (s.playing && now >= s.startAtServerMs)
      for (const fn of callbacks) fn((now - s.startAtServerMs) / 1000, s);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
