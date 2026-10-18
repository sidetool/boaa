import { requestPlainTTSWithRetry } from '../../providers/plain-tts-retry';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Paragraph, SpokenTextRule, TTSPlaybackSettings } from '../../domain/types';
import {
  plainTTSParagraphHash,
  PLAIN_TTS_SAMPLE,
  type PlainTTSRequest,
  type PlainTTSVoices,
} from '../../providers/plain-tts';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { PlayableTtsSegment } from '../../providers/tts-playback';
import type { TTSProvider } from '../../providers/tts';
import { BrowserAudioSession } from '../../providers/browser-audio-session';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import type { useTTSExecutionController } from './useTTSExecutionController';

export function usePlainTTS(input: {
  client?: RemoteApiClient;
  enabled: boolean;
  settings: TTSPlaybackSettings;
  contentRevision?: string;
  chapterId?: string;
  rules: readonly SpokenTextRule[];
  controller: ReturnType<typeof useTTSExecutionController>;
  systemTTS: TTSProvider;
  voiceURI?: string;
  onError(message: string): void;
}) {
  const [catalog, setCatalog] = useState<PlainTTSVoices>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewAudio = useMemo(() => new BrowserAudioSession(), []);
  const previewAbort = useRef<AbortController>();
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (!input.client) {
      setCatalog(undefined);
      return;
    }
    try {
      const result = await input.client.listPlainTTSVoices();
      if (generation === refreshGeneration.current) setCatalog(result);
    } catch (error) {
      if (generation === refreshGeneration.current)
        setCatalog({
          available: false,
          voices: [],
          message: error instanceof Error ? error.message : '서버 음성 목록을 불러오지 못했습니다.',
        });
    }
  }, [input.client]);
  const invalidateCatalogRequest = useCallback(() => {
    ++refreshGeneration.current;
  }, []);
  useEffect(() => {
    if (input.enabled) void refresh();
    return invalidateCatalogRequest;
  }, [input.enabled, refresh, invalidateCatalogRequest]);
  const stopPreview = useCallback(() => {
    previewAbort.current?.abort();
    previewAbort.current = undefined;
    previewAudio.stop(true);
    setPreviewBusy(false);
  }, [previewAudio]);
  useEffect(
    () => stopPreview,
    [
      stopPreview,
      input.client,
      input.settings.mode,
      input.settings.voiceSource,
      input.settings.serverVoiceId,
      input.voiceURI,
      input.chapterId,
    ],
  );
  const voiceId = input.settings.serverVoiceId || (catalog?.defaultVoiceId ?? catalog?.voices[0]?.id);
  const ready = Boolean(
    input.client && catalog?.available && catalog.revision && catalog.voices.some((voice) => voice.id === voiceId),
  );
  const latestContent = useRef({ chapterId: input.chapterId, revision: input.contentRevision });
  latestContent.current = { chapterId: input.chapterId, revision: input.contentRevision };
  const requestFor = (playable: PlayableTtsSegment, paragraph: Paragraph): PlainTTSRequest => {
    if (!ready || !voiceId || !catalog?.revision || !playable.spokenTextFingerprint)
      throw new Error('서버 목소리를 선택하고 목록을 새로고침하세요.');
    if (input.settings.offlineOnly)
      throw new Error('기본 서버 낭독에는 연결이 필요합니다. 오프라인 전용 설정을 끄거나 기기 목소리를 선택하세요.');
    return {
      voiceId,
      modelRevision: catalog.revision,
      rate: playable.rate,
      paragraphId: paragraph.id,
      paragraphHash: plainTTSParagraphHash(paragraph),
      contentRevision:
        latestContent.current.chapterId === paragraph.chapterId
          ? latestContent.current.revision
          : input.contentRevision,
      chunkHash: playable.spokenTextFingerprint,
      chunking: input.settings.plainChunking ?? 'sentence',
      batch: playable.plainBatch,
      rules: input.rules,
    };
  };
  const play = async (
    playable: PlayableTtsSegment,
    paragraph: Paragraph,
    sessionId: number,
    onProgress?: (fraction: number) => void,
  ): Promise<boolean> => {
    const operation = input.controller.beginHostedPlayback(sessionId, '음성 준비 중');
    if (!operation) return true;
    try {
      const request = requestFor(playable, paragraph);
      const key = structuredIntegrityHash({ chapter: paragraph.chapterId, request });
      const prefetched = input.controller.takePrefetched(key);
      const blob =
        prefetched?.blob ??
        (await requestPlainTTSWithRetry(
          () => input.client!.synthesizePlainTTS(paragraph.chapterId, request, operation.controller.signal),
          {
            signal: operation.controller.signal,
            onWait: (seconds) =>
              input.controller.setHostedStatus(operation, `음성 제공자 대기 중 · ${Math.ceil(seconds)}초 후 다시 시도`),
          },
        ));
      if (!input.controller.isSessionCurrent(sessionId)) return true;
      input.controller.setHostedStatus(operation, undefined);
      return await input.controller.playAudio(blob, sessionId, onProgress);
    } catch (error) {
      if (input.controller.isSessionCurrent(sessionId))
        input.onError(
          (error as { status?: number })?.status === 429
            ? '음성 제공자의 제한이 계속되어 자동 재시도를 멈췄습니다. 읽던 위치에서 다시 재생할 수 있습니다.'
            : error instanceof Error
              ? error.message
              : '서버 음성을 재생하지 못했습니다.',
        );
      return false;
    } finally {
      input.controller.finishOperation(operation);
    }
  };
  const prefetch = async (
    playable: PlayableTtsSegment,
    paragraph: Paragraph,
    sessionId: number,
    contentRevision = latestContent.current.chapterId === paragraph.chapterId
      ? latestContent.current.revision
      : input.contentRevision,
  ) => {
    let request: PlainTTSRequest;
    try {
      request = { ...requestFor(playable, paragraph), contentRevision };
    } catch {
      return;
    }
    const key = structuredIntegrityHash({ chapter: paragraph.chapterId, request });
    const abort = input.controller.beginPrefetch(sessionId, key);
    if (!abort) return;
    try {
      const blob = await input.client!.synthesizePlainTTS(paragraph.chapterId, request, abort.signal);
      input.controller.rememberPrefetched(sessionId, key, { cacheKey: key, blob });
    } catch {
      /* Foreground playback reports failures; speculative requests stay silent. */
    } finally {
      input.controller.finishPrefetch(key, abort);
    }
  };
  const preview = async () => {
    stopPreview();
    input.controller.stopAll();
    input.systemTTS.stop();
    const abort = new AbortController();
    previewAbort.current = abort;
    setPreviewBusy(true);
    try {
      if (input.settings.voiceSource === 'server') {
        if (!ready || !voiceId || !catalog?.revision) throw new Error('서버 목소리를 선택하세요.');
        const blob = await input.client!.synthesizePlainTTS(
          undefined,
          { voiceId, modelRevision: catalog.revision, rate: input.settings.rate },
          abort.signal,
        );
        if (!abort.signal.aborted) {
          previewAudio.setVolume(input.settings.volume);
          if (!(await previewAudio.playBlob(blob))) throw new Error('음성 미리듣기를 재생하지 못했습니다.');
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            abort.signal.removeEventListener('abort', cancelled);
            resolve();
          };
          const cancelled = () => {
            input.systemTTS.stop();
            finish();
          };
          abort.signal.addEventListener('abort', cancelled, { once: true });
          void input.systemTTS
            .speak({
              text: PLAIN_TTS_SAMPLE,
              voiceURI: input.voiceURI,
              rate: input.settings.rate,
              pitch: input.settings.pitch,
              volume: input.settings.volume,
              onEnd: finish,
              onError: (message) => {
                abort.signal.removeEventListener('abort', cancelled);
                reject(new Error(message));
              },
            })
            .catch((error) => {
              abort.signal.removeEventListener('abort', cancelled);
              reject(error);
            });
        });
      }
    } catch (error) {
      if (!abort.signal.aborted) input.onError(error instanceof Error ? error.message : '미리듣기에 실패했습니다.');
    } finally {
      if (previewAbort.current === abort) {
        previewAbort.current = undefined;
        setPreviewBusy(false);
      }
    }
  };
  return { catalog, ready, refresh, play, prefetch, preview, previewBusy, stopPreview };
}
