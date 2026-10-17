import { AudioLines, Pause, Play, SkipBack, SkipForward, Timer, X } from 'lucide-react';
import type { TTSCompactBarProps } from '../../features/tts/tts-compact-contract';
import { cx } from '../components/primitives';
import '../styles/tokens.css';
import './mini-player.css';

const STATUS: Record<string, string> = {
  prefetch_hit: '준비된 음성',
  native_cache_hit: '저장된 음성',
  native_cache_rendered: '음성 준비 완료',
  offline_cache_miss: '시스템 음성으로 재생',
  synthesizing: '음성 만드는 중',
  buffering: '불러오는 중',
  fallback: '시스템 음성으로 재생',
};

const TIMER_CYCLE: readonly TTSCompactBarProps['timerPreset'][] = [undefined, 10, 20, 30, 60, 'end_of_chapter'];
const timerName = (preset: TTSCompactBarProps['timerPreset']) =>
  preset === undefined ? '끔' : preset === 'end_of_chapter' ? '화 끝' : `${preset}분`;

function remaining(seconds?: number, preset?: TTSCompactBarProps['timerPreset']): string | undefined {
  if (seconds !== undefined) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return preset === 'end_of_chapter' ? '화 끝' : undefined;
}

/** ui-next listening mini player: stays on screen while reading so playback is always one tap away. */
export default function UiNextMiniPlayer(props: TTSCompactBarProps) {
  const status =
    props.speakerLabel ??
    (props.status && (STATUS[props.status] ?? props.status)) ??
    (props.busy ? '준비 중' : undefined);
  const timer = remaining(props.timerRemainingSeconds, props.timerPreset);
  const playingNow = props.playing && !props.paused;

  return (
    <section
      className={cx('tts-compact-bar ui-next un-mini', playingNow && 'is-playing', props.busy && 'is-busy')}
      aria-label="TTS 재생 제어"
      data-playing={props.playing}
    >
      <button type="button" className="un-mini-info" onClick={props.openSettings} aria-label="듣기 설정 열기">
        <span className="un-mini-art" aria-hidden="true">
          <AudioLines size={18} />
        </span>
        <span className="un-mini-text">
          <b>{props.chapterTitle}</b>
          <small>
            {status ?? props.bookTitle}
            <em>{props.rate.toFixed(1)}x</em>
            {timer && (
              <em>
                <Timer size={12} aria-hidden="true" />
                {timer}
              </em>
            )}
          </small>
        </span>
      </button>
      <div className="un-mini-controls">
        <button type="button" onClick={props.previous} aria-label="이전 문단">
          <SkipBack size={19} />
        </button>
        {playingNow ? (
          <button type="button" className="is-main" onClick={props.pause} aria-label="TTS 일시정지">
            <Pause size={20} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="is-main"
            onClick={() => (props.playing ? props.resume() : void props.start())}
            aria-label={props.playing ? 'TTS 계속 재생' : 'TTS 재생'}
          >
            <Play size={20} fill="currentColor" />
          </button>
        )}
        <button type="button" onClick={props.next} aria-label="다음 문단">
          <SkipForward size={19} />
        </button>
        <button
          type="button"
          className={cx('is-timer', props.timerPreset !== undefined && 'is-on')}
          onClick={() => {
            const next = TIMER_CYCLE[(TIMER_CYCLE.indexOf(props.timerPreset) + 1) % TIMER_CYCLE.length];
            props.setTimer(next);
          }}
          aria-label={`수면 타이머 ${timerName(props.timerPreset)}, 눌러서 바꾸기`}
        >
          <Timer size={18} />
        </button>
        <button type="button" className="is-close" onClick={props.stop} aria-label="TTS 정지">
          <X size={18} />
        </button>
      </div>
    </section>
  );
}
