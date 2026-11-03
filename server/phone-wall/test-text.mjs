import { randomUUID } from 'node:crypto';
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
export function validateTestText(text) {
  if(typeof text!=='string'||!text.trim()||text.length>500||[...segmenter.segment(text)].length>120)throw new Error('test-text-must-contain-1-to-120-characters-max-500-code-units');
  return text;
}
export function testTextDefinition(layout,{speed=240,text='Bla bla bla',asset}={}) {
  if(!Number.isFinite(speed)||speed<20||speed>1000)throw new Error('test-text-speed-must-be-between-20-and-1000');
  validateTestText(text);
  const rows=new Map();
  for(const slot of layout.slots) {
    const row=Math.floor(slot.slotIndex/layout.columns);
    if(!rows.has(row))rows.set(row,[]);
    rows.get(row).push(slot.geometry);
  }
  if(!rows.size)throw new Error('pair-phones-before-sending-test-text');
  if(!/^[a-f0-9]{64}$/.test(asset??''))throw new Error('test-text-renderer-asset-required');
  const bands=[...rows].sort(([a],[b])=>a-b).map(([row,slots],index)=>{
    const left=Math.min(...slots.map(g=>g.x)),right=Math.max(...slots.map(g=>g.x+g.width));
    const top=Math.min(...slots.map(g=>g.y)),height=Math.min(...slots.map(g=>g.height));
    return {row,left,right,top,height,delayMs:index*750};
  });
  const canvas={width:Math.max(...layout.slots.map(s=>s.geometry.x+s.geometry.width)),height:Math.max(...layout.slots.map(s=>s.geometry.y+s.geometry.height))};
  return {sceneSchemaVersion:1,artworkId:'operator-test-text',artworkVersion:randomUUID(),
    canvas,background:'#000000',parameters:{speed,text,color:'#ff0000',fontFamily:'Georgia, "Times New Roman", serif',rows:bands},
    transition:{type:'cut',durationMs:0},elements:[{id:'test-text',type:'web',asset,frame:{x:0,y:0,...canvas}}]};
}
