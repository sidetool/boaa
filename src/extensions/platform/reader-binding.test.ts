import { expect, it, vi } from 'vitest';
import { ReaderBindings, matchesReaderBinding } from './reader-binding';
import type { Installation } from './store-model';
const row = {
  pluginId: 'org.test.hold',
  installationId: 'a',
  revision: 1,
  active: 'digest',
  enabled: true,
  tombstone: false,
  manifest: { entries: { controller: { permissions: ['reader.input'] } }, contributes: { commands: ['hold'] } },
} as unknown as Installation;
function persistence(key = 'alice') {
  const values = new Map<string, string>();
  return {
    storage: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
      removeItem: (k: string) => {
        values.delete(k);
      },
    } as Storage,
    key,
    window: new EventTarget() as unknown as Window,
  };
}
it('requires an explicit host selection, persists only in the selected scope and rejects updated installations', () => {
  const p = persistence(),
    one = new ReaderBindings(p),
    other = new ReaderBindings({ ...p, key: 'bob' });
  expect(one.get()).toBeUndefined();
  one.select(row, 'hold', 'keyboard');
  const reloaded = new ReaderBindings(p);
  expect(reloaded.get()).toEqual(one.get());
  expect(other.get()).toBeUndefined();
  expect(matchesReaderBinding({ ...row, revision: 2 }, one.get()!)).toBe(false);
  expect(matchesReaderBinding({ ...row, installationId: 'new' }, one.get()!)).toBe(false);
  expect(matchesReaderBinding({ ...row, active: 'new' }, one.get()!)).toBe(false);
  const changed = vi.fn();
  one.subscribe(changed);
  one.clear();
  expect(changed).toHaveBeenCalledOnce();
  one.close();
  other.close();
  reloaded.close();
});
it('malformed persisted bindings stay disabled and storage failure does not partially enable a binding', () => {
  const p = persistence();
  p.storage.setItem(p.key, '{"edge":"right"}');
  const bindings = new ReaderBindings(p);
  expect(bindings.get()).toBeUndefined();
  vi.spyOn(p.storage, 'setItem').mockImplementation(() => {
    throw Error('quota');
  });
  expect(() => bindings.select(row, 'hold', 'right')).toThrow('quota');
  expect(bindings.get()).toBeUndefined();
  bindings.close();
});
