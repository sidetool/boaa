import { ArrowDown, ArrowUp, FileUp, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { projectSpokenText } from '@boaa/text-core/spoken-text';
import { parseTTSFilterFile, validateSpokenTextFilter } from '@boaa/text-core/spoken-text-filter';
import type { SpokenTextRule } from '../../domain/types';
import type { SpokenTextFilterInput } from '../../features/tts/TTSAddonPanel';
import { cx, Segmented, Switch } from '../components/primitives';

type FilterKind = SpokenTextFilterInput['kind'];
type Scope = SpokenTextFilterInput['scope'];

const MAX_FILTERS = 100;
const MAX_FIELD = 256;
const MAX_FILE_BYTES = 64 * 1024;
const KIND_LABEL: Record<FilterKind, string> = { replace_literal: '단어', replace_regex: '정규식' };
const SCOPE_LABEL: Record<Scope, string> = { book: '이 작품', global: '모든 작품' };

const isFilter = (rule: SpokenTextRule) => rule.kind === 'replace_literal' || rule.kind === 'replace_regex';
const asRule = (input: SpokenTextFilterInput, priority: number): SpokenTextRule => ({
  id: input.id ?? 'draft',
  scope: input.scope,
  kind: input.kind as SpokenTextRule['kind'],
  pattern: input.pattern,
  replacement: input.replacement,
  enabled: true,
  priority,
  updatedAt: '',
});
const toInput = (rule: SpokenTextRule, patch: Partial<SpokenTextFilterInput> = {}): SpokenTextFilterInput => ({
  id: rule.id,
  scope: rule.scope,
  kind: rule.kind as FilterKind,
  pattern: rule.pattern,
  replacement: rule.replacement ?? '',
  enabled: rule.enabled,
  priority: rule.priority,
  ...patch,
});
// Spaces matter in both fields; show them so "읽을 말" left blank or padded is visible.
const shown = (value: string) => (value === '' ? '(읽지 않음)' : value.replace(/ /g, '␣'));

interface ImportReview {
  readonly fileName: string;
  readonly rows: readonly { pattern: string; replacement: string; error?: string }[];
  readonly lineErrors: readonly { line: number; message: string }[];
}

export interface UiNextSpokenTextFiltersProps {
  readonly rules: readonly SpokenTextRule[];
  readonly language?: string;
  readonly currentParagraphText?: string;
  readonly requestedText?: string;
  save(input: SpokenTextFilterInput): Promise<void>;
  importFilters?(inputs: readonly SpokenTextFilterInput[]): Promise<void>;
  remove(id: string): void | Promise<unknown>;
}

/** Plain-TTS pronunciation filters: fix a word while listening, with a live before/after of the current paragraph. */
export default function UiNextSpokenTextFilters(props: UiNextSpokenTextFiltersProps) {
  const filters = useMemo(() => props.rules.filter(isFilter).sort((a, b) => a.priority - b.priority), [props.rules]);
  const otherRules = useMemo(() => props.rules.filter((rule) => !isFilter(rule)), [props.rules]);

  // Editor
  const [editingId, setEditingId] = useState<string>();
  const [kind, setKind] = useState<FilterKind>('replace_literal');
  const [scope, setScope] = useState<Scope>('book');
  const [pattern, setPattern] = useState('');
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const editing = filters.find((rule) => rule.id === editingId);
  const draftError = pattern ? validateSpokenTextFilter({ kind, pattern, replacement }) : undefined;
  const atLimit = !editing && props.rules.length >= MAX_FILTERS;
  const canSave = Boolean(pattern) && !draftError && !busy && !atLimit;
  const nextPriority = (filters.at(-1)?.priority ?? 0) + 10;

  // Preview follows the paragraph being read until the listener types their own sentence.
  // Saving stops playback, so keep the last paragraph to show the result of the fix just made.
  const liveText = props.currentParagraphText ?? props.requestedText ?? '';
  const [lastLiveText, setLastLiveText] = useState(liveText);
  useEffect(() => {
    if (liveText) setLastLiveText(liveText);
  }, [liveText]);
  const followedText = liveText || lastLiveText;
  const [customSample, setCustomSample] = useState<string>();
  const sample = customSample ?? followedText;
  const draftRule =
    pattern && !draftError
      ? asRule({ scope, kind, pattern, replacement, enabled: true }, editing?.priority ?? nextPriority)
      : undefined;
  const project = (rules: readonly SpokenTextRule[]) =>
    projectSpokenText({
      text: sample,
      language: props.language ?? 'ko-KR',
      rules,
      rubyPolicy: 'reading',
      footnotePolicy: 'skip_marker',
    }).spokenText;
  let saved = '';
  let withDraft = '';
  let previewError: string | undefined;
  try {
    saved = sample ? project(props.rules) : '';
    withDraft =
      sample && draftRule
        ? project([...otherRules, ...filters.filter((rule) => rule.id !== editingId), draftRule])
        : saved;
  } catch (error) {
    previewError = error instanceof Error ? error.message : '미리보기를 만들지 못했어요.';
  }

  const run = async (action: () => Promise<unknown> | unknown) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(error instanceof Error && error.message ? error.message : '저장하지 못했어요. 다시 시도하세요.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const resetEditor = () => {
    setEditingId(undefined);
    setPattern('');
    setReplacement('');
  };
  const startEdit = (rule: SpokenTextRule) => {
    setEditingId(rule.id);
    setKind(rule.kind as FilterKind);
    setScope(rule.scope);
    setPattern(rule.pattern);
    setReplacement(rule.replacement ?? '');
  };
  const saveDraft = async () => {
    if (!canSave || previewError) return;
    const input: SpokenTextFilterInput = editing
      ? toInput(editing, { kind, scope, pattern, replacement })
      : { scope, kind, pattern, replacement, enabled: true, priority: nextPriority };
    if (await run(() => props.save(input))) resetEditor();
  };
  const move = (index: number, direction: -1 | 1) => {
    const order = [...filters];
    const [rule] = order.splice(index, 1);
    order.splice(index + direction, 0, rule!);
    // Renumber so equal or sparse priorities still produce the order shown.
    void run(async () => {
      const changes = order.map((item, position) => toInput(item, { priority: (position + 1) * 10 }));
      if (props.importFilters) await props.importFilters(changes);
      else for (const item of changes) await props.save(item);
    });
  };

  // Import: read → review → explicit add. Late reads from a replaced/cancelled pick are dropped.
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const [review, setReview] = useState<ImportReview>();
  const [importScope, setImportScope] = useState<Scope>('book');
  const [importError, setImportError] = useState<string>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  const closeReview = () => {
    generation.current += 1;
    setReview(undefined);
    setSkipFailed(false);
    setImportError(undefined);
  };
  const pickFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    closeReview();
    const current = generation.current;
    const stale = () => !mounted.current || generation.current !== current;
    if (file.size > MAX_FILE_BYTES) return setImportError('64KiB보다 큰 파일은 가져올 수 없어요.');
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (!stale()) setImportError('파일을 읽지 못했어요. 다시 선택하세요.');
      return;
    }
    if (stale()) return;
    const parsed = parseTTSFilterFile(text);
    setReview({
      fileName: file.name,
      rows: parsed.rules.map((rule) => ({
        pattern: rule.pattern,
        replacement: rule.replacement,
        error: validateSpokenTextFilter(rule),
      })),
      lineErrors: parsed.errors,
    });
  };
  const importable = review?.rows.filter((row) => !row.error) ?? [];
  const rejectedCount = review ? review.rows.length - importable.length + review.lineErrors.length : 0;
  // With failed lines the listener must explicitly agree to add only the valid ones.
  const [skipFailed, setSkipFailed] = useState(false);
  const importRoom = MAX_FILTERS - props.rules.length;
  const importBlocked = !importable.length || importable.length > importRoom || (rejectedCount > 0 && !skipFailed);
  const confirmImport = async () => {
    if (!props.importFilters || importBlocked) return;
    const inputs = importable.map<SpokenTextFilterInput>((row, index) => ({
      scope: importScope,
      kind: 'replace_regex',
      pattern: row.pattern,
      replacement: row.replacement,
      enabled: true,
      priority: nextPriority + index * 10,
    }));
    if (await run(() => props.importFilters!(inputs))) closeReview();
  };

  return (
    <div className="un-filter">
      <section className="un-filter-preview" aria-label="미리보기">
        <div className="un-filter-preview-head">
          <b>
            {customSample !== undefined
              ? '직접 입력'
              : props.currentParagraphText
                ? '지금 읽는 문단'
                : followedText
                  ? '최근 읽은 문단'
                  : '미리볼 문장'}
          </b>
          {customSample !== undefined && followedText && (
            <button type="button" className="un-listen-link" onClick={() => setCustomSample(undefined)}>
              <RotateCcw size={13} aria-hidden="true" /> 지금 문단으로
            </button>
          )}
        </div>
        <textarea
          aria-label="미리볼 원문"
          value={sample}
          rows={3}
          maxLength={10000}
          placeholder="고칠 문장을 붙여 넣거나, 듣는 중에 열면 지금 문단이 나와요."
          onChange={(event) => setCustomSample(event.target.value)}
        />
        <div className={cx('un-filter-result', withDraft !== saved && 'is-changed')} aria-live="polite">
          <small>
            {draftRule ? (withDraft !== saved ? '이 규칙을 넣으면' : '이 규칙으로는 바뀌는 곳이 없어요') : '읽을 내용'}
          </small>
          <p>{previewError ?? (sample ? withDraft || '(읽을 내용 없음)' : '—')}</p>
        </div>
      </section>

      <section className="un-filter-editor" aria-label={editing ? '필터 수정' : '필터 추가'}>
        <div className="un-filter-editor-head">
          <b>{editing ? '필터 수정' : '발음 고치기'}</b>
          <Segmented
            label="필터 종류"
            value={kind}
            options={[
              { value: 'replace_literal', label: '단어' },
              { value: 'replace_regex', label: '정규식' },
            ]}
            onChange={setKind}
          />
        </div>
        <div className="un-filter-fields">
          <label>
            <span>찾을 말</span>
            <input
              value={pattern}
              maxLength={MAX_FIELD}
              spellCheck={false}
              placeholder={kind === 'replace_regex' ? '예: (\\d+)화' : '예: HP'}
              onChange={(event) => setPattern(event.target.value)}
            />
          </label>
          <label>
            <span>읽을 말</span>
            <input
              value={replacement}
              maxLength={MAX_FIELD}
              spellCheck={false}
              placeholder={kind === 'replace_regex' ? '예: $1 화' : '예: 에이치피 · 비우면 읽지 않음'}
              onChange={(event) => setReplacement(event.target.value)}
            />
          </label>
        </div>
        <p className={cx('un-filter-help', draftError && 'is-error')} role={draftError ? 'alert' : undefined}>
          {draftError ??
            (kind === 'replace_regex'
              ? '읽을 말에 $1·$2(괄호 묶음), $&(찾은 전체), $$($ 기호)를 쓸 수 있어요. 전방탐색 (?!…)·(?=…)과 \\1 같은 역참조는 지원하지 않아요.'
              : '적은 그대로 찾아요. 공백도 그대로 지켜요.')}
        </p>
        <div className="un-filter-editor-foot">
          <Segmented
            label="적용 범위"
            value={scope}
            options={[
              { value: 'book', label: SCOPE_LABEL.book },
              { value: 'global', label: SCOPE_LABEL.global },
            ]}
            onChange={setScope}
          />
          <span className="un-filter-actions">
            {(editing || pattern || replacement) && (
              <button type="button" className="un-btn is-ghost is-sm" onClick={resetEditor} disabled={busy}>
                <X size={15} aria-hidden="true" /> 취소
              </button>
            )}
            <button
              type="button"
              className="un-btn is-sm"
              onClick={() => void saveDraft()}
              disabled={!canSave || Boolean(previewError)}
            >
              {editing ? <Pencil size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
              {editing ? '수정' : '추가'}
            </button>
          </span>
        </div>
        {atLimit && <p className="un-filter-help is-error">필터는 {MAX_FILTERS}개까지 둘 수 있어요.</p>}
        {actionError && (
          <p className="un-filter-help is-error" role="alert">
            {actionError}
          </p>
        )}
      </section>

      <section className="un-filter-list" aria-label="저장된 필터">
        <div className="un-filter-list-head">
          <b>저장된 필터</b>
          <small>
            {filters.length}/{MAX_FILTERS} · 위에서부터 적용
          </small>
          {props.importFilters && (
            <>
              <button
                type="button"
                className="un-btn is-ghost is-sm"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                <FileUp size={15} aria-hidden="true" /> 가져오기
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".ttsfilter,text/plain"
                hidden
                aria-label=".ttsfilter 파일"
                onChange={(event) => void pickFile(event.currentTarget)}
              />
            </>
          )}
        </div>
        {importError && (
          <p className="un-filter-help is-error" role="alert">
            {importError}
          </p>
        )}
        {review && (
          <div className="un-filter-review" role="region" aria-label="가져오기 검토">
            <div className="un-filter-review-head">
              <b>{review.fileName}</b>
              <small>
                추가 {importable.length}개
                {review.rows.length - importable.length + review.lineErrors.length > 0 &&
                  ` · 제외 ${review.rows.length - importable.length + review.lineErrors.length}개`}
              </small>
            </div>
            <ul>
              {review.rows.map((row, index) => (
                <li key={index} className={cx(row.error && 'is-error')}>
                  <code>{shown(row.pattern)}</code>
                  <span aria-hidden="true">→</span>
                  <code>{shown(row.replacement)}</code>
                  {row.error && <small>{row.error}</small>}
                </li>
              ))}
              {review.lineErrors.map((error) => (
                <li key={`line-${error.line}`} className="is-error">
                  <small>
                    {error.line}행 · {error.message}
                  </small>
                </li>
              ))}
            </ul>
            {importable.length > importRoom && (
              <p className="un-filter-help is-error">
                필터는 {MAX_FILTERS}개까지예요. 지금 {Math.max(0, importRoom)}개만 더 넣을 수 있어요.
              </p>
            )}
            {rejectedCount > 0 && (
              <label className="un-filter-check">
                <input
                  type="checkbox"
                  checked={skipFailed}
                  disabled={!importable.length}
                  onChange={(event) => setSkipFailed(event.target.checked)}
                />
                <span>
                  위 {rejectedCount}개 오류 행은 빼고 정상 {importable.length}개만 추가할게요.
                </span>
              </label>
            )}
            <div className="un-filter-editor-foot">
              <Segmented
                label="가져올 범위"
                value={importScope}
                options={[
                  { value: 'book', label: SCOPE_LABEL.book },
                  { value: 'global', label: SCOPE_LABEL.global },
                ]}
                onChange={setImportScope}
              />
              <span className="un-filter-actions">
                <button type="button" className="un-btn is-ghost is-sm" onClick={closeReview} disabled={busy}>
                  취소
                </button>
                <button
                  type="button"
                  className="un-btn is-sm"
                  onClick={() => void confirmImport()}
                  disabled={busy || importBlocked}
                >
                  {rejectedCount > 0 ? `정상 ${importable.length}개만 추가` : `${importable.length}개 추가`}
                </button>
              </span>
            </div>
          </div>
        )}
        {filters.length === 0 ? (
          <p className="un-filter-help">아직 필터가 없어요. 듣다가 이상한 발음이 들리면 위에서 바로 고쳐 보세요.</p>
        ) : (
          <ol className="un-filter-rules">
            {filters.map((rule, index) => (
              <li key={rule.id} className={cx(!rule.enabled && 'is-off', rule.id === editingId && 'is-editing')}>
                <Switch
                  label={`${rule.pattern} 필터 사용`}
                  checked={rule.enabled}
                  disabled={busy}
                  onChange={(enabled) => void run(() => props.save(toInput(rule, { enabled })))}
                />
                <span className="un-filter-rule-text">
                  <span>
                    <code>{shown(rule.pattern)}</code>
                    <span aria-hidden="true"> → </span>
                    <code>{shown(rule.replacement ?? '')}</code>
                  </span>
                  <small>
                    {KIND_LABEL[rule.kind as FilterKind]} · {SCOPE_LABEL[rule.scope]}
                  </small>
                </span>
                <span className="un-filter-rule-tools">
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${rule.pattern} 위로`}
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${rule.pattern} 아래로`}
                    disabled={busy || index === filters.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${rule.pattern} 수정`}
                    disabled={busy}
                    onClick={() => startEdit(rule)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${rule.pattern} 삭제`}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await props.remove(rule.id);
                        if (rule.id === editingId) resetEditor();
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="un-filter-help">
          낭독할 때 적용되고 원문은 바뀌지 않아요. 필터는 이 기기에만 저장되며 서버와 동기화되지 않아요. 저장하면 지금
          재생과 미리 준비한 음성을 멈추고, 다시 재생할 때부터 새 규칙으로 읽어요.
        </p>
      </section>
    </div>
  );
}
