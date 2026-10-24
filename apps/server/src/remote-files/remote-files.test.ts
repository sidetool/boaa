import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { Server as SshServer, utils } from 'ssh2';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { EncryptedSourceCredentialVault, SessionSourceCredentialVault } from '../extensions/source-credential-vault.js';
import { registerRemoteFileRoutes } from '../routes/remote-files.js';
import { RemoteFileService } from './service.js';
import { connectionInput, type SavedRemoteConnection } from './common.js';
import { openSftp } from './sftp.js';
import { remoteFilePath } from '../../../../packages/extension-contracts/remote-files.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const signal = () => AbortSignal.timeout(10000);
const content = Buffer.from('한글 book content\n'.repeat(16000));
async function webdav() {
  const calls: Array<{ method: string; path: string; authorization?: string; depth?: string }> = [];
  let malicious = false;
  const server = createServer((req, res) => {
    calls.push({
      method: req.method!,
      path: req.url!,
      authorization: req.headers.authorization,
      depth: req.headers.depth as string,
    });
    if (req.headers.authorization !== 'Basic ' + Buffer.from('reader:secret-password').toString('base64')) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'PROPFIND') {
      res
        .writeHead(207, { 'content-type': 'application/xml' })
        .end(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>${malicious ? 'https://outside.invalid/secret' : '/dav/%ED%95%9C%EA%B8%80%20book.txt'}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${content.length}</d:getcontentlength><d:getetag>"v1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        );
    } else if (req.method === 'GET' && decodeURIComponent(req.url!) === '/dav/한글 book.txt') {
      res.writeHead(200, { 'content-length': content.length });
      res.write(content.subarray(0, 4096));
      res.end(content.subarray(4096));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    calls,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/dav/`,
    malicious: () => {
      malicious = true;
    },
  };
}
const input = (endpoint: string) => ({
  name: '내 NAS',
  endpoint,
  username: 'reader',
  password: 'secret-password',
  allowHttp: 'true',
});
async function bytes(stream: Readable) {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
it('connects real WebDAV, encrypts persistent credentials, browses UTF8 and downloads every byte without writing upstream', async () => {
  const fixture = await webdav(),
    root = await mkdtemp(join(tmpdir(), 'boaa-remote-files-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 7);
  const service = new RemoteFileService(new EncryptedSourceCredentialVault(root, key));
  const status = await service.connect('owner', 'webdav', input(fixture.endpoint), signal());
  expect(JSON.stringify(status)).not.toContain('secret-password');
  expect(status.connected).toBe(true);
  for (const name of await readdir(root))
    expect((await readFile(join(root, name))).includes(Buffer.from('secret-password'))).toBe(false);
  const reopened = new RemoteFileService(new EncryptedSourceCredentialVault(root, key));
  expect(reopened.status('owner', status.id!)).toEqual(status);
  expect(reopened.status('other', status.id!)).toEqual({ connected: false });
  const page = await reopened.list('owner', status.id!, { generation: status.generation }, signal());
  expect(page.entries[0].path).toBe('/한글 book.txt');
  expect(page.entries[0].size).toBe(content.length);
  expect(
    await bytes(
      await reopened.download(
        'owner',
        status.id!,
        { generation: status.generation, path: page.entries[0].path },
        signal(),
      ),
    ),
  ).toEqual(content);
  expect(fixture.calls.map((c) => c.method)).toEqual(['PROPFIND', 'PROPFIND', 'GET']);
  expect(fixture.calls[0].depth).toBe('1');
  await expect(reopened.list('owner', status.id!, { generation: 'stale' }, signal())).rejects.toThrow(
    'connection_changed',
  );
  fixture.malicious();
  await expect(reopened.list('owner', status.id!, { generation: status.generation }, signal())).rejects.toThrow(
    'invalid_response',
  );
  reopened.disconnect('owner', status.id!);
  expect(new RemoteFileService(new EncryptedSourceCredentialVault(root, key)).status('owner', status.id!)).toEqual({
    connected: false,
  });
});
it('rejects traversal and insecure WebDAV unless explicitly selected', () => {
  for (const p of ['/../secret', '/a/../b', 'a\\b', '/a\0b']) expect(() => remoteFilePath(p)).toThrow();
  expect(() => connectionInput('webdav', { ...input('http://nas.local/dav'), allowHttp: 'false' })).toThrow(
    'https_required',
  );
  expect(connectionInput('webdav', input('nas.local/dav')).endpoint).toBe('https://nas.local/dav/');
  expect(() => connectionInput('sftp', { ...input('sftp://nas.local'), hostKey: 'bad' })).toThrow('invalid_host_key');
});
it('does not save an in-flight connection after cancellation', async () => {
  let finish!: () => void;
  const held = new Promise<void>((r) => {
    finish = r;
  });
  let closed = 0;
  const service = new RemoteFileService(new SessionSourceCredentialVault(), async () => ({
    list: async () => {
      await held;
      return [];
    },
    download: async () => Readable.from([]),
    close() {
      closed++;
    },
  }));
  const abort = new AbortController();
  const pending = service.connect('owner', 'webdav', input('https://nas.example/dav/'), abort.signal);
  abort.abort();
  finish();
  await expect(pending).rejects.toThrow();
  expect(service.statuses('owner')).toEqual([]);
  expect(closed).toBe(1);
});
async function sshFixture() {
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  let authentications = 0;
  const connections = new Set<{ end(): void }>();
  const server = new SshServer({ hostKeys: [key] }, (client) => {
    connections.add(client);
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    client.on('authentication', (ctx) => {
      authentications++;
      if (ctx.method === 'password' && ctx.username === 'reader' && ctx.password === 'secret-password') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) =>
        accept().on('sftp', (accept) => {
          const s = accept(),
            status = utils.sftp.STATUS_CODE;
          let listed = false;
          const attrs = { mode: 0o100644, size: content.length, uid: 1, gid: 1, atime: 1, mtime: 1700000000 };
          s.on('REALPATH', (id, path) =>
            s.name(id, [{ filename: path === '/' ? '/books' : path, longname: '', attrs }]),
          );
          s.on('OPENDIR', (id) => s.handle(id, Buffer.from('directory')));
          s.on('READDIR', (id) => {
            if (listed) s.status(id, status.EOF);
            else {
              listed = true;
              s.name(id, [
                { filename: 'book.txt', longname: '', attrs },
                { filename: 'escape', longname: '', attrs: { ...attrs, mode: 0o120777 } },
              ]);
            }
          });
          s.on('STAT', (id, _path) => s.attrs(id, attrs));
          s.on('OPEN', (id) => s.handle(id, Buffer.from('file')));
          s.on('READ', (id, _handle, offset, length) => {
            if (offset >= content.length) s.status(id, status.EOF);
            else s.data(id, content.subarray(offset, Math.min(offset + length, content.length)));
          });
          s.on('CLOSE', (id) => s.status(id, status.OK));
        }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    for (const c of connections) c.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    endpoint: `sftp://127.0.0.1:${(server.address() as { port: number }).port}`,
    authentications: () => authentications,
  };
}
it('uses real encrypted SFTP, pins the server key, excludes symlinks and reads exact bytes', async () => {
  const fixture = await sshFixture();
  const service = new RemoteFileService(new SessionSourceCredentialVault());
  const status = await service.connect('owner', 'sftp', { ...input(fixture.endpoint), root: '/' }, signal());
  expect(status.hostKey).toMatch(/^SHA256:/);
  const page = await service.list('owner', status.id!, { generation: status.generation }, signal());
  expect(page.entries.map((e) => e.name)).toEqual(['book.txt']);
  expect(
    await bytes(
      await service.download('owner', status.id!, { generation: status.generation, path: '/book.txt' }, signal()),
    ),
  ).toEqual(content);
  const before = fixture.authentications();
  const config = {
    ...connectionInput('sftp', input(fixture.endpoint)),
    protocol: 'sftp',
    name: 'test',
    id: 'x',
    generation: 'x',
    root: '/',
    hostKey: 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, ''),
  } as SavedRemoteConnection;
  await expect(openSftp(config, signal())).rejects.toThrow('host_key_changed');
  expect(fixture.authentications()).toBe(before);
});
it('keeps remote storage administrator-only and never returns upstream errors or credentials', async () => {
  const service = new RemoteFileService(new SessionSourceCredentialVault(), async () => {
    throw new Error('secret-password remote.internal');
  });
  const app = Fastify();
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (req) => {
    req.principal = { userId: 'owner', role: req.headers['x-member'] ? 'member' : 'admin', authMethod: 'legacy-token' };
  });
  await registerRemoteFileRoutes(app, service);
  cleanup.push(() => app.close());
  const denied = await app.inject({
    method: 'POST',
    url: '/api/remote-files',
    headers: { 'x-member': '1' },
    payload: { ...input('https://nas.example/dav'), protocol: 'webdav' },
  });
  expect(denied.statusCode).toBe(403);
  const failure = await app.inject({
    method: 'POST',
    url: '/api/remote-files',
    payload: { ...input('https://nas.example/dav'), protocol: 'webdav' },
  });
  expect(failure.statusCode).toBe(502);
  expect(failure.json()).toEqual({ error: 'remote_files_unavailable' });
});

it('keeps multiple same-protocol servers independent across reload, account boundaries and removal', async () => {
  const fixture = await webdav();
  const vault = new SessionSourceCredentialVault(),
    service = new RemoteFileService(vault);
  const [one, two] = await Promise.all([
    service.connect('owner', 'webdav', { ...input(fixture.endpoint), name: '집 NAS' }, signal()),
    service.connect('owner', 'webdav', { ...input(fixture.endpoint), name: '백업 NAS' }, signal()),
  ]);
  expect(one.id).not.toBe(two.id);
  const reopened = new RemoteFileService(vault);
  expect(
    reopened
      .statuses('owner')
      .map((x) => x.name)
      .sort(),
  ).toEqual(['백업 NAS', '집 NAS']);
  expect(reopened.statuses('other')).toEqual([]);
  await expect(reopened.list('other', one.id!, { generation: one.generation }, signal())).rejects.toThrow(
    'not_connected',
  );
  reopened.disconnect('owner', one.id!);
  expect(reopened.statuses('owner')).toEqual([two]);
  expect((await reopened.list('owner', two.id!, { generation: two.generation }, signal())).entries).toHaveLength(1);
});
it('serializes additions at the connection limit and invalidates a removed connection during credential update', async () => {
  let hold: Promise<void> | undefined;
  const vault = new SessionSourceCredentialVault();
  const service = new RemoteFileService(vault, async () => ({
    list: async () => {
      await hold;
      return [];
    },
    download: async () => Readable.from([]),
    close() {},
  }));
  const saved = await service.connect('owner', 'webdav', input('https://nas.example/dav/'), signal());
  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = service.connect('owner', 'webdav', input('https://nas.example/dav/'), signal(), saved.id);
  service.disconnect('owner', saved.id!);
  release();
  await expect(pending).rejects.toThrow('connection_changed');
  expect(service.statuses('owner')).toEqual([]);
  hold = undefined;
  for (let n = 0; n < 15; n++) await service.connect('owner', 'webdav', input('https://nas.example/dav/'), signal());
  const results = await Promise.allSettled(
    [0, 1].map(() => service.connect('owner', 'webdav', input('https://nas.example/dav/'), signal())),
  );
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(service.statuses('owner')).toHaveLength(16);
});
