import { useCallback, useEffect, useRef, useState } from 'react';
import type { TTSAudiobookControls } from '../../features/tts/TTSAddonPanel';
import { BrowserAudioSession } from '../../providers/browser-audio-session';
import type { SavedAudiobook } from '../../providers/plain-audiobook';

export interface SavedPlaybackState {
  id: string;
  index: number;
  loading: boolean;
  paused: boolean;
}

/** Outcome of the last saved playback, shown on that audiobook's card. */
export interface SavedPlaybackNotice {
  id: string;
  text: string;
  error?: boolean;
}

type ItemsUpdate = (current: readonly SavedAudiobook[] | undefined) => readonly SavedAudiobook[] | undefined;

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message && error.name !== 'AbortError' ? error.message : fallback;

/**
 * Plays stored parts in order through one media element; nothing here asks an engine to synthesize.
 * The owner unmounts it (page closed, account or book changed) to stop playback and drop pending work.
 */
export function useSavedAudiobookPlayback(
  latest: { readonly current: TTSAudiobookControls },
  items: readonly SavedAudiobook[] | undefined,
  setItems: (update: ItemsUpdate) => void,
  onFinished: () => void,
) {
  const session = useRef<BrowserAudioSession>();
  const run = useRef<AbortController>();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [state, setState] = useState<SavedPlaybackState>();
  const [notice, setNotice] = useState<SavedPlaybackNotice>();
  const { rate, volume = 1 } = latest.current;

  // Position writes go one at a time and only the newest waits, so a slow save never rewinds a later one.
  const progress = useRef<{ next?: { id: string; index: number }; writing: boolean; closed: boolean }>({
    writing: false,
    closed: false,
  });
  const saveProgress = useCallback(
    (id: string, index: number) => {
      const queue = progress.current;
      queue.next = { id, index };
      if (queue.writing) return;
      queue.writing = true;
      void (async () => {
        while (queue.next && !queue.closed) {
          const { id: target, index: at } = queue.next;
          queue.next = undefined;
          await latest.current.port.progress(target, at).catch(() => undefined);
        }
        queue.writing = false;
      })();
    },
    [latest],
  );

  useEffect(() => {
    session.current?.setPlaybackRate(rate);
  }, [rate]);
  useEffect(() => {
    session.current?.setVolume(volume);
  }, [volume]);

  const stop = useCallback(() => {
    run.current?.abort();
    run.current = undefined;
    session.current?.stop(false);
    setState(undefined);
  }, []);
  useEffect(() => {
    const queue = progress.current;
    queue.closed = false;
    return () => {
      // The last started part is already queued; nothing new is written after the owner goes away.
      queue.closed = true;
      stop();
    };
  }, [stop]);

  const play = useCallback(
    (book: SavedAudiobook, start: number) => {
      run.current?.abort();
      const current = new AbortController();
      run.current = current;
      const { signal } = current;
      const find = () => itemsRef.current?.find((item) => item.id === book.id) ?? book;
      setNotice(undefined);
      setState({ id: book.id, index: start, loading: true, paused: false });
      void (async () => {
        try {
          session.current?.stop(false);
          await latest.current.beforePlayback();
          if (signal.aborted) return;
          const audio = (session.current ??= new BrowserAudioSession());
          audio.setPlaybackRate(latest.current.rate);
          audio.setVolume(latest.current.volume ?? 1);
          const fetchPart = (index: number) => latest.current.port.audio(book.id, index, signal);
          let index = Math.max(0, start);
          let next: Promise<Blob> | undefined;
          while (!signal.aborted) {
            // Parts become playable as the server finishes them; stop at the edge instead of asking for more.
            if (index >= find().completedItems) {
              setNotice({
                id: book.id,
                text:
                  index >= find().itemCount
                    ? '끝까지 들었어요.'
                    : '여기까지 만들어졌어요. 생성이 더 진행되면 이어서 들을 수 있어요.',
              });
              break;
            }
            setState({ id: book.id, index, loading: true, paused: false });
            const blob = await (next ?? fetchPart(index));
            next = index + 1 < find().completedItems ? fetchPart(index + 1) : undefined;
            next?.catch(() => undefined);
            if (signal.aborted) return;
            setState({ id: book.id, index, loading: false, paused: false });
            const at = index;
            setItems((list) => list?.map((item) => (item.id === book.id ? { ...item, playbackIndex: at } : item)));
            saveProgress(book.id, at);
            const played = await audio.playBlob(blob);
            if (signal.aborted) return;
            if (!played) throw new Error('저장된 음성을 재생하지 못했어요.');
            index += 1;
          }
          if (signal.aborted) return;
          run.current = undefined;
          setState(undefined);
          onFinished();
        } catch (error) {
          if (signal.aborted) return;
          run.current = undefined;
          session.current?.stop(false);
          setState(undefined);
          setNotice({ id: book.id, text: errorText(error, '저장된 음성을 불러오지 못했어요.'), error: true });
        }
      })();
    },
    [latest, onFinished, saveProgress, setItems],
  );

  const pause = useCallback(() => {
    session.current?.pause();
    setState((current) => current && { ...current, paused: true });
  }, []);
  const resume = useCallback(() => {
    void session.current?.resume().then((ok) => {
      if (ok) setState((current) => current && { ...current, paused: false });
    });
  }, []);

  return { state, notice, play, pause, resume, stop };
}
