import { randomBytes } from 'node:crypto';

export class PairingSession {
  constructor(store) { this.store=store;this.session=null; }
  status(deviceId) {
    const s=this.session,state=this.store.current();
    return {active:!!s&&s.expiresAt>Date.now()&&s.active,sessionId:s?.id??null,
      count:s?.assigned.size??0,capacity:s?.capacity??state.layout.rows*state.layout.columns,
      expiresAt:s?.expiresAt??null,remainingMs:Math.max(0,(s?.expiresAt??0)-Date.now()),rows:s?.rows??state.layout.rows,columns:s?.columns??state.layout.columns,
      slotIndex:s?.assigned.get(deviceId)??null,paired:state.layout.slots.some(slot=>slot.deviceId===deviceId)};
  }
  start() {
    if(this.status().active)throw new Error('pairing-already-active');
    const {rows,columns,gap,slots}=this.store.current().layout;
    const dimensions=this.store.devices().map(d=>d.capabilities??{});
    const size=(key,fallback)=>Math.max(fallback,...dimensions.map(d=>Number(d[key])).filter(n=>Number.isFinite(n)&&n>0&&n<=10000),...slots.map(s=>s.geometry[key]));
    this.session={id:randomBytes(16).toString('hex'),active:true,expiresAt:Date.now()+10*60*1000,rows,columns,gap,
      capacity:rows*columns,width:size('width',375),height:size('height',667),assigned:new Map()};
    return this.status();
  }
  stop() { if(this.session)this.session.active=false;return this.status(); }
  expire() { if(this.session?.active&&this.session.expiresAt<=Date.now()){this.stop();return true;}return false; }
  tap(deviceId,sessionId) {
    const s=this.session;
    if(!s||sessionId!==s.id)throw new Error('pairing-session-expired');
    if(s.assigned.has(deviceId))return this.status(deviceId);
    if(!this.status().active)throw new Error('pairing-session-expired');
    const state=this.store.current(),d=this.store.device(deviceId);
    if(!d)throw new Error('unknown-device');
    if(state.layout.rows!==s.rows||state.layout.columns!==s.columns||state.layout.gap!==s.gap)throw new Error('pairing-layout-changed-stop-and-restart');
    const slotIndex=s.assigned.size;
    const dimension=(key)=>{const n=d.capabilities?.[key];return Number.isFinite(n)&&n>0&&n<=10000?n:s[key];};
    state.layout.slots=state.layout.slots.filter(slot=>slot.deviceId!==deviceId&&slot.slotIndex!==slotIndex);
    state.layout.slots.push({deviceId,slotIndex,geometry:{x:(slotIndex%s.columns)*(s.width+s.gap),y:Math.floor(slotIndex/s.columns)*(s.height+s.gap),width:dimension('width'),height:dimension('height')}});
    this.store.commit(state,state.revision);
    s.assigned.set(deviceId,slotIndex);
    if(s.assigned.size===s.capacity)s.active=false;
    return this.status(deviceId);
  }
}
