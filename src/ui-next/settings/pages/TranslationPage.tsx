import { TranslateIcon } from '../../../shared/ui/translate-icon';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslationClient, translationError } from '../../../features/translation/translation-client';
import {
  DEFAULT_TRANSLATION_SETTINGS,
  validateTranslationSettings,
  type TranslationConfiguration,
  type TranslationProvider,
  type TranslationSettings,
} from '../../../translation/contracts';
import { FileJson, KeyRound } from 'lucide-react';
import { Notice, Pref, PrefField, PrefFold, PrefGroup, PrefSection, PrefSwitch } from '../../components/prefs';
import { ConfirmSheet } from '../../components/dialogs';
import { cx } from '../../components/primitives';
import './translation.css';

const PROVIDER_NAME: Record<TranslationProvider, string> = {
  gemini: 'Gemini API',
  vertex: 'Google Cloud · Vertex AI',
  'openai-compatible': 'OpenAI 호환 API',
};

export function TranslationPage() {
  const client = useTranslationClient();
  const [configuration, setConfiguration] = useState<TranslationConfiguration>();
  const [draft, setDraft] = useState<TranslationSettings>({ ...DEFAULT_TRANSLATION_SETTINGS });
  const [credential, setCredential] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [remove, setRemove] = useState<'key' | 'cache'>();
  const generation = useRef(0);
  const rememberedNextChapters = useRef(1);
  const alive = useRef(false);
  const invalidateRead = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    void client?.configuration(abort.signal).then(
      (value) => {
        setConfiguration(value);
        setDraft(value.settings);
        if (value.settings.nextChapters > 0) rememberedNextChapters.current = value.settings.nextChapters;
      },
      (reason) => {
        if (!abort.signal.aborted) setError(translationError(reason));
      },
    );
    return () => {
      alive.current = false;
      invalidateRead();
      abort.abort();
    };
  }, [client, invalidateRead]);
  const clearKey = () => {
    generation.current++;
    setCredential('');
    setFileName('');
  };
  const run = async (action: () => Promise<void>) => {
    if (busy || !client) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await action();
    } catch (reason) {
      if (alive.current) setError(translationError(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const patch = <K extends keyof TranslationSettings>(key: K, value: TranslationSettings[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const field = (
    label: string,
    key: 'model' | 'targetLanguage' | 'endpoint' | 'project' | 'location',
    help?: string,
    placeholder?: string,
  ) => (
    <PrefField label={label} help={help}>
      <input
        aria-label={label}
        value={draft[key]}
        disabled={busy}
        placeholder={placeholder}
        onChange={(event) => patch(key, event.target.value)}
        spellCheck={false}
      />
    </PrefField>
  );
  const number = (
    label: string,
    key: 'chunkCharacters' | 'concurrency' | 'nextChapters' | 'retries' | 'backoffSeconds' | 'timeoutSeconds',
    min: number,
    max: number,
  ) => (
    <Pref
      title={label}
      help={`${min.toLocaleString()}–${max.toLocaleString()}`}
      control={
        <input
          className="un-input un-translation-number"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          aria-label={label}
          value={draft[key]}
          disabled={busy}
          onChange={(event) => patch(key, Number(event.target.value))}
        />
      }
    />
  );
  if (!client) return <Notice>서버의 관리자 계정에서 작품 번역을 설정할 수 있어요.</Notice>;
  const saved = configuration?.credentials[draft.provider]?.saved === true;
  const vertex = draft.provider === 'vertex';
  // The header reports what is saved on the server, not the unsaved draft below it.
  const active = configuration?.settings;
  return (
    <div className="un-translation-settings">
      <header className={cx('un-translation-hero', active?.enabled && 'is-on')}>
        <span className="un-translation-art" aria-hidden="true">
          <TranslateIcon size={28} />
        </span>
        <div>
          <strong>{active?.enabled ? '작품 번역 켜짐' : '작품 번역 꺼짐'}</strong>
          <small>
            {active
              ? `${PROVIDER_NAME[active.provider]} · ${active.targetLanguage}로 번역 · 원문은 그대로 보관해요`
              : '설정을 불러오는 중'}
          </small>
        </div>
      </header>

      <PrefSection>
        <PrefGroup>
          <PrefSwitch
            title="작품 번역 사용"
            checked={draft.enabled}
            disabled={busy || !configuration}
            onChange={(value) => patch('enabled', value)}
            help="저장하면 적용돼요."
          />
          <PrefSwitch
            title="작품 제목도 번역"
            checked={draft.translateTitles === true}
            disabled={busy}
            onChange={(value) => patch('translateTitles', value)}
          />
          <PrefSwitch
            title="작품을 열면 자동 번역"
            checked={draft.automatic}
            disabled={busy}
            onChange={(value) => patch('automatic', value)}
            help="외국어 작품만 시작해요."
          />
          {draft.automatic && (
            <div className="un-translation-automatic-options">
              <PrefSwitch
                title="다음 화 미리 번역"
                checked={draft.nextChapters > 0}
                disabled={busy}
                onChange={(value) => {
                  if (!value) rememberedNextChapters.current = draft.nextChapters;
                  patch('nextChapters', value ? rememberedNextChapters.current : 0);
                }}
                help="미리 번역한 화에도 API 요금이 발생할 수 있어요."
              />
              {draft.nextChapters > 0 && number('미리 번역할 다음 화', 'nextChapters', 1, 3)}
            </div>
          )}
        </PrefGroup>
        <Notice>
          번역하면 원문이 선택한 제공자에게 전송되고 API 요금이 발생할 수 있어요. 현재는 관리자만 사용할 수 있어요.
        </Notice>
      </PrefSection>

      <PrefSection title="번역 엔진">
        <PrefGroup>
          <PrefField label="제공자">
            <select
              value={draft.provider}
              disabled={busy}
              onChange={(event) => {
                clearKey();
                patch('provider', event.target.value as TranslationProvider);
              }}
            >
              <option value="gemini">{PROVIDER_NAME.gemini}</option>
              <option value="vertex">{PROVIDER_NAME.vertex}</option>
              <option value="openai-compatible">{PROVIDER_NAME['openai-compatible']}</option>
            </select>
          </PrefField>
          {field('모델 ID', 'model', '텍스트 생성 모델 ID예요. TTS 모델은 쓸 수 없어요.')}
          {field('번역할 언어', 'targetLanguage', '언어 코드. 예: ko, en, ja')}
          {draft.provider === 'openai-compatible' &&
            field('API 기본 주소', 'endpoint', undefined, 'https://api.openai.com/v1')}
          {vertex && (
            <div className="un-translation-grid">
              {field('프로젝트', 'project', undefined, 'JSON의 project_id')}
              {field('리전', 'location', undefined, 'global')}
            </div>
          )}
          <div className="un-pref is-stacked un-translation-key">
            <div className="un-translation-key-head">
              <span className="un-pref-text">
                <strong>{vertex ? '서비스 계정 JSON' : 'API 키'}</strong>
              </span>
              <span className={cx('un-translation-state', saved && 'is-saved')}>
                {saved ? '서버에 암호화해 저장됨 · 원문 조회 불가' : '저장된 키 없음'}
              </span>
            </div>
            {vertex ? (
              <label className={cx('un-translation-file', busy && 'is-disabled')}>
                <FileJson size={18} aria-hidden="true" />
                <span>{fileName || 'JSON 파일 선택'}</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    clearKey();
                    if (!file) return;
                    const ticket = generation.current;
                    if (file.size > 65536) {
                      setError('64KB 이하의 서비스 계정 JSON을 선택해 주세요.');
                      return;
                    }
                    void file.text().then(
                      (text) => {
                        if (!alive.current || ticket !== generation.current) return;
                        try {
                          const json = JSON.parse(text);
                          if (
                            json.type !== 'service_account' ||
                            !json.private_key ||
                            !json.client_email ||
                            !json.project_id
                          )
                            throw new Error();
                          setCredential(text);
                          setFileName(file.name);
                          setError('');
                        } catch {
                          setError('올바른 서비스 계정 JSON이 아니에요.');
                        }
                      },
                      () => {
                        if (alive.current && ticket === generation.current)
                          setError('파일을 읽지 못했어요. 다시 선택해 주세요.');
                      },
                    );
                  }}
                />
              </label>
            ) : (
              <label className="un-translation-secret">
                <KeyRound size={17} aria-hidden="true" />
                <input
                  type="password"
                  aria-label="번역 API 키"
                  autoComplete="new-password"
                  placeholder={saved ? '새 키로 바꾸려면 입력' : '키 입력'}
                  value={credential}
                  disabled={busy}
                  onChange={(event) => setCredential(event.target.value)}
                />
              </label>
            )}
            {fileName && <small className="un-pref-field-help">저장을 눌러야 서버에 보관돼요.</small>}
            <div className="un-translation-actions">
              <button
                className="un-btn is-primary is-sm"
                disabled={busy || !credential}
                onClick={() =>
                  void run(async () => {
                    await client.credential(draft.provider, credential);
                    clearKey();
                    const value = await client.configuration();
                    if (alive.current) {
                      setConfiguration(value);
                      setMessage('키를 서버에 저장했어요. 번역 설정도 저장해 주세요.');
                    }
                  })
                }
              >
                키 저장
              </button>
              {credential && (
                <button className="un-btn is-text is-sm" disabled={busy} onClick={clearKey}>
                  입력 지우기
                </button>
              )}
              {saved && (
                <button className="un-btn is-text is-sm is-danger" disabled={busy} onClick={() => setRemove('key')}>
                  저장된 키 삭제
                </button>
              )}
            </div>
            <small className="un-pref-field-help">
              키는 브라우저가 아닌 서버에만, TTS·화자 분석 키와 따로 보관해요. 저장만으로 권한이 확인되지는 않아요.
            </small>
          </div>
        </PrefGroup>
      </PrefSection>

      <PrefFold title="속도와 재시도" summary="긴 회차는 문단 경계에서 나눠 번역해요.">
        {number('요청당 원문 문자 수', 'chunkCharacters', 2000, 12000)}
        {number('동시 요청 수', 'concurrency', 1, 3)}
        {number('최대 재시도 횟수', 'retries', 0, 5)}
        {number('첫 재시도 대기(초)', 'backoffSeconds', 1, 30)}
        {number('요청 제한 시간(초)', 'timeoutSeconds', 15, 180)}
        <p className="un-pref un-translation-fold-note">
          재시도 간격은 두 배씩 늘고, 제공자가 정한 대기 시간이 우선이에요. 실패한 요청도 과금될 수 있어요.
        </p>
      </PrefFold>
      <PrefFold title="번역 문체와 용어" summary="앞으로 요청하는 번역에 적용돼요.">
        <PrefField label="번역 지침">
          <textarea
            maxLength={2000}
            rows={3}
            value={draft.instructions}
            disabled={busy}
            onChange={(event) => patch('instructions', event.target.value)}
            placeholder="예: 대사의 말투와 인물별 존댓말을 유지해 주세요."
          />
        </PrefField>
        <PrefField label="공통 용어집" help="한 줄에 하나씩 적어요.">
          <textarea
            maxLength={10000}
            rows={5}
            value={draft.glossary}
            disabled={busy}
            onChange={(event) => patch('glossary', event.target.value)}
            placeholder="원문 이름 = 번역할 이름"
          />
        </PrefField>
      </PrefFold>

      <PrefSection title="사용량과 저장">
        <PrefGroup>
          <Pref
            title="오늘 요청한 원문"
            help="재시도 포함, 서버 날짜 기준. 실제 청구액과는 달라요."
            control={
              <strong className="un-translation-usage">
                {(configuration?.usedCharacters ?? 0).toLocaleString()}자
              </strong>
            }
          />
          <div className="un-pref">
            <button className="un-btn is-text is-sm is-danger" disabled={busy} onClick={() => setRemove('cache')}>
              내 번역 결과 모두 삭제
            </button>
          </div>
        </PrefGroup>
      </PrefSection>

      <div className="un-translation-footer">
        {error && <Notice tone="danger">{error}</Notice>}
        {message && (
          <p className="un-translation-message" role="status">
            {message}
          </p>
        )}
        <div className="un-translation-actions">
          <button
            className="un-btn is-ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const value = await client.configuration();
                if (alive.current) {
                  setConfiguration(value);
                  setDraft(value.settings);
                  clearKey();
                }
              })
            }
          >
            다시 불러오기
          </button>
          <button
            className="un-btn is-primary"
            disabled={busy || !configuration}
            onClick={() =>
              void run(async () => {
                const settings = validateTranslationSettings(draft);
                const value = await client.save(settings, configuration!.revision);
                if (alive.current) {
                  setConfiguration(value);
                  setDraft(value.settings);
                  setMessage('번역 설정을 저장했어요.');
                  window.dispatchEvent(new Event('boaa-translation-settings'));
                }
              })
            }
          >
            {busy ? '처리 중…' : '번역 설정 저장'}
          </button>
        </div>
      </div>
      <ConfirmSheet
        open={Boolean(remove)}
        title={remove === 'key' ? '번역 키를 삭제할까요?' : '번역 결과를 모두 삭제할까요?'}
        children={
          remove === 'key'
            ? '이 엔진의 진행 중인 번역도 중지돼요. TTS 키에는 영향이 없어요.'
            : '진행 중인 번역을 중지하고 저장된 번역만 삭제해요. 원문은 유지되며 다시 번역하면 API 요금이 발생해요.'
        }
        confirmLabel="삭제"
        onClose={() => setRemove(undefined)}
        onConfirm={() => {
          const kind = remove;
          setRemove(undefined);
          void run(async () => {
            if (kind === 'key') {
              await client.deleteCredential(draft.provider);
              clearKey();
            } else await client.clear();
            const value = await client.configuration();
            if (alive.current) {
              setConfiguration(value);
              setMessage('삭제했어요.');
            }
          });
        }}
      />
    </div>
  );
}
