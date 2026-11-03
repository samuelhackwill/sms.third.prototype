import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureInstallation } from '../../../scripts/phone-wall/installer/configure.mjs';
import { configuration, advertisement } from '../installation.mjs';
import { Service } from 'bonjour-service';

test('daemon upgrade preserves credentials and port, removing the old hostname claim',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'phone-wall-installer-'));
  try {
    const options={root:join(directory,'root'),logDir:join(directory,'logs'),daemonDir:join(directory,'daemons'),available:async port=>port===3101};
    const installed=await configureInstallation(options);
    assert.equal(installed.port,3101);
    const key=readFileSync(installed.keyFile,'utf8');
    assert.match(key.trim(),/^[a-f0-9]{64}$/);
    const config=configuration({PHONE_WALL_CONFIG_FILE:installed.configFile});
    assert.equal(config.adminToken,key.trim());
    assert.deepEqual(advertisement(config),{name:'Phone Wall',type:'phonewall',port:3101,txt:{path:'/phone-wall/ws',v:'1'}});
    const service=new Service(advertisement(config),()=>{},()=>{});
    const records=service.records();
    assert.equal(records.find(record=>record.type==='SRV').data.port,3101);
    assert.equal(records.find(record=>record.type==='PTR').name,'_phonewall._tcp.local');
    const plist=readFileSync(installed.plist,'utf8');
    assert.match(plist,/<key>UserName<\/key><string>_phonewall<\/string>/);
    assert.match(plist,/<key>KeepAlive<\/key><true\/>/);
    assert.ok(!plist.includes(key.trim()));
    const oldConfig=JSON.parse(readFileSync(installed.configFile,'utf8'));
    oldConfig.advertisedHost='sms-ingestor.local';
    oldConfig.serviceName='sms-ingestor';
    writeFileSync(installed.configFile,JSON.stringify(oldConfig));
    assert.equal(configuration({PHONE_WALL_CONFIG_FILE:installed.configFile}).advertisedHost,undefined);
    const upgraded=await configureInstallation({...options,available:async()=>true});
    assert.equal(upgraded.port,3101);
    assert.equal(readFileSync(upgraded.keyFile,'utf8'),key);
    assert.equal(JSON.parse(readFileSync(upgraded.configFile,'utf8')).advertisedHost,undefined);
    assert.equal(JSON.parse(readFileSync(upgraded.configFile,'utf8')).serviceName,'Phone Wall');
    writeFileSync(installed.keyFile,'corrupt');
    await assert.rejects(configureInstallation(options),/refusing to replace/);
    assert.equal(readFileSync(installed.keyFile,'utf8'),'corrupt');
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('controller configuration rejects invalid ports and ignores legacy hostname overrides',()=>{
  assert.throws(()=>configuration({PORT:'0'}),/invalid-controller-port/);
  assert.equal(configuration({PHONE_WALL_HOSTNAME:'sms-ingestor.local'}).advertisedHost,undefined);
  assert.equal(advertisement({serviceName:'Phone Wall',port:3100,advertisedHost:'sms-ingestor.local'}).host,undefined);
});
