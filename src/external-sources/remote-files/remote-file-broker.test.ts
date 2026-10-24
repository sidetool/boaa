import { expect, it } from 'vitest';
import { RemoteFileBroker, type RemoteFileFetch } from './remote-file-broker';
import { RemoteFileManager } from './remote-file-manager';
import { remoteFileBuiltInSource, remoteFileSourceId } from './remote-file-source';
const status = {
  name: '집 NAS',
  protocol: 'sftp' as const,
  connected: true,
  id: 'account',
  generation: 'v1',
  endpoint: 'sftp://nas.local:22',
  username: 'reader',
  root: '/books',
  hostKey: 'SHA256:' + 'A'.repeat(43),
};
it('loads server-owned connection state, browses folders and downloads a named UTF8 file', async () => {
  const calls: Array<{ action: string; body: unknown }> = [];
  const fetcher: RemoteFileFetch = async (_protocol, action, body) => {
    calls.push({ action, body });
    if (action === 'download') return new Response(new TextEncoder().encode('본문'));
    if (action === 'list')
      return Response.json({
        entries: [
          { name: '소설', path: '/소설', directory: true },
          { name: '책.txt', path: '/책.txt', directory: false, size: 6, revision: 'etag' },
        ],
      });
    return Response.json(status);
  };
  const broker = new RemoteFileBroker(status, fetcher);
  await broker.initialize();
  expect(broker.status().connectionGeneration).toBe('v1');
  expect(broker.connectionForm().fields.find((f) => f.id === 'privateKey')?.type).toBe('textarea');
  expect(broker.connectionForm().fields.find((f) => f.id === 'password')?.defaultValue).toBeUndefined();
  const signal = new AbortController().signal;
  const page = await broker.list({}, signal);
  expect(page.items[0].navigationRef).toBe('/소설');
  expect(page.items[1].key.connectorId).toBe(remoteFileSourceId(status.id));
  const result = await broker.download({ key: page.items[1].key, fileName: 'ignored.txt' }, signal);
  expect(result.file.name).toBe('책.txt');
  expect(await result.file.text()).toBe('본문');
  expect(calls.at(-1)).toEqual({ action: 'download', body: { path: '/책.txt', generation: 'v1' } });
  await expect(
    broker.download({ key: { ...page.items[1].key, accountConnectionId: 'other' }, fileName: 'x' }, signal),
  ).rejects.toThrow('연결 설정');
  broker.dispose();
});
it('uses two built-in read-only file sources and gives useful host-key errors without losing saved state', async () => {
  expect(remoteFileBuiltInSource(status).descriptor.title).toBe('집 NAS');
  const broker = new RemoteFileBroker(status, async (_p, action) =>
    action === 'status'
      ? Response.json(status)
      : Response.json({ error: 'remote_files_host_key_changed' }, { status: 502 }),
  );
  await broker.initialize();
  await expect(broker.connect({ endpoint: 'sftp://nas.local' })).rejects.toThrow('SSH 서버 지문');
  expect(broker.status().state).toBe('connected');
  broker.dispose();
});

it('adds two independent named sources, reuses server state on a fresh manager, and deletes only the selected server', async () => {
  const connections = new Map<string, typeof status>();
  let sequence = 0;
  const fetcher: RemoteFileFetch = async (id, action, body) => {
    if (action === 'statuses') return Response.json({ connections: [...connections.values()] });
    if (action === 'connect') {
      const input = body as { name: string };
      const saved = { ...status, id: String(++sequence), name: input.name };
      connections.set(saved.id, saved);
      return Response.json(saved);
    }
    if (action === 'disconnect') {
      connections.delete(id!);
      return Response.json({ connected: false });
    }
    throw new Error('unexpected request');
  };
  const manager = new RemoteFileManager(fetcher);
  const input = { protocol: 'sftp' as const, endpoint: 'sftp://nas.local', username: 'reader', password: 'secret' };
  await manager.add({ ...input, name: '집 NAS' });
  await manager.add({ ...input, name: '작업 NAS' });
  expect(manager.sources().map((s) => s.descriptor.title)).toEqual(['집 NAS', '작업 NAS']);
  const reopened = new RemoteFileManager(fetcher);
  await reopened.refresh();
  expect(reopened.sources()).toEqual(manager.sources());
  const firstId = reopened.sources()[0].brokerId;
  await reopened.broker(firstId)!.disconnect();
  expect(reopened.sources().map((s) => s.descriptor.title)).toEqual(['작업 NAS']);
  await manager.refresh();
  expect(manager.sources()).toEqual(reopened.sources());
  expect(manager.broker(firstId)).toBeUndefined();
  manager.dispose();
  reopened.dispose();
});
it('does not let an older catalog response erase a newly added connection', async () => {
  let finish!: (response: Response) => void;
  const manager = new RemoteFileManager(async (_id, action) =>
    action === 'statuses'
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Response.json(status),
  );
  const refresh = manager.refresh();
  await manager.add({ protocol: 'sftp', name: '집 NAS', endpoint: status.endpoint, username: 'reader' });
  finish(Response.json({ connections: [] }));
  await refresh;
  expect(manager.sources()).toHaveLength(1);
  manager.dispose();
});
