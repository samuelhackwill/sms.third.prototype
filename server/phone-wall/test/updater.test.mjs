import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateUpdate,compatibleSource } from '../../../scripts/phone-wall/update-from-github.mjs';

test('source updater rejects unmarked, incompatible or linked source before activation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'phone-wall-source-'));
  try {
    for(const path of ['server/phone-wall/public/artwork','protocol','scripts/phone-wall'])await mkdir(join(root,path),{recursive:true});
    await assert.rejects(compatibleSource(root,{nodeMajor:24}),/not updater-ready/);
    await writeFile(join(root,'server/phone-wall/update-format.json'),JSON.stringify({format:1,version:'2.2.0',minimumNodeMajor:24}));
    for(const path of ['server/phone-wall/package-lock.json','server/phone-wall/index.mjs','server/phone-wall/installation.mjs','server/phone-wall/discovery.mjs','scripts/phone-wall/update-from-github.mjs','server/phone-wall/public/artwork/barthes-sentences.ndjson'])await writeFile(join(root,path),'test');
    assert.equal((await compatibleSource(root,{nodeMajor:24})).version,'2.2.0');
    await assert.rejects(compatibleSource(root,{nodeMajor:23}),/Incompatible/);
    await symlink('/etc/passwd',join(root,'protocol/linked'));
    await assert.rejects(compatibleSource(root,{nodeMajor:24}),/links/);
  }finally{await rm(root,{recursive:true,force:true});}
});

for(const failure of [null,'health','backup'])test(`source update ${failure?'rolls back after '+failure+' failure':'activates atomically'} without changing data`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'phone-wall-swap-')),candidate=join(root,'candidate');
  try {
    await mkdir(join(root,'app'));await mkdir(candidate);await mkdir(join(root,'data'));
    await writeFile(join(root,'app/version'),'old');await writeFile(join(candidate,'version'),'new');
    await writeFile(join(root,'data/sentinel'),'keep');
    const starts=[];
    const activation=activateUpdate({directory:root,candidate,stop:async()=>{},start:async()=>starts.push(await readFile(join(root,'app/version'),'utf8')),
      backup:async()=>{if(failure==='backup')throw new Error('backup failed');},healthy:async()=>failure!=='health'});
    if(failure)await assert.rejects(activation);else await activation;
    assert.equal(await readFile(join(root,'app/version'),'utf8'),failure?'old':'new');
    assert.equal(await readFile(join(root,'data/sentinel'),'utf8'),'keep');
    assert.deepEqual(starts,failure==='health'?['new','old']:failure==='backup'?['old']:['new']);
    if(!failure)assert.equal(await readFile(join(root,'app.previous/version'),'utf8'),'old');
  }finally{await rm(root,{recursive:true,force:true});}
});
