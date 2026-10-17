import { migrateBrandStorage } from './brand-compat';
import { readBrandHeader } from './brand-compat';
import { describe, expect, it } from 'vitest';
import {
  brandEnvironment,
  isBrandValue,
  legacyBrandNames,
  normalizeBrandRecord,
  readBrandStorage,
  removeBrandStorage,
  writeBrandStorage,
} from './brand-compat';

function memory(entries: Record<string, string> = {}) {
  const rows = new Map(Object.entries(entries));
  return {
    rows,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: (key: string) => {
      rows.delete(key);
    },
  };
}

describe('BOAA legacy storage boundary', () => {
  it.each(['moya', 'noveldesk', 'moa'])('moves %s keys once without reviving stale settings', (prefix) => {
    const storage = memory({ [`${prefix}.preferences`]: '{"enabled":false}' });
    expect(readBrandStorage(storage, 'boaa.preferences')).toBe('{"enabled":false}');
    expect(storage.rows.has(`${prefix}.preferences`)).toBe(false);
    storage.setItem(`${prefix}.preferences`, 'stale');
    expect(readBrandStorage(storage, 'boaa.preferences')).toBe('{"enabled":false}');
  });
  it('preserves an explicit empty canonical value', () => {
    expect(readBrandStorage(memory({ 'boaa.token': '', 'noveldesk.token': 'old' }), 'boaa.token')).toBe('');
  });
  it('keeps the original readable when writes fail', () => {
    const storage = memory({ 'noveldesk.reader': 'original' });
    storage.setItem = () => {
      throw new Error('quota');
    };
    expect(readBrandStorage(storage, 'boaa.reader')).toBe('original');
    expect(storage.getItem('noveldesk.reader')).toBe('original');
    expect(storage.getItem('boaa.reader')).toBeNull();
  });
  it('clears aliases on logout or replacement', () => {
    const storage = memory({ 'moya.token': 'old', 'noveldesk.token': 'older' });
    writeBrandStorage(storage, 'boaa.token', 'new');
    expect([...storage.rows]).toEqual([['boaa.token', 'new']]);
    storage.setItem('noveldesk.token', 'old');
    removeBrandStorage(storage, 'boaa.token');
    expect(readBrandStorage(storage, 'boaa.token')).toBeNull();
  });
  it('migrates reserved nested configuration and built-in IDs without editing source IDs or user text', () => {
    const value = {
      _moyaIntegrations: { 'moya.ai': false },
      __moya_proxy_mode: 'default',
      extensionId: 'moya.ai',
      sourceId: 'org.moya.mangayomi.r123.s456',
      title: 'Moya notes',
      manifest: { packageFormat: 'moya.extension.package', execution: { kind: 'moya-js' }, engine: { moyaApi: 1 } },
    };
    expect(normalizeBrandRecord(value)).toEqual({
      _boaaIntegrations: { 'boaa.ai': false },
      __boaa_proxy_mode: 'default',
      extensionId: 'boaa.ai',
      sourceId: value.sourceId,
      title: value.title,
      manifest: { packageFormat: 'boaa.extension.package', execution: { kind: 'boaa-js' }, engine: { boaaApi: 1 } },
    });
    expect(value.extensionId).toBe('moya.ai');
  });
  it('honors canonical nested keys and avoids prototype mutation', () => {
    const input = JSON.parse('{"moya.ai":true,"boaa.ai":false,"__proto__":{"polluted":true}}');
    const next = normalizeBrandRecord(input);
    expect(next['boaa.ai']).toBe(false);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(Object.hasOwn(next, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('keeps crypto keys, blobs and typed data intact', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(normalizeBrandRecord(bytes)).toBe(bytes);
  });
  it('accepts old wire values while preserving strict unknown-value rejection', () => {
    expect(isBrandValue('moya-js', 'boaa-js')).toBe(true);
    expect(isBrandValue('untrusted-js', 'boaa-js')).toBe(false);
    expect(legacyBrandNames('neutral')).toEqual([]);
  });
});

describe('BOAA environment aliases', () => {
  it('uses the new value, including an explicitly empty secret', () => {
    expect(brandEnvironment({ BOAA_KEY: '', MOYA_KEY: 'old' }).BOAA_KEY).toBe('');
  });
  it.each(['MOYA', 'NOVELDESK', 'MOA'])('reads %s fallback without mutating the process environment', (prefix) => {
    const input = { [`${prefix}_KEY`]: 'legacy' };
    expect(brandEnvironment(input).BOAA_KEY).toBe('legacy');
    expect(input.BOAA_KEY).toBeUndefined();
  });
});

it('reads legacy protocol headers and honors an explicitly empty new header', () => {
  const headers = new Headers({ 'X-Moya-Frame-Revision': '42' });
  expect(readBrandHeader(headers, 'X-Boaa-Frame-Revision')).toBe('42');
  headers.set('X-Boaa-Frame-Revision', '');
  expect(readBrandHeader(headers, 'X-Boaa-Frame-Revision')).toBe('');
});

it('preserves the fixed comic profile identity even when it is a dictionary key', () => {
  const value = { profiles: { __moya_global_comic_profile__: { id: '__moya_global_comic_profile__' } } };
  expect(normalizeBrandRecord(value)).toEqual(value);
});

it('migrates a namespace without changing the bound origin or opaque scope suffix', () => {
  const scope = 'auth-session:v1:https://boaa.example:boaa-client';
  const storage = memory({ [`noveldesk:${scope}`]: 'synthetic-session' });
  expect(readBrandStorage(storage, `boaa:${scope}`)).toBe('synthetic-session');
  expect(storage.getItem(`noveldesk:${scope}`)).toBeNull();
  expect(storage.getItem(`boaa:${scope}`)).toBe('synthetic-session');
});

it('does not migrate or delete another origin when a neutral key contains a brand-like hostname', () => {
  const storage = memory({ 'reader:https://moya.example': 'unrelated account' });
  expect(readBrandStorage(storage, 'reader:https://boaa.example')).toBeNull();
  removeBrandStorage(storage, 'reader:https://boaa.example');
  expect(storage.getItem('reader:https://moya.example')).toBe('unrelated account');
});

it('keeps storage addressed by a fixed source identity while migrating host preference namespaces', () => {
  const storage = memory({ 'moya.external.example:reader': 'source state', 'noveldesk.theme': 'dark' });
  migrateBrandStorage({
    ...storage,
    get length() {
      return storage.rows.size;
    },
    key: (index) => [...storage.rows.keys()][index] ?? null,
  });
  expect(storage.getItem('moya.external.example:reader')).toBe('source state');
  expect(storage.getItem('boaa.theme')).toBe('dark');
  expect(storage.getItem('noveldesk.theme')).toBeNull();
});

it.each(['apk', 'mangayomi'])('preserves persisted %s source IDs and dictionary keys', (kind) => {
  const id = `moya.${kind}.${'a'.repeat(24)}.123`;
  const value = { id, sources: { [id]: { connectorId: id, sourceId: id } } };
  expect(normalizeBrandRecord(value)).toEqual(value);
});

it('discards retired UI rollout flags instead of migrating or reviving them', () => {
  const storage = memory({
    'moya.uiNext': '1',
    'noveldesk.uiNext': '1',
    'moa.uiNext': '1',
    'boaa.uiNext': '1',
    'moya.theme': 'dark',
  });
  migrateBrandStorage({
    ...storage,
    get length() {
      return storage.rows.size;
    },
    key: (index) => [...storage.rows.keys()][index] ?? null,
  });
  expect([...storage.rows]).toEqual([['boaa.theme', 'dark']]);
});

it('still renames non-identity host names inside the APK namespace', () => {
  expect(normalizeBrandRecord({ id: 'moya.apk.tools', 'moya.apk.debug': false })).toEqual({
    id: 'boaa.apk.tools',
    'boaa.apk.debug': false,
  });
});
