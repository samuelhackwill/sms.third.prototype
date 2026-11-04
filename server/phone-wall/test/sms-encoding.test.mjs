import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTendaResponse,repairArchivedSms } from '../sms-encoding.mjs';

test('router CESU-8 emoji is decoded before JSON parsing',()=>{
  const raw=Buffer.concat([Buffer.from('{"content":"café '),Buffer.from('eda0bdedb0ad','hex'),Buffer.from('"}')]);
  assert.equal(JSON.parse(decodeTendaResponse(raw)).content,'café 🐭');
  const corrupted=new TextDecoder('gbk').decode(raw);
  assert.equal(repairArchivedSms(JSON.parse(corrupted).content),'café 🐭');
});

test('genuine GBK text is preserved',()=>{
  assert.equal(decodeTendaResponse(Buffer.from('c4e3bac3','hex')),'你好');
  assert.equal(repairArchivedSms('你好'),'你好');
});
