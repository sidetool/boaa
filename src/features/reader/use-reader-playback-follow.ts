import { useCallback, useEffect, useRef, useState } from 'react';

/** Playback owns only its own scroll request. User navigation and narration continue independently. */
export function useReaderPlaybackFollow(
  active: boolean,
  index: number | undefined,
  seek: (target: string | number, behavior: ScrollBehavior, signal: AbortSignal) => Promise<unknown>,
) {
  const [detached, setDetached] = useState(false);
  const following = useRef(true);
  const latest = useRef<string | number>();
  const pending = useRef<AbortController>();
  const hiddenTarget = useRef(false);
  const current = useRef({ index, seek });
  current.current = { index, seek };

  const follow = useCallback(async (target: string | number, behavior: ScrollBehavior = 'smooth') => {
    latest.current = target;
    pending.current?.abort();
    if (document.visibilityState === 'hidden') {
      hiddenTarget.current = true;
      return false;
    }
    if (!following.current) return false;
    const request = new AbortController();
    pending.current = request;
    try {
      const result = await current.current.seek(target, behavior, request.signal);
      return result !== false && !request.signal.aborted;
    } catch {
      // A failed visual lookup must not interrupt the audio session.
      return false;
    } finally {
      if (pending.current === request) pending.current = undefined;
    }
  }, []);

  useEffect(() => {
    if (!active) {
      following.current = true;
      latest.current = undefined;
      hiddenTarget.current = false;
      setDetached(false);
      return;
    }
    let hiddenIndex = current.current.index;
    let interrupted = false;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenIndex = current.current.index;
        interrupted = Boolean(pending.current);
        pending.current?.abort();
      } else {
        // Native playback can advance its index in the background without a JS paragraph callback.
        let target = hiddenTarget.current || interrupted ? latest.current : undefined;
        if (!hiddenTarget.current && current.current.index !== hiddenIndex) target = current.current.index;
        interrupted = false;
        hiddenTarget.current = false;
        if (target !== undefined) void follow(target, 'auto');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      pending.current?.abort();
    };
  }, [active, follow]);

  const detach = () => {
    if (!active || !following.current) return;
    following.current = false;
    pending.current?.abort();
    setDetached(true);
  };
  const resume = () => {
    following.current = true;
    setDetached(false);
    const target = latest.current ?? current.current.index;
    if (target !== undefined) void follow(target, 'auto');
  };
  const isDetached = useCallback(() => !following.current, []);
  return { follow, detach, resume, detached, isDetached };
}
