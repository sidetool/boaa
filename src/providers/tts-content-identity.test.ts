import { expect, it } from 'vitest';
import { TTSContentIdentity } from './tts-content-identity';
import type { Chapter, Novel } from '../domain/types';
const book = (revision: string, format = 'txt') => ({ id: 'b', activeContentRevisionId: revision, format }) as Novel;
const chapter = (id = 'a', hash = 'hash') => ({ id, textHash: hash, paragraphCount: 8 }) as Chapter;
it('preserves TXT playback and automatic chapter carry when another episode is appended', () => {
  const identity = new TTSContentIdentity();
  const first = identity.update(book('1'), chapter());
  expect(identity.update(book('2'), chapter())).toBe(first);
  expect(identity.update(book('2'), chapter('b', 'next'))).toBe(first);
  expect(identity.update(book('3'), chapter('b', 'changed'))).not.toBe(first);
});
it('fences book changes and non-TXT semantic revisions', () => {
  const identity = new TTSContentIdentity();
  const first = identity.update(book('1', 'epub'), chapter());
  expect(identity.update(book('2', 'epub'), chapter())).not.toBe(first);
  const before = identity.update(book('1'), chapter());
  expect(identity.update({ ...book('1'), id: 'other' }, chapter())).not.toBe(before);
});
