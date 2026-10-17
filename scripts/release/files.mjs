import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(file, fallback, limit = 1024 * 1024) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('management_state_invalid');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function atomicJson(file, value, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.part`;
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(JSON.stringify(value) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('management_request_invalid');
  const fields = {
    check: ['action'],
    update: ['action'],
    channel: ['action', 'channel'],
    component: ['action', 'componentId', 'enabled'],
  }[value.action];
  if (!fields || Object.keys(value).some((key) => !fields.includes(key))) throw new Error('management_request_invalid');
  if (value.action === 'channel' && !['stable', 'beta'].includes(value.channel))
    throw new Error('management_request_invalid');
  if (
    value.action === 'component' &&
    (!['apk', 'browser', 'metadata'].includes(value.componentId) || typeof value.enabled !== 'boolean')
  )
    throw new Error('management_request_invalid');
  return value;
}
