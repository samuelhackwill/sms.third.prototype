import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

export function localOperatorConnection(address, interfaces=networkInterfaces()) {
  const host=String(address??'').replace(/^::ffff:/,'');
  if(host==='127.0.0.1'||host==='::1')return true;
  if(isIP(host)===6)return /^fe80:/i.test(host);
  if(isIP(host)!==4)return false;
  const remote=host.split('.').map(Number);
  return Object.values(interfaces).flat().some(entry=>{
    if(entry?.family!=='IPv4'||entry.internal)return false;
    const own=entry.address.split('.').map(Number),mask=entry.netmask.split('.').map(Number);
    return remote.every((byte,index)=>(byte&mask[index])===(own[index]&mask[index]));
  });
}
