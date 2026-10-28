import { AlertCircle, FlaskConical, Pause, Play, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudiobookStatus } from '../../providers/plain-audiobook';
import type { PlainTTSProviderStatus, PlainTTSVoice } from '../../providers/plain-tts';
import type { SpeakerEngine } from '../../providers/speaker-engine';
import type {
  SpeakerGenerationEstimate,
  SpeakerGenerationInput,
  SpeakerGenerationJob,
  SpeakerGenerationPreferences,
  TTSSpeakerGenerationControls,
} from '../../providers/speaker-generation';
import { formatBytes, formatCount } from '../../utils/format';
import { cx } from '../components/primitives';
import SpeakerJobProgress from './SpeakerJobProgress';
import { ChapterScopeFields, chapterScopeSummary, useChapterScope } from './chapter-scope';
import { speakerPreferenceQueue } from './speaker-generation-preferences';
import UiNextCastingOptions, { castingMode, flashDesigner, validBudget } from './UiNextCastingOptions';
import UiNextBookVoices from './UiNextBookVoices';
import UiNextSpeakerRevoice from './UiNextSpeakerRevoice';
import type { SpeakerCastingOptions, LibraryVoice, VoiceDesignProvider } from '../../providers/voice-library';
import './audiobook.css';
import './speaker-generation.css';

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
const ACTIVE: readonly AudiobookStatus[] = ['queued', 'running', 'pausing', 'deleting'];
const STEPS = [
  ['attribution', '화자 찾기'],
  ['identity', '인물 연결'],
  ['casting', '목소리 배정'],
  ['performance', '연기 분석'],
  ['audio', '음성 만들기'],
] as const;
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message && error.name !== 'AbortError' ? error.message : fallback;
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export interface UiNextSpeakerGenerationPanelProps {
  readonly controls: TTSSpeakerGenerationControls;
  /** Opens the analysis model page; this page stays mounted, so its choices survive the visit. */
  onManageEngines?(): void;
  /** Bumped when analysis models were edited: reload the list without changing the choice. */
  readonly enginesRevision?: number;
  onManageVoices?(): void;
  readonly voicesRevision?: number;
}

/** 화자별 미리 생성하기: the server finds speakers, assigns voices and makes audio; the reader plays what is ready. */
export default function UiNextSpeakerGenerationPanel(props: UiNextSpeakerGenerationPanelProps) {
  // Account, session or book changed: every list, choice and pending request starts over.
  return <Body key={props.controls.key} {...props} />;
}

function Body({
  controls,
  onManageEngines,
  enginesRevision = 0,
  onManageVoices,
  voicesRevision = 0,
}: UiNextSpeakerGenerationPanelProps) {
  const latest = useRef(controls);
  latest.current = controls;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ───────── jobs ─────────
  const [items, setItems] = useState<readonly SpeakerGenerationJob[]>();
  const [listError, setListError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [listed, setListed] = useState(0);
  const listRun = useRef<AbortController>();
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
      if (!run.signal.aborted && !isAbort(error)) setListError(message(error, '목록을 불러오지 못했어요.'));
    } finally {
      if (listRun.current === run) {
        setRefreshing(false);
        if (!run.signal.aborted) setListed((count) => count + 1);
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => listRun.current?.abort();
  }, [refresh]);
  const busy = items?.some((item) => ACTIVE.includes(item.status)) ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => void refresh(), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [busy, listed, refresh]);

  // ───────── saved choices ─────────
  // Bound to this lifetime's port (one account and book); the queue outlives the page so closing never drops a save.
  const [queue] = useState(() => speakerPreferenceQueue(controls.port));
  const [restored] = useState(() => queue.latest);
  // 'failed': choices still work but are not saved, so a missed read never overwrites what the server has.
  const [prefs, setPrefs] = useState<'loading' | 'ready' | 'failed'>(restored ? 'ready' : 'loading');
  const [engineChoice, setEngineChoice] = useState(restored?.engineId || undefined);
  const [narratorChoice, setNarratorChoice] = useState(restored?.narratorVoiceId || undefined);
  const [poolChoice, setPoolChoice] = useState<readonly string[] | undefined>(restored?.characterVoiceIds);
  const [castingChoice, setCastingChoice] = useState<SpeakerCastingOptions | undefined>(restored?.casting);
  const [actingChoice, setActingChoice] = useState<boolean | undefined>(restored?.autoActing);
  const [library, setLibrary] = useState<{ voices: LibraryVoice[]; designers: VoiceDesignProvider[] }>();
  const [libraryError, setLibraryError] = useState<string>();
  useEffect(() => {
    const port = controls.voiceLibrary;
    if (!port) return;
    const c = new AbortController();
    port.list(c.signal).then(
      (v) => {
        if (!c.signal.aborted) {
          setLibrary(v);
          setLibraryError(undefined);
        }
      },
      (e) => {
        if (!c.signal.aborted) setLibraryError(message(e, '목소리 보관함을 불러오지 못했어요.'));
      },
    );
    return () => c.abort();
  }, [controls.voiceLibrary, voicesRevision]);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => queue.onError(() => setSaveFailed(true)), [queue]);
  useEffect(() => {
    // A newer choice from this session may still be on its way to the server; it wins over a read.
    if (restored) return;
    const run = new AbortController();
    queue.port.preferences(run.signal).then(
      (value) => {
        if (run.signal.aborted) return;
        // Restored as saved, missing ids included; anything picked meanwhile is kept.
        if (value) {
          setEngineChoice((current) => current ?? (value.engineId || undefined));
          setNarratorChoice((current) => current ?? (value.narratorVoiceId || undefined));
          setPoolChoice((current) => current ?? value.characterVoiceIds);
          setCastingChoice((current) => current ?? value.casting);
          setActingChoice((current) => current ?? value.autoActing);
        }
        setPrefs('ready');
      },
      (error) => {
        if (!run.signal.aborted && !isAbort(error)) setPrefs('failed');
      },
    );
    return () => run.abort();
  }, [queue, restored]);

  // ───────── analysis models ─────────
  const [engines, setEngines] = useState<readonly SpeakerEngine[]>();
  const [engineError, setEngineError] = useState<string>();
  useEffect(() => {
    const run = new AbortController();
    setEngineError(undefined);
    latest.current.engines.list(run.signal).then(
      (next) => !run.signal.aborted && setEngines(next),
      (error) => {
        if (!run.signal.aborted && !isAbort(error)) setEngineError(message(error, '분석 모델을 불러오지 못했어요.'));
      },
    );
    return () => run.abort();
  }, [enginesRevision]);
  // A choice is kept by id while the list reloads; if it disappears it is shown as missing, never swapped.
  const analysisEngines = engines?.filter((e) => e.purpose !== 'casting');
  const firstEnabled = analysisEngines?.find((engine) => engine.enabled)?.id;
  const engineId = engineChoice ?? firstEnabled ?? '';
  const engine = analysisEngines?.find((item) => item.id === engineId);
  const engineMissing = Boolean(engines && engineId && !engine);
  const engineOff = engine?.enabled === false;

  // ───────── voices ─────────
  const catalog = controls.voices;
  const voices: readonly PlainTTSVoice[] = catalog?.voices ?? [];
  const providers: readonly PlainTTSProviderStatus[] = catalog?.providers ?? [];
  const down = (voice: PlainTTSVoice) =>
    providers.find((provider) => provider.id === voice.providerId)?.available === false;
  const narratorId = narratorChoice ?? (controls.narratorVoiceId || catalog?.defaultVoiceId || '');
  const narrator = voices.find((voice) => voice.id === narratorId);
  const narratorMissing = Boolean(catalog && narratorId && !narrator);
  const narratorDown = narrator ? down(narrator) : false;
  // Untouched pool = the narrator's engine, so a free narrator never quietly pulls in a paid engine.
  const poolFor = (id: string) => {
    const lead = voices.find((voice) => voice.id === id);
    const eligible = voices
      .filter((voice) => lead && voice.id !== id && voice.providerId === lead.providerId && !down(voice))
      .filter((voice) => library?.voices.find((v) => v.voiceId === voice.id)?.enabled !== false)
      .map((voice) => voice.id);
    const curated = eligible.filter((id) => library?.voices.some((v) => v.voiceId === id && v.enabled));
    if (!eligible.length && lead && !down(lead) && library?.voices.find((v) => v.voiceId === id)?.enabled !== false)
      return [id];
    return (curated.length ? curated : eligible).slice(0, 32);
  };
  const defaultPool = poolFor(narratorId);
  const pool = poolChoice ?? defaultPool;
  const poolIsDefault = pool.length === defaultPool.length && defaultPool.every((id) => pool.includes(id));
  const poolMissing = pool.filter((id) => catalog && !voices.some((voice) => voice.id === id));
  const poolDown = pool.filter((id) => {
    const voice = voices.find((item) => item.id === id);
    return voice ? down(voice) : false;
  });

  /** Only the person's own changes are saved; restoring or defaulting never writes back. */
  const choose = (change: Partial<SpeakerGenerationPreferences> & { resetPool?: boolean }) => {
    const narratorVoiceId = change.narratorVoiceId ?? narratorId;
    // New voices are made on the narrator's own Flash connection, so a narrator change carries it along.
    const follow =
      change.narratorVoiceId !== undefined && !change.casting && castingChoice?.autoDesign
        ? flashDesigner(
            voices.find((voice) => voice.id === narratorVoiceId),
            library?.designers,
          )
        : undefined;
    const next = follow
      ? { ...change, casting: { ...castingChoice!, designProviderId: follow.id, designModelId: follow.modelId } }
      : change;
    const characterVoiceIds = next.resetPool
      ? poolFor(narratorVoiceId)
      : (next.characterVoiceIds ?? [...(poolChoice ?? poolFor(narratorVoiceId))]);
    if (next.engineId !== undefined) setEngineChoice(next.engineId);
    if (next.narratorVoiceId !== undefined) setNarratorChoice(next.narratorVoiceId);
    if (next.characterVoiceIds !== undefined) setPoolChoice(next.characterVoiceIds);
    if (next.casting !== undefined) setCastingChoice(next.casting);
    if (next.autoActing !== undefined) setActingChoice(next.autoActing);
    if (next.resetPool) setPoolChoice(undefined);
    if (prefs !== 'ready') return;
    setSaveFailed(false);
    queue.save({
      engineId: next.engineId ?? engineId,
      narratorVoiceId,
      characterVoiceIds,
      casting: next.casting ?? castingChoice,
      // Only an explicit on/off is saved; no saved choice means "on whenever the voices support it".
      ...((next.autoActing ?? actingChoice) !== undefined ? { autoActing: next.autoActing ?? actingChoice } : {}),
    });
  };
  // Voice creation is a Gemini 3.8 Flash TTS feature: only a Flash narrator opens it, on that same connection.
  const designing = !!castingChoice?.autoDesign && castingMode(castingChoice) !== 'order';
  const naturalVoices = castingMode(castingChoice) === 'create';
  const designer = flashDesigner(narrator, library?.designers);
  const designProblem =
    !designing || !library || designer
      ? undefined
      : '새 목소리 만들기는 내레이터가 Gemini 3.8 Flash TTS일 때만 쓸 수 있어요. 내레이터나 배정 방식을 바꿔 주세요.';
  // A restored design choice may carry a 0 limit; the server refuses it, so it is asked for instead of sent.
  const budgetProblem =
    designing && !validBudget(castingChoice!.maxDesignedVoices) ? '새로 만들 인물 수를 정해 주세요.' : undefined;
  // Saved connection ids may be stale; what is sent always names the narrator's current connection.
  const casting =
    designing && designer
      ? { ...castingChoice!, designProviderId: designer.id, designModelId: designer.modelId }
      : castingChoice;
  // Automatic acting is on by default when the narrator and pool all support it; an explicit off is kept.
  const actingUnsupported = [narratorId, ...pool].filter(
    (id) => voices.find((voice) => voice.id === id)?.autoActingSupported !== true,
  );
  const actingAvailable = Boolean(narratorId) && actingUnsupported.length === 0;
  const autoActing = actingChoice ?? actingAvailable;
  const togglePool = (id: string) =>
    choose({ characterVoiceIds: pool.includes(id) ? pool.filter((item) => item !== id) : [...pool, id] });

  // ───────── new job ─────────
  const range = useChapterScope(controls.chapters, controls.currentChapterId);
  const problem = !engines
    ? undefined
    : analysisEngines?.length === 0
      ? '먼저 분석 모델을 연결해 주세요.'
      : !engineId
        ? '분석 모델을 골라 주세요.'
        : engineMissing
          ? '고른 분석 모델을 찾을 수 없어요. 다시 골라 주세요.'
          : engineOff
            ? '고른 분석 모델이 꺼져 있어요.'
            : !catalog?.available || voices.length === 0
              ? '서버 TTS 목소리가 준비되면 만들 수 있어요.'
              : !narratorId || narratorMissing
                ? '내레이터 목소리를 다시 골라 주세요.'
                : narratorDown
                  ? '내레이터 목소리의 엔진에 연결할 수 없어요.'
                  : poolMissing.length
                    ? '목록에 없는 인물 목소리를 빼 주세요.'
                    : poolDown.length
                      ? '연결이 안 되는 엔진의 인물 목소리를 빼 주세요.'
                      : pool.length === 0
                        ? '인물 목소리를 하나 이상 골라 주세요.'
                        : range.selected.length === 0
                          ? '만들 회차를 골라 주세요.'
                          : autoActing && !actingAvailable
                            ? '장면 연기를 지원하지 않는 목소리가 있어요. 장면 연기를 끄거나 목소리를 바꿔 주세요.'
                            : (designProblem ?? budgetProblem);
  // Missing models or voices are already explained in their own section.
  const problemAbove = analysisEngines?.length === 0 || !catalog?.available || voices.length === 0;
  const input: SpeakerGenerationInput | undefined =
    engines &&
    !problem &&
    prefs !== 'loading' &&
    (!controls.voiceLibrary || !!library) &&
    (!castingChoice?.engineId ||
      !!engines.find((e) => e.id === castingChoice.engineId && e.enabled && e.purpose === 'casting'))
      ? {
          chapterIds: range.selected.map((chapter) => chapter.id),
          engineId,
          narratorVoiceId: narratorId,
          characterVoiceIds: [...pool],
          ...(casting ? { casting } : {}),
          // The default for voices without support stays implicit; explicit choices are always sent.
          ...(actingChoice !== undefined || autoActing ? { autoActing } : {}),
          rules: controls.rules,
          footnotePlayback: controls.footnotePlayback,
        }
      : undefined;
  const inputKey = input ? JSON.stringify(input) : '';
  const [estimate, setEstimate] = useState<{ key: string; value: SpeakerGenerationEstimate }>();
  const fresh = estimate && estimate.key === inputKey ? estimate.value : undefined;
  const [paidAck, setPaidAck] = useState(false);
  const [working, setWorking] = useState<'estimate' | 'create'>();
  // State updates land after the click; the ref stops a second create from the same plan in between.
  const creating = useRef(false);
  const [createError, setCreateError] = useState<string>();
  const createRun = useRef<AbortController>();
  useEffect(() => () => createRun.current?.abort(), []);
  useEffect(() => {
    setPaidAck(false);
    setCreateError(undefined);
  }, [inputKey]);

  const runEstimate = async () => {
    if (!input || creating.current) return;
    createRun.current?.abort();
    const run = new AbortController();
    createRun.current = run;
    setWorking('estimate');
    setCreateError(undefined);
    try {
      const value = await latest.current.port.estimate(input, run.signal);
      if (!run.signal.aborted) setEstimate({ key: inputKey, value });
    } catch (error) {
      if (!run.signal.aborted && !isAbort(error)) setCreateError(message(error, '분석 범위를 확인하지 못했어요.'));
    } finally {
      if (createRun.current === run) setWorking(undefined);
    }
  };

  const runCreate = async () => {
    if (!input || !fresh || (fresh.paid && !paidAck) || creating.current) return;
    creating.current = true;
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
      // A timed-out request may still have started the job; the same plan returns it again.
      setCreateError(message(error, '만들기를 시작하지 못했어요. 목록을 확인해 주세요.'));
    } finally {
      creating.current = false;
      if (createRun.current === run) setWorking(undefined);
      if (!run.signal.aborted) void refresh();
    }
  };

  // ───────── job actions ─────────
  const [confirm, setConfirm] = useState<Confirm>();
  const [pending, setPending] = useState<string>();
  const acting = useRef(false);
  const [actionError, setActionError] = useState<{ id: string; text: string }>();
  const act = async (id: string, task: () => Promise<SpeakerGenerationJob | void>) => {
    if (acting.current) return;
    acting.current = true;
    setPending(id);
    setActionError(undefined);
    try {
      const next = await task();
      if (!alive.current) return;
      if (next) setItems((current) => current?.map((item) => (item.id === next.id ? next : item)));
      else setItems((current) => current?.filter((item) => item.id !== id));
      setConfirm(undefined);
    } catch (error) {
      if (alive.current) setActionError({ id, text: message(error, '요청을 처리하지 못했어요.') });
    } finally {
      acting.current = false;
      if (alive.current) {
        setPending(undefined);
        void refresh();
      }
    }
  };
  const resume = (item: SpeakerGenerationJob, confirmed = false) => {
    if (item.paid && !confirmed) return setConfirm({ id: item.id, action: 'resume' });
    void act(item.id, () => latest.current.port.control(item.id, 'resume', item.paid && confirmed));
  };
  const listen = async (item: SpeakerGenerationJob) => {
    setActionError(undefined);
    try {
      await latest.current.listen(item);
    } catch (error) {
      if (alive.current) setActionError({ id: item.id, text: message(error, '본문에서 듣기를 시작하지 못했어요.') });
    }
  };

  const voiceGroups = groupVoices(voices, providers);
  const missingPoolVoices = poolChoice?.filter((id) => !voices.some((voice) => voice.id === id)) ?? [];
  const hasVoices = !!catalog?.available && voices.length > 0;
  const mode = controls.voiceLibrary ? castingMode(castingChoice) : 'order';
  // The same list means different things per mode; its name says which.
  const poolTitle = mode === 'create' ? '그 밖의 인물용 목소리' : mode === 'pick' ? '후보 목소리' : '배정할 목소리';
  const poolDescribed = pool.filter((id) => {
    const saved = library?.voices.find((v) => v.voiceId === id);
    return !!(
      saved?.timbre.trim() ||
      saved?.description.trim() ||
      voices.find((v) => v.id === id)?.description?.trim()
    );
  }).length;
  const poolNames = pool
    .map((id) => library?.voices.find((v) => v.voiceId === id)?.alias || voices.find((v) => v.id === id)?.label || id)
    .join(', ');
  const poolPicker = hasVoices && (
    <details className="un-cast-options un-cast-pool-box">
      <summary>
        <span>
          {poolTitle} · {pool.length}개
        </span>
        {pool.length > 0 && <small>{poolNames}</small>}
      </summary>
      <div className="un-cast-field">
        <span id="un-cast-pool">
          {poolTitle} <small>{formatCount(pool.length)}개 선택</small>
        </span>
        {voiceGroups.map((group) => (
          <div key={group.key} className="un-cast-pool">
            {voiceGroups.length > 1 && <small>{group.label}</small>}
            <div className="un-listen-chips" role="group" aria-labelledby="un-cast-pool">
              {group.voices.map((voice) => {
                const isNarrator = voice.id === narratorId;
                const on = pool.includes(voice.id);
                return (
                  <button
                    key={voice.id}
                    type="button"
                    aria-pressed={on}
                    className={cx(on && 'is-active')}
                    disabled={prefs === 'loading' || (down(voice) && !on) || (!on && pool.length >= 32)}
                    onClick={() => togglePool(voice.id)}
                  >
                    {voice.label}
                    {isNarrator ? ' · 내레이터' : voice.paid ? ' · 유료' : ''}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {missingPoolVoices.length > 0 && (
          <div className="un-listen-chips" role="group" aria-label="목록에 없는 인물 목소리">
            {missingPoolVoices.map((id) => (
              <button key={id} type="button" aria-pressed className="is-active" onClick={() => togglePool(id)}>
                목록에 없음 · {id}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="un-book-note">
        한 번 정한 인물 목소리는 이 작품에서 계속 써요.
        {!poolIsDefault && (
          <>
            {' '}
            <button type="button" className="un-listen-link" onClick={() => choose({ resetPool: true })}>
              기본 목록으로 되돌리기
            </button>
          </>
        )}
      </p>
    </details>
  );

  return (
    <div className="un-book un-cast">
      <p className="un-cast-flag">
        <FlaskConical size={15} aria-hidden="true" />
        <span>
          <b>실험 기능</b> · 화자가 불확실한 문장은 내레이터가 읽어요.
        </span>
      </p>

      <section className="un-book-group" aria-labelledby="un-cast-range">
        <div className="un-book-group-head">
          <h3 id="un-cast-range">생성할 범위</h3>
        </div>
        <ChapterScopeFields state={range} />
        <p className="un-book-note">
          만들 범위: <b>{chapterScopeSummary(range)}</b>
        </p>
      </section>

      <section className="un-book-group" aria-labelledby="un-cast-engine">
        <div className="un-book-group-head">
          <h3 id="un-cast-engine">분석 모델</h3>
          {onManageEngines && (
            <button type="button" className="un-btn is-text is-sm" onClick={onManageEngines}>
              <Settings2 size={14} aria-hidden="true" />
              연결 관리
            </button>
          )}
        </div>
        <p className="un-book-note">대사마다 누가 말하는지 찾아요.</p>
        {engineError ? (
          <p className="un-book-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            {engineError}
          </p>
        ) : !engines ? (
          <p className="un-book-note">불러오는 중…</p>
        ) : analysisEngines?.length === 0 ? (
          <div className="un-book-note is-box">
            아직 연결한 분석 모델이 없어요.{' '}
            {onManageEngines && (
              <button type="button" className="un-listen-link" onClick={onManageEngines}>
                분석 모델 연결
              </button>
            )}
          </div>
        ) : (
          <select
            aria-label="분석 모델"
            value={engineId}
            disabled={prefs === 'loading'}
            onChange={(event) => choose({ engineId: event.target.value })}
          >
            {!engineId && <option value="">분석 모델 고르기</option>}
            {engineMissing && <option value={engineId}>목록에 없는 분석 모델</option>}
            {analysisEngines?.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.enabled && item.id !== engineId}>
                {item.name}
                {item.name !== item.modelId ? ` · ${item.modelId}` : ''}
                {item.paid ? ' · 유료 API' : ''}
                {!item.enabled ? ' · 꺼짐' : ''}
              </option>
            ))}
          </select>
        )}
      </section>

      <section className="un-book-group" aria-labelledby="un-cast-voices">
        <div className="un-book-group-head">
          <h3 id="un-cast-voices">내레이터</h3>
          <button
            type="button"
            className="un-icon-btn is-sm"
            onClick={() => void latest.current.refreshVoices()}
            aria-label="목소리 목록 새로고침"
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {!catalog?.available || voices.length === 0 ? (
          <p className="un-book-note is-box">
            {catalog?.message ?? '목소리를 불러오는 중이에요.'} 목소리는 듣기 설정의 TTS 연결에서 추가해요.
          </p>
        ) : (
          <>
            <select
              aria-label="내레이터 목소리"
              value={narratorId}
              disabled={prefs === 'loading'}
              onChange={(event) => choose({ narratorVoiceId: event.target.value })}
            >
              {!narratorId && <option value="">목소리 고르기</option>}
              {narratorMissing && <option value={narratorId}>목록에 없는 목소리 · {narratorId}</option>}
              {voiceGroups.map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.voices.map((voice) => (
                    <option key={voice.id} value={voice.id} disabled={down(voice) && voice.id !== narratorId}>
                      {voice.label}
                      {voice.paid ? ' · 유료 API' : ''}
                      {down(voice) ? ' · 연결 안 됨' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="un-book-note">
              지문과 화자가 불확실한 문장을 읽어요.
              {designer ? ' Gemini 3.8 Flash TTS라 인물마다 새 목소리를 만들 수 있어요.' : ''}
            </p>
          </>
        )}
      </section>

      {controls.voiceLibrary ? (
        <>
          {libraryError && (
            <p className="un-book-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              {libraryError}
            </p>
          )}
          <UiNextCastingOptions
            value={castingChoice}
            engines={engines?.filter((e) => e.purpose === 'casting') ?? []}
            designer={designer}
            disabled={prefs === 'loading'}
            pool={poolPicker}
            poolDescribed={{ described: poolDescribed, total: pool.length }}
            onChange={(casting) => choose({ casting })}
            onManage={onManageEngines}
            onLibrary={onManageVoices}
          />
        </>
      ) : (
        hasVoices && (
          <section className="un-book-group" aria-label="인물 목소리">
            <div className="un-book-group-head">
              <h3>인물 목소리</h3>
            </div>
            {poolPicker}
            <p className="un-book-note">고른 목소리를 인물마다 돌아가며 써요.</p>
          </section>
        )
      )}

      <section className="un-book-group" aria-labelledby="un-cast-acting">
        <div className="un-book-group-head">
          <h3 id="un-cast-acting">장면 연기</h3>
          <small>선택</small>
        </div>
        <label className="un-book-ack un-cast-toggle">
          <input
            type="checkbox"
            checked={autoActing}
            disabled={prefs === 'loading' || (!autoActing && !actingAvailable)}
            onChange={(event) => choose({ autoActing: event.target.checked })}
          />
          <span>
            감정·속도 살려 읽기
            <small className="un-book-note">
              {actingAvailable
                ? '목소리는 그대로 두고 장면마다 말하는 느낌만 바꿔요. 화자 분석과 함께 처리해요.'
                : actingUnsupported.length === [narratorId, ...pool].length
                  ? '지금 고른 목소리로는 쓸 수 없어요.'
                  : `지원하지 않는 목소리가 있어 쓸 수 없어요: ${actingUnsupported
                      .slice(0, 3)
                      .map((id) => voices.find((voice) => voice.id === id)?.label ?? id)
                      .join(', ')}${actingUnsupported.length > 3 ? ` 외 ${actingUnsupported.length - 3}개` : ''}`}
            </small>
          </span>
        </label>
      </section>

      <section className="un-book-group" aria-label="만들기">
        {problem && engines && !problemAbove && <p className="un-book-note is-box">{problem}</p>}
        {prefs === 'failed' && (
          <p className="un-book-note" role="status">
            저장한 설정을 불러오지 못했어요. 지금 바꾸는 설정은 저장되지 않아요.
          </p>
        )}
        {saveFailed && (
          <p className="un-book-note" role="status">
            설정을 저장하지 못했어요. 다시 바꾸면 다시 저장해요.
          </p>
        )}
        {fresh && (
          <div className="un-book-estimate" aria-label="생성 확인">
            <dl>
              <div>
                <dt>만들 회차</dt>
                <dd>{formatCount(fresh.chapterCount)}</dd>
              </div>
              <div>
                <dt>앞 회차(분석만)</dt>
                <dd>{formatCount(fresh.contextChapterCount)}</dd>
              </div>
              <div>
                <dt>낭독 글자</dt>
                <dd>{formatCount(fresh.characters)}</dd>
              </div>
            </dl>
            {fresh.contextChapterCount > 0 && (
              <p className="un-book-voice">
                인물을 알아보려고 앞 {formatCount(fresh.contextChapterCount)}개 회차도 읽어요. 음성은 만들지 않아요.
              </p>
            )}
            <ul className="un-cast-plan" aria-label="이번 작업에서 쓰는 모델">
              <li>
                <span>화자 분석</span>
                <b>{fresh.modelLabel}</b>
              </li>
              {fresh.selectionModelLabel && (
                <li>
                  <span>목소리 배정</span>
                  <b>{fresh.selectionModelLabel}</b>
                </li>
              )}
              {!!fresh.maxDesignedVoices && (
                <li>
                  <span>새 목소리</span>
                  <b>
                    {designer?.name ?? 'Gemini 3.8 Flash TTS'} · 최대 {fresh.maxDesignedVoices}명
                  </b>
                </li>
              )}
              {input?.autoActing && (
                <li>
                  <span>장면 연기</span>
                  <b>켬 · 화자 분석과 함께</b>
                </li>
              )}
              <li>
                <span>음성 합성</span>
                <b>{fresh.voiceLabel}</b>
              </li>
            </ul>
            {!!fresh.maxDesignedVoices && (
              <p className="un-book-note">
                {naturalVoices
                  ? `주요·조연에게 최대 ${fresh.maxDesignedVoices}명까지 새 목소리를 만들어요. 직접 지정한 인물은 그대로예요.`
                  : `주요 인물에게 최대 ${fresh.maxDesignedVoices}명까지 새 목소리를 만들어요.`}
              </p>
            )}
            {fresh.paid && (
              <label className="un-book-ack">
                <input type="checkbox" checked={paidAck} onChange={(event) => setPaidAck(event.target.checked)} />
                <span>유료 API 요금이 나올 수 있어요. 확인했어요.</span>
              </label>
            )}
          </div>
        )}
        {createError && (
          <p className="un-book-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            {createError}
          </p>
        )}
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
              {working === 'estimate' ? '확인하는 중' : '생성 전 확인'}
            </button>
          )}
        </div>
      </section>

      <section className="un-book-group" aria-labelledby="un-cast-saved">
        <div className="un-book-group-head">
          <h3 id="un-cast-saved">만든 음성</h3>
          <button
            type="button"
            className="un-icon-btn is-sm"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="목록 새로고침"
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
            아직 없어요. 앱을 닫아도 서버에서 계속 만들고, 준비된 회차부터 들을 수 있어요.
          </p>
        ) : (
          <ul className="un-book-list">
            {items.map((item) => (
              <JobItem
                key={item.id}
                item={item}
                bookVoices={<UiNextBookVoices job={item} port={controls.port} voices={voices} />}
                revoice={
                  <UiNextSpeakerRevoice
                    job={item}
                    port={controls.port}
                    voices={voices}
                    library={library?.voices}
                    engines={engines}
                    designers={library?.designers}
                    onCreated={() => void refresh()}
                  />
                }
                pending={pending === item.id}
                confirm={confirm?.id === item.id ? confirm.action : undefined}
                error={actionError?.id === item.id ? actionError.text : undefined}
                onPlay={() => void listen(item)}
                onPause={() => void act(item.id, () => latest.current.port.control(item.id, 'pause'))}
                onResume={(confirmed) => resume(item, confirmed)}
                onRemove={(confirmed) =>
                  confirmed
                    ? void act(item.id, () => latest.current.port.remove(item.id))
                    : setConfirm({ id: item.id, action: 'remove' })
                }
                onCancel={() => setConfirm(undefined)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function groupVoices(voices: readonly PlainTTSVoice[], providers: readonly PlainTTSProviderStatus[]) {
  const groups: { key: string; label: string; voices: PlainTTSVoice[] }[] = [];
  for (const voice of voices) {
    const key = voice.providerId ?? '';
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      const provider = providers.find((candidate) => candidate.id === key);
      group = { key, label: provider?.name ?? voice.providerName ?? '서버', voices: [] };
      groups.push(group);
    }
    group.voices.push(voice);
  }
  return groups;
}

function rangeLabel(item: SpeakerGenerationJob) {
  const { firstChapterTitle: first, lastChapterTitle: last } = item;
  if (first && last && first !== last) return `${first} ~ ${last}`;
  return first ?? last ?? `${formatCount(item.chapterCount)}개 회차`;
}

function JobItem({
  item,
  bookVoices,
  revoice,
  pending,
  confirm,
  error,
  onPlay,
  onPause,
  onResume,
  onRemove,
  onCancel,
}: {
  item: SpeakerGenerationJob;
  bookVoices?: import('react').ReactNode;
  revoice?: import('react').ReactNode;
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
  const ready = item.readyChapterIds.length;
  const playable = item.status !== 'deleting' && ready > 0;
  const remaining = Math.max(0, item.itemCount - item.completedItems);
  // The job does not say whether it acts, so the acting step is listed only while it runs.
  const steps = STEPS.filter(([stage]) => stage !== 'performance' || item.stage === 'performance');
  const step = steps.findIndex(([stage]) => stage === item.stage);
  const showSteps = item.status !== 'completed' && item.stage !== 'complete';

  return (
    <li className="un-book-item">
      <div className="un-book-item-head">
        <b>{rangeLabel(item)}</b>
        <span className={cx('un-book-badge', `is-${item.status}`)}>
          {item.status === 'queued' && item.retryAt ? '재시도 대기' : STATUS_LABEL[item.status]}
        </span>
      </div>
      <small className="un-book-meta">
        {formatCount(item.chapterCount)}개 회차 · {item.voiceLabel} · {item.providerName}
        {item.revoiceFrom ? ' · 목소리 바꾼 버전' : ''}
      </small>
      {showSteps && (
        <ol className="un-cast-steps" aria-label="진행 단계">
          {steps.map(([stage, label], index) => (
            <li
              key={stage}
              className={cx(index < step && 'is-done', index === step && 'is-current')}
              aria-current={index === step ? 'step' : undefined}
            >
              {label}
            </li>
          ))}
        </ol>
      )}
      <SpeakerJobProgress item={item} />
      {(error || (item.error && !(item.status === 'queued' && item.retryAt))) && (
        <p
          className={!error && item.status === 'queued' ? 'un-book-meta' : 'un-book-error'}
          role={!error && item.status === 'queued' ? 'status' : 'alert'}
        >
          <AlertCircle size={15} aria-hidden="true" />
          {error ?? item.error}
        </p>
      )}
      {revoice}
      {bookVoices}
      {confirm ? (
        <div
          className="un-book-confirm"
          role="group"
          aria-label={confirm === 'remove' ? '삭제 확인' : '이어 만들기 확인'}
        >
          <p>
            {confirm === 'remove'
              ? `만든 음성 ${formatBytes(item.bytes)}를 서버에서 지워요. 되돌릴 수 없어요.`
              : `${item.planningComplete === false || item.itemCount === 0 ? '남은 회차를 이어서 만들어요.' : `남은 ${formatCount(remaining)}개 구간을 이어서 만들어요.`} 유료 API 요금이 나올 수 있어요.`}
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
          {item.status !== 'deleting' && (
            <button type="button" className="un-btn is-ghost is-sm" onClick={onPlay} disabled={pending || !playable}>
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
          {stopped && (
            <button type="button" className="un-btn is-text is-sm" onClick={() => onResume()} disabled={pending}>
              <Play size={14} aria-hidden="true" />
              {item.status === 'failed' ? '다시 시도' : '이어 만들기'}
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
