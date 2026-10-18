import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlainTTSAudioCache } from './plain-tts-audio-cache.js';
describe('private ordinary TTS audio cache', () => {
  it('survives a new cache instance and does not cross owner/revision keys', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'boaa-tts-'));
    try {
      const audio = { data: Buffer.from('fixture'), contentType: 'audio/wav' };
      await createPlainTTSAudioCache(dir).put('userA/revision1', audio);
      const next = createPlainTTSAudioCache(dir);
      expect(await next.get('userA/revision1')).toEqual(audio);
      expect(await next.get('userB/revision1')).toBeUndefined();
      expect(await next.get('userA/revision2')).toBeUndefined();
      expect((await stat(path.join(dir, (await readdir(dir))[0]))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('evicts old entries instead of growing without a bound', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'boaa-tts-'));
    try {
      const cache = createPlainTTSAudioCache(dir, { maxBytes: 40 });
      await cache.put('one', { data: Buffer.alloc(20), contentType: 'audio/wav' });
      await cache.put('two', { data: Buffer.alloc(20), contentType: 'audio/wav' });
      expect(await cache.get('one')).toBeUndefined();
      expect(await cache.get('two')).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
