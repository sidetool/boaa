import { vi } from 'vitest';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type {
  ExternalSourceController,
  ExternalSourceItemView,
  UseExternalSourceControllerOptions,
} from './external-source-controller-contract';
import type { SourceReleasePreference } from '../../external-sources/source-user-state';
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const sourceId = 'fixture.source' as ExtensionContributionId;
export const episode = (remoteId = 'one'): ExternalSourceItemView => ({
  key: { connectorId: sourceId, accountConnectionId: 'account', remoteId },
  kind: 'file',
  title: remoteId,
  importability: 'supported',
  selected: false,
  importState: 'available',
  release: { title: remoteId, chapterNumber: remoteId === 'one' ? 1 : 2 },
  collection: { remoteId: 'work', title: 'Synthetic work' },
});
export const visit = { source: episode().key, collectionRemoteId: 'work' } as SourceReleasePreference;
export function fixture() {
  let generation = 'one';
  let connected = true;
  const textPort = { kind: 'text' as const, open: vi.fn(async () => ({ text: 'synthetic body' })) };
  const state = {
    getCachePage: vi.fn(async () => undefined),
    saveCachePage: vi.fn(async () => {}),
    listLinks: vi.fn(async () => []),
  };
  const registry = {
    getSourceStream: vi.fn(() => textPort),
    getExternalSourceStatus: vi.fn(() => ({
      state: connected ? 'connected' : 'disconnected',
      accountConnectionId: 'account',
      connectionGeneration: generation,
    })),
    listExternalSource: vi.fn(async () => ({ items: [episode(), episode('two')] })),
  };
  const options = {
    registry,
    state,
    settingsScope: 'synthetic',
    extensionRevision: 0,
    hostContext: { brokers: { get: () => undefined } },
    notify: vi.fn(),
    listChapters: vi.fn(async () => []),
    getNovel: vi.fn(async () => undefined),
    downloadPolicy: { autoNext: true, nextCount: 1 },
  } as unknown as UseExternalSourceControllerOptions;
  return {
    options,
    registry,
    state,
    textPort,
    generation(value: string) {
      generation = value;
    },
    offline() {
      connected = false;
    },
  };
}
export type Streaming = ExternalSourceController['streaming'];
