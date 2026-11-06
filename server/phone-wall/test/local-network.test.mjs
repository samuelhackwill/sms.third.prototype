import test from 'node:test';
import assert from 'node:assert/strict';
import { localOperatorConnection } from '../local-network.mjs';

test('shutdown accepts the Mac LAN and loopback, but not a different network',()=>{
  const interfaces={en0:[{family:'IPv4',address:'10.73.73.30',netmask:'255.255.255.0',internal:false}]};
  assert.equal(localOperatorConnection('10.73.73.45',interfaces),true);
  assert.equal(localOperatorConnection('::ffff:10.73.73.45',interfaces),true);
  assert.equal(localOperatorConnection('127.0.0.1',interfaces),true);
  assert.equal(localOperatorConnection('::1',interfaces),true);
  assert.equal(localOperatorConnection('fe80::abcd',interfaces),true);
  assert.equal(localOperatorConnection('10.73.74.45',interfaces),false);
  assert.equal(localOperatorConnection('100.99.141.41',interfaces),false);
  assert.equal(localOperatorConnection('not-an-address',interfaces),false);
});
