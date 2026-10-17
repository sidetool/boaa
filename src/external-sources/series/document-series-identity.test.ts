import { afterEach, expect, it, vi } from 'vitest';
import { persistentId128 } from '@boaa/text-core/hash';
import { externalDocumentCollectionId, externalDocumentReleaseSourceId } from './document-series-identity';

vi.mock('@boaa/text-core/hash', async (original) => {
  const actual = await original<typeof import('@boaa/text-core/hash')>();
  return { ...actual, persistentId128: vi.fn(actual.persistentId128) };
});
afterEach(() => vi.clearAllMocks());

it('reuses immutable source IDs across fresh key objects without changing persistent bytes', async () => {
  const { persistentId128: actual } =
    await vi.importActual<typeof import('@boaa/text-core/hash')>('@boaa/text-core/hash');
  const key = { connectorId: 'synthetic.source', remoteId: 'episode-1' };
  for (let index = 0; index < 100; index++) {
    expect(externalDocumentReleaseSourceId({ ...key }, 'work')).toBe(
      actual('external_release', [key.connectorId, '', 'work', key.remoteId]),
    );
    expect(externalDocumentCollectionId({ ...key }, 'work')).toBe(
      actual('external_series', [key.connectorId, '', 'work']),
    );
  }
  expect(persistentId128).toHaveBeenCalledTimes(2);
});

it('isolates source, account, collection and release identities, including separator characters', () => {
  const key = { connectorId: 'synthetic.other', accountConnectionId: 'account', remoteId: 'one' };
  const ids = [
    externalDocumentReleaseSourceId(key, 'work'),
    externalDocumentReleaseSourceId({ ...key, connectorId: 'synthetic.different' }, 'work'),
    externalDocumentReleaseSourceId({ ...key, accountConnectionId: 'other' }, 'work'),
    externalDocumentReleaseSourceId({ ...key, remoteId: 'two' }, 'work'),
    externalDocumentReleaseSourceId(key, 'other'),
    externalDocumentReleaseSourceId({ ...key, accountConnectionId: 'a::b' }, 'c'),
    externalDocumentReleaseSourceId({ ...key, accountConnectionId: 'a' }, 'b::c'),
  ];
  expect(new Set(ids).size).toBe(ids.length);
});

it('bounds retained identities and recomputes evicted entries with the same value', () => {
  const key = { connectorId: 'synthetic.eviction', remoteId: 'first' };
  const first = externalDocumentReleaseSourceId(key, 'work');
  for (let index = 0; index < 2048; index++) {
    externalDocumentReleaseSourceId({ ...key, remoteId: String(index) }, 'work');
  }
  vi.mocked(persistentId128).mockClear();
  expect(externalDocumentReleaseSourceId({ ...key }, 'work')).toBe(first);
  expect(persistentId128).toHaveBeenCalledOnce();
});
