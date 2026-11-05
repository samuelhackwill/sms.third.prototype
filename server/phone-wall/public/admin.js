import { drawArtwork, drawLiveText, hasTestTextPreview } from "./scene-preview.js";
const $ = (id) => document.getElementById(id);
function requestId(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();return Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');}
let virtualDraft = null;
let inspectedDeviceId = null;
let token = sessionStorage.getItem('phoneWallOperatorKey') ?? "",
  data = null,
  offset = 0,
  edited = false,
  groupSignature = "",
  canvases = [];
const selected = new Set(),
  samples = [];
let wallSignature = "";
let testDeployment = null, testOffline = 0, sendingTest = false;
let testSpeedEdited=false;
let testMessageEdited=false;
let kissingEdited=false;
let curatedEdited=false,curatedLoadedCount=-1,curatedLoadedSelected=-1,curatedLoading=false;
let curatedLoadedGeneration=null;
let curatedSaveTimer=null,curatedEditVersion=0;
let speedDragMode=null,densityDragging=false;
function speedLabels(mode){
  const min=Number($(`${mode}-min-speed`).value),max=Number($(`${mode}-max-speed`).value);
  $(`${mode}-min-value`).textContent=`${min} px/s`;
  $(`${mode}-max-value`).textContent=`${max} px/s`;
}
function densityLabel(){$('curated-archive-density-value').textContent=$('curated-archive-density').value==='6'?'Saturate':$('curated-archive-density').value;}
const curatedTexts=()=>[$('curated-custom-a').value,$('curated-custom-b').value];
for(const id of ['curated-custom-a','curated-custom-b'])$(id).oninput=()=>{
  curatedEdited=true;const version=++curatedEditVersion;
  clearTimeout(curatedSaveTimer);
  if(data?.ticker?.enabled&&data.ticker.mode==='curated')curatedSaveTimer=setTimeout(async()=>{
    try{await api({action:'curated.messages',messages:curatedTexts()});if(version===curatedEditVersion)curatedEdited=false;}
    catch(error){status(error.message);}
  },500);
};
function updateCuratedMarkers(){
  const list=$('curated-list'),rail=$('curated-selection-rail');
  const height=Math.max(1,list.scrollHeight);
  const markers=[...list.querySelectorAll('button[aria-pressed="true"]')].map(button=>{
    const marker=document.createElement('span');
    marker.className='curated-selection-marker';
    marker.style.top=`${Math.max(1,Math.min(99,(button.offsetTop+button.offsetHeight/2)/height*100))}%`;
    return marker;
  });
  rail.replaceChildren(...markers);
}
window.addEventListener('resize',()=>requestAnimationFrame(updateCuratedMarkers));
async function loadCurated(){
  if(curatedLoading||!token)return;
  curatedLoading=true;
  try{
    const response=await fetch('/phone-wall/curated',{headers:{Authorization:`Bearer ${token}`}});
    if(!response.ok)throw new Error('curated-library-unavailable');
    const {messages}=await response.json();
    const items=messages.map(message=>{
      const button=document.createElement('button');
      button.type='button';
      const label=document.createElement('span'),meta=document.createElement('span'),body=document.createElement('span');
      label.className='curated-selection-label';label.textContent='✓ Included';
      meta.className='curated-source-label';meta.textContent=message.source==='sms'?`Archived SMS · ${message.sender}`:'Messages archive';
      body.textContent=message.text;
      button.append(label,meta,body);
      button.setAttribute('aria-pressed',String(message.selected===1));
      button.onclick=run(async()=>{
        const result=await api({action:'curated.toggle',id:message.id});
        button.setAttribute('aria-pressed',String(result.selected));
        requestAnimationFrame(updateCuratedMarkers);
      });
      return button;
    });
    $('curated-list').replaceChildren(...items);
    if(!items.length)$('curated-list').textContent='No archived messages yet.';
    requestAnimationFrame(updateCuratedMarkers);
    curatedLoadedCount=messages.length;
    curatedLoadedSelected=messages.filter(message=>message.selected===1).length;
    curatedLoadedGeneration=data?.ticker?.libraryGeneration??null;
  }catch(error){$('curated-list').textContent=error.message;}
  finally{curatedLoading=false;}
}
for(const id of ['kissing-trim','kissing-before','kissing-after','kissing-in','kissing-out'])$(id).oninput=()=>{kissingEdited=true;};
const defaultTestMessage=$('test-text-message').value;
$('test-text-message').oninput=()=>{testMessageEdited=true;};
function showTestSpeed() {
  $('test-text-speed-value').textContent=`${$('test-text-speed').value} logical px/s`;
}
$('test-text-speed').oninput=()=>{testSpeedEdited=true;showTestSpeed();};
function selectTab(name) {
  for(const tab of ['control','advanced']) {
    const selected=tab===name;
    $(`${tab}-tab`).setAttribute('aria-selected',String(selected));
    $(`${tab}-tab`).tabIndex=selected?0:-1;
    $(`${tab}-panel`).hidden=!selected;
  }
  if (data) render();
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
  const sent = Date.now();
  const response = await fetch("/phone-wall/api", {
    method: input ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) { token = ''; sessionStorage.removeItem('phoneWallOperatorKey'); $('login').hidden = false; }
    throw new Error(value.error);
  }
  if (!input) {
    data = value;
    if (data.serverTimeMs) {
      const received = Date.now();
      samples.push({ rtt: received - sent, offset: data.serverTimeMs - (sent + received) / 2 });
      if (samples.length > 20) samples.shift();
      offset = samples.reduce((a, b) => a.rtt < b.rtt ? a : b).offset;
    }
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
// Use the same scheduled handover and per-device assignment as the phone.
function artworkAt(patch, now = Date.now() + offset) {
  if(patch.kissing?.enabled)return null;
  if (patch.scene?.id === 'identify' && patch.previewUntil > now) return null;
  const pending = patch.artwork?.pending;
  return pending?.phase === 'scheduled' && now >= pending.startAtServerMs
    ? pending : patch.artwork?.active;
}
function isPairing(patch) {
  return patch.pairing?.active && patch.pairing.expiresAt > Date.now() + offset;
}

function renderPhoneDetails() {
  const slot = data.state.layout.slots.find(s => s.deviceId === inspectedDeviceId);
  const device = data.devices.find(d => d._id === slot?.deviceId);
  $('phone-details').hidden = !device;
  if (!device) return;
  const lines = deviceLines(device, slot.slotIndex);
  $('phone-details-heading').textContent = lines[0];
  $('phone-details-readings').replaceChildren(...lines.slice(1).filter(Boolean).map(line => {
    const p = document.createElement('p'); p.textContent = line; return p;
  }));
  $('phone-details-preview').textContent = canvases.find(c => c.slot?.deviceId === device._id)?.previewNote.textContent ?? '';
  $('phone-select').textContent = selected.has(device._id) ? 'Deselect for Advanced actions' : 'Select for Advanced actions';
  $('phone-select').setAttribute('aria-pressed', String(selected.has(device._id)));
}

function deviceLines(device, index) {
  const age = Date.now() + offset - new Date(device?.lastSeenAt).getTime();
  return [
    `R${Math.floor(index / data.state.layout.columns) + 1} C${index % data.state.layout.columns + 1} · Slot ${index}`,
    device ? device.connected ? 'ONLINE' : age < 60000 ? 'STALE' : 'OFFLINE' : 'EMPTY · no phone assigned',
    device ? `App ${device.appVersion ?? '?'}` : '',
    device?.lastError ? `Error ${device.lastError}` : '',
  ];
}
function renderErrors() {
  const entries = (data.errors ?? []).map(entry => ({
    at: entry.at, deviceId: entry.deviceId,
    source: entry.record?.source ?? 'phone', code: entry.record?.code ?? entry.record?.result ?? 'error',
    appVersion: entry.record?.appVersion, freeDisk: entry.record?.freeDisk,
  }));
  for (const device of data.devices) {
    if (!device.lastError || entries.some(entry => entry.deviceId === device._id && entry.code === device.lastError)) continue;
    entries.push({at: device.lastSeenAt, deviceId: device._id, source: 'current', code: device.lastError, appVersion: device.appVersion});
  }
  entries.sort((a,b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const slots = new Map(data.state.layout.slots.map(slot => [slot.deviceId, slot.slotIndex]));
  $('error-log-entries').replaceChildren(...entries.slice(0,100).map(entry => {
    const p = document.createElement('p');
    const slot = slots.get(entry.deviceId);
    p.textContent = `${entry.at ? new Date(entry.at).toLocaleString() : 'Unknown time'} · ${slot == null ? entry.deviceId.slice(0,8) : `Slot ${slot}`} · App ${entry.appVersion ?? '?'}${entry.freeDisk > 0 ? ` · ${(entry.freeDisk / 1073741824).toFixed(1)} GB free` : ''} · ${entry.source}: ${entry.code}`;
    return p;
  }));
  if (!entries.length) $('error-log-entries').textContent = 'No phone errors recorded.';
}
function render() {
  const state = data.state,
    devices = data.devices;
  const cpu=data.system?.controllerCpuPercent;
  $('controller-cpu').textContent=`Controller CPU ${Number.isFinite(cpu)?`${cpu}%`:'—'}`;
  const pairing=data.pairing;
  const kissing=data.kissing;
  $('kissing-start').disabled=!kissing||kissing.enabled||!!pairing?.active||!!kissing.upgradeRequired?.length;
  $('kissing-stop').disabled=!kissing?.enabled;
  $('kissing-apply').disabled=!kissing||!!pairing?.active;
  if(kissing&&!kissingEdited){
    $('kissing-trim').checked=kissing.trim;
    for(const [id,key] of [['kissing-before','trimStartOffsetSec'],['kissing-after','trimEndOffsetSec'],['kissing-in','revealDurationMs'],['kissing-out','fadeOutDurationMs']])$(id).value=kissing[key];
  }
  $('kissing-status').textContent=kissing?.upgradeRequired?.length?`Install phone app 2.4 on ${kissing.upgradeRequired.length} connected phones to enable video.`:
    `${kissing?.enabled?(state.mode==='exhibition'&&!pairing?.active?'PLAYING INDEPENDENTLY · SOUND ON':'PAUSED (night / pairing)'):'STOPPED'} · ${kissing?.clips??0} clips cached on Mac${kissing?.busy?' · caching available clips':''}${kissing?.lastError?' · '+kissing.lastError:''}`;
  renderPhoneDetails();
  renderErrors();
  $('debug-toggle').checked=!!state.debugEnabled;
  $('debug-status').textContent=state.debugEnabled?'Visible on phones with app 2.4.2 or newer.':'Hidden on phones.';
  const live=data.ticker;
  const barthesActive=live?.enabled&&live.mode==='barthes';
  const smsActive=live?.active?.filter(run=>run.source==='router').length??0;
  $('live-status').textContent=`Always watching · ${live?.routerQueued??0} SMS waiting · ${smsActive} SMS active · ${live?.routerArchive?.total??0} archived · ${live?.routerArchive?.pending??0} awaiting router cleanup${live?.routerArchive?.missingId?` · ${live.routerArchive.missingId} lack router IDs`:''}`;
  $('live-alert-toggle').checked=!!live?.liveAlertEnabled;
  $('live-alert-status').textContent=live?.liveAlertEnabled?live?.alertUpgradeRequired?.length?`Update ${live.alertUpgradeRequired.length} connected phones to app 2.4.4 for ding and vibration.`:'Ding and vibration enabled on updated phones.':'Silent when live SMS starts.';
  const transition=data.transition;
  $('sms-transition').disabled=!!pairing?.active||state.mode!=='exhibition'||!!kissing?.enabled||!transition?.available||!!transition?.preparing||!!transition?.active;
  $('sms-transition-status').textContent=transition?.active?'Playing across the wall…':transition?.preparing?'Preparing the web artwork on connected phones…':transition?.error??(transition?.available?'Ready for a manual transition.':'Show live text artwork on connected phones first.');
  $('barthes-start').disabled=!!barthesActive||!!pairing?.active||!!live?.upgradeRequired?.length||!state.layout.slots.length;
  $('barthes-stop').disabled=!barthesActive;
  $('barthes-status').textContent=live?.upgradeRequired?.length?`Install phone app 2.3 on ${live.upgradeRequired.length} connected phones.`:
    barthesActive?`${state.mode==='exhibition'?'PLAYING':'WAITING'} · ${live.queued} queued · ${live.active.length} active rows · ${live.completed} completed`:'Stopped';
  const curatedActive=live?.enabled&&live.mode==='curated';
  if(!curatedEdited){$('curated-custom-a').value=live?.customTexts?.[0]??'';$('curated-custom-b').value=live?.customTexts?.[1]??'';}
  $('curated-start').disabled=!!pairing?.active||!state.layout.slots.length||!!live?.upgradeRequired?.length;
  $('curated-start').textContent=curatedActive?'Apply row messages':'Start Curated Mode';
  $('curated-stop').disabled=!curatedActive;
  $('curated-second-toggle').checked=!!live?.curatedSecondEnabled;
  $('curated-db-toggle').checked=!!live?.curatedInjectionEnabled;
  $('curated-archive-toggle').checked=!!live?.archiveReplayEnabled;
  $('curated-status').textContent=curatedActive?`${live.curatedSecondEnabled?'Two reserved rows':'First row reserved'} · rotation ${live.curatedInjectionEnabled?'on':'off'} · color sweep ${live.archiveReplayEnabled?'on':'off'} · ${live.queued} waiting`:`Stopped · ${live?.curatedSelected??0} selected texts`;
  for(const mode of ['barthes','curated']){if(speedDragMode!==mode){$(`${mode}-min-speed`).value=live?.speedRanges?.[mode]?.min??(mode==='barthes'?1000:240);$(`${mode}-max-speed`).value=live?.speedRanges?.[mode]?.max??(mode==='barthes'?6000:240);}speedLabels(mode);}
  if(!densityDragging)$('curated-archive-density').value=live?.archiveDensity??1;
  densityLabel();
  if(curatedLoadedCount!==live?.curatedCount||curatedLoadedSelected!==live?.curatedSelected||curatedLoadedGeneration!==live?.libraryGeneration)void loadCurated();
  const router=live?.router;
  $('reader-status').textContent=live?.upgradeRequired?.length?`Install phone app 2.3 for live playback (${live.upgradeRequired.length} phones need updating).`:router?.status==='reading'&&Date.now()-router.at<15000?router.deleteError?`Tenda polled · cleanup error: ${router.deleteError}`:router.stats?.emptyResponse?`Tenda polled ${Math.max(0,Math.round((Date.now()-router.at)/1000))}s ago · router returned no inbox · last full inbox ${router.lastNonempty?`${Math.round((Date.now()-router.lastNonempty.at)/60000)} min ago`:'never'}`:`Tenda router connected · polled ${Math.max(0,Math.round((Date.now()-router.at)/1000))}s ago`:router?.status==='error'?`Tenda router error: ${router.code}`:router?.status==='starting'?'Connecting to Tenda router…':'Tenda router is not connected.';
  if(!testSpeedEdited)$('test-text-speed').value=state.testTextSpeed??240;
  if(!testMessageEdited)$('test-text-message').value=state.testText??defaultTestMessage;
  showTestSpeed();
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
    artwork: devices.map((d) => {
      const art = artworkAt(d.display ?? {});
      return [d._id, art?.deploymentId, art?.releaseId, art?.startAtServerMs,
        d.display?.mode, d.display?.scene, d.display?.kissing?.enabled, isPairing(d.display ?? {}), d.display?.pairing?.slotIndex];
    }),
    selected: [...selected],
    inspected: inspectedDeviceId,
    draft: virtualDraft,
    web: $("web-previews").checked,
    live: data.ticker?.active.map(run=>[run.id,run.phase,run.startAtServerMs]),
  });
  $('matrix-status').textContent = virtualDraft
    ? 'LOCAL DRAFT · Phones are unchanged. Choose Show Live Wall to return to controller state.'
    : 'LIVE CONTROLLER STATE · 3s refresh. Offline phones may differ.';
  // Keep running web renderers alive across telemetry polls.
  for (const { slot, index, labels } of canvases) {
    const device = devices.find(d => d._id === slot?.deviceId);
    const lines = deviceLines(device, index);
    labels.forEach((label, i) => { label.textContent = i === 0 ? `R${Math.floor(index / state.layout.columns) + 1} C${index % state.layout.columns + 1}` : lines[i]; });
    const card = labels[0].parentElement;
    card.setAttribute('aria-label', lines.filter(Boolean).join('. '));
    card.dataset.connection = device ? device.connected ? 'online' : 'offline' : 'empty';
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
  if (wallSignature === wallKey) return;
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
    canvas.style.aspectRatio = `${slot?.geometry.width ?? 375} / ${slot?.geometry.height ?? 667}`;
    if (selected.has(slot?.deviceId)) card.classList.add("selected");
    card.tabIndex = slot ? 0 : -1;
    card.setAttribute("role", slot ? "button" : "img");
    card.setAttribute('aria-expanded', String(!!slot && inspectedDeviceId === slot.deviceId));
    card.setAttribute('aria-controls', 'phone-details');
    if (slot?.deviceId === inspectedDeviceId) card.classList.add('inspected');
    const choose = () => {
      if (slot) {
        inspectedDeviceId = slot.deviceId;
        render();
        $('phone-details').scrollIntoView({ block: 'nearest' });
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
    const art = artworkAt(device?.display ?? {});
    const previewDefinition = virtualDraft ?? art?.release.definition;
    const webElement = previewDefinition?.elements.find(
      (e) => e.type === "web",
    );
    if (
      webElement &&
      !hasTestTextPreview(previewDefinition) && previewDefinition?.artworkId !== 'live-ticker' &&
      slot &&
      (virtualDraft || !isPairing(device?.display ?? {})) &&
      (virtualDraft || (device?.display?.mode ?? state.mode) === 'exhibition') &&
      $("web-previews").checked && selected.has(slot.deviceId) && webPreviewCount++ < 4
    ) {
      const iframe = document.createElement("iframe");
      iframe.title = `Web artwork preview slot ${index}`;
      iframe.sandbox = "allow-scripts";
      iframe.style.cssText =
        `width:100%;aspect-ratio:${slot.geometry.width} / ${slot.geometry.height};border:0;background:black`;
      const g = (virtualDraft ? null : art?.release.layout?.slots.find(s => s.deviceId === slot.deviceId)?.geometry) ?? slot.geometry,
        context = {
          ...previewDefinition,
          definition: previewDefinition,
          parameters: previewDefinition.parameters ?? {},
          geometry: g,
          deviceId:slot.deviceId,
          preview:true,
          liveRun:data.ticker?.active.find(run=>run.targets.includes(slot.deviceId))??null,
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
    const lines = deviceLines(device, index), labels = [];
    card.setAttribute('aria-label', lines.filter(Boolean).join('. '));
    card.dataset.connection = device ? device.connected ? 'online' : 'offline' : 'empty';
    for (const [lineIndex, line] of lines.entries()) {
      const p = document.createElement("p");
      p.textContent = lineIndex === 0 ? `R${Math.floor(index / state.layout.columns) + 1} C${index % state.layout.columns + 1}` : line;
      card.append(p);
      labels.push(p);
    }
    const previewNote = document.createElement('p');
    previewNote.className = 'preview-note';
    card.append(previewNote);
    $("wall").append(card);
    canvases.push({ canvas, slot, index, labels, artwork: art, previewNote });
  }
}
let lastFrame = 0;
function drawSMSTransition(c,slot,active,now){
  if(!slot||!active)return;
  const elapsed=(now-active.startAtServerMs)/1000;
  if(elapsed<0||elapsed>=1.65)return;
  const row=active.rows.find(item=>item.row===Math.floor(slot.slotIndex/data.state.layout.columns));
  if(!row)return;
  const g=slot.geometry,fontSize=Math.min(row.height*0.5,(row.right-row.left)*0.17);
  c.save();c.setTransform(1,0,0,1,0,0);c.fillStyle='#000';c.fillRect(0,0,300,400);
  c.scale(300/g.width,400/g.height);c.translate(-g.x,-g.y);
  c.beginPath();c.rect(row.left,row.top,row.right-row.left,row.height);c.clip();
  c.font=`${fontSize}px Arial, sans-serif`;c.textBaseline='top';
  const text='\u2764\uFE0F SMS \u2764\uFE0F',textWidth=c.measureText(text).width;
  const startX=row.row%2===0?row.left-textWidth:row.right;
  const targetX=(row.left+row.right-textWidth)/2;
  const x=startX+(targetX-startX)*Math.min(1,elapsed/0.85);
  const blinking=elapsed>=0.85&&elapsed<1.25&&(elapsed-0.85)%0.2>=0.11;
  c.globalAlpha=blinking?0:elapsed>=1.25?Math.max(0,(1.65-elapsed)/0.4):1;
  c.fillStyle='#ff0000';c.fillText(text,x,row.top+(row.height-fontSize)/2);
  c.restore();
}
function draw(time) {
  requestAnimationFrame(draw);
  if (!data || time - lastFrame < 33) return;
  lastFrame = time;
  const now = Date.now() + offset,
    state = data.state;
  const width = state.layout.slots.length
    ? Math.max(
        1,
        ...state.layout.slots.map((s) => s.geometry.x + s.geometry.width),
      )
    : state.layout.columns * 375;
  for (const { canvas, slot, index, artwork, previewNote } of canvases) {
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
    const definition = virtualDraft ?? artworkAt(patch, now)?.release.definition;
    if (previewNote.textContent && ((!hasTestTextPreview(definition) && definition?.artworkId !== 'live-ticker') || (!virtualDraft && (mode !== 'exhibition' || isPairing(patch))))) previewNote.textContent = '';
    if (!slot && !virtualDraft) {
      c.fillStyle = '#d6d8cc'; c.fillRect(0, 0, 300, 400);
      c.strokeStyle = '#7b9d92'; c.lineWidth = 3; c.beginPath();
      c.moveTo(125, 200); c.lineTo(175, 200);
      c.moveTo(150, 175); c.lineTo(150, 225); c.stroke();
      continue;
    }
    if (!virtualDraft && isPairing(patch)) {
      const assigned = patch.pairing.slotIndex != null;
      c.fillStyle = assigned ? '#0d6626' : '#cc0d0d';
      c.fillRect(0, 0, 300, 400);
      c.fillStyle = '#fff'; c.font = '24px sans-serif';
      c.fillText(assigned ? 'ASSIGNED' : 'PAIRING', 20, 170);
      c.font = '18px sans-serif';
      c.fillText(assigned ? `Slot ${patch.pairing.slotIndex}` : 'Tap phone to assign', 20, 210);
      continue;
    }
    if (mode !== "exhibition" && !virtualDraft) continue;
    if(!virtualDraft&&patch.kissing?.enabled){
      c.fillStyle='#fff';c.font='24px Georgia';c.fillText('KISSING WALL',20,175);
      c.font='18px Georgia';c.fillText('Independent · sound on',20,210);
      previewNote.textContent='Status preview only. Video plays locally on the phone.';
      continue;
    }
    const art = artworkAt(patch, now);
    if (art?.deploymentId !== artwork?.deploymentId || art?.startAtServerMs !== artwork?.startAtServerMs) {
      render(); return;
    }
    if (virtualDraft || art) {
      const manifest = virtualDraft ?? art.release.definition;
      const layout = virtualDraft ? null : art?.release.layout;
      const actual =
        layout?.slots.find((s) => s.deviceId === slot?.deviceId)?.geometry ?? g;
      const note = !virtualDraft && manifest.artworkId === 'live-ticker'
        ? drawLiveText(c, manifest, actual, data.ticker?.active.find(run => run.targets.includes(slot.deviceId)), now)
        : drawArtwork(c, manifest, actual, virtualDraft ? draftStarted : art.startAtServerMs, now, index);
      if (note && previewNote.textContent !== note) {
        previewNote.textContent = note;
        if (slot?.deviceId === inspectedDeviceId) $('phone-details-preview').textContent = note;
      }
      if (!canvas.hidden && !hasTestTextPreview(manifest) && manifest.elements.some(e => e.type === 'web')) {
        c.fillStyle = '#000'; c.fillRect(0, 330, 300, 70);
        c.fillStyle = '#fff'; c.font = '16px sans-serif';
        c.fillText('Web artwork preview off', 10, 355);
        c.fillText('Select phone + enable below', 10, 380);
      }
      if(!virtualDraft)drawSMSTransition(c,slot,data.transition?.active,now);
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
      if(s.id==='identify'){
        c.font = "24px monospace";
        c.fillText(`Slot ${index}`, 20, 50);
        c.fillText(`R${Math.floor(index/state.layout.columns)+1} C${index%state.layout.columns+1}`,20,90);
      }
    } else
      c.fillText(
        s.kind === "text"
          ? s.text
          : `${s.kind} · ${(s.hash ?? "").slice(0, 8)}`,
        20,
        60,
      );
    c.restore();
    if(!virtualDraft)drawSMSTransition(c,slot,data.transition?.active,now);
  }
}
requestAnimationFrame(draw);
$('phone-select').onclick = () => {
  if (!inspectedDeviceId) return;
  selected.has(inspectedDeviceId) ? selected.delete(inspectedDeviceId) : selected.add(inspectedDeviceId);
  render();
};
$('phone-details-close').onclick = () => { inspectedDeviceId = null; render(); };
$("login").onsubmit = run(async () => {
  token = $("key").value;
  $("key").value = "";
  await api();
  sessionStorage.setItem('phoneWallOperatorKey',token);
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
  if (data) render();
});
$("draft-live").onclick = () => {
  virtualDraft = null;
  $("release-status").textContent = "Showing live releases.";
  if (data) render();
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
  if (data) render();
});
$("identify").onclick = run(() => api({ action: "identify", ...target() }));
$('pairing-start').onclick=run(()=>api({action:'pairing.start'}));
$('pairing-stop').onclick=run(()=>api({action:'pairing.stop'}));
$('barthes-start').onclick=run(()=>api({action:'barthes.start'}));
$('live-alert-toggle').onchange=run(()=>api({action:'live.alert',enabled:$('live-alert-toggle').checked}));
$('sms-transition').onclick=run(()=>api({action:'transition.sms'}));
$('barthes-stop').onclick=run(()=>api({action:'barthes.stop'}));
$('curated-start').onclick=run(async()=>{clearTimeout(curatedSaveTimer);await api({action:data.ticker?.enabled&&data.ticker.mode==='curated'?'curated.messages':'curated.start',messages:curatedTexts()});curatedEdited=false;});
$('curated-stop').onclick=run(()=>api({action:'curated.stop'}));
$('curated-second-toggle').onchange=run(async()=>{
  if(curatedEdited&&data.ticker?.enabled&&data.ticker.mode==='curated'){
    clearTimeout(curatedSaveTimer);
    await api({action:'curated.messages',messages:curatedTexts()});
    curatedEdited=false;
  }
  await api({action:'curated.second',enabled:$('curated-second-toggle').checked});
});
$('curated-db-toggle').onchange=run(()=>api({action:'curated.injection',enabled:$('curated-db-toggle').checked}));
$('curated-archive-toggle').onchange=run(()=>api({action:'curated.archive',enabled:$('curated-archive-toggle').checked}));
for(const mode of ['barthes','curated'])for(const side of ['min','max']){
  const control=$(`${mode}-${side}-speed`);
  control.oninput=()=>{speedDragMode=mode;const other=$(`${mode}-${side==='min'?'max':'min'}-speed`);if(side==='min'&&Number(control.value)>Number(other.value))other.value=control.value;if(side==='max'&&Number(control.value)<Number(other.value))other.value=control.value;speedLabels(mode);};
  control.onchange=run(async()=>{const min=Number($(`${mode}-min-speed`).value),max=Number($(`${mode}-max-speed`).value);try{await api({action:'ticker.speed-range',mode,min,max});}finally{speedDragMode=null;}});
}
$('curated-archive-density').oninput=()=>{densityDragging=true;densityLabel();};
$('curated-archive-density').onchange=run(async()=>{try{await api({action:'curated.archive-density',density:Number($('curated-archive-density').value)});}finally{densityDragging=false;}});
$('reset-installation').onclick=run(async()=>{
  if(!confirm('Erase all Phone Wall pairings, wall settings, queued messages and downloaded media, then restart the controller?'))return;
  const button=$('reset-installation'),before=data?.state?.installationId;
  button.disabled=true;
  $('reset-status').textContent='Resetting installation data…';
  try {
    const response=await fetch('/phone-wall/reset',{method:'POST',headers:{Authorization:`Bearer ${token}`}});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error);
    $('reset-status').textContent=`Controller restarting. ${result.online} connected phones received a media clear command.`;
    for(let attempt=0;attempt<45;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,1000));
      try {
        await api();
        if(before&&data.state.installationId!==before) {
          selected.clear();virtualDraft=null;edited=false;
          render();
          $('reset-status').textContent='Installation reset complete. Pair the phones again.';
          return;
        }
      }catch{}
    }
    $('reset-status').textContent='Reset requested. The controller has not returned yet; check its service log.';
  }finally{button.disabled=false;}
});
function kissingSettings(){return {trim:$('kissing-trim').checked,trimStartOffsetSec:Number($('kissing-before').value),trimEndOffsetSec:Number($('kissing-after').value),revealDurationMs:Number($('kissing-in').value),fadeOutDurationMs:Number($('kissing-out').value)};}
$('kissing-start').onclick=run(async()=>{await api({action:'kissing.start',settings:kissingSettings()});virtualDraft=null;});
$('kissing-stop').onclick=run(()=>api({action:'kissing.stop'}));
$('kissing-apply').onclick=run(async()=>{await api({action:'kissing.settings',settings:kissingSettings()});kissingEdited=false;});
$('send-test-text').onclick=run(async()=>{
  sendingTest=true;testDeployment=null;$('send-test-text').disabled=true;
  $('test-text-status').textContent='Sending test…';
  try {
    const result=await api({action:'test.text',speed:Number($('test-text-speed').value),text:$('test-text-message').value});
    testDeployment=result.deployment.id;testOffline=result.offline;
    virtualDraft=null;
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
if(launchKey!==null){history.replaceState(null,'',location.pathname+location.search);if(/^[a-f0-9]{64}$/.test(launchKey)){token=launchKey;api().then(()=>sessionStorage.setItem('phoneWallOperatorKey',token)).catch(error=>status(error.message));}}
else if(token)api().catch(error=>status(error.message));
setInterval(async () => {
  if (!token) return;
  try {
    await api();
  } catch (error) {
    status(`Controller unavailable: ${error.message}. Retrying…`);
  }
}, 3000);

$('debug-toggle').onchange=run(()=>api({action:'debug',enabled:$('debug-toggle').checked}));
