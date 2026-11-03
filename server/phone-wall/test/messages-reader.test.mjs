import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../app.mjs';
import { MessagesReader,readMessageBatch,appleDate,decodeAttributedBodies } from '../messages-reader.mjs';
import { messagesAgentPlist } from '../../../scripts/phone-wall/install-messages-agent.mjs';

const key='messages-reader-fixture-secret-000000000000';
test('read-only Messages reader skips history/sent/reactions, decodes bodies, retries, and keeps its cursor over restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wall-reader-')),path=join(directory,'chat.db');
  const source=new DatabaseSync(path);source.exec('CREATE TABLE message(ROWID INTEGER PRIMARY KEY,guid TEXT,text TEXT,date INTEGER,is_from_me INTEGER,attributedBody BLOB,associated_message_type INTEGER DEFAULT 0,is_system_message INTEGER DEFAULT 0)');
  const add=source.prepare('INSERT INTO message(guid,text,date,is_from_me,attributedBody,associated_message_type) VALUES(?,?,?,?,?,?)');
  const date=BigInt(Date.parse('2026-11-03T10:00:00Z')-Date.UTC(2001,0,1))*1000000n;
  add.run('old','Do not import history',date,0,null,0);
  let server=await createController({dataDir:join(directory,'wall'),adminToken:key});await server.app.listen({host:'127.0.0.1',port:0});
  t.after(async()=>{await server.app.close();source.close();await rm(directory,{recursive:true,force:true});});
  const reader=new MessagesReader({dbPath:path,sourceId:'reader-fixture-0001',url:`http://127.0.0.1:${server.app.server.address().port}`,token:key,decode:async blobs=>blobs.map(()=> 'Attributed 👩🏽‍🔧')});
  await reader.poll();assert.equal(server.ticker.source(reader.sourceId).database_id,null);
  server.ticker.start();await reader.poll();assert.equal(server.ticker.status().queued,0);
  add.run('new','Incoming 🍆',date,0,null,0);add.run('sent','Do not display sent',date,1,null,0);
  add.run('reaction','Do not display reactions',date,0,null,2000);add.run('attachment',null,date,0,null,0);
  add.run('attributed',null,date,0,Buffer.from('fixture'),0);
  const before=await readFile(path);await reader.poll();assert.deepEqual(await readFile(path),before);
  assert.equal(server.ticker.status().queued,2);assert.equal(server.ticker.source(reader.sourceId).row_id,6);
  assert.deepEqual(server.store.db.prepare('SELECT text FROM ticker_messages ORDER BY seq').all().map(row=>row.text),['Incoming 🍆','Attributed 👩🏽‍🔧']);
  await reader.poll();assert.equal(server.ticker.status().queued,2);
  add.run('decode-failure',null,date,0,Buffer.from('fixture'),0);
  reader.decode=async()=>{throw new Error('attributed-body-decode-failed');};
  await assert.rejects(reader.poll(),/decode-failed/);assert.equal(server.ticker.source(reader.sourceId).row_id,6);
  reader.decode=async()=>['Recovered ❤️'];await reader.poll();assert.equal(server.ticker.status().queued,3);
  await server.app.close();server=await createController({dataDir:join(directory,'wall'),adminToken:key});await server.app.listen({host:'127.0.0.1',port:0});
  reader.url=`http://127.0.0.1:${server.app.server.address().port}`;add.run('after-restart','Still incoming',date,0,null,0);await reader.poll();
  assert.equal(server.ticker.status().queued,4);assert.equal(server.ticker.source(reader.sourceId).row_id,8);
  const denied=await server.app.inject({url:'/phone-wall/reader/reader-fixture-0001'});assert.equal(denied.statusCode,401);
});
test('Apple epoch conversion handles nanoseconds without unsafe SQLite integer conversion',()=>{
  assert.equal(appleDate(0n),null);assert.equal(appleDate(1000000000n),'2032-09-09T01:46:40.000Z');
  assert.equal(appleDate(1000000000000000000n),'2032-09-09T01:46:40.000Z');
});
test('user reader service has no embedded credential and no privileged service user',()=>{
  const plist=messagesAgentPlist('/Users/museum');assert.match(plist,/messages-reader.mjs/);assert.match(plist,/PhoneWallReader/);
  assert.ok(!plist.includes('<key>UserName</key>'));assert.ok(!plist.includes(key));
});
test('macOS decodes actual NSArchiver attributed-body data without slicing UTF-8 or emoji',{skip:process.platform!=='darwin'},async()=>{
  const fixture='BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBKyVGaXh0dXJlIPCfjYYg8J+RqfCfj73igI3wn5SnIPCfh6vwn4e3hoQCaUkBF5KEhIQMTlNEaWN0aW9uYXJ5AJSEAWkAhoY=';
  assert.deepEqual(await decodeAttributedBodies([Buffer.from(fixture,'base64')]),['Fixture 🍆 👩🏽‍🔧 🇫🇷']);
});
