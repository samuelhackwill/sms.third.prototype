import { drawArtwork } from "./scene-preview.js";
const $ = (id) => document.getElementById(id);
function requestId(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();return Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');}
let virtualDraft = null;
let token = "",
  data = null,
  offset = 0,
  edited = false,
  groupSignature = "",
  canvases = [];
const selected = new Set(),
  samples = [];
let wallSignature = "";
let testDeployment = null, testOffline = 0, sendingTest = false;
function selectTab(name) {
  for(const tab of ['control','advanced']) {
    const selected=tab===name;
    $(`${tab}-tab`).setAttribute('aria-selected',String(selected));
    $(`${tab}-tab`).tabIndex=selected?0:-1;
    $(`${tab}-panel`).hidden=!selected;
  }
}
for(const tab of ['control','advanced']) {
  $(`${tab}-tab`).onclick=()=>selectTab(tab);
  $(`${tab}-tab`).onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const next=event.key==='Home'?'control':event.key==='End'?'advanced':tab==='control'?'advanced':'control';
    selectTab(next);$(`${next}-tab`).focus();
  };
}
function status(message) {
  $("status").textContent = message;
}
async function api(input) {
  const response = await fetch("/phone-wall/api", {
    method: input ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  if (!input) {
    data = value;
    $('login').hidden=true;
    render();
  } else await api();
  return value;
}
function run(fn) {
  return async (event) => {
    event?.preventDefault();
    try {
      await fn(event);
    } catch (error) {
      status(error.message);
    }
  };
}
function target() {
  const scope = $("scope").value;
  if (scope === "all") return {};
  if (scope === "selected") {
    if (!selected.size) throw new Error("Select one or more paired phones.");
    return { deviceIds: [...selected] };
  }
  return { group: scope.slice(6) };
}
function scene() {
  const f = $("scene");
  return {
    id: requestId(),
    kind: f.kind.value,
    text: f.text.value,
    speed: Number(f.speed.value),
    fontSize: Number(f.fontSize.value),
    color: f.color.value,
    startAtServerMs: Date.now() + offset + 1500,
    ...(f.hash.value ? { hash: f.hash.value } : {}),
  };
}
function render() {
  const state = data.state,
    devices = data.devices;
  const pairing=data.pairing;
  const test=data.artwork.deployments.find(d=>d.id===testDeployment);
  const busy=test&&['preparing','scheduled'].includes(test.phase);
  $('send-test-text').disabled=sendingTest||!!pairing?.active||!!busy;
  if(test) {
    const count=Object.keys(test.targets).length;
    const failed=Object.values(test.targets).filter(t=>t.status==='error').length;
    $('test-text-status').textContent=failed?`Test failed on ${failed} phones. Open Advanced for details.`:
      test.phase==='preparing'?`Preparing ${count} phones…`:
      test.phase==='scheduled'?`Ready. Starting ${count} phones together…`:
      test.phase==='active'?`Test sent to ${count} phone${count===1?'':'s'}.${testOffline?` ${testOffline} offline phones skipped.`:''}`:
      `Test ${test.phase}: ${test.reason??'see Advanced for details'}`;
  }
  $('pairing-start').disabled=!!pairing?.active;
  $('pairing-stop').disabled=!pairing?.active;
  $('pairing-status').textContent=pairing?.active?`PAIRING ACTIVE · ${pairing.count}/${pairing.capacity} assigned · Next: row ${Math.floor(pairing.count/pairing.columns)+1}, column ${pairing.count%pairing.columns+1}. Tap a red phone.`:`Pairing stopped · ${pairing?.count??0} assigned this session. Existing positions retained.`;
  status(
    `${devices.filter((d) => d.connected).length} connected · ${state.layout.slots.length}/${state.layout.rows * state.layout.columns} paired · ${state.mode} · revision ${state.revision}`,
  );
  if (!edited) $("config").value = JSON.stringify(state, null, 2);
  renderReleases();
  const history = $("history"),
    last = history.value;
  history.replaceChildren(
    ...data.history.map((h) => {
      const o = new Option(
        `Revision ${h.revision} · ${new Date(h.created).toLocaleString()}`,
        h.revision,
      );
      return o;
    }),
  );
  if ([...history.options].some((o) => o.value === last)) history.value = last;
  const signature = JSON.stringify(Object.keys(state.groups));
  if (signature !== groupSignature) {
    groupSignature = signature;
    const previous = $("scope").value;
    $("scope").replaceChildren(
      new Option("Entire matrix", "all"),
      new Option("Selected phones", "selected"),
      ...Object.keys(state.groups).map(
        (g) => new Option(`Group: ${g}`, `group:${g}`),
      ),
    );
    $("scope").value = previous || "all";
  }
  const wallKey = JSON.stringify({
    revision: state.revision,
    slots: state.layout.slots,
    artwork: devices.map((d) => [
      d._id,
      d.display?.artwork?.active?.deploymentId,
    ]),
    selected: [...selected],
    draft: virtualDraft,
    web: $("web-previews").checked,
  });
  if ($("web-previews").checked && wallSignature === wallKey) return;
  wallSignature = wallKey;
  $("wall").style.setProperty("--columns", state.layout.columns);
  $("wall").replaceChildren();
  canvases = [];
  let webPreviewCount = 0;
  for (
    let index = 0;
    index < state.layout.rows * state.layout.columns;
    index++
  ) {
    const slot = state.layout.slots.find((s) => s.slotIndex === index),
      device = devices.find((d) => d._id === slot?.deviceId),
      card = document.createElement("article"),
      canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 400;
    if (selected.has(slot?.deviceId)) card.classList.add("selected");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", String(selected.has(slot?.deviceId)));
    const choose = () => {
      if (slot) {
        selected.has(slot.deviceId)
          ? selected.delete(slot.deviceId)
          : selected.add(slot.deviceId);
        render();
      }
    };
    card.onclick = choose;
    card.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    };
    card.append(canvas);
    const art = device?.display?.artwork?.active;
    const previewDefinition = virtualDraft ?? art?.release.definition;
    const webElement = previewDefinition?.elements.find(
      (e) => e.type === "web",
    );
    if (
      $("web-previews").checked &&
      webElement &&
      slot &&
      selected.has(slot.deviceId) &&
      (virtualDraft || (device?.display?.mode ?? state.mode) === 'exhibition') &&
      webPreviewCount++ < 4
    ) {
      const iframe = document.createElement("iframe");
      iframe.title = `Web artwork preview slot ${index}`;
      iframe.sandbox = "allow-scripts";
      iframe.style.cssText =
        "width:100%;height:190px;border:0;background:black";
      const g = slot.geometry,
        context = {
          ...previewDefinition,
          definition: previewDefinition,
          parameters: previewDefinition.parameters ?? {},
          geometry: g,
          viewport: g,
          playing: true,
          startAtServerMs: virtualDraft ? draftStarted : art.startAtServerMs,
          clockOffsetMs: offset,
        };
      const encoded = btoa(
        Array.from(new TextEncoder().encode(JSON.stringify(context)), (b) =>
          String.fromCharCode(b),
        ).join(""),
      );
      iframe.src =
        (virtualDraft
          ? `/experiment/${webElement.asset}`
          : `/artwork-preview/${art.releaseId}/index.html`) +
        "#" +
        encodeURIComponent(encoded);
      canvas.hidden = true;
      card.append(iframe);
    }
    const t = device?.telemetry ?? {},
      age = Date.now() - new Date(device?.lastSeenAt).getTime();
    const lines = [
      `R${Math.floor(index / state.layout.columns) + 1} C${(index % state.layout.columns) + 1} · Slot ${index}`,
      device
        ? device.connected
          ? "ONLINE"
          : age < 60000
            ? "STALE"
            : "OFFLINE"
        : "VIRTUAL / EMPTY",
      device
        ? `${Math.round((t.battery ?? -1) * 100)}% · ${t.charging ? "charging" : "not charging"} · thermal ${t.thermalState ?? "?"}`
        : "Click a pairing code to assign",
      device
        ? `App ${device.appVersion} · scene ${t.currentSceneId ?? "?"}`
        : "",
      device?.lastError ?? "",
      device?.artworkStatus
        ? `Artwork: ${device.artworkStatus.status} ${device.artworkStatus.code ?? ""}`
        : "",
    ];
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      card.append(p);
    }
    $("wall").append(card);
    canvases.push({ canvas, slot, index });
  }
  $("pending").replaceChildren();
  for (const d of devices.filter((d) => !d.paired)) {
    const b = document.createElement("button");
    b.textContent = `Pair ${d.pairingCode} · ${d.connected?'ONLINE':'OFFLINE'} · ${d.capabilities?.model ?? d._id}`;
    b.onclick = () => {
      $("pair").code.value = d.pairingCode;
      $("pair").width.value = d.capabilities?.width ?? 375;
      $("pair").height.value = d.capabilities?.height ?? 667;
    };
    $("pending").append(b);
  }
}
let lastFrame = 0;
function draw(time) {
  requestAnimationFrame(draw);
  if (!data || $('advanced-panel').hidden || time - lastFrame < 33) return;
  lastFrame = time;
  const now = Date.now() + offset,
    state = data.state;
  const width = state.layout.slots.length
    ? Math.max(
        1,
        ...state.layout.slots.map((s) => s.geometry.x + s.geometry.width),
      )
    : state.layout.columns * 375;
  for (const { canvas, slot, index } of canvases) {
    const c = canvas.getContext("2d"),
      patch =
        data.devices.find((d) => d._id === slot?.deviceId)?.display ??
        state.overrides?.[slot?.deviceId] ??
        {},
      s = patch.scene ?? state.scene,
      mode = patch.mode ?? state.mode,
      g = slot?.geometry ?? {
        x: (index % state.layout.columns) * 375,
        y: Math.floor(index / state.layout.columns) * 667,
        width: 375,
        height: 667,
      };
    c.fillStyle = "#000";
    c.fillRect(0, 0, 300, 400);
    if (mode !== "exhibition" && !virtualDraft) continue;
    const art =
      patch.artwork?.pending?.phase === "scheduled" &&
      now >= patch.artwork.pending.startAtServerMs
        ? patch.artwork.pending
        : patch.artwork?.active;
    if (virtualDraft || art) {
      const manifest = virtualDraft ?? art.release.definition;
      const layout = art?.release.layout;
      const actual =
        layout?.slots.find((s) => s.deviceId === slot?.deviceId)?.geometry ?? g;
      drawArtwork(
        c,
        manifest,
        actual,
        virtualDraft ? draftStarted : art.startAtServerMs,
        now,
        index,
      );
      continue;
    }
    c.save();
    c.scale(300 / g.width, 400 / g.height);
    c.fillStyle = s.color ?? "#fff";
    c.font = `${s.fontSize ?? 48}px monospace`;
    if (s.kind === "solid") {
      c.fillRect(0, 0, g.width, g.height);
    } else if (s.kind === "ticker") {
      const textWidth = c.measureText(s.text).width,
        x =
          width -
          (((Math.max(0, now - s.startAtServerMs) / 1000) * s.speed) %
            (width + textWidth)) -
          g.x;
      c.fillText(s.text, x, (s.fontSize ?? 48) - g.y);
    } else if (s.kind === "test") {
      c.font = "24px monospace";
      c.fillText(`Slot ${index}`, 20, 50);
      c.fillText(String(Math.round(now)), 20, 90);
      c.fillStyle = "#4de0ce";
      c.fillRect(((now / 10) % width) - g.x, 0, 10, g.height);
    } else
      c.fillText(
        s.kind === "text"
          ? s.text
          : `${s.kind} · ${(s.hash ?? "").slice(0, 8)}`,
        20,
        60,
      );
    c.restore();
  }
}
requestAnimationFrame(draw);
$("login").onsubmit = run(async () => {
  token = $("key").value;
  $("key").value = "";
  await api();
});
document
  .querySelectorAll("[data-mode]")
  .forEach(
    (b) =>
      (b.onclick = run(() => api({ action: "mode", mode: b.dataset.mode }))),
  );
document.querySelectorAll("[data-command]").forEach(
  (b) =>
    (b.onclick = run(() =>
      api({
        action: "command",
        name: b.dataset.command,
        ...target(),
        operationId: requestId(),
      }),
    )),
);
$("scene").onsubmit = run(async () => {
  const definition = draftFromControls();
  $("artwork-draft").value = JSON.stringify(definition, null, 2);
  const value = await api({ action: "release.create", definition });
  $("artwork-releases").value = value.release.id;
  $("release-status").textContent =
    "Release created from controls. Prepare a phone or group, then promote the same release.";
});
let draftStarted = Date.now();
function draftFromControls() {
  const s = scene(),
    layout = data?.state.layout ?? { rows: 6, columns: 5, slots: [] };
  const width = Math.max(
      layout.columns * 375,
      ...layout.slots.map((s) => s.geometry.x + s.geometry.width),
    ),
    height = Math.max(
      layout.rows * 667,
      ...layout.slots.map((s) => s.geometry.y + s.geometry.height),
    );
  const type =
    s.kind === "solid" ? "rect" : s.kind === "test" ? "text" : s.kind;
  return {
    sceneSchemaVersion: 1,
    artworkId: "museum-artwork",
    artworkVersion: new Date().toISOString(),
    canvas: { width, height },
    background: "#102b28",
    transition: { type: "fade", durationMs: 350 },
    parameters: { text: s.text, color: s.color, speed: s.speed },
    elements: [
      {
        id: "main",
        type,
        frame: { x: 0, y: 0, width, height },
        text:
          s.kind === "test" ? "Phone {deviceId} / R{row} C{column}" : s.text,
        color: s.color,
        fontSize: s.fontSize,
        speed: s.speed,
        ...(s.hash ? { asset: s.hash } : {}),
      },
    ],
  };
}
function renderReleases() {
  const selector = $("artwork-releases"),
    chosen = selector.value;
  selector.replaceChildren(
    ...(data.artwork?.releases ?? []).map(
      (r) =>
        new Option(
          `${r.definition.artworkId} / ${r.definition.artworkVersion} · ${r.id.slice(0, 8)}`,
          r.id,
        ),
    ),
  );
  if ([...selector.options].some((o) => o.value === chosen))
    selector.value = chosen;
  $("deployments").replaceChildren();
  for (const d of data.artwork?.deployments ?? []) {
    const line = document.createElement("p");
    const counts = Object.entries(d.targets)
      .map(
        ([id, t]) =>
          `${id.slice(0, 8)}: ${t.status}${t.code ? " (" + t.code + ")" : ""}`,
      )
      .join(" · ");
    line.textContent = `${d.id.slice(0, 8)} / ${d.releaseId.slice(0, 8)} / ${d.phase}${d.reason ? " / " + d.reason : ""}\n${counts}`;
    if (d.phase === "preparing") {
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel Preparation";
      cancel.onclick = run(() =>
        api({ action: "release.cancel", deploymentId: d.id }),
      );
      line.append(cancel);
    }
    $("deployments").append(line);
  }
}
$("draft-from-controls").onclick = () => {
  $("artwork-draft").value = JSON.stringify(draftFromControls(), null, 2);
};
$("artwork-draft").value = JSON.stringify(draftFromControls(), null, 2);
$("draft-preview").onclick = run(() => {
  virtualDraft = JSON.parse($("artwork-draft").value);
  draftStarted = Date.now() + offset;
  $("release-status").textContent = "Local draft preview. No phones changed.";
});
$("draft-live").onclick = () => {
  virtualDraft = null;
  $("release-status").textContent = "Showing live releases.";
};
$("web-previews").onchange = () => {
  if (data) render();
};
$("release-create").onclick = run(async () => {
  const value = await api({
    action: "release.create",
    definition: JSON.parse($("artwork-draft").value),
  });
  $("artwork-releases").value = value.release.id;
  $("release-status").textContent =
    `Immutable release ${value.release.id.slice(0, 12)} created. Prepare it on a target.`;
});
async function deployRelease(all = false) {
  const releaseId = $("artwork-releases").value;
  if (!releaseId) throw new Error("Create or select a release first.");
  const result = await api({
    action: "release.deploy",
    releaseId,
    operationId: requestId(),
    ...(all ? {} : target()),
  });
  virtualDraft = null;
  $("release-status").textContent =
    `Preparing ${result.deployment.id.slice(0, 8)}. Waiting for every target before synchronized activation.`;
}
$("release-target").onclick = run(() => deployRelease());
$("release-wall").onclick = run(() => deployRelease(true));
$("release-rollback").onclick = run(() => deployRelease());
$("preview").onclick = run(() => {
  virtualDraft = draftFromControls();
  draftStarted = Date.now() + offset;
  $("artwork-draft").value = JSON.stringify(virtualDraft, null, 2);
  $("release-status").textContent = "Virtual draft preview. Phones unchanged.";
});
$("identify").onclick = run(() => api({ action: "identify", ...target() }));
$('pairing-start').onclick=run(()=>api({action:'pairing.start'}));
$('pairing-stop').onclick=run(()=>api({action:'pairing.stop'}));
$('send-test-text').onclick=run(async()=>{
  sendingTest=true;testDeployment=null;$('send-test-text').disabled=true;
  $('test-text-status').textContent='Sending test…';
  try {
    const result=await api({action:'test.text'});
    testDeployment=result.deployment.id;testOffline=result.offline;
  } catch(error) {$('test-text-status').textContent=error.message;throw error;}
  finally {sendingTest=false;if(data)render();}
});
$("pair").onsubmit = run(() => {
  const f = $("pair");
  return api({
    action: "pair",
    code: f.code.value.trim().toUpperCase(),
    slotIndex: Number(f.slotIndex.value),
    geometry: Object.fromEntries(
      ["x", "y", "width", "height"].map((k) => [k, Number(f[k].value)]),
    ),
  });
});
$("config").oninput = () => {
  edited = true;
};
$("load-config").onclick = () => {
  edited = false;
  render();
};
$("save-config").onclick = run(async () => {
  const config = JSON.parse($("config").value);
  await api({
    action: "configure",
    config,
    expectedRevision: config.revision,
    operationId: requestId(),
  });
  edited = false;
  render();
});
$("rollback").onclick = run(() =>
  api({
    action: "rollback",
    revision: Number($("history").value),
    expectedRevision: data.state.revision,
    operationId: requestId(),
  }),
);
async function upload(body, mime) {
  const r = await fetch("/phone-wall/media", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
    body,
  });
  const asset = await r.json();
  if (!r.ok) throw new Error(asset.error);
  $("scene").hash.value = asset.hash;
  $("scene").kind.value =
    mime === "text/javascript"
      ? "web"
      : mime.startsWith("image/")
        ? "image"
        : "video";
  status(`Uploaded ${asset.hash}. Preview or publish the scene.`);
}
$("upload").onsubmit = run(() => {
  const file = $("upload").file.files[0];
  return upload(file, file.type);
});
$("code").value =
  "const app = new PIXI.Application({resizeTo:window,backgroundColor:0x102b28});\ndocument.body.appendChild(app.view);\nconst dot = new PIXI.Graphics().beginFill(0xff653c).drawCircle(0,0,40).endFill();\napp.stage.addChild(dot);\napp.ticker.stop();\nPhoneWall.onFrame((elapsed,state)=>{\n dot.x = (elapsed * (state.parameters.speed || 100)) % window.innerWidth;\n dot.y = window.innerHeight / 2;\n app.render();\n});";
$("upload-code").onclick = run(() =>
  upload($("code").value, "text/javascript"),
);
const launchKey=new URLSearchParams(location.hash.slice(1)).get('operatorKey');
if(launchKey!==null){history.replaceState(null,'',location.pathname+location.search);if(/^[a-f0-9]{64}$/.test(launchKey)){token=launchKey;api().catch(error=>status(error.message));}}
setInterval(async () => {
  if (!token) return;
  const sent = Date.now();
  try {
    await api();
    const received = Date.now();
    if (data.serverTimeMs) {
      samples.push({
        rtt: received - sent,
        offset: data.serverTimeMs - (sent + received) / 2,
      });
      if (samples.length > 20) samples.shift();
      offset = samples.reduce((a, b) => (a.rtt < b.rtt ? a : b)).offset;
    }
  } catch (error) {
    status(`Controller unavailable: ${error.message}. Retrying…`);
  }
}, 3000);
