import { randomUUID } from 'node:crypto';

export function testTextDefinition(layout) {
  const rows=new Map();
  for(const slot of layout.slots) {
    const row=Math.floor(slot.slotIndex/layout.columns);
    if(!rows.has(row))rows.set(row,[]);
    rows.get(row).push(slot.geometry);
  }
  if(!rows.size)throw new Error('pair-phones-before-sending-test-text');
  const elements=[...rows].sort(([a],[b])=>a-b).map(([row,slots],index)=>{
    const left=Math.min(...slots.map(g=>g.x)),right=Math.max(...slots.map(g=>g.x+g.width));
    const top=Math.min(...slots.map(g=>g.y)),height=Math.min(...slots.map(g=>g.height));
    const fontSize=Math.min(200,Math.max(48,height*0.55));
    const text='Bla bla bla',width=Math.ceil(text.length*fontSize*0.7)+20;
    return {id:`test-row-${row}`,type:'text',text,fontSize,color:'#ffffff',
      frame:{x:right,y:top+Math.max(0,(height-fontSize*1.3)/2),width,height:fontSize*1.3},
      animation:{property:'x',from:right,to:left-width,durationMs:Math.ceil((right-left+width)/240*1000),delayMs:index*750,repeat:false,easing:'linear'}};
  });
  return {sceneSchemaVersion:1,artworkId:'operator-test-text',artworkVersion:randomUUID(),
    canvas:{width:Math.max(...layout.slots.map(s=>s.geometry.x+s.geometry.width)),height:Math.max(...layout.slots.map(s=>s.geometry.y+s.geometry.height))},
    background:'#000000',transition:{type:'cut',durationMs:0},elements};
}
