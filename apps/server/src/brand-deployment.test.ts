import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { S3Client } from '@aws-sdk/client-s3';
import { expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { selectCompatibleBucket } from './services/object-storage.js';

it('projects old deployment identifiers while new values, including empty ones, take precedence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'boaa-config-'));
  try {
    const output = path.join(root, 'runtime.js');
    const script = new URL('../../../deploy/web-runtime-config.sh', import.meta.url).pathname;
    for (const [extra, expected] of [
      [{}, 'legacy'],
      [{ BOAA_DROPBOX_APP_KEY: '' }, ''],
      [{ BOAA_DROPBOX_APP_KEY: 'new' }, 'new'],
    ] as const) {
      execFileSync('sh', [script, output], {
        env: { PATH: process.env.PATH, MOYA_DROPBOX_APP_KEY: 'legacy', ...extra },
      });
      const context = {
        TextDecoder,
        Uint8Array,
        atob,
        __BOAA_RUNTIME_CONFIG__: undefined as undefined | { dropboxAppKey: string },
        __MOYA_RUNTIME_CONFIG__: undefined as unknown,
      };
      vm.runInNewContext(await readFile(output, 'utf8'), context);
      expect(context.__BOAA_RUNTIME_CONFIG__?.dropboxAppKey).toBe(expected);
      expect(context.__MOYA_RUNTIME_CONFIG__).toBe(context.__BOAA_RUNTIME_CONFIG__);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('selects an existing legacy bucket before a fresh bucket can hide it', async () => {
  const missing = Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
  const send = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce({});
  const client = { send } as unknown as S3Client;
  const config = loadConfig({});
  await selectCompatibleBucket(client, config);
  expect(config.s3.bucket).toBe('noveldesk-uploads');
  expect(send.mock.calls.map(([command]) => command.input.Bucket)).toEqual(['boaa-uploads', 'noveldesk-uploads']);
  await selectCompatibleBucket(client, config);
  expect(send).toHaveBeenCalledTimes(2);
});

it('keeps canonical buckets and explicit operator configuration authoritative', async () => {
  const send = vi.fn().mockResolvedValue({});
  const config = loadConfig({});
  await selectCompatibleBucket({ send } as unknown as S3Client, config);
  expect(config.s3.bucket).toBe('boaa-uploads');
  expect(send).toHaveBeenCalledTimes(1);
  const explicit = loadConfig({ S3_BUCKET: 'operator' });
  await selectCompatibleBucket({ send } as unknown as S3Client, explicit);
  expect(send).toHaveBeenCalledTimes(1);
  const error = new Error('permission');
  await expect(
    selectCompatibleBucket({ send: vi.fn().mockRejectedValue(error) } as unknown as S3Client, loadConfig({})),
  ).rejects.toBe(error);
});
