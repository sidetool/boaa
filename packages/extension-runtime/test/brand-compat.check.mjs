import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runExtension } from '../host.mjs';
import { taskBootstrap } from '../browser-controller/task-bootstrap.mjs';
import { bootstrap } from '../browser-controller/guest-bootstrap.mjs';
import { migrationBootstrap } from '../browser-controller/migration-bootstrap.mjs';

test('old compiled extensions run through the legacy entry global', async () => {
  const value = await runExtension({
    source:
      'globalThis.moyaExtension = async (method, input, host) => ({method, input, reply: await host.request("example", null)});',
    method: 'legacy',
    input: { value: 1 },
    broker: { example: () => 2 },
  });
  assert.deepEqual(value, { method: 'legacy', input: { value: 1 }, reply: 2 });
});

test('canonical entry global is authoritative when both are present', async () => {
  assert.equal(
    await runExtension({
      source: 'globalThis.moyaExtension=()=>"old";globalThis.boaaExtension=()=>"new";',
      method: 'probe',
    }),
    'new',
  );
  await assert.rejects(
    runExtension({ source: 'globalThis.moyaExtension=()=>"old";globalThis.boaaExtension=null;', method: 'probe' }),
    { code: 'invalid_extension' },
  );
});

test('old and new task registration APIs reference the same immutable object', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(`(${taskBootstrap})()`, sandbox);
  assert.equal(vm.runInContext('MoyaPlugin === BoaaPlugin', sandbox), true);
  assert.equal(vm.runInContext('Object.getOwnPropertyDescriptor(globalThis,"MoyaPlugin").writable', sandbox), false);
});

test('old and new migration registration APIs reference the same immutable object', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(`(${migrationBootstrap})()`, sandbox);
  assert.equal(vm.runInContext('MoyaPlugin === BoaaPlugin', sandbox), true);
});

test('old controller packages register through the canonical immutable API', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(`(${bootstrap})(async () => JSON.stringify(null))`, sandbox);
  assert.equal(vm.runInContext('MoyaPlugin === BoaaPlugin', sandbox), true);
  vm.runInContext('MoyaPlugin.register({apiVersion:2, activate(){}})', sandbox);
});
