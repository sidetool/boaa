import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ExternalItemPage,
  ExternalItemSummary,
  ExternalCatalogCachePage,
  ExternalSourceConnectionStatus,
} from '../../external-sources/contracts';
import { useSourceCatalogQuery, type SourceCatalogQueryInput } from './use-source-catalog-query';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
});
const sourceId = 'test.catalog';
function item(id: string): ExternalItemSummary {
  return {
    key: { connectorId: sourceId, accountConnectionId: 'account', remoteId: id },
    title: id,
    importability: 'unsupported',
    kind: 'folder',
  };
}
function fixture() {
  let connection: ExternalSourceConnectionStatus = {
    state: 'connected',
    accountConnectionId: 'account',
    connectionGeneration: 'g1',
  };
  const port: SourceCatalogQueryInput = {
    activeSourceId: sourceId,
    blocked: false,
    settingsScope: 'user-a',
    extensionRevision: 0,
    registry: {
      getExternalSourceStatus: vi.fn(() => connection),
      listExternalSource: vi.fn(async () => ({ items: [item('fresh')] })),
    },
    hostContext: { brokers: { get: () => undefined } },
    state: { getCachePage: vi.fn(async () => undefined), saveCachePage: vi.fn(async () => {}) },
    reconcile: vi.fn(async () => {}),
    retainSelection: vi.fn(),
    notify: vi.fn(),
  };
  let hook!: ReturnType<typeof useSourceCatalogQuery>;
  function Harness({ value }: { value: SourceCatalogQueryInput }) {
    hook = useSourceCatalogQuery(value);
    return null;
  }
  act(() => {
    renderer = create(<Harness value={port} />);
  });
  return {
    port,
    get hook() {
      return hook;
    },
    setConnection(value: ExternalSourceConnectionStatus) {
      connection = value;
    },
    update(value: SourceCatalogQueryInput) {
      act(() => renderer!.update(<Harness value={value} />));
    },
  };
}
it('supersedes cache reads and prevents old finally from ending a newer load', async () => {
  const h = fixture(),
    oldCache = deferred<ExternalCatalogCachePage | undefined>(),
    fresh = deferred<ExternalItemPage>();
  vi.mocked(h.port.state.getCachePage).mockReturnValueOnce(oldCache.promise);
  vi.mocked(h.port.registry.listExternalSource).mockReturnValueOnce(fresh.promise);
  let old!: Promise<boolean | undefined>, next!: Promise<boolean | undefined>;
  act(() => {
    old = h.hook.loadPage({ query: 'old' }, false);
  });
  act(() => {
    next = h.hook.loadPage({ query: 'new' }, false);
  });
  await vi.waitFor(() => expect(h.port.registry.listExternalSource).toHaveBeenCalledOnce());
  await act(async () => {
    oldCache.resolve(undefined);
    await old;
  });
  expect(h.hook.state.loading).toBe(true);
  await act(async () => {
    fresh.resolve({ items: [item('new')] });
    await next;
  });
  expect(h.hook.state.catalogItems.map((value) => value.title)).toEqual(['new']);
  expect(h.port.state.saveCachePage).toHaveBeenCalledOnce();
});
it.each(['storage', 'registry', 'settings', 'extension', 'unmount'])(
  'rejects late success/error/finally after %s owner replacement',
  async (kind) => {
    const h = fixture(),
      pending = deferred<ExternalItemPage>();
    vi.mocked(h.port.registry.listExternalSource).mockReturnValueOnce(pending.promise);
    let task!: Promise<boolean | undefined>;
    act(() => {
      task = h.hook.loadPage({}, false);
    });
    await vi.waitFor(() => expect(h.port.registry.listExternalSource).toHaveBeenCalledOnce());
    const signal = vi.mocked(h.port.registry.listExternalSource).mock.calls[0][3];
    if (kind === 'unmount') {
      act(() => renderer!.unmount());
      renderer = undefined;
    } else
      h.update({
        ...h.port,
        state: kind === 'storage' ? { ...h.port.state } : h.port.state,
        registry: kind === 'registry' ? { ...h.port.registry } : h.port.registry,
        settingsScope: kind === 'settings' ? 'user-b' : h.port.settingsScope,
        extensionRevision: kind === 'extension' ? 1 : 0,
      });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.reject(new Error('late transport failure'));
      await task;
    });
    expect(h.port.notify).not.toHaveBeenCalled();
    expect(h.port.reconcile).not.toHaveBeenCalled();
    expect(h.port.state.saveCachePage).not.toHaveBeenCalled();
  },
);
it('blocks retained callbacks across owner A→B→A', async () => {
  const h = fixture(),
    old = h.hook.loadPage;
  h.update({ ...h.port, settingsScope: 'user-b' });
  h.update(h.port);
  await old({}, false, undefined, true, false, 'command-refresh');
  expect(h.port.registry.listExternalSource).not.toHaveBeenCalled();
  await act(async () => {
    await h.hook.loadPage({}, false);
  });
  expect(h.port.registry.listExternalSource).toHaveBeenCalledOnce();
});
it('fences same-account connection generations and skips reconciliation/cache after a stale response', async () => {
  const h = fixture(),
    pending = deferred<ExternalItemPage>();
  vi.mocked(h.port.registry.listExternalSource).mockReturnValueOnce(pending.promise);
  let task!: Promise<boolean | undefined>;
  act(() => {
    task = h.hook.loadPage({}, false);
  });
  await vi.waitFor(() => expect(h.port.registry.listExternalSource).toHaveBeenCalledOnce());
  h.setConnection({ state: 'connected', accountConnectionId: 'account', connectionGeneration: 'g3' });
  await act(async () => {
    pending.resolve({ items: [item('old-account')] });
    await task;
  });
  expect(h.hook.state.catalogItems).toEqual([]);
  expect(h.port.state.saveCachePage).not.toHaveBeenCalled();
  expect(h.port.reconcile).not.toHaveBeenCalled();
  expect(h.hook.state.loading).toBe(false);
});
it('does not write cache after cancellation while subscription reconciliation is pending', async () => {
  const h = fixture(),
    pending = deferred<void>();
  vi.mocked(h.port.reconcile).mockReturnValueOnce(pending.promise);
  let task!: Promise<boolean | undefined>;
  act(() => {
    task = h.hook.loadPage({}, false);
  });
  await vi.waitFor(() => expect(h.port.reconcile).toHaveBeenCalledOnce());
  act(() => h.hook.listAbortRef.current?.abort());
  await act(async () => {
    pending.resolve();
    await task;
  });
  expect(h.port.state.saveCachePage).not.toHaveBeenCalled();
  expect(h.port.notify).not.toHaveBeenCalled();
  expect(h.hook.state.loading).toBe(false);
});
it('accepts equivalent freshly allocated host contexts and preserves local seed while appending a catalog', async () => {
  const h = fixture();
  h.hook.localSeriesPageSeedRef.current = {
    sourceId,
    accountConnectionId: 'account',
    parentRef: 'work',
    items: [item('local')],
    remoteItems: [],
    detail: { title: 'Work' },
  };
  const pending = deferred<ExternalItemPage>();
  vi.mocked(h.port.registry.listExternalSource).mockReturnValueOnce(pending.promise);
  let task!: Promise<boolean | undefined>;
  act(() => {
    task = h.hook.loadPage({ parentRef: 'work' }, false);
  });
  await vi.waitFor(() => expect(h.port.registry.listExternalSource).toHaveBeenCalledOnce());
  h.update({ ...h.port, hostContext: { brokers: { get: () => undefined } } });
  await act(async () => {
    pending.resolve({ items: [item('remote')] });
    await task;
  });
  expect(h.hook.state.catalogItems.map((value) => value.title)).toEqual(['remote', 'local']);
  expect(h.port.notify).not.toHaveBeenCalled();
});

it('keeps matching work metadata through a failed request and retry without inventing a catalogue', async () => {
  const h = fixture();
  vi.mocked(h.port.registry.listExternalSource).mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    await h.hook.loadPage({ parentRef: 'work' }, false, undefined, false, false, 'navigation', { title: 'Work' });
  });
  expect(h.hook.state.catalogDetail?.title).toBe('Work');
  expect(h.hook.state.listFailure).toBeDefined();
  expect(h.hook.state.loading).toBe(false);
  expect(h.hook.state.catalogItems).toEqual([]);
  await act(async () => {
    await h.hook.loadPage({ parentRef: 'work' }, false, undefined, false, true);
  });
  expect(h.hook.state.catalogDetail?.title).toBe('Work');
  expect(h.hook.state.listFailure).toBeUndefined();
});

it.each(['folder', 'parent', 'account', 'generation', 'browse'])(
  'does not reuse work metadata for a different %s destination',
  async (destination) => {
    const h = fixture();
    await act(async () => {
      await h.hook.loadPage({ parentRef: 'work' }, false, undefined, false, false, 'navigation', { title: 'Work' });
    });
    if (destination === 'account' || destination === 'generation') {
      h.setConnection({
        state: 'connected',
        accountConnectionId: destination === 'account' ? 'other-account' : 'account',
        connectionGeneration: destination === 'generation' ? 'g2' : 'g1',
      });
    }
    if (destination === 'browse') {
      vi.mocked(h.port.registry.listExternalSource).mockResolvedValueOnce({
        items: [],
        browse: { availableModes: ['popular'], activeMode: 'popular' },
      });
    }
    await act(async () => {
      await h.hook.loadPage(
        { parentRef: destination === 'parent' ? 'other' : 'work' },
        false,
        undefined,
        false,
        false,
        'navigation',
        destination === 'folder' ? null : undefined,
      );
    });
    expect(h.hook.state.catalogDetail).toBeUndefined();
  },
);
