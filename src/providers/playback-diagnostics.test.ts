import { afterEach, expect, it, vi } from 'vitest';
import {
  PlaybackDiagnostics,
  playbackDiagnostics,
  startPlaybackDiagnostics,
  tracePlaybackWait,
} from './playback-diagnostics';
import { BrowserAudioSession } from './browser-audio-session';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps a bounded wake snapshot after later playback and excludes free-form data', () => {
  let now = 0;
  const trace = new PlaybackDiagnostics(
    () => now,
    () => false,
  );
  trace.record('sample');
  expect(trace.report()).toBeUndefined();
  trace.start({});
  trace.record('wait-start', { op: 1, stage: 3, privateText: 'secret', invalid: NaN } as never);
  const stop = trace.observeMedia(() => ({ time: 2.5, paused: true }));
  now = 120_000;
  trace.lifecycle('visible');
  stop();
  for (let i = 0; i < 1000; i++) trace.record('sample', { time: i });
  const report = JSON.parse(trace.report()!);
  expect(report.beforeWake.at(-1)).toMatchObject({
    event: 'media-snapshot',
    ms: 120_000,
    values: { time: 2.5, paused: true },
  });
  expect(report.recent).toHaveLength(256);
  expect(trace.report()).not.toMatch(/secret|privateText|invalid/);
});

it('observes the original success or error without retrying or exposing error contents', async () => {
  playbackDiagnostics.start({});
  const value = new Blob(['fixture']);
  const success = vi.fn(async () => value);
  await expect(tracePlaybackWait('savedAudio', success)).resolves.toBe(value);
  const error = Object.assign(new Error('private URL'), { status: 503 });
  const fail = vi.fn(async () => {
    throw error;
  });
  await expect(tracePlaybackWait('savedAudio', fail)).rejects.toBe(error);
  expect(success).toHaveBeenCalledTimes(1);
  expect(fail).toHaveBeenCalledTimes(1);
  expect(playbackDiagnostics.report()).not.toContain('private URL');
  expect(JSON.parse(playbackDiagnostics.report()!).recent.at(-1)).toMatchObject({
    event: 'wait-error',
    values: { status: 503, stage: 3 },
  });
});

it('captures actual media state before the visibility watchdog changes it', async () => {
  vi.useFakeTimers();
  const documentEvents = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  vi.stubGlobal('document', documentEvents);
  vi.stubGlobal('window', new EventTarget());
  startPlaybackDiagnostics({});
  const audio = {
    src: '',
    onended: null,
    onerror: null,
    currentTime: 3,
    duration: 10,
    paused: false,
    ended: false,
    readyState: 4,
    networkState: 1,
    play: vi.fn(async () => {
      audio.paused = false;
    }),
    pause: vi.fn(() => {
      audio.paused = true;
    }),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  };
  const session = new BrowserAudioSession(
    { createAudio: () => audio, createObjectUrl: () => 'blob:private', revokeObjectUrl: vi.fn() },
    true,
  );
  const played = session.playBlob(new Blob(['audio']));
  await Promise.resolve();
  audio.paused = true;
  documentEvents.visibilityState = 'visible';
  documentEvents.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve();
  expect(audio.paused).toBe(false);
  const report = JSON.parse(playbackDiagnostics.report()!);
  expect(report.beforeWake.at(-1)).toMatchObject({
    event: 'media-snapshot',
    values: { paused: true, time: 3, ready: 4 },
  });
  expect(report.recent.some((e: { event: string }) => e.event === 'recovery')).toBe(true);
  expect(playbackDiagnostics.report()).not.toContain('blob:private');
  session.stop();
  await played;
  expect(vi.getTimerCount()).toBe(0);
});
