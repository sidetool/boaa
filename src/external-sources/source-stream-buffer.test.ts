import { describe, it, expect, vi } from 'vitest';
import { SourceStreamBuffer } from './source-stream-buffer';
function fixture() {
  const sessions: {
    close: ReturnType<typeof vi.fn>;
    loadPage: ReturnType<typeof vi.fn>;
    invalidatePage: ReturnType<typeof vi.fn>;
  }[] = [];
  const port = {
    open: vi.fn(async () => {
      const session = {
        pageCount: 20,
        close: vi.fn(),
        invalidatePage: vi.fn(),
        loadPage: vi.fn(async () => new Blob(['page'])),
      };
      sessions.push(session);
      return session;
    }),
  };
  return { port, sessions, buffer: new SourceStreamBuffer(port), signal: new AbortController().signal };
}
describe('stream episode buffer', () => {
  it('discards a rejected page without dropping prepared neighbors and invalidates the backend cache', async () => {
    const invalidatePage = vi.fn();
    const loadPage = vi.fn(async (index: number) => new Blob([String(index)]));
    const buffer = new SourceStreamBuffer({
      open: async () => ({ pageCount: 2, loadPage, invalidatePage, close: vi.fn() }),
    });
    const signal = new AbortController().signal;
    try {
      const session = await buffer.open('episode', signal);
      const old = await session.loadPage(0, signal);
      const neighbor = await session.loadPage(1, signal);
      session.invalidatePage?.(0);
      expect(invalidatePage).toHaveBeenCalledWith(0);
      expect(await session.loadPage(0, signal)).not.toBe(old);
      expect(await session.loadPage(1, signal)).toBe(neighbor);
      expect(loadPage).toHaveBeenCalledTimes(3);
    } finally {
      buffer.close();
    }
  });
  it('reuses the prepared next session and bytes when it becomes the current episode', async () => {
    const f = fixture();
    const first = await f.buffer.open('first', f.signal);
    const next = await f.buffer.open('next', f.signal);
    const blob = await next.loadPage(0, f.signal);
    expect(await f.buffer.open('next', f.signal)).toBe(next);
    expect(await next.loadPage(0, f.signal)).toBe(blob);
    expect(f.sessions[1].loadPage).toHaveBeenCalledTimes(1);
    f.buffer.retain(['next']);
    expect(f.sessions[0].close).toHaveBeenCalledOnce();
    await expect(first.loadPage(0, f.signal)).rejects.toThrow();
    f.buffer.close();
    expect(f.sessions[1].close).toHaveBeenCalledOnce();
  });
  it('bounds cached pages and does not retain a whole episode', async () => {
    const f = fixture(),
      session = await f.buffer.open('book', f.signal);
    for (let i = 0; i < 20; i++) await session.loadPage(i, f.signal);
    await session.loadPage(19, f.signal);
    expect(f.sessions[0].loadPage).toHaveBeenCalledTimes(20);
    await session.loadPage(0, f.signal);
    expect(f.sessions[0].loadPage).toHaveBeenCalledTimes(21);
    f.buffer.close();
  });
  it('renews expired connections transparently and retries the requested page', async () => {
    const f = fixture(),
      session = await f.buffer.open('book', f.signal);
    f.sessions[0].loadPage.mockRejectedValueOnce(new Error('source_stream_expired'));
    expect((await session.loadPage(4, f.signal)).size).toBe(4);
    expect(f.port.open).toHaveBeenCalledTimes(2);
    expect(f.sessions[0].close).toHaveBeenCalledOnce();
    expect(f.sessions[1].loadPage).toHaveBeenCalledWith(4, expect.any(AbortSignal));
    f.buffer.close();
  });
  it('keeps an image retry fresh even when its stream session has expired', async () => {
    const f = fixture();
    try {
      const session = await f.buffer.open('book', f.signal);
      await session.loadPage(0, f.signal);
      session.invalidatePage?.(0);
      f.sessions[0].loadPage.mockRejectedValueOnce(new Error('source_stream_expired'));
      await session.loadPage(0, f.signal);
      expect(f.sessions[1].invalidatePage).toHaveBeenCalledExactlyOnceWith(0);
      expect(f.sessions[1].loadPage).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    } finally {
      f.buffer.close();
    }
  });
  it('closes an opening session if cancellation arrives before it resolves', async () => {
    const f = fixture(),
      controller = new AbortController();
    const pending = f.buffer.open('book', controller.signal);
    await Promise.resolve(); // Allow the shared open to reach the port.
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(f.sessions[0].close).toHaveBeenCalledOnce();
    f.buffer.close();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('shares a delayed open and page fetch while cancelling each subscriber independently', async () => {
  const opening = deferred<void>();
  const page = deferred<Blob>();
  let openSignal!: AbortSignal, pageSignal!: AbortSignal;
  const raw = {
    pageCount: 2,
    close: vi.fn(),
    loadPage: vi.fn(async (_index: number, signal: AbortSignal) => {
      pageSignal = signal;
      return page.promise;
    }),
  };
  const port = {
    open: vi.fn(async (_id: string, signal: AbortSignal) => {
      openSignal = signal;
      await opening.promise;
      return raw;
    }),
  };
  const buffer = new SourceStreamBuffer(port);
  const prefetch = new AbortController(),
    foreground = new AbortController();
  const warm = buffer.open('next', prefetch.signal);
  const visible = buffer.open('next', foreground.signal);
  await Promise.resolve();
  expect(port.open).toHaveBeenCalledOnce();
  prefetch.abort();
  await expect(warm).rejects.toThrow();
  expect(openSignal.aborted).toBe(false);
  opening.resolve();
  const session = await visible;
  expect(raw.close).not.toHaveBeenCalled();
  const warmPageController = new AbortController();
  const warmPage = session.loadPage(0, warmPageController.signal);
  const visiblePage = session.loadPage(0, foreground.signal);
  await Promise.resolve();
  expect(raw.loadPage).toHaveBeenCalledOnce();
  warmPageController.abort();
  await expect(warmPage).rejects.toThrow();
  expect(pageSignal.aborted).toBe(false);
  const blob = new Blob(['same bytes']);
  page.resolve(blob);
  expect(await visiblePage).toBe(blob);
  expect(await session.loadPage(0, foreground.signal)).toBe(blob);
  buffer.close();
  expect(raw.close).toHaveBeenCalledOnce();
});

it('aborts shared page work after its last subscriber leaves and retries with fresh work', async () => {
  const f = fixture();
  const session = await f.buffer.open('episode', f.signal);
  const stale = deferred<Blob>();
  let shared!: AbortSignal;
  f.sessions[0].loadPage.mockImplementationOnce((_index: number, signal: AbortSignal) => {
    shared = signal;
    return stale.promise;
  });
  const first = new AbortController(),
    second = new AbortController();
  const a = session.loadPage(0, first.signal),
    b = session.loadPage(0, second.signal);
  await Promise.resolve();
  first.abort();
  second.abort();
  await Promise.all([expect(a).rejects.toThrow(), expect(b).rejects.toThrow()]);
  expect(shared.aborted).toBe(true);
  const fresh = await session.loadPage(0, f.signal);
  stale.resolve(new Blob(['late discarded bytes']));
  await Promise.resolve();
  expect(await session.loadPage(0, f.signal)).toBe(fresh);
  expect(f.sessions[0].loadPage).toHaveBeenCalledTimes(2);
  f.buffer.close();
});

it('invalidates a pending page without letting its late bytes replace a fresh retry', async () => {
  const f = fixture();
  const session = await f.buffer.open('episode', f.signal);
  const stale = deferred<Blob>();
  f.sessions[0].loadPage.mockReturnValueOnce(stale.promise);
  const pending = session.loadPage(0, f.signal);
  await Promise.resolve();
  session.invalidatePage?.(0);
  const fresh = await session.loadPage(0, f.signal);
  stale.resolve(new Blob(['invalid']));
  await expect(pending).rejects.toThrow();
  expect(await session.loadPage(0, f.signal)).toBe(fresh);
  expect(f.sessions[0].invalidatePage).toHaveBeenCalledExactlyOnceWith(0);
  f.buffer.close();
});

it('isolates pending opens across owners and closes late cancelled sessions exactly once', async () => {
  const delayed = deferred<void>();
  const raws: { pageCount: number; loadPage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  const port = {
    open: vi.fn(async () => {
      const raw = { pageCount: 1, loadPage: vi.fn(), close: vi.fn() };
      raws.push(raw);
      await delayed.promise;
      return raw;
    }),
  };
  const oldOwner = new SourceStreamBuffer(port),
    newOwner = new SourceStreamBuffer(port);
  const signal = new AbortController().signal;
  const old = oldOwner.open('same-id', signal);
  const next = newOwner.open('same-id', signal);
  await Promise.resolve();
  expect(port.open).toHaveBeenCalledTimes(2);
  oldOwner.close();
  await expect(old).rejects.toThrow();
  delayed.resolve();
  const session = await next;
  expect(raws[0].close).toHaveBeenCalledOnce();
  expect(raws[1].close).not.toHaveBeenCalled();
  expect(await newOwner.open('same-id', signal)).toBe(session);
  newOwner.close();
  expect(raws[1].close).toHaveBeenCalledOnce();
});

it('does not dispatch a queued page after invalidation before its shared task starts', async () => {
  const f = fixture();
  const session = await f.buffer.open('episode', f.signal);
  const old = session.loadPage(0, f.signal);
  session.invalidatePage?.(0);
  const fresh = session.loadPage(0, f.signal);
  await expect(old).rejects.toThrow('Page invalidated');
  expect(await fresh).toBeInstanceOf(Blob);
  expect(f.sessions[0].loadPage).toHaveBeenCalledOnce();
  f.buffer.close();
});

it('makes one upstream page request for simultaneous foreground and prefetch readers', async () => {
  const f = fixture();
  const session = await f.buffer.open('episode', f.signal);
  const delayed = deferred<Blob>();
  f.sessions[0].loadPage.mockReturnValue(delayed.promise);
  const first = session.loadPage(0, f.signal),
    second = session.loadPage(0, f.signal);
  await Promise.resolve();
  const calls = f.sessions[0].loadPage.mock.calls.length;
  const blob = new Blob(['shared']);
  delayed.resolve(blob);
  expect(await Promise.all([first, second])).toEqual([blob, blob]);
  f.buffer.close();
  expect(calls).toBe(1);
});

it('cancels every page subscriber when its session is released', async () => {
  const f = fixture();
  const session = await f.buffer.open('episode', f.signal);
  const delayed = deferred<Blob>();
  let shared!: AbortSignal;
  f.sessions[0].loadPage.mockImplementation((_index: number, signal: AbortSignal) => {
    shared = signal;
    return delayed.promise;
  });
  const first = session.loadPage(0, f.signal),
    second = session.loadPage(0, f.signal);
  await Promise.resolve();
  f.buffer.retain([]);
  await Promise.all([expect(first).rejects.toThrow(), expect(second).rejects.toThrow()]);
  expect(shared.aborted).toBe(true);
  expect(f.sessions[0].close).toHaveBeenCalledOnce();
  delayed.resolve(new Blob(['discarded']));
  await expect(session.loadPage(0, f.signal)).rejects.toThrow();
  f.buffer.close();
});
