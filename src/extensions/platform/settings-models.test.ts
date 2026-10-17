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
  };
  const service = {
    status: () => ({ faults: [], reader: { errors: { 'fixture.plugin': 'stopped' } } }),
    reconcile: vi.fn(async () => {}),
    settings: vi.fn(async () => {}),
  };
  const http = { revoke: vi.fn(async () => {}) };
  const session = {
    store,
    service,
    http,
    signal: new AbortController().signal,
    off: false,
  } as unknown as ProductPluginSession;
  return { row, review, store, service, http, session };
}
it('keeps review grants explicit, filters deleted installations and prevents live config migration', async () => {
  const { session, row, review, store } = fixture();
  const model = await mount(() => usePlatformPluginSettingsModel(session));
  expect(model.current.rows).toEqual([row]);
  expect(model.current.loading).toBe(false);
  expect(model.current.faults).toEqual([{ id: row.pluginId, code: 'stopped', revision: 0 }]);
  act(() => model.current.showReview(review));
  expect(model.current.grants).toEqual({ controller: [] });
  expect(model.current.preserve).toBe(true);
  act(() => model.current.setPermission('controller', 'settings.own', true));
  store.inspectConfig.mockResolvedValueOnce({ value: {} } as ConfigRow);
  await expect(model.current.approve()).rejects.toMatchObject({ code: 'migration_requires_disabled' });
  expect(store.installWithMigration).not.toHaveBeenCalled();
  act(() => model.current.setPreserve(false));
  await act(async () => {
    await model.current.approve();
  });
  expect(store.install).toHaveBeenCalledWith(
    review,
    expect.objectContaining({ data: 'reset', roles: { controller: ['settings.own'] } }),
  );
  expect(model.current.review).toBeUndefined();
  model.close();
});
it('retains revoke failures as semantic errors after stopping the plugin', async () => {
  const { session, row, http, store, service } = fixture();
  http.revoke.mockRejectedValueOnce(new Error('offline'));
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
