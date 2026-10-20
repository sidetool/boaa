import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslationClient, translationError } from '../../../features/translation/translation-client';
import {
  DEFAULT_TRANSLATION_SETTINGS,
  validateTranslationSettings,
  type TranslationConfiguration,
  type TranslationProvider,
  type TranslationSettings,
} from '../../../translation/contracts';
import { Notice, PrefFold, PrefGroup, PrefSection, PrefSwitch } from '../../components/prefs';
import { ConfirmSheet } from '../../components/dialogs';
import './translation.css';
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
    hint?: string,
  ) => (
    <label className="un-translation-field">
      <span>{label}</span>
      <input
        className="un-input"
        aria-label={label}
        value={draft[key]}
        disabled={busy}
        onChange={(event) => patch(key, event.target.value)}
        spellCheck={false}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
  const number = (
    label: string,
    key: 'chunkCharacters' | 'concurrency' | 'nextChapters' | 'retries' | 'backoffSeconds' | 'timeoutSeconds',
    min: number,
    max: number,
  ) => (
    <label className="un-translation-field">
      <span>{label}</span>
      <input
        className="un-input"
        type="number"
        min={min}
        max={max}
        aria-label={label}
        value={draft[key]}
        disabled={busy}
        onChange={(event) => patch(key, Number(event.target.value))}
      />
      <small>
        {min.toLocaleString()}–{max.toLocaleString()}
      </small>
    </label>
  );
  if (!client) return <Notice>서버의 관리자 계정에서 작품 번역을 설정할 수 있어요.</Notice>;
  return (
    <div className="un-translation-settings">
      <PrefSection title="작품 번역" hint="텍스트 작품을 읽을 때 사용할 번역 엔진이에요. 원문은 그대로 보관해요.">
        <PrefGroup>
          <PrefSwitch
            title="작품 번역 사용"
            checked={draft.enabled}
            disabled={busy || !configuration}
            onChange={(value) => patch('enabled', value)}
            help="기본은 꺼져 있어요. 아래 설정을 저장하면 적용돼요."
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
            help="외국어 작품만 시작해요. 언어가 불확실하면 먼저 확인해요."
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
                help="현재 화 번역이 끝나면 다음 화도 준비해요. 미리 번역한 내용에도 API 요금이 발생할 수 있어요."
              />
              {draft.nextChapters > 0 && number('미리 번역할 다음 화', 'nextChapters', 1, 3)}
            </div>
          )}
        </PrefGroup>
        <Notice>
          번역을 시작하면 원문이 선택한 제공자에게 전송되고 API 요금이 발생할 수 있어요. 현재는 관리자만 사용할 수
          있어요.
        </Notice>
      </PrefSection>
      <PrefSection title="번역 엔진">
        <label className="un-translation-field">
          <span>제공자</span>
          <select
            className="un-input"
            value={draft.provider}
            disabled={busy}
            onChange={(event) => {
              clearKey();
              patch('provider', event.target.value as TranslationProvider);
            }}
          >
            <option value="gemini">Gemini API</option>
            <option value="vertex">Google Cloud · Vertex AI</option>
            <option value="openai-compatible">OpenAI 호환 API</option>
          </select>
        </label>
        {field('모델 ID', 'model', '사용 권한이 있는 텍스트 생성 모델의 ID를 입력하세요. TTS 모델은 사용할 수 없어요.')}
        {field('번역할 언어', 'targetLanguage', '기본 ko(한국어). en, ja 등 언어 코드를 사용할 수 있어요.')}
        {draft.provider === 'openai-compatible' &&
          field('API 기본 주소', 'endpoint', 'HTTPS 주소. 예: https://api.openai.com/v1')}
        {draft.provider === 'vertex' && (
          <div className="un-translation-grid">
            {field('프로젝트', 'project', '비우면 JSON의 project_id 사용')}
            {field('리전', 'location', '기본 global')}
          </div>
        )}
        <div className="un-translation-key">
          <strong>{draft.provider === 'vertex' ? '서비스 계정 JSON' : 'API 키'}</strong>
          <small>
            {configuration?.credentials[draft.provider]?.saved
              ? '서버에 암호화해 저장됨 · 원문 조회 불가'
              : '저장된 키 없음'}
          </small>
          {draft.provider === 'vertex' ? (
            <label className="un-translation-field">
              <span>JSON 파일 선택</span>
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
            <input
              className="un-input"
              type="password"
              aria-label="번역 API 키"
              autoComplete="new-password"
              value={credential}
              disabled={busy}
              onChange={(event) => setCredential(event.target.value)}
            />
          )}
          {fileName && <small>{fileName} · 저장을 눌러야 서버에 보관돼요.</small>}
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
            <button className="un-btn is-ghost is-sm" disabled={busy || !credential} onClick={clearKey}>
              입력 지우기
            </button>
            <button
              className="un-btn is-ghost is-sm"
              disabled={busy || !configuration?.credentials[draft.provider]?.saved}
              onClick={() => setRemove('key')}
            >
              저장된 키 삭제
            </button>
          </div>
          <small>
            브라우저에 키를 보관하지 않아요. TTS·화자 분석 키와 별도로 저장돼요. 키 저장만으로 연결이나 모델 사용 권한이
            검증되지는 않아요.
          </small>
        </div>
      </PrefSection>
      <PrefFold title="속도와 재시도" summary="화 단위로 저장하고, 긴 회차는 문단 경계에서 나눠 번역해요.">
        <div className="un-translation-grid">
          {number('요청당 원문 문자 수', 'chunkCharacters', 2000, 12000)}
          {number('동시 요청 수', 'concurrency', 1, 3)}
          {number('최대 재시도 횟수', 'retries', 0, 5)}
          {number('첫 재시도 대기(초)', 'backoffSeconds', 1, 30)}
          {number('요청 제한 시간(초)', 'timeoutSeconds', 15, 180)}
        </div>
        <Notice>
          재시도 간격은 두 배씩 늘어나며, 제공자가 지정한 대기 시간을 우선해요. 실패한 요청도 과금될 수 있어요.
        </Notice>
      </PrefFold>
      <PrefFold title="번역 문체와 용어" summary="이 설정은 앞으로 요청하는 번역에 적용돼요.">
        <label className="un-translation-field">
          <span>번역 지침</span>
          <textarea
            className="un-input"
            maxLength={2000}
            rows={3}
            value={draft.instructions}
            disabled={busy}
            onChange={(event) => patch('instructions', event.target.value)}
            placeholder="예: 대사의 말투와 인물별 존댓말을 유지해 주세요."
          />
        </label>
        <label className="un-translation-field">
          <span>공통 용어집</span>
          <textarea
            className="un-input"
            maxLength={10000}
            rows={5}
            value={draft.glossary}
            disabled={busy}
            onChange={(event) => patch('glossary', event.target.value)}
            placeholder="원문 이름 = 번역할 이름"
          />
        </label>
      </PrefFold>
      <PrefSection title="사용량과 저장">
        <div className="un-translation-grid">
          <p>
            오늘 요청한 원문 <strong>{(configuration?.usedCharacters ?? 0).toLocaleString()}자</strong>
            <small className="un-translation-help">재시도 포함, 서버 날짜 기준. 실제 제공자 청구액과는 달라요.</small>
          </p>
        </div>
        <button className="un-btn is-ghost is-sm" disabled={busy} onClick={() => setRemove('cache')}>
          내 번역 결과 모두 삭제
        </button>
      </PrefSection>
      {error && <Notice tone="danger">{error}</Notice>}
      {message && <p role="status">{message}</p>}
      <div className="un-translation-actions">
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
