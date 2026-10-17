import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { postgresProfileUser } from './embedded-server.mjs';
test('existing embedded databases retain the original role and fresh profiles use BOAA', () => {
  assert.equal(postgresProfileUser({}, true), 'moya');
  assert.equal(postgresProfileUser({}, false), 'boaa');
  assert.equal(postgresProfileUser({ postgresUser: 'boaa' }, true), 'boaa');
  assert.throws(() => postgresProfileUser({ postgresUser: 'invalid/user' }, true));
});
