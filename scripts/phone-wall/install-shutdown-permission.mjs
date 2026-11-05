import { spawnSync } from 'node:child_process';
import { writeFile, chmod, chown, rename, readFile, unlink } from 'node:fs/promises';

const file='/private/etc/sudoers.d/phone-wall-shutdown';
const temporary=file+'.next';
const rule='_phonewall ALL=(root) NOPASSWD: /sbin/shutdown -h now\n';

if(process.platform!=='darwin'||process.getuid?.()!==0)
  throw new Error('Run the shutdown permission installer as administrator.');
const sudoers=await readFile('/private/etc/sudoers','utf8');
if(!/^\s*#includedir\s+\/(?:private\/)?etc\/sudoers\.d\s*$/m.test(sudoers))
  throw new Error('sudoers.d is not included by this Mac.');
await writeFile(temporary,rule,{mode:0o440});
await chown(temporary,0,0);
await chmod(temporary,0o440);
const lint=spawnSync('/usr/sbin/visudo',['-cf',temporary],{encoding:'utf8'});
if(lint.status!==0){await unlink(temporary);throw new Error(lint.stderr||'Invalid shutdown permission rule.');}
await rename(temporary,file);
const fullLint=spawnSync('/usr/sbin/visudo',['-cf','/private/etc/sudoers'],{encoding:'utf8'});
if(fullLint.status!==0)throw new Error(fullLint.stderr||'Installed sudoers policy failed validation.');
console.log('Installed exact-command shutdown permission for _phonewall.');
