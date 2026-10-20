import {
  normalizePlainTTSBatchCharacters,
  MIN_PLAIN_TTS_BATCH_CHARACTERS,
  MAX_PLAIN_TTS_BATCH_CHARACTERS,
} from '../../providers/plain-tts-limits';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SkipBack,
  Server,
  SpellCheck,
  SkipForward,
  SlidersHorizontal,
  Square,
  Trash2,
  Users,
  Volume2,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useSelfHostCapability } from '../../features/auth/self-host-account-api';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import type { TTSPlaybackSettings } from '../../domain/types';
import ProviderSettingsPanel from '../../features/providers/ProviderSettingsPanel';
import { SettingsSlider } from '../../features/reader-settings/SettingsSlider';
import TTSAddonPanel, { type TTSAddonPanelProps } from '../../features/tts/TTSAddonPanel';
import UiNextSpokenTextFilters from './UiNextSpokenTextFilters';
import type { TTSVoice } from '../../providers/tts';
import { cx, Segmented, Switch } from '../components/primitives';
import './listen.css';

type Page = 'main' | 'details' | 'advanced' | 'engines' | 'filters';
// Plain catalog entries may name the engine they run on; ids stay opaque and are saved as-is.
type EngineVoice = TTSVoice & { providerId?: string; providerName?: string; modelId?: string; paid?: boolean };
interface EngineStatus {
  id: string;
  name: string;
  modelId?: string;
  available: boolean;
  paid: boolean;
  message?: string;
}
const PAGE_TITLE: Record<Exclude<Page, 'main'>, string> = {
  details: '세부 청취 설정',
  advanced: '화자·고급 설정',
  engines: 'TTS 엔진 연결',
  filters: '발음·문자 필터',
};
type SleepValue = TTSPlaybackSettings['sleepTimerDefault'];
type SkipKind = 'skip_line' | 'skip_prefix' | 'skip_suffix';

const SPEEDS = [0.8, 1, 1.2, 1.5, 1.8] as const;
const SLEEP: readonly { value: SleepValue; label: string }[] = [
  { value: undefined, label: '끔' },
  { value: 10, label: '10분' },
  { value: 20, label: '20분' },
  { value: 30, label: '30분' },
  { value: 60, label: '60분' },
  { value: 'end_of_chapter', label: '화 끝' },
];
const SKIP_TYPES = [
  ['author_note', '작가의 말'],
  ['system_message', '시스템 문구'],
  ['sfx', '효과음'],
] as const;
const SKIP_KIND_LABEL: Record<SkipKind, string> = {
  skip_prefix: '이 문구로 시작',
  skip_suffix: '이 문구로 끝남',
  skip_line: '문장 전체 일치',
};

// Batch size is shared with server reconstruction and saved with other listening settings.
type PlainChunking = NonNullable<TTSPlaybackSettings['plainChunking']>;
const CHUNKING_HINT: Record<PlainChunking, string> = {
  sentence: '첫 소리가 빠르고 문장마다 따라 표시돼요. 재생 중 자주 끊기면 문단이나 묶음을 써 보세요.',
  paragraph: '요청이 줄어 끊김이 덜할 수 있어요. 첫 소리가 늦고 문단 단위로 표시돼요. 700자가 넘는 문단은 나눠 읽어요.',
  batch:
    '짧은 문단을 설정한 글자 수까지, 최대 16문단씩 합성해 요청을 줄여요. 첫 소리가 더 늦고, 화면은 재생 진행에 맞춰 문단을 대략 따라가요. 이어듣기는 묶음 첫 문단부터이며 이전·다음은 준비된 묶음 단위로 이동해요. 묶음 안에서는 문장·문단 쉬는 간격이 적용되지 않아요.',
};

const clampSpeed = (value: number) => Math.round(Math.min(1.8, Math.max(0.6, value)) * 10) / 10;

function Group({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="un-listen-group">
      <div className="un-listen-group-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** ui-next 듣기 tab: a player first, then the few choices people change while listening. */
export default function UiNextListenPanel(props: TTSAddonPanelProps) {
  const localStatic = useOptionalAppRuntime()?.product?.kind === 'local-static';
  // Server voices and per-speaker casting run on server providers; members listen with this device's voices.
  const providers = useSelfHostCapability('useProviders');
  const [page, setPage] = useState<Page>('main');
  const settings = props.playbackSettings;
  const plainMode = !providers || settings.mode !== 'cast';
  const { changePlaybackSettings } = props;
  useEffect(() => {
    if (!providers && (settings.mode === 'cast' || settings.voiceSource === 'server'))
      changePlaybackSettings({ mode: 'plain', voiceSource: 'system' });
  }, [providers, settings.mode, settings.voiceSource, changePlaybackSettings]);
  const serverPlain = providers && plainMode && settings.voiceSource === 'server';
  const serverVoices: readonly EngineVoice[] = props.plainVoices?.voices ?? [];
  const catalog = props.plainVoices as { providers?: readonly EngineStatus[]; defaultVoiceId?: string } | undefined;
  const engines: readonly EngineStatus[] = catalog?.providers ?? [];
  const serverReady = Boolean(props.plainVoices?.available && serverVoices.length);
  const serverVoiceId = settings.serverVoiceId ?? '';
  // Same resolution as playback: the server names its default ('' = not ready); older servers mean the first voice.
  const defaultVoiceId = catalog?.defaultVoiceId ?? serverVoices[0]?.id ?? '';
  const effectiveVoiceId = serverVoiceId || defaultVoiceId;
  const selectedVoice = serverVoices.find((voice) => voice.id === effectiveVoiceId);
  const serverVoiceMissing = Boolean(serverVoiceId && !selectedVoice);
  // No default yet: never borrow another (possibly paid) engine's voice for the listener.
  const defaultUnavailable = serverReady && !serverVoiceId && !selectedVoice;
  const selectedEngine = selectedVoice?.providerId
    ? engines.find((engine) => engine.id === selectedVoice.providerId)
    : undefined;
  // A broken engine blocks its own voices only; we never swap in another engine behind the listener's back.
  const selectedEngineDown = selectedEngine?.available === false;
  // Voice labels like "한국어 여성1" don't say which engine speaks them; name it beside the picker.
  const selectedEngineName = selectedEngine?.name ?? selectedVoice?.providerName;
  const selectedModel = selectedEngine?.modelId ?? selectedVoice?.modelId ?? props.plainVoices?.modelId;
  const selectedPaid = Boolean(selectedVoice?.paid ?? selectedEngine?.paid);
  const voiceGroups = groupByEngine(serverVoices, engines);
  const enginesDown = engines.filter((engine) => !engine.available);
  const playbackUnavailable = plainMode
    ? serverPlain
      ? !serverReady || serverVoiceMissing || defaultUnavailable || selectedEngineDown
      : props.unavailable
    : props.unavailable && !props.hostedPlaybackReady;
  const rateUnavailable = props.unavailable && !props.hostedPlaybackReady && !serverReady;
  const count = props.paragraphCount;
  const index = props.paragraphIndex;

  // A "hear this sentence" request from the reader lands on the spoken-text preview.
  useEffect(() => {
    if (props.spokenPreviewRequest?.text.trim()) setPage('advanced');
  }, [props.spokenPreviewRequest]);

  if (page !== 'main') {
    return (
      <div className="un-listen">
        <button
          type="button"
          className="un-listen-back"
          onClick={() => {
            // Engine keys or models may have changed; reload the voice list the player picks from.
            if (page === 'engines') props.refreshPlainVoices?.();
            setPage('main');
          }}
        >
          <ChevronLeft size={20} aria-hidden="true" />
          듣기
        </button>
        <h3 className="un-listen-page-title">{PAGE_TITLE[page]}</h3>
        {page === 'details' ? (
          <ListenDetails {...props} serverPlain={serverPlain} />
        ) : page === 'filters' && props.saveSpokenTextFilter ? (
          <UiNextSpokenTextFilters
            rules={props.spokenTextRules}
            language={props.bookLanguage}
            currentParagraphText={props.currentParagraphText}
            requestedText={props.spokenPreviewRequest?.text}
            save={props.saveSpokenTextFilter}
            importFilters={props.importSpokenTextFilters}
            remove={props.deleteSpokenTextSkipRule}
          />
        ) : page === 'engines' ? (
          <>
            <p className="un-listen-note">
              연결한 엔진의 목소리는 듣기 탭의 서버 목소리에 바로 나타나요. 화자 분석이나 승인 없이 쓸 수 있어요.
            </p>
            <ProviderSettingsPanel
              scope="tts_synthesis"
              title="TTS 엔진"
              providers={props.providers}
              draft={props.providerDraft}
              controller={props.providerController}
            />
          </>
        ) : (
          <TTSAddonPanel {...props} view="advanced" />
        )}
      </div>
    );
  }

  const status = serverPlain
    ? serverReady
      ? undefined
      : { title: '서버 음성 확인 필요', message: props.plainVoices?.message ?? '서버 음성 목록을 확인하세요.' }
    : props.statusTone === 'ready'
      ? undefined
      : {
          title: !props.status
            ? 'TTS 상태 확인 중'
            : !props.status.canSpeak
              ? '이 기기에서 TTS를 쓸 수 없어요'
              : '기본 음성으로 읽어요',
          message: props.selectedVoiceMissing
            ? '저장된 음성을 찾을 수 없어 자동 선택으로 재생합니다.'
            : (props.status?.message ?? '시스템 음성 지원 여부를 확인하고 있습니다.'),
        };

  return (
    <div className="un-listen">
      {status && (
        <div className={cx('un-listen-status', props.statusTone === 'danger' && 'is-danger')} role="status">
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <b>{status.title}</b>
            <p>{status.message}</p>
          </div>
          <button
            type="button"
            className="un-icon-btn is-sm"
            onClick={() => (serverPlain ? props.refreshPlainVoices?.() : void props.refreshStatus())}
            aria-label="TTS 상태 새로고침"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      )}

      <section className="un-listen-player" aria-label="재생">
        <div className="un-listen-now">
          <small>{props.playing ? (props.paused ? '일시정지됨' : '듣는 중') : '이 화 듣기'}</small>
          <b>
            {index !== undefined && count ? `${index + 1}번째 문단` : count ? `${count}개 문단` : '본문 없음'}
            {index !== undefined && count ? <span> / {count}</span> : null}
          </b>
          {props.activePlayback && <span className="un-listen-voice">{props.activePlayback.speakerLabel}</span>}
        </div>
        <div className="un-listen-bar" aria-hidden="true">
          <span style={{ width: `${index !== undefined && count ? ((index + 1) / count) * 100 : 0}%` }} />
        </div>
        <div className="un-listen-controls">
          <button
            type="button"
            className="un-listen-ctl"
            onClick={props.stop}
            disabled={!props.playing}
            aria-label="정지"
          >
            <Square size={18} />
          </button>
          <button
            type="button"
            className="un-listen-ctl"
            onClick={() => props.jump(-1)}
            disabled={playbackUnavailable || !count || (index ?? 0) <= 0}
            aria-label="이전 문단"
          >
            <SkipBack size={22} />
          </button>
          {!props.playing || props.paused ? (
            <button
              type="button"
              className="un-listen-play"
              onClick={() => (props.playing ? props.resume() : void props.start())}
              disabled={!props.playing && playbackUnavailable}
              aria-label={props.playing ? '계속 듣기' : '재생'}
            >
              <Play size={28} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="un-listen-play" onClick={props.pause} aria-label="일시정지">
              <Pause size={28} fill="currentColor" />
            </button>
          )}
          <button
            type="button"
            className="un-listen-ctl"
            onClick={() => props.jump(1)}
            disabled={playbackUnavailable || !count || (index ?? 0) >= count - 1}
            aria-label="다음 문단"
          >
            <SkipForward size={22} />
          </button>
          <span className="un-listen-ctl-spacer" aria-hidden="true" />
        </div>
        {props.resumeLabel && !props.playing && (
          <button type="button" className="un-listen-resume" onClick={() => void props.resumeSavedPlayback()}>
            <RotateCcw size={15} aria-hidden="true" />
            {props.resumeLabel}
          </button>
        )}
        {props.playing && props.saveSpokenTextFilter && (
          // Heard something wrong? Jump straight to the filter with this paragraph in the preview.
          <button type="button" className="un-listen-resume" onClick={() => setPage('filters')}>
            <SpellCheck size={15} aria-hidden="true" />
            발음 고치기
          </button>
        )}
      </section>

      <Group title="재생">
        <div className="un-listen-row">
          <span className="un-listen-label">속도</span>
          <div className="un-listen-stepper">
            <button
              type="button"
              disabled={rateUnavailable || props.speed <= 0.6}
              onClick={() => props.changeSpeed(clampSpeed(props.speed - 0.1))}
              aria-label="속도 낮추기"
            >
              <Minus size={16} />
            </button>
            <output aria-live="polite">{props.speed.toFixed(1)}x</output>
            <button
              type="button"
              disabled={rateUnavailable || props.speed >= 1.8}
              onClick={() => props.changeSpeed(clampSpeed(props.speed + 0.1))}
              aria-label="속도 높이기"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
        <div className="un-listen-chips" role="radiogroup" aria-label="자주 쓰는 속도">
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              role="radio"
              aria-checked={Math.abs(props.speed - speed) < 0.05}
              className={cx(Math.abs(props.speed - speed) < 0.05 && 'is-active')}
              disabled={rateUnavailable}
              onClick={() => props.changeSpeed(speed)}
            >
              {speed.toFixed(1)}x
            </button>
          ))}
        </div>
        <div className="un-listen-row is-stacked">
          <span className="un-listen-label">수면 타이머</span>
          <div className="un-listen-chips" role="radiogroup" aria-label="기본 수면 타이머">
            {SLEEP.map((option) => (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={settings.sleepTimerDefault === option.value}
                className={cx(settings.sleepTimerDefault === option.value && 'is-active')}
                onClick={() => props.changePlaybackSettings({ sleepTimerDefault: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="un-listen-row">
          <span className="un-listen-label">화가 끝나면</span>
          <Segmented
            label="화가 끝나면"
            value={settings.chapterEndBehavior}
            options={[
              { value: 'stop', label: '멈춤' },
              { value: 'continue', label: '다음 화' },
            ]}
            onChange={(chapterEndBehavior) => props.changePlaybackSettings({ chapterEndBehavior })}
          />
        </div>
      </Group>

      <Group title="목소리">
        {providers && (
          <Segmented
            label="낭독 방식"
            value={plainMode ? 'plain' : 'cast'}
            options={[
              { value: 'plain', label: '기본 목소리' },
              { value: 'cast', label: '화자별 목소리' },
            ]}
            onChange={(mode) => props.changePlaybackSettings({ mode })}
          />
        )}
        {plainMode ? (
          <>
            {!localStatic && providers && (
              <div className="un-listen-row">
                <span className="un-listen-label">음성</span>
                <Segmented
                  label="음성 사용"
                  value={serverPlain ? 'server' : 'system'}
                  options={[
                    { value: 'system', label: '이 기기' },
                    { value: 'server', label: '서버' },
                  ]}
                  onChange={(voiceSource) => props.changePlaybackSettings({ voiceSource })}
                />
              </div>
            )}
            <div className="un-listen-voice-pick">
              {serverPlain ? (
                <select
                  aria-label="서버 목소리"
                  value={serverVoiceId}
                  disabled={!props.plainVoices?.available || serverVoices.length === 0}
                  onChange={(event) => props.changePlaybackSettings({ serverVoiceId: event.target.value })}
                >
                  <option value="">
                    서버 기본 목소리
                    {selectedVoice && !serverVoiceId
                      ? ` · ${selectedVoice.label}`
                      : defaultUnavailable
                        ? ' · 준비 안 됨'
                        : ''}
                  </option>
                  {serverVoiceMissing && <option value={serverVoiceId}>저장된 목소리 없음 · {serverVoiceId}</option>}
                  {voiceGroups.length > 1
                    ? voiceGroups.map((group) => (
                        <optgroup key={group.key} label={group.label}>
                          {group.voices.map((voice) => (
                            <VoiceOption key={voice.id} voice={voice} engine={group.engine} />
                          ))}
                        </optgroup>
                      ))
                    : serverVoices.map((voice) => (
                        <VoiceOption key={voice.id} voice={voice} engine={voiceGroups[0]?.engine} />
                      ))}
                </select>
              ) : (
                <select
                  aria-label="기기 목소리"
                  value={props.selectedSystemVoiceId ?? ''}
                  disabled={props.voices.length === 0}
                  onChange={(event) => props.changeSystemVoice(event.target.value || undefined)}
                >
                  {props.selectedVoiceMissing && <option value={props.selectedSystemVoiceId}>저장된 음성 없음</option>}
                  <option value="">자동 선택</option>
                  {props.voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="un-listen-preview"
                onClick={() => void props.previewPlainVoice?.()}
                disabled={
                  !props.previewPlainVoice ||
                  props.plainPreviewBusy ||
                  playbackUnavailable ||
                  (serverPlain && (serverVoiceMissing || defaultUnavailable || selectedEngineDown))
                }
                aria-busy={props.plainPreviewBusy}
                aria-label="목소리 미리듣기"
              >
                <Volume2 size={18} aria-hidden="true" />
                <span>{props.plainPreviewBusy ? '듣는 중' : '미리듣기'}</span>
              </button>
            </div>
            {serverPlain && selectedVoice && (selectedEngineName || selectedModel) && (
              <p className="un-listen-engine-tag">
                엔진 <b>{selectedEngineName ?? selectedModel}</b>
                {selectedEngineName && selectedModel && selectedModel !== selectedEngineName
                  ? ` · ${selectedModel}`
                  : ''}
                {!serverVoiceId ? ' · 서버 기본' : ''}
              </p>
            )}
            {serverPlain && selectedPaid && !serverVoiceMissing && (
              <p className="un-listen-note is-paid" role="note">
                <b>외부 API 목소리</b> · 재생과 미리듣기마다{' '}
                {selectedEngine?.name ?? selectedVoice?.providerName ?? '외부'} API 사용량(요금)이 발생할 수 있어요.
              </p>
            )}
            {serverPlain && (
              <p className="un-listen-note">
                {serverVoiceMissing
                  ? '저장된 목소리를 찾을 수 없습니다. 사용할 목소리를 다시 선택하세요.'
                  : defaultUnavailable
                    ? '기본 엔진이 준비되지 않았어요. 다른 엔진을 쓰려면 목소리를 직접 고르세요.'
                    : selectedEngineDown
                      ? `${selectedEngine?.name ?? '선택한 엔진'}에 연결할 수 없어요${selectedEngine?.message ? ` (${selectedEngine.message})` : ''}. 다른 엔진은 자동으로 대신하지 않으니 목소리를 직접 고르세요.`
                      : (props.plainVoices?.message ??
                        (serverReady
                          ? `${serverVoices.length}개 서버 목소리를 쓸 수 있어요.`
                          : '사용 가능한 서버 목소리를 불러오세요.'))}{' '}
                {props.refreshPlainVoices && (
                  <button type="button" className="un-listen-link" onClick={() => props.refreshPlainVoices?.()}>
                    새로고침
                  </button>
                )}
              </p>
            )}
            {serverPlain && enginesDown.length > 0 && !selectedEngineDown && (
              <ul className="un-listen-engines" aria-label="연결 안 된 엔진">
                {enginesDown.map((engine) => (
                  <li key={engine.id}>
                    <b>{engine.name}</b> 연결 안 됨{engine.message ? ` · ${engine.message}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="un-listen-note">
            인물마다 다른 목소리로 읽어요. 목소리는 아래 <b>화자·고급 설정</b>에서 고를 수 있어요.
          </p>
        )}
      </Group>

      <div className="un-listen-scope">
        <div>
          <b>이 작품에만 적용</b>
          <small>
            {props.bookOverrideEnabled ? '바꾼 설정은 이 작품에만 저장돼요.' : '바꾼 설정은 모든 작품의 기본값이 돼요.'}
          </small>
        </div>
        {props.bookOverrideEnabled && (
          <button type="button" className="un-listen-link" onClick={props.resetBookOverride}>
            초기화
          </button>
        )}
        <Switch label="이 작품에만 적용" checked={props.bookOverrideEnabled} onChange={props.setBookOverrideEnabled} />
      </div>

      <nav className="un-listen-links" aria-label="더 많은 청취 설정">
        {props.saveSpokenTextFilter && (
          <button type="button" onClick={() => setPage('filters')}>
            <SpellCheck size={19} aria-hidden="true" />
            <span>
              <b>발음·문자 필터</b>
              <small>찾을 말을 읽을 말로 바꾸기, 정규식, .ttsfilter 가져오기</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        )}
        <button type="button" onClick={() => setPage('details')}>
          <SlidersHorizontal size={19} aria-hidden="true" />
          <span>
            <b>세부 청취 설정</b>
            <small>
              {serverPlain ? '합성 단위, 음높이, 볼륨, 쉬는 간격, 건너뛸 내용' : '음높이, 볼륨, 쉬는 간격, 건너뛸 내용'}
            </small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => setPage('advanced')}>
          <Users size={19} aria-hidden="true" />
          <span>
            <b>화자·고급 설정</b>
            <small>인물별 목소리, 발음 사전, 읽기 미리보기</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        {providers && !localStatic && (
          <button type="button" onClick={() => setPage('engines')}>
            <Server size={19} aria-hidden="true" />
            <span>
              <b>TTS 엔진 연결</b>
              <small>Supertonic, 외부 TTS API 키와 모델</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        )}
      </nav>
    </div>
  );
}

function VoiceOption({ voice, engine }: { voice: EngineVoice; engine?: EngineStatus }) {
  const paid = voice.paid ?? engine?.paid;
  return (
    <option value={voice.id} disabled={engine?.available === false}>
      {voice.label}
      {paid ? ' · 유료 API' : ''}
      {engine?.available === false ? ' · 연결 안 됨' : ''}
    </option>
  );
}

/** Voices keep catalog order; engines appear in the order their first voice does. */
function groupByEngine(voices: readonly EngineVoice[], engines: readonly EngineStatus[]) {
  const groups: { key: string; label: string; engine?: EngineStatus; voices: EngineVoice[] }[] = [];
  for (const voice of voices) {
    const key = voice.providerId ?? '';
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      const engine = engines.find((candidate) => candidate.id === key);
      const name = engine?.name ?? voice.providerName ?? '서버';
      const model = engine?.modelId ?? voice.modelId;
      group = {
        key,
        label: model ? `${name} · ${model}` : name,
        engine,
        voices: [],
      };
      groups.push(group);
    }
    group.voices.push(voice);
  }
  return groups;
}

function ListenDetails(props: TTSAddonPanelProps & { serverPlain: boolean }) {
  const settings = props.playbackSettings;
  // Server plain voices only: one request per paragraph (≤700자) trades first-sound latency for fewer requests.
  const plainChunking: PlainChunking = settings.plainChunking ?? 'sentence';
  const [skipPattern, setSkipPattern] = useState('');
  const [skipKind, setSkipKind] = useState<SkipKind>('skip_prefix');
  // Replacement filters (literal and regex) live on their own page; list only skip rules here.
  const skipRules = props.spokenTextRules.filter((rule) => rule.kind.startsWith('skip_'));

  return (
    <>
      <Group title="소리">
        <SettingsSlider
          label="음높이"
          min={0.5}
          max={2}
          step={0.1}
          value={settings.pitch}
          disabled={!props.pitchSupported}
          onChange={(pitch) => props.changePlaybackSettings({ pitch })}
        />
        {!props.pitchSupported && <p className="un-listen-note">이 음성에서는 음높이를 바꿀 수 없어요.</p>}
        <SettingsSlider
          label="볼륨"
          min={0}
          max={100}
          step={5}
          suffix="%"
          value={Math.round(settings.volume * 100)}
          onChange={(volume) => props.changePlaybackSettings({ volume: volume / 100 })}
        />
      </Group>

      <Group title="쉬는 간격">
        {(
          [
            ['sentencePauseMs', '문장 사이', 1200, 10],
            ['paragraphPauseMs', '문단 사이', 2500, 20],
            ['chapterPauseMs', '화 사이', 5000, 100],
          ] as const
        ).map(([key, label, max, step]) => (
          <SettingsSlider
            key={key}
            label={label}
            min={0}
            max={max}
            step={step}
            suffix="ms"
            value={settings[key]}
            onChange={(value) => props.changePlaybackSettings({ [key]: value })}
          />
        ))}
      </Group>

      <Group title="읽는 방식">
        {props.serverPlain && (
          <div className="un-listen-row is-stacked">
            <span className="un-listen-label">합성 단위</span>
            <Segmented
              label="합성 단위"
              value={plainChunking}
              options={[
                { value: 'sentence', label: '문장' },
                { value: 'paragraph', label: '문단' },
                { value: 'batch', label: '묶음' },
              ]}
              onChange={(next) => props.changePlaybackSettings({ plainChunking: next })}
            />
            <small className="un-listen-hint">{CHUNKING_HINT[plainChunking]}</small>
          </div>
        )}
        {props.serverPlain && plainChunking === 'batch' && (
          <SettingsSlider
            label="묶음 크기"
            min={MIN_PLAIN_TTS_BATCH_CHARACTERS}
            max={MAX_PLAIN_TTS_BATCH_CHARACTERS}
            step={100}
            suffix="자"
            value={normalizePlainTTSBatchCharacters(settings.plainBatchCharacters)}
            onChange={(plainBatchCharacters) => props.changePlaybackSettings({ plainBatchCharacters })}
          />
        )}
        <div className="un-listen-row is-stacked">
          <span className="un-listen-label">EPUB 각주</span>
          <Segmented
            label="EPUB 각주"
            value={settings.footnotePlayback}
            options={[
              { value: 'end_of_chapter', label: '화 끝에서' },
              { value: 'immediate', label: '바로' },
              { value: 'skip', label: '읽지 않음' },
            ]}
            onChange={(footnotePlayback) => props.changePlaybackSettings({ footnotePlayback })}
          />
        </div>
        <div className="un-listen-toggle">
          <span>
            <b>준비된 음성만 사용</b>
            <small>
              {props.serverPlain
                ? '기본 서버 낭독은 인터넷 연결이 필요해요.'
                : '저장된 음성이 없으면 시스템 음성으로 계속 읽어요.'}
            </small>
          </span>
          <Switch
            label="준비된 음성만 사용"
            checked={settings.offlineOnly}
            onChange={(offlineOnly) => props.changePlaybackSettings({ offlineOnly })}
          />
        </div>
      </Group>

      <Group title="건너뛸 내용" aside={<small>원문은 바뀌지 않아요</small>}>
        <div className="un-listen-chips" role="group" aria-label="읽지 않을 내용">
          {SKIP_TYPES.map(([type, label]) => {
            const on = settings.skippedContentTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                aria-pressed={on}
                className={cx(on && 'is-active')}
                onClick={() =>
                  props.changePlaybackSettings({
                    skippedContentTypes: on
                      ? settings.skippedContentTypes.filter((item) => item !== type)
                      : [...settings.skippedContentTypes, type],
                  })
                }
              >
                {label}
              </button>
            );
          })}
        </div>
        <form
          className="un-listen-skip-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!skipPattern.trim()) return;
            void props.saveSpokenTextSkipRule(skipPattern, skipKind);
            setSkipPattern('');
          }}
        >
          <select
            aria-label="건너뛰기 방식"
            value={skipKind}
            onChange={(event) => setSkipKind(event.target.value as SkipKind)}
          >
            {(Object.keys(SKIP_KIND_LABEL) as SkipKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {SKIP_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
          <input
            value={skipPattern}
            aria-label="건너뛸 문구"
            placeholder="예: [작가의 말]"
            onChange={(event) => setSkipPattern(event.target.value)}
          />
          <button type="submit" className="un-btn is-ghost is-sm" disabled={!skipPattern.trim()}>
            추가
          </button>
        </form>
        {skipRules.length > 0 && (
          <ul className="un-listen-rules">
            {skipRules.map((rule) => (
              <li key={rule.id}>
                <span>
                  <b>{rule.pattern}</b>
                  <small>{SKIP_KIND_LABEL[rule.kind as SkipKind] ?? '건너뛰기'}</small>
                </span>
                <button
                  type="button"
                  className="un-icon-btn is-sm"
                  aria-label={`${rule.pattern} 건너뛰기 규칙 삭제`}
                  onClick={() => void props.deleteSpokenTextSkipRule(rule.id)}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Group>
    </>
  );
}
