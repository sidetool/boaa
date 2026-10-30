import { loadPreparedAudio } from './prepared-audio-load';
import { tracePlaybackWait } from '../../providers/playback-diagnostics';
import { PlainTTSSessionCache, waitForPlainTTSAudio } from '../../providers/plain-tts-session-cache';
import { requestPlainTTSWithRetry } from '../../providers/plain-tts-retry';
import { ttsQueueItemFingerprint } from '../../providers/tts-playback-resume';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudiobookPort } from '../../providers/plain-audiobook';
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
  owner?: object;
  enabled: boolean;
  settings: TTSPlaybackSettings;
  contentRevision?: string;
  chapterId?: string;
  rules: readonly SpokenTextRule[];
  controller: ReturnType<typeof useTTSExecutionController>;
  systemTTS: TTSProvider;
  voiceURI?: string;
  prepared?: AudiobookPort;
  onError(message: string): void;
}) {
  // Own the resource by account/runtime/content identity, not by playback or speed.
  const { audio: audioCache } = useMemo(
    () => ({ client: input.client, owner: input.owner, audio: new PlainTTSSessionCache() }),
    [input.client, input.owner],
  );
  useEffect(() => () => audioCache.clear(), [audioCache]);
  const [catalog, setCatalog] = useState<PlainTTSVoices>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewAudio = useMemo(() => new BrowserAudioSession(), []);
  useEffect(() => {
    previewAudio.setPlaybackRate(input.settings.rate);
    previewAudio.setVolume(input.settings.volume);
  }, [previewAudio, input.settings.rate, input.settings.volume]);
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
  const scopeFor = (revision = input.contentRevision) =>
    structuredIntegrityHash({
      voiceId,
      modelRevision: catalog?.revision,
      rules: input.rules,
      chunking: input.settings.plainChunking ?? 'sentence',
      batchCharacters: input.settings.plainBatchCharacters,
      contentRevision: revision,
    });
  const lastPlayback = useRef<{
    cache: PlainTTSSessionCache;
    scope: string;
    chapterId: string;
    index: number;
    fingerprint: string;
    prepared?: boolean;
  }>();
  const retryTarget = () => {
    const target = lastPlayback.current;
    return target &&
      target.cache === audioCache &&
      (target.prepared || target.scope === scopeFor()) &&
      target.chapterId === input.chapterId
      ? { index: target.index, fingerprint: target.fingerprint }
      : undefined;
  };
  const reusableStart = (index: number) => audioCache.batch(scopeFor(), input.chapterId ?? '', index)?.[0] ?? index;
  const jumpIndex = (index: number, direction: -1 | 1) => {
    const positions = audioCache.batch(scopeFor(), input.chapterId ?? '', index);
    if (!positions || positions.length < 2) return index + direction;
    if (direction === 1) return positions[positions.length - 1] + 1;
    return index > positions[0] ? positions[0] : reusableStart(index - 1);
  };
  const requestFor = (playable: PlayableTtsSegment, paragraph: Paragraph): PlainTTSRequest => {
    if (!ready || !voiceId || !catalog?.revision || !playable.spokenTextFingerprint)
      throw new Error('서버 목소리를 선택하고 목록을 새로고침하세요.');
    if (input.settings.offlineOnly)
      throw new Error('기본 서버 낭독에는 연결이 필요합니다. 오프라인 전용 설정을 끄거나 기기 목소리를 선택하세요.');
    return {
      voiceId,
      modelRevision: catalog.revision,
      voiceRevision: catalog.voices.find((voice) => voice.id === voiceId)?.model?.revision,
      rate: 1,
      paragraphId: paragraph.id,
      paragraphHash: plainTTSParagraphHash(paragraph),
      contentRevision:
        latestContent.current.chapterId === paragraph.chapterId
          ? latestContent.current.revision
          : input.contentRevision,
      chunkHash: playable.spokenTextFingerprint,
      chunking: input.settings.plainChunking ?? 'sentence',
      batch: playable.plainBatch,
      batchCharacters: input.settings.plainChunking === 'batch' ? input.settings.plainBatchCharacters : undefined,
      rules: input.rules,
    };
  };
  const play = async (
    playable: PlayableTtsSegment,
    paragraph: Paragraph,
    sessionId: number,
    onProgress?: (fraction: number) => void,
    regeneration?: { prepared(): void },
  ): Promise<boolean> => {
    const operation = input.controller.beginHostedPlayback(sessionId, '음성 준비 중');
    if (!operation) {
      regeneration?.prepared();
      return true;
    }
    try {
      if (playable.preparedAudio && input.prepared) {
        const item = playable.preparedAudio;
        input.controller.setHostedStatus(
          operation,
          regeneration ? '현재 음성 다시 만드는 중' : item.ready ? '미리 만든 음성 불러오는 중' : '현재 구간 준비 중',
        );
        const key = `prepared:${item.id}:${item.ordinal}`;
        lastPlayback.current = {
          cache: audioCache,
          scope: scopeFor(),
          chapterId: paragraph.chapterId,
          index: paragraph.index - 1,
          fingerprint: ttsQueueItemFingerprint(playable),
          prepared: true,
        };
        if (regeneration) audioCache.remove(key);
        const blob = await tracePlaybackWait(
          'buffer',
          () =>
            requestPlainTTSWithRetry(
              () =>
                waitForPlainTTSAudio(
                  audioCache.getOrCreate({
                    key,
                    readOnly: item.ready && !regeneration,
                    chapter: paragraph.chapterId,
                    scope: scopeFor(),
                    positions: playable.plainBatchPositions?.map((p) => p.paragraphIndex) ?? [],
                    fetch: (signal) =>
                      regeneration
                        ? input.prepared!.resolve(item.id, item.ordinal, true, signal)
                        : loadPreparedAudio(input.prepared!, item, signal),
                  }),
                  operation.controller.signal,
                ),
              {
                signal: operation.controller.signal,
                onWait: (seconds) =>
                  input.controller.setHostedStatus(
                    operation,
                    `음성 제공자 대기 중 · ${Math.ceil(seconds)}초 후 다시 시도`,
                  ),
              },
            ),
          { prepared: true, ordinal: item.ordinal, regenerate: Boolean(regeneration) },
        );
        regeneration?.prepared();
        if (!input.controller.isSessionCurrent(sessionId)) return true;
        input.controller.setHostedStatus(operation, undefined);
        return await input.controller.playAudio(blob, sessionId, onProgress);
      }
      const request = requestFor(playable, paragraph);
      const key = structuredIntegrityHash({ chapter: paragraph.chapterId, request });
      lastPlayback.current = {
        cache: audioCache,
        scope: scopeFor(request.contentRevision),
        chapterId: paragraph.chapterId,
        index: paragraph.index - 1,
        fingerprint: ttsQueueItemFingerprint(playable),
      };
      if (regeneration) {
        audioCache.remove(key);
        input.controller.setHostedStatus(operation, '현재 음성 다시 만드는 중');
      }
      // Retry at the playback consumer: an existing prefetch has no retry policy of its own.
      // The cache still owns in-flight synthesis, so stopping playback never duplicates paid work.
      const blob = await tracePlaybackWait(
        'buffer',
        () =>
          requestPlainTTSWithRetry(
            () =>
              waitForPlainTTSAudio(
                audioCache.getOrCreate({
                  key,
                  chapter: paragraph.chapterId,
                  scope: scopeFor(request.contentRevision),
                  positions: playable.plainBatchPositions?.map((p) => p.paragraphIndex) ?? [],
                  fetch: (signal) =>
                    input.client!.synthesizePlainTTS(
                      paragraph.chapterId,
                      regeneration ? { ...request, regenerate: true } : request,
                      signal,
                    ),
                }),
                operation.controller.signal,
              ),
            {
              signal: operation.controller.signal,
              onWait: (seconds) =>
                input.controller.setHostedStatus(
                  operation,
                  `음성 제공자 대기 중 · ${Math.ceil(seconds)}초 후 다시 시도`,
                ),
            },
          ),
        { prepared: false, regenerate: Boolean(regeneration) },
      );
      regeneration?.prepared();
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
      regeneration?.prepared();
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
    if (playable.preparedAudio && input.prepared) {
      if (!input.controller.isSessionCurrent(sessionId)) return;
      const item = playable.preparedAudio;
      try {
        await audioCache.getOrCreate({
          key: `prepared:${item.id}:${item.ordinal}`,
          readOnly: item.ready,
          chapter: paragraph.chapterId,
          scope: scopeFor(),
          positions: playable.plainBatchPositions?.map((p) => p.paragraphIndex) ?? [],
          fetch: (signal) => loadPreparedAudio(input.prepared!, item, signal),
        });
      } catch {
        /* Foreground reports the error. */
      }
      return;
    }
    let request: PlainTTSRequest;
    try {
      request = { ...requestFor(playable, paragraph), contentRevision };
    } catch {
      return;
    }
    const key = structuredIntegrityHash({ chapter: paragraph.chapterId, request });
    if (!input.controller.isSessionCurrent(sessionId)) return;
    try {
      await audioCache.getOrCreate({
        key,
        chapter: paragraph.chapterId,
        scope: scopeFor(request.contentRevision),
        positions: playable.plainBatchPositions?.map((p) => p.paragraphIndex) ?? [],
        fetch: (signal) => input.client!.synthesizePlainTTS(paragraph.chapterId, request, signal),
      });
    } catch {
      /* Foreground playback reports failures; speculative requests stay silent. */
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
          { voiceId, modelRevision: catalog.revision, rate: 1 },
          abort.signal,
        );
        if (!abort.signal.aborted) {
          previewAudio.setVolume(input.settings.volume);
          previewAudio.setPlaybackRate(input.settings.rate);
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
  return {
    catalog,
    ready,
    refresh,
    play,
    prefetch,
    preview,
    previewBusy,
    stopPreview,
    reusableStart,
    jumpIndex,
    retryTarget,
  };
}
