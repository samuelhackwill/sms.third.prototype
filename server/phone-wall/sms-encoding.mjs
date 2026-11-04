const utf8=new TextDecoder('utf-8',{fatal:true});
const gbk=new TextDecoder('gbk');
let gbkReverse;

// The router sometimes writes a UTF-16 surrogate pair as two UTF-8 sequences.
// Replace only complete high/low pairs; ordinary UTF-8 and GBK bytes stay intact.
export function normalizeCesu8(bytes){
  const raw=Buffer.from(bytes);
  const parts=[];
  let start=0;
  for(let i=0;i+5<raw.length;i++){
    if(raw[i]!==0xed||raw[i+1]<0xa0||raw[i+1]>0xaf||(raw[i+2]&0xc0)!==0x80||raw[i+3]!==0xed||raw[i+4]<0xb0||raw[i+4]>0xbf||(raw[i+5]&0xc0)!==0x80)continue;
    const high=0xd800+((raw[i+1]&15)<<6)+(raw[i+2]&63);
    const low=0xdc00+((raw[i+4]&15)<<6)+(raw[i+5]&63);
    parts.push(raw.subarray(start,i),Buffer.from(String.fromCodePoint(0x10000+((high-0xd800)<<10)+(low-0xdc00))));
    i+=5;start=i+1;
  }
  if(!parts.length)return raw;
  parts.push(raw.subarray(start));
  return Buffer.concat(parts);
}

export function decodeTendaResponse(bytes){
  const raw=Buffer.from(bytes);
  try{return utf8.decode(normalizeCesu8(raw));}
  catch(error){if(!(error instanceof TypeError))throw error;return gbk.decode(raw);}
}

function reverseGbk(){
  if(gbkReverse)return gbkReverse;
  const result=new Map();
  for(let lead=0x81;lead<=0xfe;lead++)for(let trail=0x40;trail<=0xfe;trail++){
    if(trail===0x7f)continue;
    const bytes=Buffer.from([lead,trail]),character=gbk.decode(bytes);
    if([...character].length===1&&character!=='\ufffd'&&!result.has(character))result.set(character,bytes);
  }
  gbkReverse=result;
  return result;
}

function encodeGbk(text){
  const map=reverseGbk(),parts=[];
  for(const character of text){
    const code=character.codePointAt(0);
    if(code<0x80)parts.push(Buffer.from([code]));
    else if(map.has(character))parts.push(map.get(character));
    else return null;
  }
  return Buffer.concat(parts);
}

export function repairArchivedSms(text){
  if(typeof text!=='string'||!/[\u3400-\u9fff]/u.test(text))return text;
  const bytes=encodeGbk(text);
  if(!bytes)return text;
  const normalized=normalizeCesu8(bytes);
  if(normalized.length===bytes.length)return text;
  try{return utf8.decode(normalized);}
  catch{return text;}
}
