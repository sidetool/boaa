import { Clock3, LoaderCircle } from 'lucide-react';
import type { SpeakerGenerationJob } from '../../providers/speaker-generation';
import { formatBytes, formatCount } from '../../utils/format';
import { Progress } from '../components/primitives';
import { audioCounts } from './AudioGaps';

const stageLabel: Record<SpeakerGenerationJob['stage'], string> = {
  waiting: '생성 준비',
  attribution: '화자 찾기',
  identity: '인물 연결',
  casting: '목소리 배정',
  performance: '연기 분석',
  audio: '음성 만들기',
  complete: '생성 완료',
};

/** Report observed phases and checkpoint counts; never invent a percentage for an in-flight model request. */
export default function SpeakerJobProgress({ item }: { item: SpeakerGenerationJob }) {
  const active = item.status === 'running';
  const analyzing = ['attribution', 'identity', 'casting', 'performance'].includes(item.stage);
  const total = item.analysisProgress?.chapterCount ?? item.chapterCount + item.contextChapterCount;
  const current = item.analysisProgress?.currentChapter;
  const attributed = item.analysisProgress?.attributionCompleted;
  const retryTime = item.retryAt ? Date.parse(item.retryAt) : NaN;
  const retrying = item.status === 'queued' && Number.isFinite(retryTime);
  const ready = item.readyChapterIds.length;
  const { done, skipped, blocked } = audioCounts(item);
  const label = stageLabel[item.stage];
  // A partial plan has no known audio total, so its bar would overstate progress; analysis checkpoints stay honest.
  const audioBar = !analyzing && item.itemCount > 0 && item.planningComplete !== false;
  // The server names what is waiting (analysis, voice design, audio); its own '· N초 후' tail would go stale,
  // so only the part before it is shown and the retry time below stays live.
  const waiting = retrying ? item.error?.split(' · ')[0]?.trim() : undefined;
  const activity = retrying
    ? waiting || '요청 제한으로 대기 중'
    : item.status === 'queued'
      ? '차례를 기다리는 중'
      : item.status === 'pausing'
        ? '진행 중인 요청을 마치면 멈춰요'
        : (item.status === 'paused' || item.status === 'failed') && blocked > 0
          ? '콘텐츠 제한 구간에서 멈췄어요'
          : item.status === 'paused'
            ? `${label} 단계에서 멈췄어요`
            : item.status === 'failed'
              ? `${label} 단계에서 중단됐어요`
              : active
                ? `${label} 중`
                : undefined;
  const currentText = current
    ? `${formatCount(total)}개 중 ${formatCount(current.number)}번째 회차${current.contextOnly ? ' · 인물 파악을 위한 앞 회차' : ''}`
    : undefined;
  return (
    <>
      {activity && (
        <div className="un-cast-activity" role="status" aria-live="polite">
          {active ? (
            <LoaderCircle size={16} className="un-spin" aria-hidden="true" />
          ) : (
            <Clock3 size={16} aria-hidden="true" />
          )}
          <span>
            <b>{activity}</b>
            {currentText && <small>{currentText}</small>}
            {(current?.title || (item.stage === 'audio' && item.currentChapterTitle)) && (
              <small>{current?.title || item.currentChapterTitle}</small>
            )}
            {retrying && (
              <small>
                {retryTime > Date.now() ? (
                  <>
                    <time dateTime={item.retryAt}>
                      {new Date(retryTime).toLocaleTimeString('ko-KR', {
                        hour: 'numeric',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </time>
                    에 자동으로 다시 시도해요.
                  </>
                ) : (
                  '자동 재시도를 준비하고 있어요.'
                )}
              </small>
            )}
          </span>
        </div>
      )}
      {item.status !== 'completed' && !audioBar && total > 0 && (
        <Progress value={item.analyzedChapters / total} label="회차 분석 진행" />
      )}
      {item.status !== 'completed' && audioBar && <Progress value={done / item.itemCount} label="생성 진행" />}
      {/* Parallel attribution can run ahead of the ordered identity step; text only, so the bar keeps one meaning. */}
      {attributed !== undefined && total > 0 && item.status !== 'completed' && (
        <small className="un-book-meta">
          화자 찾기 완료 {formatCount(attributed)} / {formatCount(total)}회차
        </small>
      )}
      <small className="un-book-meta">
        {total > 0
          ? `분석 완료 ${formatCount(item.analyzedChapters)} / ${formatCount(total)}회차`
          : '분석할 회차를 확인하고 있어요.'}
        {item.contextChapterCount > 0 ? ` (앞 회차 ${formatCount(item.contextChapterCount)}개 포함)` : ''}
      </small>
      {item.itemCount > 0 ? (
        <small className="un-book-meta">
          {/* With silent segments the count is processed, not voiced, segments. */}
          {item.planningComplete === false ? `지금까지 계획된 ${skipped > 0 ? '구간 중 ' : '음성 '}` : ''}
          {skipped > 0 ? '처리 ' : ''}
          {formatCount(done)} / {formatCount(item.itemCount)} 구간 · {formatBytes(item.bytes)}
        </small>
      ) : (
        <small className="un-book-meta">
          {item.status === 'completed' ? '생성할 음성 구간이 없어요.' : '음성 구간 수는 회차 분석 후 표시돼요.'}
        </small>
      )}
      {ready > 0 && (
        <small className="un-book-meta">
          들을 수 있는 회차 {formatCount(ready)}/{formatCount(item.chapterCount)}
        </small>
      )}
    </>
  );
}
