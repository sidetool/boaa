import { afterEach, expect, it, vi } from 'vitest';
import { ReaderPluginDecorationLayers } from '../../reader/plugin-decoration-layers';
import { ReaderDecorationRuntime, type PluginReaderContent, type DecorationPlan } from './reader-decoration-runtime';
const content: PluginReaderContent = {
  key: 'reader-a',
  bookId: 'a',
  chapterId: 'chapter',
  contentRevision: 'v1',
  theme: 'light',
  blocks: [{ id: 'p', text: 'hello', textHash: 'h' }],
};
const paint = {
  layers: [
    {
      id: 'ink',
      palette: { color: { color: '#123456' } },
      ranges: [{ paragraphId: 'p', start: 0, end: 2, styleId: 'color' }],
    },
  ],
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});
function setup(run: DecorationPlan['run']) {
  vi.useFakeTimers();
  const layers = new ReaderPluginDecorationLayers(() => {}),
    runtime = new ReaderDecorationRuntime(layers);
  cleanups.push(() => runtime.close());
  const plan: DecorationPlan = { id: 'test', key: 'config-1', configRevision: 1, run };
  runtime.refresh([plan]);
  runtime.update(content);
  return { layers, runtime, plan };
}
it('discards an old book result even when paragraph IDs and text are reused', async () => {
  let finish!: (v: typeof paint) => void;
  const run = vi
    .fn()
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    .mockResolvedValue(paint);
  const f = setup(run);
  await vi.advanceTimersByTimeAsync(50);
  const signal = run.mock.calls[0][1] as AbortSignal;
  f.runtime.update({ ...content, key: 'reader-b', bookId: 'b' });
  expect(signal.aborted).toBe(true);
  finish(paint);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.layers.getSnapshot('p')).toEqual([]);
  await vi.advanceTimersByTimeAsync(50);
  expect(run).toHaveBeenCalledTimes(2);
  expect(f.layers.getSnapshot('p')).toHaveLength(1);
});
it('clears changed settings, coalesces updates and ignores old config replies', async () => {
  let finish!: (v: typeof paint) => void;
  const run = vi
    .fn()
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    .mockResolvedValue(paint);
  const f = setup(run);
  await vi.advanceTimersByTimeAsync(50);
  f.runtime.refresh([{ ...f.plan, key: 'config-2' }]);
  f.runtime.refresh([{ ...f.plan, key: 'config-3' }]);
  finish(paint);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.layers.getSnapshot('p')).toEqual([]);
  await vi.advanceTimersByTimeAsync(50);
  expect(run).toHaveBeenCalledTimes(2);
  expect(f.runtime.status().errors).toEqual({});
  f.runtime.refresh([]);
  expect(f.layers.getSnapshot('p')).toEqual([]);
});
it('bounds bad results without retry loops and retains unrelated owners', async () => {
  const f = setup(async () => paint);
  f.runtime.refresh([
    f.plan,
    {
      ...f.plan,
      id: 'bad',
      run: async () => ({ layers: [{ id: 'evil', ranges: [], palette: { ink: { fontSize: 100 } } }] }),
    },
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.layers.getSnapshot('p')).toHaveLength(1);
  expect(f.runtime.status().errors.bad).toBe('INVALID_PLUGIN_DECORATION');
  f.runtime.invalidate('test');
  expect(f.layers.getSnapshot('p')).toEqual([]);
});
it('drops content and all pending effects on teardown or oversized input', async () => {
  let finish!: (v: typeof paint) => void;
  const f = setup(() => new Promise((resolve) => (finish = resolve)));
  await vi.advanceTimersByTimeAsync(50);
  f.runtime.update({ ...content, blocks: [{ id: 'p', text: 'a'.repeat(50000), textHash: 'h' }] });
  expect(f.runtime.status().errors.$reader).toBe('CONTENT_LIMIT');
  finish(paint);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.layers.getSnapshot('p')).toEqual([]);
  f.runtime.close();
  f.runtime.update(content);
  f.runtime.refresh([f.plan]);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.layers.getSnapshot('p')).toEqual([]);
});
