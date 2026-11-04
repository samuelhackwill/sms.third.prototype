import { randomUUID } from 'node:crypto';
import { readFile,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory='/Library/Application Support/PhoneWall/requests';
async function requestPull(){
  if(process.getuid?.()===0)throw new Error('Run this command as the Mac operator, without sudo');
  const id=randomUUID(),temporary=join(directory,`pull-${id}.tmp`);
  await writeFile(temporary,JSON.stringify({id,at:new Date().toISOString()})+'\n',{mode:0o600});
  await rename(temporary,join(directory,'pull.json'));
  console.log('Pull requested. Waiting for the controller restart…');
  const deadline=Date.now()+240000;
  while(Date.now()<deadline){
    const status=await readFile('/Library/Application Support/PhoneWall/pull-status.json','utf8').then(JSON.parse).catch(()=>null);
    if(status?.id===id){
      if(status.state==='complete'){console.log(`Controller updated to ${status.detail.slice(0,8)}.`);return;}
      if(status.state==='error')throw new Error(`Pull failed: ${status.detail}`);
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('Pull did not finish within four minutes; check /Library/Logs/PhoneWall/pull.log');
}
if(process.argv[1]===fileURLToPath(import.meta.url))await requestPull();
