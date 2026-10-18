import { expect, it, vi } from 'vitest';
import { BookPlaybackCoordinator, deferChapterPlayback } from './book-playback-coordinator';
it('does not lose the next chapter when a render cancels the deferred callback', async () => {
  const coordinator = new BookPlaybackCoordinator();
  const start = vi.fn();
  const target = { bookId: 'b', chapterId: 'c', startIndex: 0 };
  coordinator.schedule(target);
  const cancel = deferChapterPlayback(coordinator, 'b', 'c', start);
  cancel();
  deferChapterPlayback(coordinator, 'b', 'c', start);
  await Promise.resolve();
  expect(start).toHaveBeenCalledExactlyOnceWith(target);
});
it('ignores cancelled/replaced continuation requests', async () => {
  const coordinator = new BookPlaybackCoordinator();
  const start = vi.fn();
  coordinator.schedule({ bookId: 'b', chapterId: 'c', startIndex: 0 });
  deferChapterPlayback(coordinator, 'b', 'c', start);
  coordinator.cancel();
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
});
