import { ReaderBindings } from './reader-binding';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ProductPluginSession } from './product-session';
import type { Installation, InstallReview, ConfigRow } from './store-model';
import { usePlatformPluginSettingsModel } from './use-platform-plugin-settings-model';
import {
  usePluginConfigEditorModel,
  usePluginJsonFieldModel,
  usePluginViewModel,
  usePluginReaderInputModel,
} from './use-platform-plugin-editor-models';

async function mount<T>(read: () => T) {
  let value!: T;
  let renderer!: ReactTestRenderer;
  function Harness() {
    value = read();
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  return {
    get current() {
      return value;
    },
    close: () => act(() => renderer.unmount()),
  };
}
function fixture() {
  const row = {
    pluginId: 'fixture.plugin',
    revision: 3,
    enabled: true,
    active: 'old',
    manifest: { entries: { controller: { permissions: ['settings.own'] } }, contributes: { connections: ['server'] } },
  } as unknown as Installation;
  const review = {
    pluginId: row.pluginId,
    digest: 'new',
    expectedRevision: 3,
    publisherChanged: false,
    sourceChanged: false,
    manifest: row.manifest,
  } as InstallReview;
  const store = {
    list: vi.fn(async () => [row, { ...row, pluginId: 'deleted', tombstone: true }]),
    inspectConfig: vi.fn(async () => undefined as ConfigRow | undefined),
    inspectRetained: vi.fn(async () => review),
    install: vi.fn(async () => {}),
    installWithMigration: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    writeHostConfig: vi.fn(async () => {}),
    unfinishedMarkers: vi.fn(async () => [] as { pluginId: string }[]),
    acknowledgeMarkers: vi.fn(async () => {}),
  };
  const service = {
    status: () => ({ faults: [], reader: { errors: { 'fixture.plugin': 'stopped' } } }),
    reconcile: vi.fn(async () => {}),
    settings: vi.fn(async () => {}),
  };
  const http = {
    retire: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    host: vi.fn(async () => {}),
    owner: vi.fn((row) => row),
  };
  const session = {
    store,
    service,
    http,
    signal: new AbortController().signal,
    off: false,
  } as unknown as ProductPluginSession;
  return { row, review, store, service, http, session };
}
it('approves the declared role grants together and leaves existing connections intact when migration is rejected', async () => {
  const { session, row, review, store, http } = fixture();
  const model = await mount(() => usePlatformPluginSettingsModel(session));
  expect(model.current.rows).toEqual([row]);
  expect(model.current.loading).toBe(false);
  expect(model.current.faults).toEqual([{ id: row.pluginId, code: 'stopped', revision: 0 }]);
  act(() => model.current.showReview(review));
  expect(model.current.grants).toEqual({ controller: ['settings.own'] });
  expect(model.current.preserve).toBe(true);
  store.inspectConfig.mockResolvedValueOnce({ value: {} } as ConfigRow);
  await expect(model.current.approve()).rejects.toMatchObject({ code: 'migration_requires_disabled' });
  expect(store.installWithMigration).not.toHaveBeenCalled();
  expect(store.install).not.toHaveBeenCalled();
  expect(http.retire).not.toHaveBeenCalled();
  act(() => model.current.setPreserve(false));
  await act(async () => {
    await model.current.approve();
  });
  expect(store.install).toHaveBeenCalledWith(
    review,
    expect.objectContaining({ data: 'reset', roles: { controller: ['settings.own'] } }),
  );
  expect(model.current.review).toBeUndefined();
  expect(http.retire).toHaveBeenCalledWith(row);
  expect(store.install.mock.invocationCallOrder[0]).toBeLessThan(http.retire.mock.invocationCallOrder[0]);
  model.close();
});
it('rejects an outdated installation review before changing the installation or its connections', async () => {
  const f = fixture();
  const model = await mount(() => usePlatformPluginSettingsModel(f.session));
  act(() => model.current.showReview(f.review));
  f.store.list.mockResolvedValue([{ ...f.row, revision: 4 }]);
  await expect(model.current.approve()).rejects.toMatchObject({ code: 'review_stale' });
  expect(f.store.install).not.toHaveBeenCalled();
  expect(f.http.retire).not.toHaveBeenCalled();
  model.close();
});
it('does not revoke connections after rejected installation validation', async () => {
  const f = fixture();
  const model = await mount(() => usePlatformPluginSettingsModel(f.session));
  act(() => model.current.showReview(f.review));
  f.store.install.mockRejectedValueOnce(new Error('INSTALL_CONFLICT'));
  await expect(model.current.approve()).rejects.toThrow('INSTALL_CONFLICT');
  expect(f.http.retire).not.toHaveBeenCalled();
  expect(model.current.review).toBe(f.review);
  model.close();
});
it('ignores a review cancelled while installation preflight is pending', async () => {
  const f = fixture();
  const model = await mount(() => usePlatformPluginSettingsModel(f.session));
  act(() => model.current.showReview(f.review));
  let resolve!: (rows: Installation[]) => void;
  f.store.list.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const operation = model.current.approve();
  act(() => model.current.setReview(undefined));
  resolve([f.row]);
  await expect(operation).rejects.toMatchObject({ code: 'review_stale' });
  expect(f.store.install).not.toHaveBeenCalled();
  expect(f.http.retire).not.toHaveBeenCalled();
  model.close();
});
it.each([false, true])(
  'connects declared public services after commit, preserving credentials (own origin: %s)',
  async (ownOrigin) => {
    const f = fixture();
    const manifest = {
      ...f.review.manifest,
      entries: { controller: { path: 'dist/controller.js', permissions: ['http.request'] } },
      features: { required: ['http.request', ...(ownOrigin ? ['http.origin'] : [])], optional: [] },
      connections: [{ id: 'catalog', title: '작품 목록', endpoint: 'https://catalog.example/', methods: ['GET'] }],
    } as InstallReview['manifest'];
    Object.assign(f.review, { manifest });
    const installed = { ...f.row, revision: 4, active: 'new', manifest: f.review.manifest };
    f.store.install.mockImplementationOnce(async () => {
      f.store.list.mockResolvedValue([installed]);
    });
    const model = await mount(() => usePlatformPluginSettingsModel(f.session));
    act(() => model.current.showReview(f.review));
    await act(async () => {
      await model.current.approve();
    });
    expect(f.http.host).toHaveBeenCalledWith(
      'approve',
      installed,
      expect.objectContaining({
        slot: 'catalog',
        endpoint: 'https://catalog.example/',
        roles: ['controller'],
        methods: ['GET'],
        headers: ['accept', 'content-type', 'accept-language', ...(ownOrigin ? ['origin'] : [])],
        auth: { kind: 'none' },
        expectedRevision: null,
      }),
    );
    expect(f.store.install.mock.invocationCallOrder[0]).toBeLessThan(f.http.host.mock.invocationCallOrder[0]);
    model.close();
    const g = fixture();
    Object.assign(g.review, { manifest });
    g.store.install.mockImplementationOnce(async () => {
      g.store.list.mockResolvedValue([installed]);
    });
    g.http.list.mockResolvedValue([{ slot: 'catalog', authenticated: true }] as never);
    const other = await mount(() => usePlatformPluginSettingsModel(g.session));
    act(() => other.current.showReview(g.review));
    await act(async () => {
      await other.current.approve();
    });
    expect(g.http.host).not.toHaveBeenCalled();
    other.close();
  },
);
it('retains revoke failures as semantic errors after stopping the plugin', async () => {
  const { session, row, http, store, service } = fixture();
  http.retire.mockRejectedValueOnce(new Error('offline'));
  const model = await mount(() => usePlatformPluginSettingsModel(session));
  await act(async () => {
    model.current.toggle(row);
  });
  expect(store.disable).toHaveBeenCalledWith(row.pluginId, row.revision, undefined);
  expect(service.reconcile).toHaveBeenCalledOnce();
  expect(model.current.error?.code).toBe('disable_revoke_failed');
  expect(model.current.busy).toBe(false);
  model.close();
});
it('submits config revisions and leaves conflict errors available without acknowledging a save', async () => {
  const { session, row, store } = fixture();
  const config: ConfigRow = {
    scope: 'test',
    installationId: 'install',
    digest: 'old',
    revision: 7,
    schema: { version: 1, fields: { count: { type: 'number', default: 1 } } },
    value: { count: 1 },
  };
  const saved = vi.fn();
  const model = await mount(() => usePluginConfigEditorModel(session, row, config, saved));
  act(() => model.current.setValue({ count: 2 }));
  const cause = new Error('revision conflict');
  store.writeHostConfig.mockRejectedValueOnce(cause);
  await act(async () => {
    await model.current.save();
  });
  expect(store.writeHostConfig).toHaveBeenLastCalledWith(row.pluginId, row.revision, {
    schema: config.schema,
    expectedRevision: 7,
    value: { count: 2 },
  });
  expect(saved).not.toHaveBeenCalled();
  expect(model.current.error?.cause).toBe(cause);
  await act(async () => {
    await model.current.save();
  });
  expect(saved).toHaveBeenCalledOnce();
  model.close();
});
it('keeps invalid JSON as a draft without submitting it and aborts hosted views on unmount', async () => {
  const change = vi.fn();
  const json = await mount(() => usePluginJsonFieldModel([], change));
  act(() => {
    expect(json.current.changeText('[')).toBe(false);
  });
  expect(change).not.toHaveBeenCalled();
  expect(json.current.text).toBe('[');
  act(() => {
    expect(json.current.changeText('[1]')).toBe(true);
  });
  expect(change).toHaveBeenCalledWith([1]);
  json.close();
  const open = vi.fn(async () => {});
  const session = { views: { open } } as unknown as ProductPluginSession;
  const view = await mount(() => usePluginViewModel(session, 'fixture.plugin', 'settings'));
  const signal = (open.mock.calls[0] as unknown as [string, string, unknown, AbortSignal])[3];
  expect(signal.aborted).toBe(false);
  view.close();
  expect(signal.aborted).toBe(true);
});

it('binds input to the active installation revision and keeps unavailable commands as errors', async () => {
  const bindings = new ReaderBindings();
  const row = {
    ...fixture().row,
    scope: 'test',
    installationId: 'install',
    provenance: 'local-file',
    tombstone: false,
    manifest: { entries: { controller: { permissions: ['reader.input'] } }, contributes: { commands: ['hold'] } },
  } as unknown as Installation;
  const session = { bindings, off: false } as unknown as ProductPluginSession;
  const model = await mount(() => usePluginReaderInputModel(session, row));
  expect(model.current.available).toBe(true);
  act(() => model.current.selectCommand('hold'));
  expect(model.current.selected).toMatchObject({ command: 'hold', edge: 'right', revision: row.revision });
  act(() => model.current.selectEdge('keyboard'));
  expect(bindings.get()?.edge).toBe('keyboard');
  act(() => model.current.selectCommand('missing'));
  expect(model.current.error?.code).toBe('operation_failed');
  expect(bindings.get()?.command).toBe('hold');
  act(() => model.current.selectCommand(''));
  expect(bindings.get()).toBeUndefined();
  model.close();
});
it('offers marker recovery only for plugins with unfinished runtime work', async () => {
  const { session, row, store } = fixture();
  store.unfinishedMarkers.mockResolvedValue([{ pluginId: row.pluginId }]);
  const model = await mount(() => usePlatformPluginSettingsModel(session));
  expect([...model.current.recoveryIds]).toEqual([row.pluginId]);
  store.unfinishedMarkers.mockResolvedValue([]);
  await act(async () => {
    await model.current.acknowledge({ ...row, enabled: false });
  });
  expect(store.acknowledgeMarkers).toHaveBeenCalledWith(row.pluginId, row.revision);
  expect(model.current.recoveryIds.size).toBe(0);
  model.close();
});
