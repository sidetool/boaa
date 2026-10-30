import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import PlaybackDiagnostics from './PlaybackDiagnostics';
import { playbackDiagnostics } from '../../providers/playback-diagnostics';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])('copies locally or supplies manual text when clipboard succeeds=%s', async (success) => {
  const report = '{"format":"fixture"}';
  vi.spyOn(playbackDiagnostics, 'report').mockReturnValue(report);
  const writeText = vi.fn(async () => {
    if (!success) throw Error('clipboard unavailable');
  });
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(<PlaybackDiagnostics />);
  });
  await act(async () => root.root.findByType('button').props.onClick());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(report);
  if (success) expect(root.root.findAllByType('textarea')).toHaveLength(0);
  else expect(root.root.findByType('textarea').props.value).toBe(report);
  act(() => root.unmount());
});
