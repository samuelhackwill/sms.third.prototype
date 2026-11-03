import { randomUUID } from 'node:crypto';
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
export function validateTestText(text) {
  if(typeof text!=='string'||!text.trim()||text.length>500||[...segmenter.segment(text)].length>120)throw new Error('test-text-must-contain-1-to-120-characters-max-500-code-units');
  return text;
}
export function estimateTestTextWidth(text,fontSize) {
  // Bound whole glyph clusters, never count a joined emoji as separate letters.
  return Math.ceil([...segmenter.segment(text)].reduce((sum,{segment})=>sum+(/^[\x20-\x7e]$/.test(segment)?7:15),0)*fontSize/10)+20;
}

export function testTextDefinition(layout,{speed=240,text='Bla bla bla'}={}) {
  if(!Number.isFinite(speed)||speed<20||speed>1000)throw new Error('test-text-speed-must-be-between-20-and-1000');
  validateTestText(text);
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
    const width=estimateTestTextWidth(text,fontSize);
    return {id:`test-row-${row}`,type:'text',text,fontSize,color:'#ffffff',
      frame:{x:right,y:top+Math.max(0,(height-fontSize*1.3)/2),width,height:fontSize*1.3},
      animation:{property:'x',from:right,to:left-width,durationMs:Math.ceil((right-left+width)/speed*1000),delayMs:index*750,repeat:false,easing:'linear'}};
  });
  return {sceneSchemaVersion:1,artworkId:'operator-test-text',artworkVersion:randomUUID(),
    canvas:{width:Math.max(...layout.slots.map(s=>s.geometry.x+s.geometry.width)),height:Math.max(...layout.slots.map(s=>s.geometry.y+s.geometry.height))},
    background:'#000000',parameters:{speed,text},transition:{type:'cut',durationMs:0},elements};
}
