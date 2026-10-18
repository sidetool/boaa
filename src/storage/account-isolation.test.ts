import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAccountReaderDb, resetReaderDbForTests } from './reader-database';
import { createDocumentTextStore } from './document-text-store';
import { createHostedTTSOfflineStore } from './hosted-tts-offline-cache';
import { createTTSDownloadStore } from './tts-download-store';
import { createBookEnrichmentStore } from './book-enrichment-store';
import { BOOK_ENRICHMENT_STORES } from './book-enrichment-schema';
import { transactionDone } from './indexeddb-transaction';
import {
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
  clearSourceMetadataCache,
  readSourceMetadataCacheUsage,
} from '../external-sources/local-state';
import { LibraryFolderLocalStateStore, resetLibraryFolderLocalStateForTests } from '../library-folders/local-state';
import { accountStorage } from './account-storage';
const scopeA = 'hosted-account:synthetic-A',
  scopeB = 'hosted-account:synthetic-B';
beforeEach(async () => {
  await resetReaderDbForTests();
  await resetExternalSourceLocalStateForTests();
  await resetLibraryFolderLocalStateForTests();
});
afterEach(async () => {
  await resetReaderDbForTests();
  await resetExternalSourceLocalStateForTests();
  await resetLibraryFolderLocalStateForTests();
});

it('isolates identical source IDs, credentials, crypto keys, caches and scoped retention', async () => {
  const a = new ExternalSourceLocalStateStore(scopeA),
    b = new ExternalSourceLocalStateStore(scopeB),
    legacy = new ExternalSourceLocalStateStore();
  const credential = (label: string) => ({
    id: 'same-credential',
    connectorId: 'fixture.source',
    accountConnectionId: 'same-connection',
    label,
    credentialEnvelope: `encrypted-${label}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  await legacy.saveCredential(credential('legacy'));
  expect(await b.getCredential('fixture.source')).toBeUndefined();
  await a.saveCredential(credential('A'));
  await b.saveCredential(credential('B'));
  expect((await a.getCredential('fixture.source'))?.label).toBe('A');
  expect((await b.getCredential('fixture.source'))?.label).toBe('B');
  expect(await a.getOrCreateCredentialKey()).not.toBe(await b.getOrCreateCredentialKey());
  const cache = {
    id: 'same-cache',
    connectorId: 'fixture.source',
    queryFingerprint: '{}',
    items: [],
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 100000).toISOString(),
    schemaVersion: 1 as const,
  };
  await a.saveCachePage(cache);
  await b.saveCachePage(cache);
  await clearSourceMetadataCache(scopeA);
  expect((await readSourceMetadataCacheUsage(scopeA)).entries).toBe(0);
  expect((await readSourceMetadataCacheUsage(scopeB)).entries).toBe(1);
  expect((await legacy.getCredential('fixture.source'))?.label).toBe('legacy');
});

it('isolates document recovery/search and audio blobs with identical book/revision/cache IDs', async () => {
  const da = createAccountReaderDb(scopeA),
    db = createAccountReaderDb(scopeB);
  const a = new (createDocumentTextStore(da).IndexedDbDocumentTextRepository)();
  const b = new (createDocumentTextStore(db).IndexedDbDocumentTextRepository)();
  const revision = {
    id: 'same-revision',
    bookId: 'same-book',
    pageIndex: 0,
    pageHash: 'same-hash',
    source: 'pdf_native' as const,
    engine: 'pdfjs',
    engineVersion: '5',
    status: 'ready' as const,
    qualityScore: 1,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const block = (text: string) => ({
    id: 'same-block',
    revisionId: revision.id,
    bookId: revision.bookId,
    pageIndex: 0,
    order: 0,
    role: 'paragraph' as const,
    text,
    normalizedText: text,
    quads: [],
    direction: 'ltr' as const,
  });
  await a.saveReadyPage(revision, [block('alpha')]);
  await b.saveReadyPage(revision, [block('beta')]);
  expect((await a.getBlocks(revision.id))[0].text).toBe('alpha');
  expect((await b.getBlocks(revision.id))[0].text).toBe('beta');
  expect(await b.search(revision.bookId, 'alpha')).toEqual([]);
  const ca = new (createHostedTTSOfflineStore(da).IndexedDbHostedTTSOfflineCache)();
  const cb = new (createHostedTTSOfflineStore(db).IndexedDbHostedTTSOfflineCache)();
  const audio = {
    bookId: 'same-book',
    chapterId: 'same-chapter',
    cacheKey: 'same-cache',
    renderSpecHash: 'same-render',
    contentRevisionId: 'same-revision',
  };
  await ca.put({ ...audio, blob: new Blob(['alpha'], { type: 'audio/mpeg' }) });
  await cb.put({ ...audio, blob: new Blob(['beta'], { type: 'audio/mpeg' }) });
  expect((await ca.status()).byteSize).toBe(5);
  expect((await cb.status()).byteSize).toBe(4);
});

it('keeps enrichment enumeration and download recovery inside the selected database', async () => {
  const da = createAccountReaderDb(scopeA),
    db = createAccountReaderDb(scopeB);
  for (const [open, value] of [
    [da, 'alpha'],
    [db, 'beta'],
  ] as const) {
    const database = await open();
    const tx = database.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readwrite');
    tx.objectStore(BOOK_ENRICHMENT_STORES.candidates).put({
      id: 'same',
      bookId: 'same-book',
      createdAt: '2026-01-01',
      value,
    });
    await transactionDone(tx);
  }
  expect((await createBookEnrichmentStore(da).listBookEnrichmentCandidates('same-book'))[0]).toHaveProperty(
    'value',
    'alpha',
  );
  expect((await createBookEnrichmentStore(db).listBookEnrichmentCandidates('same-book'))[0]).toHaveProperty(
    'value',
    'beta',
  );
  const a = new (createTTSDownloadStore(da).IndexedDbTTSDownloadRepository)();
  const b = new (createTTSDownloadStore(db).IndexedDbTTSDownloadRepository)();
  const job = await a.create({
    bookId: 'same-book',
    contentRevisionId: 'same-revision',
    chapterIds: ['same-chapter'],
    wholeBook: true,
  });
  await a.planItems(job.id, [{ chapterId: 'same-chapter', cacheKey: 'same-cache', renderSpecHash: 'same-render' }]);
  expect(await b.get(job.id)).toBeUndefined();
  expect(await b.recoverInterrupted()).toBe(0);
  expect(await a.interruptedRenderSpecHashes()).toEqual(['same-render']);
});

it('refuses disposed database owners and confines storage enumeration/deletion to one owner', async () => {
  const lifetime = new AbortController();
  const a = new ExternalSourceLocalStateStore(scopeA, lifetime.signal);
  const open = createAccountReaderDb(scopeA, lifetime.signal);
  await open();
  lifetime.abort();
  await expect(open()).rejects.toMatchObject({ name: 'AbortError' });
  await expect(a.getCredential('fixture.source')).rejects.toMatchObject({ name: 'AbortError' });
  const values = new Map<string, string>();
  const raw = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
    clear: () => values.clear(),
  } as Storage;
  raw.setItem('boaa.setting', 'legacy');
  const sa = accountStorage(raw, scopeA),
    sb = accountStorage(raw, scopeB);
  expect(sb.getItem('boaa.setting')).toBeNull();
  sa.setItem('boaa.setting', 'A');
  sb.setItem('boaa.setting', 'B');
  sa.clear();
  expect(sa.length).toBe(0);
  expect(sb.getItem('boaa.setting')).toBe('B');
  expect(raw.getItem('boaa.setting')).toBe('legacy');
});

it('isolates same-ID directory handles and clears only the selected owner', async () => {
  const a = new LibraryFolderLocalStateStore(scopeA),
    b = new LibraryFolderLocalStateStore(scopeB);
  await a.saveDirectoryHandle('same-folder', { kind: 'directory', name: 'alpha' } as FileSystemDirectoryHandle);
  await b.saveDirectoryHandle('same-folder', { kind: 'directory', name: 'beta' } as FileSystemDirectoryHandle);
  expect((await a.getDirectoryHandle('same-folder'))?.name).toBe('alpha');
  await a.clearDirectoryHandle('same-folder');
  expect(await a.getDirectoryHandle('same-folder')).toBeUndefined();
  expect((await b.getDirectoryHandle('same-folder'))?.name).toBe('beta');
});
