import { spawn } from 'node:child_process';
import { mkdirSync, statSync, renameSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.PHONE_WALL_LOG_DIR;
if (!root) throw new Error('Set PHONE_WALL_LOG_DIR to an absolute writable directory');
mkdirSync(root,{recursive:true,mode:0o700});
const file = join(root,'server.log');
let bytes = existsSync(file) ? statSync(file).size : 0;
function write(chunk) {
  if (bytes + chunk.length > 5*1024*1024) {
    for (let n=3;n>=0;n--) { const from=n?`${file}.${n}`:file; if(existsSync(from))renameSync(from,`${file}.${n+1}`); }
    bytes=0;
  }
  appendFileSync(file,chunk,{mode:0o600}); bytes+=chunk.length;
}
const child=spawn(process.execPath,[process.env.PHONE_WALL_ENTRY],{env:process.env,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',write);child.stderr.on('data',write);
child.on('error',()=>{write(Buffer.from('server-process-start-failed\n'));process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code ?? (signal ? 1 : 0);});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
