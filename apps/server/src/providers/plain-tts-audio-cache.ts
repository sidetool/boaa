import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';

type Audio = { data: Buffer; contentType: string };
/** Private, disposable audio cache. Keys include owner, content revision, engine revision, voice and rate. */
export function createPlainTTSAudioCache(directory: string, options: { maxBytes?: number; ttlMs?: number } = {}) {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  const filename = (key: string) => path.join(directory, createHash('sha256').update(key).digest('hex') + '.audio');
  let tail = Promise.resolve();
  return {
    async get(key: string): Promise<Audio | undefined> {
      try {
        const file = filename(key),
          info = await stat(file);
        if (Date.now() - info.mtimeMs > ttlMs || info.size > 17 * 1024 * 1024) {
          await unlink(file);
          return;
        }
        const buffer = await readFile(file),
          separator = buffer.indexOf(10);
        if (separator < 1 || separator > 100) return;
        const contentType = buffer.subarray(0, separator).toString('utf8');
        if (!/^audio\/[a-zA-Z0-9.+-]+$/.test(contentType)) return;
        const data = buffer.subarray(separator + 1);
        if (!data.length) return;
        await utimes(file, new Date(), new Date());
        return { data, contentType };
      } catch {
        return;
      }
    },
    put(key: string, audio: Audio): Promise<void> {
      const work = async () => {
        if (!/^audio\/[a-zA-Z0-9.+-]+$/.test(audio.contentType)) return;
        const bytes = Buffer.concat([Buffer.from(audio.contentType + '\n'), audio.data]);
        if (bytes.length > maxBytes) return;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.audio$/.test(name));
        const entries = await Promise.all(
          names.map(async (name) => {
            try {
              const info = await stat(path.join(directory, name));
              return { name, ...info };
            } catch {
              return;
            }
          }),
        );
        const valid = entries
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
          .sort((a, b) => a.mtimeMs - b.mtimeMs);
        let size = valid.reduce((sum, entry) => sum + entry.size, 0);
        let count = valid.length;
        for (const entry of valid) {
          if (Date.now() - entry.mtimeMs <= ttlMs && size + bytes.length <= maxBytes && count < 128) break;
          await unlink(path.join(directory, entry.name));
          size -= entry.size;
          count--;
        }
        const target = filename(key),
          temporary = target + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temporary, bytes, { mode: 0o600 });
          await rename(temporary, target);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      };
      tail = tail.then(work).catch(() => {}); // Cache failures never prevent listening.
      return tail;
    },
  };
}
