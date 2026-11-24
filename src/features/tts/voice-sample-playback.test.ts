import { expect, it, vi } from 'vitest';
import { VoiceSamplePlayback } from './voice-sample-playback';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('aborts a superseded request and ignores the audio from a late synthesis', async () => {
  const audio = { playBlob: vi.fn(async () => true), stop: vi.fn() };
  const samples = new VoiceSamplePlayback(audio);
  const old = deferred<Blob>();
  let signal!: AbortSignal;
  const first = samples.play(async (request, playBlob) => {
    signal = request;
    return playBlob(await old.promise);
  });
  const replacement = new Blob(['second']);
  await samples.play((_signal, playBlob) => playBlob(replacement));
  expect(signal.aborted).toBe(true);
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  old.resolve(new Blob(['first']));
  await Promise.resolve();
  expect(audio.playBlob).toHaveBeenCalledExactlyOnceWith(replacement);
});

it('stops active audio and does not report the cancelled sample as completed', async () => {
  const active = deferred<boolean>();
  const audio = { playBlob: vi.fn(() => active.promise), stop: vi.fn() };
  const samples = new VoiceSamplePlayback(audio);
  const played = samples.play((_signal, playBlob) => playBlob(new Blob()));
  audio.stop.mockClear();
  samples.stop();
  active.resolve(true);
  await expect(played).rejects.toMatchObject({ name: 'AbortError' });
  expect(audio.stop).toHaveBeenCalledExactlyOnceWith(false);
});
