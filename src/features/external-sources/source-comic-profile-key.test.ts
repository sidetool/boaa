import { expect, it } from 'vitest';
import { persistentId128 } from '@boaa/text-core/hash';
import { sourceComicProfileKey } from './source-comic-profile-key';
import { serialCollectionKey } from './source-serial-item';
import { episode } from './source-command-test-fixtures';
it('shares a work profile across episodes and its saved series without crossing source accounts', () => {
  const first = episode('one'),
    next = episode('two');
  const key = sourceComicProfileKey(first, 'fallback');
  expect(sourceComicProfileKey(next, 'next')).toBe(key);
  expect(key).toBe(
    persistentId128('external_series', [
      serialCollectionKey({ ...first, collection: first.collection!, release: first.release! }),
    ]),
  );
  expect(sourceComicProfileKey({ ...next, key: { ...next.key, accountConnectionId: 'other' } }, 'fallback')).not.toBe(
    key,
  );
  expect(sourceComicProfileKey({ ...next, collection: undefined }, 'fallback')).toBe('fallback');
});
