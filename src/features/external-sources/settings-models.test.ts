import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useExternalSourceSettingsModel, type ExternalSourceSettingsModel } from './use-external-source-settings-model';
import {
  useSourceConnectionSettingsModel,
  type SourceConnectionSettingsModel,
} from './use-source-connection-settings-model';
import type { ExternalSourceController, ExternalSourceView } from './external-source-controller-contract';
afterEach(() => vi.unstubAllGlobals());
it('preserves favorites on write failure and applies independent metadata filters', async () => {
  const setItem = vi.fn(() => {
    throw new Error('quota');
  });
  vi.stubGlobal('localStorage', { getItem: () => '["source-0"]', setItem });
  const controller = {
    sources: Array.from({ length: 7 }, (_, index) => ({
      id: `source-${index}`,
      title: `Source ${index}`,
      origin: 'plugin',
      contentKind: index ? 'image' : 'text',
      lang: index ? 'en' : 'ko',
      connection: { state: 'connected' },
    })),
  } as unknown as ExternalSourceController;
  let model!: ExternalSourceSettingsModel;
  let renderer!: ReactTestRenderer;
  function Harness() {
    model = useExternalSourceSettingsModel(controller);
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  act(() => model.toggleFavorite('source-1'));
  expect(model.error).toBe(true);
  expect(model.favorites).toEqual(['source-0']);
  act(() => {
    model.setKind('text');
    model.setLanguage('ko');
    model.setState('favorite');
  });
  expect(model.filtered.map((source) => source.id)).toEqual(['source-0']);
  expect(model.languageOptions).toEqual(['*', 'en', 'ko', 'unknown']);
  act(() => renderer.unmount());
});
it('resets connection fields when the selected source changes and submits raw values', async () => {
  const controller = {
    connect: vi.fn(async () => undefined),
    activeSourceId: 'one',
    busy: false,
  } as unknown as ExternalSourceController;
  let source = {
    id: 'one',
    connection: { state: 'disconnected' },
    connectionForm: { fields: [{ id: 'endpoint', defaultValue: 'initial' }] },
  } as unknown as ExternalSourceView;
  let model!: SourceConnectionSettingsModel;
  let renderer!: ReactTestRenderer;
  function Harness() {
    model = useSourceConnectionSettingsModel(source, controller);
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  act(() => model.setValues({ endpoint: 'edited' }));
  await model.submitConnection();
  expect(controller.connect).toHaveBeenCalledWith({ endpoint: 'edited' });
  source = { ...source, id: 'two' as ExternalSourceView['id'] };
  act(() => renderer.update(createElement(Harness)));
  expect(model.values.endpoint).toBe('initial');
  expect(model.active).toBe(false);
  act(() => renderer.unmount());
});
