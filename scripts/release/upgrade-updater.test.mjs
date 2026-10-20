import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageUpdaterImage } from './upgrade-updater.mjs';
import { atomicJson } from './files.mjs';

test('updater-only transition preserves app/data configuration and restores prior state on failure', async (t) => {
  for (const fail of [false, true]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'boaa-upgrade-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const previous = { version: '1.0.0', compose: 'old' };
    const calls = [];
    const config = {
      services: { api: { image: 'original-api', volumes: ['original-data'] }, updater: { image: 'original-updater' } },
    };
    const d = {
      directory,
      current: previous,
      config,
      initialize: async () => {},
      stage: async (c, s) => {
        assert.deepEqual(c.services.api, config.services.api);
        return { ...s, compose: 'new' };
      },
      compose: async (f, args) => {
        calls.push([f, args]);
        if (fail && f === 'new') throw Error('fixture');
      },
      commit: async (s) => {
        d.current = s;
      },
    };
    const task = stageUpdaterImage(d, 'ghcr.io/example/boaa-updater@sha256:' + 'a'.repeat(64));
    if (fail) {
      await assert.rejects(task);
      assert.equal(d.current, previous);
    } else {
      await task;
      assert.equal(d.current.compose, 'new');
    }
    assert(calls.every(([, args]) => args.includes('--no-start') && args.at(-1) === 'updater'));
    await atomicJson(path.join(directory, 'status.json'), { busy: true });
    const count = calls.length;
    await assert.rejects(
      stageUpdaterImage(d, 'ghcr.io/example/boaa-updater@sha256:' + 'a'.repeat(64)),
      /management_busy/,
    );
    assert.equal(calls.length, count);
  }
});
