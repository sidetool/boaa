import { describe, expect, it, vi } from 'vitest';
import { createLibraryCoverResolver } from './library-cover-resolver';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import { SessionCoverCache } from '../../external-sources/session-cover-cache';

const work = {
  id: 'work',
  connectorId: 'sample.source',
  collectionRemoteId: 'known-work',
  navigationRef: 'detail-route',
};
function fixture() {
  const registry = {
    getExternalSourceStatus: vi.fn(() => ({ state: 'connected' })),
    peekExternalSourceCover: vi.fn((): string | undefined => 'blob:memory'),
    resolveExternalSourceCover: vi.fn(async (): Promise<string | undefined> => 'blob:disk'),
    listExternalSource: vi.fn(async () => ({
      items: [],
      detail: { title: 'Sample', coverRef: { connectorId: work.connectorId, remoteId: 'different-cover' } },
    })),
  };
  return {
    registry,
    resolver: createLibraryCoverResolver(() => ({
      registry: registry as unknown as ExternalSourceRegistryPort,
      hostContext: { brokers: { get: () => undefined } },
    })),
  };
}
describe('known library cover fast path', () => {
  it('peeks on the first render and hydrates disk artwork without requesting the release list', async () => {
    const { registry, resolver } = fixture();
    expect(resolver.peek(work)).toBe('blob:memory');
    expect(await resolver.resolve(work, new AbortController().signal)).toBe('blob:disk');
    expect(registry.resolveExternalSourceCover.mock.calls[0]).toContainEqual({
      connectorId: work.connectorId,
      accountConnectionId: undefined,
      remoteId: 'known-work',
    });
    expect(registry.listExternalSource).not.toHaveBeenCalled();
  });
  it('reads persistent cover bytes before any list or cover network request', async () => {
    const { registry, resolver } = fixture();
    const cache = new SessionCoverCache(undefined, undefined, {
      get: vi.fn(async () => ({
        key: 'cover',
        source: 'sample.source',
        blob: new Blob(['cover'], { type: 'image/png' }),
        time: Date.now(),
        usedAt: Date.now(),
      })),
      put: vi.fn(),
      invalidateSource: vi.fn(),
    });
    const network = vi.fn(async () => undefined);
    registry.resolveExternalSourceCover.mockImplementation(() =>
      cache.resolve(
        JSON.stringify(['sample.source', 'generation', 'known-work']),
        network,
        new AbortController().signal,
      ),
    );
    try {
      expect(await resolver.resolve(work, new AbortController().signal)).toMatch(/^blob:/);
      expect(network).not.toHaveBeenCalled();
      expect(registry.listExternalSource).not.toHaveBeenCalled();
    } finally {
      cache.clear();
    }
  });
  it('retains the detail lookup fallback for sources without a direct cover', async () => {
    const { registry, resolver } = fixture();
    registry.resolveExternalSourceCover.mockResolvedValueOnce(undefined).mockResolvedValueOnce('blob:fallback');
    expect(await resolver.resolve(work, new AbortController().signal)).toBe('blob:fallback');
    expect(registry.listExternalSource).toHaveBeenCalledOnce();
  });
  it('does not use artwork belonging to another account or a cancelled request', async () => {
    const { registry, resolver } = fixture();
    expect(resolver.peek({ ...work, accountConnectionId: 'other' })).toBeUndefined();
    expect(
      await resolver.resolve({ ...work, accountConnectionId: 'other' }, new AbortController().signal),
    ).toBeUndefined();
    const abort = new AbortController();
    abort.abort();
    await expect(resolver.resolve(work, abort.signal)).rejects.toBeDefined();
    expect(registry.resolveExternalSourceCover).not.toHaveBeenCalled();
  });
});
