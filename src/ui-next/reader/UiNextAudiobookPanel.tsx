import { AlertCircle, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TTSAudiobookControls } from '../../features/tts/TTSAddonPanel';
import type {
  AudiobookEstimate,
  AudiobookInput,
  AudiobookStatus,
  SavedAudiobook,
} from '../../providers/plain-audiobook';
import { formatBytes, formatCount } from '../../utils/format';
import { cx, Progress, Segmented } from '../components/primitives';
import './audiobook.css';

type Scope = 'current' | 'range' | 'all';
type Confirm = { id: string; action: 'resume' | 'remove' };

const POLL_MS = 4000;
const STATUS_LABEL: Record<AudiobookStatus, string> = {
  queued: '대기 중',
  running: '만드는 중',
  pausing: '중지하는 중',
  paused: '멈춤',
  failed: '실패',
  completed: '완료',
  deleting: '삭제 중',
};
// The server keeps working on these; the page refreshes them while it is open.
const ACTIVE: readonly AudiobookStatus[] = ['queued', 'running', 'pausing', 'deleting'];
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message && error.name !== 'AbortError' ? error.message : fallback;
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** 저장 오디오북: ordinary server narration made ahead of time and kept on the account's server. */
export default function UiNextAudiobookPanel({ controls }: { controls: TTSAudiobookControls }) {
  // Account, session or book changed: drop every list, job view and saved playback at once.
  return <AudiobookBody key={controls.key} controls={controls} />;
}

function AudiobookBody({ controls }: { controls: TTSAudiobookControls }) {
  // The parent builds a new controls object each render; lifetime follows `key`, callbacks read the latest.
  const latest = useRef(controls);
  latest.current = controls;
  const { chapters, currentChapterId, generation } = controls;

  const [items, setItems] = useState<readonly SavedAudiobook[]>();
  const [listError, setListError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  // Counts finished list attempts, failed ones included, so polling keeps its bounded retry.
  const [listed, setListed] = useState(0);
  const listRun = useRef<AbortController>();
  // Late replies from create/control/remove must not start requests after this lifetime ends.
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!alive.current) return;
    listRun.current?.abort();
    const run = new AbortController();
    listRun.current = run;
    setRefreshing(true);
    try {
      const next = await latest.current.port.list(run.signal);
      if (run.signal.aborted) return;
      setItems(next);
      setListError(undefined);
    } catch (error) {
      if (!run.signal.aborted && !isAbort(error)) setListError(message(error, '저장 목록을 불러오지 못했어요.'));
    } finally {
      if (listRun.current === run) {
        setRefreshing(false);
        if (!run.signal.aborted) setListed((count) => count + 1);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      listRun.current?.abort();
    };
  }, [refresh]);

  // Jobs keep running on the server after this page closes; poll only while it is open.
  const busy = items?.some((item) => ACTIVE.includes(item.status)) ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => void refresh(), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [busy, listed, refresh]);

  // ───────── new audiobook ─────────
  const currentIndex = chapters.findIndex((chapter) => chapter.id === currentChapterId);
  const [chosenScope, setScope] = useState<Scope>(currentIndex >= 0 ? 'current' : 'all');
  const scope: Scope = chosenScope === 'current' && currentIndex < 0 ? 'all' : chosenScope;
  const [from, setFrom] = useState(Math.max(0, currentIndex));
  const [to, setTo] = useState(Math.max(0, currentIndex));
  const selected =
    scope === 'all'
      ? chapters
      : scope === 'range'
        ? chapters.slice(Math.min(from, to), Math.max(from, to) + 1)
        : currentIndex >= 0
          ? [chapters[currentIndex]]
          : [];
  const input: AudiobookInput | undefined =
    generation && selected.length ? { ...generation, chapterIds: selected.map((chapter) => chapter.id) } : undefined;
  const inputKey = input ? JSON.stringify(input) : '';
  const [estimate, setEstimate] = useState<{ key: string; value: AudiobookEstimate }>();
  const fresh = estimate && estimate.key === inputKey ? estimate.value : undefined;
  const [paidAck, setPaidAck] = useState(false);
  const [working, setWorking] = useState<'estimate' | 'create'>();
  const [createError, setCreateError] = useState<string>();
  const createRun = useRef<AbortController>();
  useEffect(() => () => createRun.current?.abort(), []);
  // A different range, voice or rule is a different plan: its paid consent never carries over.
  useEffect(() => {
    setPaidAck(false);
    setCreateError(undefined);
  }, [inputKey]);

  const runEstimate = async () => {
    if (!input) return;
    createRun.current?.abort();
    const run = new AbortController();
    createRun.current = run;
    setWorking('estimate');
    setCreateError(undefined);
    try {
      const value = await latest.current.port.estimate(input, run.signal);
      if (!run.signal.aborted) setEstimate({ key: inputKey, value });
    } catch (error) {
      if (!run.signal.aborted && !isAbort(error)) setCreateError(message(error, '글자 수를 확인하지 못했어요.'));
    } finally {
      if (createRun.current === run) setWorking(undefined);
    }
  };

  const runCreate = async () => {
    if (!input || !fresh || (fresh.paid && !paidAck)) return;
    createRun.current?.abort();
    const run = new AbortController();
    createRun.current = run;
    setWorking('create');
    setCreateError(undefined);
    try {
      const job = await latest.current.port.create(input, fresh.fingerprint, fresh.paid && paidAck, run.signal);
      if (run.signal.aborted) return;
      setItems((current) => [job, ...(current ?? []).filter((item) => item.id !== job.id)]);
      setEstimate(undefined);
      setPaidAck(false);
    } catch (error) {
      if (run.signal.aborted) return;
      // A cancelled or timed-out request may still have created the job; the same plan returns it again.
      setCreateError(message(error, '만들기를 시작하지 못했어요. 목록을 확인해 주세요.'));
    } finally {
      if (createRun.current === run) setWorking(undefined);
      if (!run.signal.aborted) void refresh();
    }
  };

  // ───────── saved list actions ─────────
  const [confirm, setConfirm] = useState<Confirm>();
  const [pending, setPending] = useState<string>();
  const [actionError, setActionError] = useState<{ id: string; text: string }>();
  const act = async (id: string, run: () => Promise<SavedAudiobook | void>) => {
    setPending(id);
    setActionError(undefined);
    try {
      const next = await run();
      if (!alive.current) return;
      if (next) setItems((current) => current?.map((item) => (item.id === next.id ? next : item)));
      else setItems((current) => current?.filter((item) => item.id !== id));
      setConfirm(undefined);
    } catch (error) {
      if (alive.current) setActionError({ id, text: message(error, '요청을 처리하지 못했어요.') });
    } finally {
      setPending(undefined);
      void refresh();
    }
  };
  const resume = (item: SavedAudiobook, confirmed = false) => {
    if (item.paid && !confirmed) {
      setConfirm({ id: item.id, action: 'resume' });
      return;
    }
    void act(item.id, () => latest.current.port.control(item.id, 'resume', item.paid && confirmed));
  };
  const remove = (item: SavedAudiobook) => {
    void act(item.id, () => latest.current.port.remove(item.id));
  };

  const totalBytes = items?.reduce((sum, item) => sum + item.bytes, 0) ?? 0;
  const listen = async (item: SavedAudiobook) => {
    setActionError(undefined);
    try {
      await latest.current.listen(item);
    } catch (error) {
      if (alive.current) setActionError({ id: item.id, text: message(error, '본문에서 듣기를 시작하지 못했어요.') });
    }
  };
  return (
    <div className="un-book">
      <section className="un-book-group" aria-labelledby="un-book-new">
        <div className="un-book-group-head">
          <h3 id="un-book-new">생성할 범위</h3>
          <small>현재 목소리 사용</small>
        </div>
        {generation && (
          <>
            <Segmented
              label="만들 범위"
              value={scope}
              options={[
                ...(currentIndex >= 0 ? [{ value: 'current' as const, label: '이 화' }] : []),
                { value: 'range', label: '범위' },
                { value: 'all', label: '전체' },
              ]}
              onChange={setScope}
            />
            {scope === 'range' && (
              <div className="un-book-range">
                <ChapterSelect
                  label="시작 회차"
                  chapters={chapters}
                  value={from}
                  onChange={(next) => {
                    setFrom(next);
                    if (next > to) setTo(next);
                  }}
                />
                <span aria-hidden="true">~</span>
                <ChapterSelect
                  label="끝 회차"
                  chapters={chapters}
                  value={to}
                  onChange={(next) => {
                    setTo(next);
                    if (next < from) setFrom(next);
                  }}
                />
              </div>
            )}
            <p className="un-book-note">
              만들 범위:{' '}
              <b>
                {scope === 'current' && selected[0]
                  ? selected[0].title || '현재 회차'
                  : scope === 'all'
                    ? `전체 ${formatCount(chapters.length)}개 회차`
                    : `${formatCount(selected.length)}개 회차`}
              </b>
              . 현재 듣기 설정으로 음성을 미리 만들어요.
            </p>
          </>
        )}
        {!generation ? (
          <p className="un-book-note is-box">
            미리 생성하려면 듣기에서 <b>서버</b> 목소리를 선택해 주세요. 이미 만든 음성은 엔진이 꺼져 있어도 들을 수
            있어요.
          </p>
        ) : fresh ? (
          <div className="un-book-estimate" aria-label="생성 확인">
            <dl>
              <div>
                <dt>회차</dt>
                <dd>{formatCount(fresh.chapterCount)}</dd>
              </div>
              <div>
                <dt>구간</dt>
                <dd>{formatCount(fresh.itemCount)}</dd>
              </div>
              <div>
                <dt>낭독 글자</dt>
                <dd>{formatCount(fresh.characters)}</dd>
              </div>
            </dl>
            <p className="un-book-voice">
              <b>{fresh.voiceLabel}</b> · {fresh.providerName}
            </p>
            {fresh.paid && (
              <label className="un-book-ack">
                <input type="checkbox" checked={paidAck} onChange={(event) => setPaidAck(event.target.checked)} />
                <span>음성을 만들 때 선택한 서비스의 API 사용 요금이 발생할 수 있어요.</span>
              </label>
            )}
          </div>
        ) : null}

        {createError && (
          <p className="un-book-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            {createError}
          </p>
        )}

        {generation && (
          <div className="un-book-actions">
            {fresh ? (
              <>
                <button
                  type="button"
                  className="un-btn is-primary is-sm"
                  onClick={() => void runCreate()}
                  disabled={!!working || (fresh.paid && !paidAck)}
                  aria-busy={working === 'create' || undefined}
                >
                  {working === 'create' ? '시작하는 중' : '생성 시작'}
                </button>
                <button
                  type="button"
                  className="un-btn is-text is-sm"
                  onClick={() => setEstimate(undefined)}
                  disabled={!!working}
                >
                  취소
                </button>
              </>
            ) : (
              <button
                type="button"
                className="un-btn is-ghost is-sm"
                onClick={() => void runEstimate()}
                disabled={!input || !!working}
                aria-busy={working === 'estimate' || undefined}
              >
                {working === 'estimate' ? '확인하는 중' : '글자 수 확인'}
              </button>
            )}
          </div>
        )}
      </section>

      <section className="un-book-group" aria-labelledby="un-book-saved">
        <div className="un-book-group-head">
          <h3 id="un-book-saved">미리 만든 음성</h3>
          <button
            type="button"
            className="un-icon-btn is-sm"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="저장 목록 새로고침"
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {listError && (
          <p className="un-book-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            {listError}
          </p>
        )}
        {!items ? (
          !listError && <p className="un-book-note">불러오는 중…</p>
        ) : items.length === 0 ? (
          <p className="un-book-note is-box">
            아직 미리 만든 음성이 없어요. 한 번 만들어 두면 다른 기기에서도 다시 들을 수 있어요.
          </p>
        ) : (
          <>
            <ul className="un-book-list">
              {items.map((item) => (
                <SavedItem
                  key={item.id}
                  item={item}
                  pending={pending === item.id}
                  confirm={confirm?.id === item.id ? confirm.action : undefined}
                  error={actionError?.id === item.id ? actionError.text : undefined}
                  onPlay={() => void listen(item)}
                  onPause={() => void act(item.id, () => latest.current.port.control(item.id, 'pause'))}
                  onResume={(confirmed) => resume(item, confirmed)}
                  onRemove={(confirmed) => (confirmed ? remove(item) : setConfirm({ id: item.id, action: 'remove' }))}
                  onCancel={() => setConfirm(undefined)}
                />
              ))}
            </ul>
            <p className="un-book-note">
              서버에 {formatBytes(totalBytes)} 보관 중. 만드는 작업은 앱을 닫아도 서버에서 계속돼요. 본문에서 평소처럼
              듣고, 읽는 위치와 다음 화도 함께 따라가요.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function ChapterSelect({
  label,
  chapters,
  value,
  onChange,
}: {
  label: string;
  chapters: TTSAudiobookControls['chapters'];
  value: number;
  onChange: (index: number) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {chapters.map((chapter, index) => (
        <option key={chapter.id} value={index}>
          {chapter.title || `${index + 1}화`}
        </option>
      ))}
    </select>
  );
}

function rangeLabel(item: Pick<SavedAudiobook, 'firstChapterTitle' | 'lastChapterTitle' | 'chapterCount'>) {
  const { firstChapterTitle: first, lastChapterTitle: last } = item;
  if (first && last && first !== last) return `${first} ~ ${last}`;
  return first ?? last ?? `${formatCount(item.chapterCount)}개 회차`;
}

function SavedItem({
  item,
  pending,
  confirm,
  error,
  onPlay,
  onPause,
  onResume,
  onRemove,
  onCancel,
}: {
  item: SavedAudiobook;
  pending: boolean;
  confirm?: Confirm['action'];
  error?: string;
  onPlay(): void;
  onPause(): void;
  onResume(confirmed?: boolean): void;
  onRemove(confirmed?: boolean): void;
  onCancel(): void;
}) {
  const generating = item.status === 'queued' || item.status === 'running';
  const stopped = item.status === 'paused' || item.status === 'failed';
  const removable = !generating && item.status !== 'pausing' && item.status !== 'deleting';
  const playable = item.status !== 'deleting';
  const remaining = Math.max(0, item.itemCount - item.completedItems);
  const created = new Date(item.createdAt);

  return (
    <li className="un-book-item">
      <div className="un-book-item-head">
        <b>{rangeLabel(item)}</b>
        <span className={cx('un-book-badge', `is-${item.status}`)}>{STATUS_LABEL[item.status]}</span>
      </div>
      <small className="un-book-meta">
        {formatCount(item.chapterCount)}개 회차 · {item.voiceLabel} · {item.providerName}
        {Number.isNaN(created.getTime()) ? '' : ` · ${created.toLocaleDateString()}`}
      </small>
      {item.status !== 'completed' && (
        <Progress value={item.completedItems / Math.max(1, item.itemCount)} label="생성 진행" />
      )}
      <small className="un-book-meta">
        {formatCount(item.completedItems)} / {formatCount(item.itemCount)} 구간 · {formatBytes(item.bytes)}
        {generating && item.currentChapterTitle ? ` · ${item.currentChapterTitle}` : ''}
        {item.status === 'pausing' ? ' · 지금 구간을 마치면 멈춰요' : ''}
      </small>
      {(item.error || error) && (
        <p
          className={!error && item.status === 'queued' ? 'un-book-meta' : 'un-book-error'}
          role={!error && item.status === 'queued' ? 'status' : 'alert'}
        >
          <AlertCircle size={15} aria-hidden="true" />
          {error ?? item.error}
        </p>
      )}
      {confirm ? (
        <div
          className="un-book-confirm"
          role="group"
          aria-label={confirm === 'remove' ? '삭제 확인' : '이어 만들기 확인'}
        >
          <p>
            {confirm === 'remove'
              ? `저장된 음성 ${formatBytes(item.bytes)}를 서버에서 지워요. 되돌릴 수 없어요.`
              : `남은 ${formatCount(remaining)}개 구간을 이어 만들어요. API 사용 요금이 발생할 수 있고, 중단된 구간은 다시 생성될 수 있어요.`}
          </p>
          <div className="un-book-actions">
            <button
              type="button"
              className={cx('un-btn is-sm', confirm === 'remove' ? 'un-book-danger' : 'is-primary')}
              onClick={() => (confirm === 'remove' ? onRemove(true) : onResume(true))}
              disabled={pending}
            >
              {confirm === 'remove' ? '삭제' : '이어 만들기'}
            </button>
            <button type="button" className="un-btn is-text is-sm" onClick={onCancel} disabled={pending}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <div className="un-book-actions">
          {playable && (
            <button type="button" className="un-btn is-ghost is-sm" onClick={onPlay} disabled={pending}>
              <Play size={15} fill="currentColor" aria-hidden="true" />
              본문에서 듣기
            </button>
          )}
          {generating && (
            <button type="button" className="un-btn is-text is-sm" onClick={onPause} disabled={pending}>
              <Pause size={14} aria-hidden="true" />
              멈추기
            </button>
          )}
          {stopped && remaining > 0 && (
            <button type="button" className="un-btn is-text is-sm" onClick={() => onResume()} disabled={pending}>
              <Play size={14} aria-hidden="true" />
              이어 만들기
            </button>
          )}
          {removable && (
            <button
              type="button"
              className="un-icon-btn is-sm un-book-remove"
              onClick={() => onRemove()}
              disabled={pending}
              aria-label="음성 삭제"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      )}
    </li>
  );
}
