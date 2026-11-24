import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useReaderPlaybackFollow } from './use-reader-playback-follow';

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function setup(seek: Parameters<typeof useReaderPlaybackFollow>[2]) {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', doc);
  let follow!: ReturnType<typeof useReaderPlaybackFollow>;
  function Harness({ active, index }: { active: boolean; index: number }) {
    follow = useReaderPlaybackFollow(active, index, seek);
    return null;
  }
  const render = (active: boolean, index: number) => <Harness active={active} index={index} />;
  act(() => {
    renderer = create(render(true, 0));
  });
  return {
    get controls() {
      return follow;
    },
    update(active: boolean, index: number) {
      act(() => renderer.update(render(active, index)));
    },
    visibility(value: string) {
      act(() => {
        doc.visibilityState = value;
        doc.dispatchEvent(new Event('visibilitychange'));
      });
    },
  };
}

it('cancels a pending visual jump on manual input and returns only to the latest narrated paragraph', async () => {
  let resolve!: () => void;
  const seek = vi.fn(
    (_target: string | number, _behavior: ScrollBehavior, _signal: AbortSignal) =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const h = setup(seek);
  const first = h.controls.follow('p1');
  act(() => h.controls.detach());
  expect(h.controls.detached).toBe(true);
  expect(seek.mock.calls[0][2].aborted).toBe(true);
  resolve();
  await expect(first).resolves.toBe(false);
  await h.controls.follow('p2');
  h.visibility('hidden');
  await h.controls.follow('p3');
  h.visibility('visible');
  expect(seek).toHaveBeenCalledTimes(1);
  act(() => h.controls.resume());
  expect(seek).toHaveBeenLastCalledWith('p3', 'auto', expect.any(AbortSignal));
  expect(h.controls.detached).toBe(false);
  resolve();
});

it('catches up once on foreground return and starts a new session attached', async () => {
  const seek = vi.fn(async () => true);
  const h = setup(seek);
  h.visibility('hidden');
  await h.controls.follow('p1');
  await h.controls.follow('p2');
  expect(seek).not.toHaveBeenCalled();
  h.visibility('visible');
  expect(seek).toHaveBeenCalledExactlyOnceWith('p2', 'auto', expect.any(AbortSignal));
  h.visibility('hidden');
  h.update(true, 4);
  h.visibility('visible');
  expect(seek).toHaveBeenLastCalledWith(4, 'auto', expect.any(AbortSignal));
  act(() => h.controls.detach());
  h.update(false, 4);
  h.update(true, 0);
  await h.controls.follow('next');
  expect(seek).toHaveBeenLastCalledWith('next', 'smooth', expect.any(AbortSignal));
});
