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
  SkipForward,
  SlidersHorizontal,
  Square,
  Trash2,
  Users,
  Volume2,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import type { TTSPlaybackSettings } from '../../domain/types';
import { SettingsSlider } from '../../features/reader-settings/SettingsSlider';
import TTSAddonPanel, { type TTSAddonPanelProps } from '../../features/tts/TTSAddonPanel';
import { cx, Segmented, Switch } from '../components/primitives';
import './listen.css';

type Page = 'main' | 'details' | 'advanced';
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
  const [page, setPage] = useState<Page>('main');
  const settings = props.playbackSettings;
  const plainMode = settings.mode !== 'cast';
  const serverPlain = plainMode && settings.voiceSource === 'server';
  const serverVoices = props.plainVoices?.voices ?? [];
  const serverVoiceId = settings.serverVoiceId ?? '';
  const serverVoiceMissing = Boolean(serverVoiceId && !serverVoices.some((voice) => voice.id === serverVoiceId));
  const serverReady = Boolean(props.plainVoices?.available && serverVoices.length);
  const playbackUnavailable = plainMode
    ? serverPlain
      ? !serverReady || serverVoiceMissing
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
        <button type="button" className="un-listen-back" onClick={() => setPage('main')}>
          <ChevronLeft size={20} aria-hidden="true" />
          듣기
        </button>
        <h3 className="un-listen-page-title">{page === 'details' ? '세부 청취 설정' : '화자·고급 설정'}</h3>
        {page === 'details' ? (
          <ListenDetails {...props} serverPlain={serverPlain} />
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
        <Segmented
          label="낭독 방식"
          value={plainMode ? 'plain' : 'cast'}
          options={[
            { value: 'plain', label: '기본 목소리' },
            { value: 'cast', label: '화자별 목소리' },
          ]}
          onChange={(mode) => props.changePlaybackSettings({ mode })}
        />
        {plainMode ? (
          <>
            {!localStatic && (
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
                  <option value="">서버 기본 목소리</option>
                  {serverVoiceMissing && <option value={serverVoiceId}>저장된 목소리 없음 · {serverVoiceId}</option>}
                  {serverVoices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.label}
                    </option>
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
                  (serverPlain && serverVoiceMissing)
                }
                aria-busy={props.plainPreviewBusy}
                aria-label="목소리 미리듣기"
              >
                <Volume2 size={18} aria-hidden="true" />
                <span>{props.plainPreviewBusy ? '듣는 중' : '미리듣기'}</span>
              </button>
            </div>
            {serverPlain && (
              <p className="un-listen-note">
                {serverVoiceMissing
                  ? '저장된 목소리를 찾을 수 없습니다. 사용할 목소리를 다시 선택하세요.'
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
        <button type="button" onClick={() => setPage('details')}>
          <SlidersHorizontal size={19} aria-hidden="true" />
          <span>
            <b>세부 청취 설정</b>
            <small>음높이, 볼륨, 쉬는 간격, 건너뛸 내용</small>
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
      </nav>
    </div>
  );
}

function ListenDetails(props: TTSAddonPanelProps & { serverPlain: boolean }) {
  const settings = props.playbackSettings;
  const [skipPattern, setSkipPattern] = useState('');
  const [skipKind, setSkipKind] = useState<SkipKind>('skip_prefix');
  const skipRules = props.spokenTextRules.filter((rule) => rule.kind !== 'replace_literal');

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
