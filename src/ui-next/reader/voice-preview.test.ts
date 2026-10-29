import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoicePreview } from './voice-preview';

const audio = vi.hoisted(() => ({
  stop: vi.fn(),
  playBlob: vi.fn(async (_blob: Blob) => true),
}));
vi.mock('../../providers/browser-audio-session', () => ({
  BrowserAudioSession: class {
    stop = audio.stop;
    playBlob = audio.playBlob;
  },
}));
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
/** A load whose replies are released by hand, so in-flight states can be observed. */
function loader() {
  const calls: { voiceId: string; signal: AbortSignal; resolve(blob: Blob): void }[] = [];
  const load = vi.fn(
    (voiceId: string, signal: AbortSignal) => new Promise<Blob>((resolve) => calls.push({ voiceId, signal, resolve })),
  );
  return { load, calls };
}
afterEach(() => vi.clearAllMocks());

describe('voice preview player', () => {
  it('requests only on play, stops the body first and plays once ready', async () => {
    const { load, calls } = loader();
    const before = vi.fn();
    const p = createVoicePreview(load, before);
    expect(load).not.toHaveBeenCalled();
    void p.play('job:s1:now:v1', 'r1|v1', 'v1');
    await flush();
    expect(before).toHaveBeenCalledTimes(1);
    expect(p.state).toEqual({ token: 'job:s1:now:v1', phase: 'loading' });
    calls[0].resolve(new Blob(['a']));
    await flush();
    expect(audio.playBlob).toHaveBeenCalledTimes(1);
    expect(p.state).toEqual({});
  });

  it('shares one request when the same voice is pressed on another row while loading', async () => {
    const { load, calls } = loader();
    const p = createVoicePreview(load);
    void p.play('job:s1:pick:v1', 'r1|v1', 'v1');
    await flush();
    void p.play('job:s2:pick:v1', 'r1|v1', 'v1');
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(calls[0].signal.aborted).toBe(false);
    expect(p.state.token).toBe('job:s2:pick:v1');
    calls[0].resolve(new Blob(['a']));
    await flush();
    expect(audio.playBlob).toHaveBeenCalledTimes(1);
    // Cached: replaying makes no request.
    void p.play('job:s3:now:v1', 'r1|v1', 'v1');
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(audio.playBlob).toHaveBeenCalledTimes(2);
  });

  it('aborts a request nobody waits for and ignores its late reply', async () => {
    const { load, calls } = loader();
    const p = createVoicePreview(load);
    void p.play('job:s1:now:v1', 'r1|v1', 'v1');
    await flush();
    // Another voice: the first request is dropped.
    void p.play('job:s1:pick:v2', 'r1|v2', 'v2');
    await flush();
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve(new Blob(['late']));
    await flush();
    expect(audio.playBlob).not.toHaveBeenCalled();
    // Pressing the loading button again cancels it.
    void p.play('job:s1:pick:v2', 'r1|v2', 'v2');
    await flush();
    expect(calls[1].signal.aborted).toBe(true);
    expect(p.state).toEqual({});
    // The late first reply was never cached.
    void p.play('job:s1:now:v1', 'r1|v1', 'v1');
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('stops only matching buttons, and reset drops pending requests and cached samples', async () => {
    const { load, calls } = loader();
    const p = createVoicePreview(load);
    void p.play('job-a:s1:now:v1', 'r1|v1', 'v1');
    await flush();
    p.stop((t) => t.startsWith('job-b:'));
    expect(p.state.token).toBe('job-a:s1:now:v1');
    p.reset();
    expect(calls[0].signal.aborted).toBe(true);
    expect(p.state).toEqual({});
    expect(audio.stop).toHaveBeenCalled();
  });

  it('keeps a bounded number of samples, evicting the least recently heard', async () => {
    const load = vi.fn(async () => new Blob(['x']));
    const p = createVoicePreview(load);
    for (let i = 0; i < 13; i++) await p.play(`t${i}`, `k${i}`, `v${i}`);
    expect(load).toHaveBeenCalledTimes(13);
    await p.play('again-12', 'k12', 'v12');
    expect(load).toHaveBeenCalledTimes(13);
    await p.play('again-0', 'k0', 'v0');
    expect(load).toHaveBeenCalledTimes(14);
  });

  it('sends nothing until the body has stopped, and reports a failing stop or a throwing request on the button', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const { load, calls } = loader();
      let release!: () => void;
      const before = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
      const p = createVoicePreview(load, before);
      void p.play('job:s1:now:v1', 'r1|v1', 'v1');
      await flush();
      expect(load).not.toHaveBeenCalled();
      release();
      await flush();
      expect(load).toHaveBeenCalledTimes(1);
      calls[0].resolve(new Blob(['a']));
      await flush();

      // The body cannot be stopped: no request, the error lands on the button.
      const failing = createVoicePreview(load, () => Promise.reject(new Error('본문 낭독을 멈추지 못했어요.')));
      await failing.play('job:s1:now:v2', 'r1|v2', 'v2');
      expect(load).toHaveBeenCalledTimes(1);
      expect(failing.state.error?.message).toBe('본문 낭독을 멈추지 못했어요.');

      // A request that throws synchronously, joined by a second row, then a stop that fails mid-wait.
      const throwing = createVoicePreview(() => {
        throw new Error('연결 없음');
      });
      await throwing.play('job:s1:now:v3', 'r1|v3', 'v3');
      expect(throwing.state.error).toEqual({ token: 'job:s1:now:v3', message: '연결 없음' });
      let fail!: (error: Error) => void;
      const slow = createVoicePreview(
        () => new Promise<Blob>((_, reject) => (fail = reject)),
        vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('멈추지 못했어요')),
      );
      void slow.play('job:s1:now:v4', 'r1|v4', 'v4');
      await flush();
      // Same voice on another row joins the request; its body stop then fails and lets go of it.
      void slow.play('job:s2:now:v4', 'r1|v4', 'v4');
      await flush();
      expect(slow.state.error).toEqual({ token: 'job:s2:now:v4', message: '멈추지 못했어요' });
      fail(new Error('늦은 실패'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('reports a failed sample on its own button', async () => {
    const p = createVoicePreview(async () => {
      throw new Error('요청 제한');
    });
    await p.play('job:s1:now:v1', 'r1|v1', 'v1');
    expect(p.state).toEqual({ error: { token: 'job:s1:now:v1', message: '요청 제한' } });
  });
});
