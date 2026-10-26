import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, statfs, readdir } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export interface SavedAudio {
  data: Buffer;
  contentType: string;
  key: string;
}
export class AudiobookAudioStore {
  constructor(private readonly directory: string) {}
  private location(id: string, ordinal: number) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(ordinal) || ordinal < 0)
      throw new Error('invalid_audio_identity');
    return path.join(this.directory, id, `${ordinal}.audio`);
  }
  async get(id: string, ordinal: number): Promise<SavedAudio | undefined> {
    try {
      const buffer = await readFile(this.location(id, ordinal));
      const end = buffer.indexOf(10);
      if (end < 1 || end > 2048 || buffer.length > 17 * 1024 * 1024) return;
      const meta = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      const data = buffer.subarray(end + 1);
      if (
        !data.length ||
        !/^audio\/[a-zA-Z0-9.+-]+$/.test(meta.contentType) ||
        typeof meta.key !== 'string' ||
        createHash('sha256').update(data).digest('hex') !== meta.sha256
      )
        return;
      return { data, contentType: meta.contentType, key: meta.key };
    } catch {
      return;
    }
  }
  async put(id: string, ordinal: number, audio: SavedAudio) {
    if (
      !audio.data.length ||
      audio.data.length > 16 * 1024 * 1024 ||
      !/^audio\/[a-zA-Z0-9.+-]+$/.test(audio.contentType)
    )
      throw new Error('invalid_saved_audio');
    const destination = this.location(id, ordinal);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const free = await statfs(this.directory);
    if (free.bavail * free.bsize < audio.data.length + 64 * 1024 * 1024)
      throw Object.assign(new Error('서버의 저장 공간이 부족합니다. 공간을 확보한 뒤 이어 만들어 주세요.'), {
        statusCode: 507,
      });
    const metadata = JSON.stringify({
      contentType: audio.contentType,
      key: audio.key,
      sha256: createHash('sha256').update(audio.data).digest('hex'),
    });
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, Buffer.concat([Buffer.from(metadata + '\n'), audio.data]), { mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async remove(id: string) {
    await rm(path.dirname(this.location(id, 0)), { recursive: true, force: true });
  }
  async ids(): Promise<string[]> {
    try {
      return (await readdir(this.directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async find(pool: pg.Pool, userId: string, key: string): Promise<SavedAudio | undefined> {
    const rows = (
      await pool.query(
        `select i.audiobook_id,i.ordinal from saved_audiobook_items i
      join saved_audiobooks a on a.id=i.audiobook_id join library_books b on b.id=a.book_id
      where i.cache_key=$1 and i.status='ready' and a.user_id=$2 and b.user_id=$2
      and b.deleted_at is null and a.status<>'deleting'
      and a.content_revision is not distinct from b.active_content_revision_id limit 4`,
        [key, userId],
      )
    ).rows;
    for (const row of rows) {
      const audio = await this.get(row.audiobook_id, row.ordinal);
      if (audio?.key === key) return audio;
    }
  }
}
