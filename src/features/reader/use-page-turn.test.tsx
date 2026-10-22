import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePageTurn } from './use-page-turn';

const curl = vi.hoisted(() => ({
  width: 400,
  height: 700,
  top: 0,
  ready: undefined as Promise<void> | undefined,
  activate: vi.fn(),
  draw: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('./page-curl-renderer', () => ({ createPageCurl: () => curl }));

describe('page turn ownership', () => {
  let renderer: ReactTestRenderer;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    curl.ready = undefined;
    vi.stubGlobal('performance', { now: () => Date.now() });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) =>
      setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function harness(options: { manualReady?: boolean; rtl?: boolean; curl?: boolean } = {}) {
    let previewMounted = false;
    let resolve!: (value: string | undefined) => void;
    const prepare = vi.fn(
      (_direction: number, _signal: AbortSignal) =>
        new Promise<string | undefined>((done) => {
          resolve = done;
        }),
    );
    const commit = vi.fn();
    const error = vi.fn();
    const stage = {
      current: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        clientWidth: 400,
        querySelector: () => (previewMounted ? {} : null),
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, height: 700 }),
        dataset: {},
        style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      } as unknown as HTMLElement,
    };
    let turn!: ReturnType<typeof usePageTurn<string>>;
    function Harness({ scope = 'a', position = 0 }: { scope?: string; position?: number }) {
      turn = usePageTurn({ stage, enabled: true, scope, position, prepare, commit, error, ...options });
      previewMounted = turn.preview !== undefined;
      return null;
    }
    act(() => {
      renderer = create(<Harness />);
    });
    return {
      get turn() {
        return turn;
      },
      prepare,
      commit,
      error,
      stage,
      resolve: async (value = 'next') => {
        await act(async () => {
          resolve(value);
        });
      },
      rerender: (scope: string, position = 0) =>
        act(() => renderer.update(<Harness scope={scope} position={position} />)),
    };
  }
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('waits for snapshot decoding before activation or a released turn can commit', async () => {
    let decode!: () => void;
    curl.ready = new Promise<void>((resolve) => {
      decode = resolve;
    });
    const h = harness({ curl: true });
    act(() => {
      h.turn.turn(1);
    });
    await h.resolve();
    await advance(1000);
    expect(curl.activate).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    await act(async () => {
      decode();
    });
    expect(curl.activate).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(h.commit).toHaveBeenCalledExactlyOnceWith('next');
    expect(h.turn.active).toBe(false);
  });

  it.each(['cancel', 'scope', 'timeout', 'failure'] as const)(
    'drops snapshot decode after %s and preserves navigation',
    async (reason) => {
      let decode!: () => void;
      let reject!: (error: Error) => void;
      curl.ready = new Promise<void>((resolve, fail) => {
        decode = resolve;
        reject = fail;
      });
      const h = harness({ curl: true });
      act(() => {
        h.turn.turn(1);
      });
      await h.resolve();
      if (reason === 'cancel') act(() => h.turn.cancel());
      if (reason === 'scope') h.rerender('other');
      if (reason === 'timeout') await advance(15_001);
      if (reason === 'failure')
        await act(async () => {
          reject(new Error('snapshot decode failed'));
        });
      await act(async () => {
        decode();
      });
      await advance(1000);
      expect(curl.activate).not.toHaveBeenCalled();
      expect(h.commit).not.toHaveBeenCalled();
      expect(curl.destroy).toHaveBeenCalledTimes(1);
      expect(h.turn.active).toBe(false);
      expect(h.error).toHaveBeenCalledTimes(reason === 'failure' || reason === 'timeout' ? 1 : 0);
    },
  );

  it.each(['decode', 'timeout', 'scope', 'prepare'] as const)(
    'consumes the rest of a claimed gesture after %s failure, allowing only an explicit retry',
    async (failure) => {
      let reject!: (error: Error) => void;
      curl.ready = new Promise<void>((_, fail) => {
        reject = fail;
      });
      const h = harness({ curl: true });
      act(() => {
        h.turn.down(1, 350, 350);
        expect(h.turn.move(1, 150, 350)).toBe(true);
      });
      await h.resolve();
      if (failure === 'decode')
        await act(async () => {
          reject(new Error('decode failed'));
        });
      if (failure === 'timeout') await advance(15_001);
      if (failure === 'scope') h.rerender('new-scope');
      if (failure === 'prepare') act(() => h.turn.fail(new Error('preview failed')));
      expect(h.turn.active).toBe(false);
      act(() => {
        expect(h.turn.move(1, 140, 350)).toBe(true);
        expect(h.turn.up(1, 140)).toBe(true);
      });
      await advance(700);
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.commit).not.toHaveBeenCalled();
      curl.ready = undefined;
      act(() => {
        expect(h.turn.turn(1)).toBe(true);
      });
      await h.resolve();
      await advance(700);
      expect(h.commit).toHaveBeenCalledExactlyOnceWith('next');
    },
  );

  it('keeps the current page until the preview is decoded and commits once despite repeated turns', async () => {
    const h = harness({ manualReady: true });
    act(() => {
      expect(h.turn.turn(1)).toBe(true);
      expect(h.turn.turn(1)).toBe(false);
    });
    await h.resolve();
    await advance(1000);
    expect(h.commit).not.toHaveBeenCalled();
    act(() => h.turn.ready());
    await advance(400);
    expect(h.commit).toHaveBeenCalledExactlyOnceWith('next');
    expect(h.turn.active).toBe(false);
  });

  it('keeps curl ownership while preparing instead of briefly applying flat-page transforms', async () => {
    const h = harness({ curl: true });
    act(() => {
      h.turn.down(1, 350, 350);
      h.turn.move(1, 200, 350);
    });
    await advance(20);
    expect(h.stage.current.dataset.turnRenderer).toBe('curl');
    expect(curl.draw).not.toHaveBeenCalled();
    act(() => h.turn.cancel());
    expect(h.stage.current.dataset.turnRenderer).toBeUndefined();
    await h.resolve();
    expect(curl.draw).not.toHaveBeenCalled();
  });

  it('paints a newly mounted curl preview without requiring another pointer movement', async () => {
    const h = harness({ curl: true });
    act(() => {
      h.turn.down(1, 350, 350);
      h.turn.move(1, 190, 350);
    });
    await advance(20);
    expect(curl.draw).not.toHaveBeenCalled();
    await h.resolve();
    expect(curl.draw.mock.lastCall?.[0]).toBeCloseTo(0.2);
    expect(h.commit).not.toHaveBeenCalled();
  });
  it('discards late preparation after a document or position change', async () => {
    const h = harness();
    act(() => {
      h.turn.turn(1);
    });
    const signal = h.prepare.mock.calls[0][1];
    h.rerender('b', 4);
    expect(signal.aborted).toBe(true);
    await h.resolve();
    await advance(500);
    expect(h.turn.preview).toBeUndefined();
    expect(h.commit).not.toHaveBeenCalled();
  });
  it('returns a cancelled drag without changing reading position', async () => {
    const h = harness();
    act(() => {
      h.turn.down(1, 350, 20);
      h.turn.move(1, 200, 20);
    });
    await h.resolve();
    act(() => {
      expect(h.turn.up(1, 200, true)).toBe(true);
    });
    await advance(500);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.turn.active).toBe(false);
  });
  it('maps RTL dragging to logical next and keeps the committed preview during position replacement', async () => {
    const h = harness({ rtl: true });
    h.commit.mockImplementation(() => h.rerender('a', 1));
    act(() => {
      h.turn.down(2, 50, 20);
      expect(h.turn.move(2, 200, 20)).toBe(true);
    });
    expect(h.prepare.mock.calls[0][0]).toBe(1);
    await h.resolve();
    act(() => {
      h.turn.up(2, 200);
    });
    await advance(500);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.turn.active).toBe(false);
  });
  it('cancels a pending release on blur and never commits its late response', async () => {
    const h = harness();
    act(() => {
      h.turn.turn(1);
    });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await h.resolve();
    await advance(500);
    expect(h.commit).not.toHaveBeenCalled();
  });
  it('does not revive a preview that finishes while a cancelled drag returns', async () => {
    const h = harness();
    act(() => {
      h.turn.down(1, 350, 20);
      h.turn.move(1, 200, 20);
      h.turn.up(1, 200, true);
    });
    expect(h.prepare.mock.calls[0][1].aborted).toBe(true);
    await h.resolve();
    expect(h.turn.preview).toBeUndefined();
    await advance(500);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.turn.active).toBe(false);
  });

  it('animates a curl tap through intermediate shapes before committing exactly once', async () => {
    const h = harness({ curl: true });
    act(() => {
      h.turn.turn(1);
    });
    await h.resolve();
    await advance(200);
    expect(h.commit).not.toHaveBeenCalled();
    expect(curl.draw.mock.calls.some(([progress]) => progress > 0 && progress < 1)).toBe(true);
    await advance(500);
    expect(h.commit).toHaveBeenCalledExactlyOnceWith('next');
    expect(curl.destroy).toHaveBeenCalledOnce();
    expect(h.turn.active).toBe(false);
  });

  it.each([false, true])('tracks incoming and outgoing curl travel independently (RTL %s)', async (rtl) => {
    const h = harness({ curl: true, rtl });
    const sign = rtl ? -1 : 1;
    for (const direction of [1, -1] as const) {
      const end = 200 - 140 * direction * sign;
      act(() => {
        h.turn.down(1, 200, 350);
        h.turn.move(1, end, 350);
      });
      expect(h.prepare.mock.lastCall?.[0]).toBe(direction);
      await h.resolve();
      await advance(20);
      expect(curl.draw.mock.lastCall?.[0]).toBeCloseTo(direction === 1 ? 0.175 : 0.35);
      act(() => {
        h.turn.up(1, end, true);
      });
      await advance(600);
    }
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('removes a curling copy on document replacement and never commits the old turn', async () => {
    const h = harness({ curl: true });
    act(() => {
      h.turn.turn(1);
    });
    await h.resolve();
    await advance(180);
    h.rerender('another-document');
    const draws = curl.draw.mock.calls.length;
    await advance(600);
    expect(curl.destroy).toHaveBeenCalledOnce();
    expect(curl.draw.mock.calls).toHaveLength(draws);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('keeps a decoded backward sheet owned while held at and across the endpoint for longer than preparation timeout', async () => {
    const h = harness({ curl: true });
    act(() => {
      h.turn.down(1, 0, 550);
      h.turn.move(1, 380, 550);
    });
    await h.resolve('previous');
    for (const x of [380, 420, 360, 430, 380, 440]) {
      act(() => {
        h.turn.move(1, x, 550);
      });
      await advance(3500);
      expect(h.turn.active).toBe(true);
      expect(h.turn.preview).toBe('previous');
      expect(h.commit).not.toHaveBeenCalled();
      expect(curl.destroy).not.toHaveBeenCalled();
    }
    act(() => {
      h.turn.up(1, 440, true);
    });
    await advance(700);
    expect(h.commit).not.toHaveBeenCalled();
    expect(curl.destroy).toHaveBeenCalledOnce();
    expect(h.turn.active).toBe(false);
  });

  it('ignores late image decode readiness after a pending curl drag was cancelled', async () => {
    const h = harness({ curl: true, manualReady: true });
    act(() => {
      h.turn.down(1, 350, 20);
      h.turn.move(1, 200, 20);
    });
    await h.resolve();
    act(() => {
      h.turn.up(1, 200, true);
      h.turn.ready();
    });
    await advance(600);
    expect(curl.draw).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.turn.active).toBe(false);
  });
});
