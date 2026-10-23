import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({
  status: 200,
  encoding: 'identity',
  chunks: [] as Buffer[],
  address: '8.8.8.8',
  options: undefined as Record<string, unknown> | undefined,
  requests: 0,
}));
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: network.address, family: 4 }],
}));
vi.mock('node:https', () => ({
  request: (_url: URL, options: Record<string, unknown>, receive: (response: EventEmitter) => void) => {
    network.requests++;
    network.options = options;
    const request = new EventEmitter();
    return Object.assign(request, {
      end() {
        queueMicrotask(() => {
          let destroyed = false;
          const response = Object.assign(new EventEmitter(), {
            statusCode: network.status,
            headers: { 'content-encoding': network.encoding },
            destroy(error: Error) {
              destroyed = true;
              response.emit('error', error);
            },
          });
          receive(response);
          for (const chunk of network.chunks) if (!destroyed) response.emit('data', chunk);
          if (!destroyed) response.emit('end');
        });
      },
    });
  },
}));
import { coverMime, pluginCoverTransport } from './cover-transport';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const cover = (path = 'cover.png', beforeSend?: () => Promise<void>) =>
  pluginCoverTransport(
    `https://art.example/images/${path}`,
    'https://art.example/images/',
    'https://reader.example',
    new AbortController().signal,
    beforeSend,
  );

beforeEach(() => {
  Object.assign(network, {
    status: 200,
    encoding: 'identity',
    chunks: [png],
    address: '8.8.8.8',
    requests: 0,
    options: undefined,
  });
});

it('returns bounded raster bytes with a pinned address and no credential/cookie headers', async () => {
  expect(await cover()).toEqual({ mime: 'image/png', data: png.toString('base64') });
  expect(network.options?.headers).toEqual({
    accept: 'image/png,image/jpeg,image/webp',
    'accept-encoding': 'identity',
  });
  const lookup = network.options!.lookup as (
    _host: string,
    options: object,
    callback: (...args: unknown[]) => void,
  ) => void;
  await new Promise<void>((resolve) =>
    lookup('art.example', { all: true }, (...args) => {
      expect(args).toEqual([null, [{ address: '8.8.8.8', family: 4 }]]);
      resolve();
    }),
  );
  expect(coverMime(Buffer.from([255, 216, 255]))).toBe('image/jpeg');
  expect(coverMime(Buffer.from('RIFF0000WEBP'))).toBe('image/webp');
});

it('rejects path escapes, private addresses and revoked permission before opening a connection', async () => {
  for (const path of ['%2f../secret', '%252e%252e/secret', '../secret']) await expect(cover(path)).rejects.toThrow();
  network.address = '127.0.0.1';
  await expect(cover()).rejects.toThrow(/HTTP_(ADDRESS|ENDPOINT)_DENIED/);
  network.address = '8.8.8.8';
  await expect(
    cover('cover.png', async () => {
      throw Error('REVOKED');
    }),
  ).rejects.toThrow('REVOKED');
  expect(network.requests).toBe(0);
});

it('does not follow redirects or expand compressed, active, or oversized content', async () => {
  network.status = 302;
  await expect(cover()).rejects.toThrow('COVER_DENIED');
  network.status = 200;
  network.encoding = 'gzip';
  await expect(cover()).rejects.toThrow('COVER_DENIED');
  network.encoding = 'identity';
  network.chunks = [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')];
  await expect(cover()).rejects.toThrow('INVALID_COVER');
  network.chunks = [png, Buffer.alloc(512 * 1024)];
  await expect(cover()).rejects.toThrow('COVER_LIMIT');
});
