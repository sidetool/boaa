import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeakerEngine, SpeakerEnginesPort } from '../../providers/speaker-engine';
import { DEFAULT_SPEAKER_ENGINE_URL, draftFrom, emptyDraft, readDraft } from './speaker-engine-draft';
import UiNextSpeakerEngines from './UiNextSpeakerEngines';

let root: ReactTestRenderer;
afterEach(() => {
  if (root) act(() => root.unmount());
});

const saved: SpeakerEngine = {
  id: 'e1',
  name: '집 PC 모델',
  engineUrl: DEFAULT_SPEAKER_ENGINE_URL,
  protocol: 'openai',
  url: 'http://10.0.0.2:11434/v1',
  modelId: 'model-a',
  maxOutputTokens: 24576,
  paid: false,
  enabled: true,
  hasApiKey: true,
  hasEngineToken: true,
  revision: 'r1',
};

function port(list: SpeakerEngine[] = []) {
  return {
    list: vi.fn(async () => list),
    probe: vi.fn<SpeakerEnginesPort['probe']>(async () => ({ engineVersion: '1', models: ['model-a', 'model-b'] })),
    save: vi.fn(async (input: Parameters<SpeakerEnginesPort['save']>[0], _signal?: AbortSignal, id?: string) => {
      const { apiKey, engineToken, serviceAccountJson, ...rest } = input;
      return {
        ...saved,
        ...rest,
        id: id ?? 'new',
        hasApiKey: apiKey === undefined ? saved.hasApiKey : Boolean(apiKey),
        hasEngineToken: engineToken === undefined ? saved.hasEngineToken : Boolean(engineToken),
        hasServiceAccount:
          serviceAccountJson === undefined
            ? list.find((v) => v.id === id)?.hasServiceAccount
            : Boolean(serviceAccountJson),
      };
    }),
    remove: vi.fn(async () => {}),
  } satisfies SpeakerEnginesPort;
}

async function setup(list: SpeakerEngine[] = [], onChanged = vi.fn()) {
  const p = port(list);
  await act(async () => {
    root = create(<UiNextSpeakerEngines port={p} onChanged={onChanged} />);
  });
  return { p, onChanged };
}
const flat = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : flat(child))).join('');
const text = () => flat(root.root);
const button = (label: string) =>
  root.root.findAll(
    (node) => node.type === 'button' && (node.props['aria-label'] === label || flat(node).trim() === label),
  )[0]!;
const field = (label: string) =>
  root.root
    .findAllByType('label')
    .find((node) => node.findAllByType('span')[0] && flat(node.findAllByType('span')[0]!) === label)!
    .find((node) => node.type === 'input' || node.type === 'select');
const type = (label: string, value: string) => act(() => field(label).props.onChange({ target: { value } }));
const check = (label: string, checked: boolean) =>
  act(() =>
    root.root
      .findAllByType('label')
      .find((node) => flat(node).startsWith(label))!
      .findByType('input')
      .props.onChange({ target: { checked } }),
  );
const submit = () => act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
const accountJson = JSON.stringify({
  type: 'service_account',
  project_id: 'fixture-project',
  client_email: 'fixture@fixture-project.iam.gserviceaccount.com',
  private_key: 'test UI shape only',
});
const chooseJson = (text: string) =>
  act(async () =>
    root.root
      .findByProps({ type: 'file' })
      .props.onChange({ currentTarget: { files: [{ size: text.length, text: async () => text }], value: 'selected' } }),
  );

describe('PDF input option', () => {
  it.each(['gemini', 'vertex'] as const)(
    'preserves %s PDF selection across save/reopen and omits it for OpenAI',
    async (protocol) => {
      const engine = {
        ...saved,
        protocol,
        inputFormat: 'pdf' as const,
        projectId: 'fixture-project',
        location: 'global',
        hasServiceAccount: true,
      };
      const { p } = await setup([engine]);
      act(() => button('집 PC 모델 수정').props.onClick());
      expect(text()).toContain('PDF로 압축해서 보내기');
      expect(readDraft(draftFrom(engine), engine).input.inputFormat).toBe('pdf');
      await submit();
      expect(p.save.mock.calls[0]![0].inputFormat).toBe('pdf');
      act(() => button('집 PC 모델 수정').props.onClick());
      check('PDF로 압축해서 보내기', false);
      await submit();
      expect(p.save.mock.calls[1]![0]).not.toHaveProperty('inputFormat');
      act(() => button('집 PC 모델 수정').props.onClick());
      check('PDF로 압축해서 보내기', true);
      act(() => button('OpenAI 호환').props.onClick());
      expect(text()).not.toContain('PDF로 압축해서 보내기');
      expect(readDraft({ ...draftFrom(engine), protocol: 'openai' }, engine).input).not.toHaveProperty('inputFormat');
    },
  );
  it('leaves existing text-mode connections unchanged by default', () => {
    for (const protocol of ['gemini', 'vertex', 'openai'] as const) {
      const engine = { ...saved, protocol };
      expect(draftFrom(engine).pdfInput).toBe(false);
      expect(readDraft(draftFrom(engine), engine).input).not.toHaveProperty('inputFormat');
    }
  });
});

describe('Vertex connection editor', () => {
  it('uploads JSON, fills project, sends selected purpose/model/reasoning and keeps keys out of the rendered page', async () => {
    const { p } = await setup();
    act(() => button('모델 추가').props.onClick());
    act(() => button('Vertex AI').props.onClick());
    await submit();
    expect(p.save).not.toHaveBeenCalled();
    await chooseJson(accountJson);
    expect(field('프로젝트 ID').props.value).toBe('fixture-project');
    expect(field('리전').props.value).toBe('global');
    type('모델 용도', 'casting');
    type('모델 ID', 'selected-vertex-model');
    type('추론 강도', 'high');
    type('리전', 'us-central1');
    expect(text()).not.toContain('test UI shape only');
    expect(root.root.findAllByType('label').some((label) => flat(label).startsWith('API 키 (선택)'))).toBe(false);
    await act(async () => button('연결 확인').props.onClick());
    expect(p.probe.mock.calls[0]![0]).toMatchObject({
      protocol: 'vertex',
      purpose: 'casting',
      projectId: 'fixture-project',
      location: 'us-central1',
      serviceAccountJson: accountJson,
    });
    await submit();
    expect(p.save.mock.calls[0]![0]).toMatchObject({
      protocol: 'vertex',
      reasoning: 'high',
      modelId: 'selected-vertex-model',
    });
    expect(p.save.mock.calls[0]![0]).not.toHaveProperty('apiKey');
  });
  it('reopens and toggles saved Vertex credentials without requesting or resending JSON', async () => {
    const vertex: SpeakerEngine = {
      ...saved,
      protocol: 'vertex',
      projectId: 'fixture-project',
      location: 'global',
      hasApiKey: false,
      hasEngineToken: false,
      hasServiceAccount: true,
    };
    const { p } = await setup([vertex]);
    await act(async () => button('집 PC 모델 사용').props.onClick());
    expect(p.save.mock.calls[0]![0]).not.toHaveProperty('serviceAccountJson');
    act(() => button('집 PC 모델 수정').props.onClick());
    expect(text()).toContain('저장된 JSON을 사용해요');
    type('이름', '별칭만 변경');
    await submit();
    expect(p.save.mock.calls[1]![0]).not.toHaveProperty('serviceAccountJson');
    expect(p.save.mock.calls[1]![0].modelId).toBe(vertex.modelId);
  });
  it('rejects invalid JSON and discards a late file read after switching protocol', async () => {
    const { p } = await setup();
    act(() => button('모델 추가').props.onClick());
    act(() => button('Vertex AI').props.onClick());
    await chooseJson('{bad');
    expect(text()).toContain('JSON 형식');
    let resolve!: (v: string) => void;
    act(() =>
      root.root.findByProps({ type: 'file' }).props.onChange({
        currentTarget: {
          files: [
            {
              size: 100,
              text: () =>
                new Promise<string>((r) => {
                  resolve = r;
                }),
            },
          ],
          value: 'selected',
        },
      }),
    );
    await submit();
    expect(p.save).not.toHaveBeenCalled();
    act(() => button('Gemini').props.onClick());
    await act(async () => resolve(accountJson));
    type('모델 API 주소', 'https://generativelanguage.googleapis.com');
    type('모델 ID', 'selected-model');
    await submit();
    expect(p.save.mock.calls[0]![0]).not.toHaveProperty('serviceAccountJson');
  });
});

describe('speaker engine draft', () => {
  it('keeps omitted secrets, clears on request, and refuses to send them to a moved origin', () => {
    const draft = draftFrom(saved);
    expect(readDraft(draft, saved).input).not.toHaveProperty('apiKey');
    expect(readDraft(draft, saved).input).not.toHaveProperty('engineToken');
    expect(readDraft({ ...draft, clearKey: true }, saved).input.apiKey).toBe('');

    const movedModel = readDraft({ ...draft, url: 'https://api.example.com/v1' }, saved);
    expect(movedModel.decisions).toEqual({ apiKey: true, engineToken: false });
    expect(movedModel.saveProblem).toContain('API 키');

    const movedEngine = readDraft({ ...draft, engineUrl: 'http://10.0.0.9:8095' }, saved);
    expect(movedEngine.decisions).toEqual({ apiKey: false, engineToken: true });
    expect(readDraft({ ...draft, engineUrl: 'http://10.0.0.9:8095', engineToken: 'new' }, saved).saveProblem).toBe(
      undefined,
    );
    // Path changes on the same origin keep the stored secrets.
    expect(readDraft({ ...draft, url: 'http://10.0.0.2:11434/v2' }, saved).decisions.apiKey).toBe(false);
  });

  it('bounds output tokens and leaves reasoning out unless chosen', () => {
    const draft = draftFrom(saved);
    expect(readDraft({ ...draft, maxOutputTokens: '512' }, saved).saveProblem).toContain('1024~32768');
    expect(readDraft({ ...draft, maxOutputTokens: '40000' }, saved).saveProblem).toContain('1024~32768');
    expect(readDraft(draft, saved).input).not.toHaveProperty('reasoning');
    expect(readDraft({ ...draft, reasoning: 'high' }, saved).input.reasoning).toBe('high');
  });

  it('sends the output limit field only when it is not the implicit compatible default', () => {
    const draft = draftFrom(saved);
    expect(draft.tokenLimitParameter).toBe('max_tokens');
    expect(readDraft(draft, saved).input).not.toHaveProperty('tokenLimitParameter');
    const latest = { ...draft, tokenLimitParameter: 'max_completion_tokens' as const };
    expect(readDraft(latest, saved).input.tokenLimitParameter).toBe('max_completion_tokens');
    expect(readDraft({ ...latest, protocol: 'gemini' }, saved).input).not.toHaveProperty('tokenLimitParameter');
    // An explicit stored choice is kept as stored.
    const stored = { ...saved, tokenLimitParameter: 'max_tokens' as const };
    expect(readDraft(draftFrom(stored), stored).input.tokenLimitParameter).toBe('max_tokens');
  });

  it('keeps analysis limits implicit for older models, sends retry 0, and drops the cap when cleared', () => {
    const old = draftFrom(saved);
    expect(old.analysisConcurrency).toBe(1);
    expect(old.rateLimitRetries).toBe('');
    expect(readDraft(old, saved).input).not.toHaveProperty('analysisConcurrency');
    expect(readDraft(old, saved).input).not.toHaveProperty('rateLimitRetries');
    expect(readDraft(emptyDraft()).input).not.toHaveProperty('analysisConcurrency');
    const tuned = { ...saved, analysisConcurrency: 3, rateLimitRetries: 0 };
    const draft = draftFrom(tuned);
    expect(draft.rateLimitRetries).toBe('0');
    expect(readDraft(draft, tuned).input).toMatchObject({ analysisConcurrency: 3, rateLimitRetries: 0 });
    // Lowering back to 1 is sent explicitly; clearing the retry field removes the cap.
    const back = readDraft({ ...draft, analysisConcurrency: 1, rateLimitRetries: '' }, tuned);
    expect(back.input.analysisConcurrency).toBe(1);
    expect(back.input).not.toHaveProperty('rateLimitRetries');
    expect(readDraft({ ...draft, rateLimitRetries: '101' }, tuned).saveProblem).toContain('요청 제한 재시도 횟수');
    expect(readDraft({ ...draft, rateLimitRetries: '1.5' }, tuned).saveProblem).toContain('요청 제한 재시도 횟수');
    // Casting never uses these limits.
    const casting = readDraft({ ...draft, purpose: 'casting', rateLimitRetries: '101' }, tuned);
    expect(casting.input).not.toHaveProperty('analysisConcurrency');
    expect(casting.input).not.toHaveProperty('rateLimitRetries');
    expect(casting.saveProblem).toBeUndefined();
  });
});

describe('UiNextSpeakerEngines', () => {
  it('adds a model with the default service address, a checked model list and typed key', async () => {
    const { p, onChanged } = await setup();
    expect(text()).toContain('연결한 분석 모델이 없어요');
    act(() => button('모델 추가').props.onClick());
    type('모델 API 주소', 'https://api.example.com/v1');
    type('API 키 (선택)', 'secret-key');
    await act(async () => button('연결 확인').props.onClick());
    expect(p.probe).toHaveBeenCalledWith(
      expect.objectContaining({ engineUrl: DEFAULT_SPEAKER_ENGINE_URL, url: 'https://api.example.com/v1' }),
      expect.any(AbortSignal),
      undefined,
    );
    expect(text()).toContain('모델 2개를 찾았어요');
    act(() => button('model-b').props.onClick());
    await submit();
    expect(p.save).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'model-b',
        apiKey: 'secret-key',
        maxOutputTokens: 24576,
        paid: true,
        protocol: 'openai',
      }),
      expect.any(AbortSignal),
      undefined,
    );
    expect(onChanged).toHaveBeenCalled();
    expect(text()).toContain('model-b');
  });

  it('accepts a model typed by hand when the service lists none', async () => {
    const { p } = await setup();
    p.probe.mockResolvedValueOnce({ engineVersion: '1', models: [] });
    act(() => button('모델 추가').props.onClick());
    type('모델 API 주소', 'http://10.0.0.3:8000/v1');
    await act(async () => button('연결 확인').props.onClick());
    expect(text()).toContain('모델 ID를 직접 넣어 주세요');
    type('모델 ID', 'typed-model');
    check('사용량 요금이 있는 모델', false);
    await submit();
    expect(p.save.mock.calls[0]![0]).toMatchObject({ modelId: 'typed-model', paid: false });
  });

  it('asks for a new token when the analysis service moves, and keeps both secrets otherwise', async () => {
    const { p } = await setup([saved]);
    act(() => button('집 PC 모델 수정').props.onClick());
    type('분석 서비스 주소', 'http://10.0.0.9:8095');
    expect(text()).toContain('저장된 토큰은 새 주소로 보내지 않아요');
    await submit();
    expect(p.save).not.toHaveBeenCalled();

    type('분석 서비스 주소', DEFAULT_SPEAKER_ENGINE_URL);
    type('이름', '새 이름');
    await submit();
    const sent = p.save.mock.calls[0]![0];
    expect(sent).not.toHaveProperty('apiKey');
    expect(sent).not.toHaveProperty('engineToken');
    expect(sent.name).toBe('새 이름');
  });

  it('turns a model off without touching its secrets', async () => {
    const { p } = await setup([saved]);
    await act(async () => button('집 PC 모델 사용').props.onClick());
    const sent = p.save.mock.calls[0]![0];
    expect(sent.enabled).toBe(false);
    expect(sent).not.toHaveProperty('apiKey');
    expect(sent).not.toHaveProperty('engineToken');
    expect(p.save.mock.calls[0]![2]).toBe('e1');
  });

  it('edits analysis limits under advanced settings and keeps them when turned off', async () => {
    const tuned = { ...saved, analysisConcurrency: 2, rateLimitRetries: 0 };
    const { p } = await setup([tuned]);
    act(() => button('집 PC 모델 수정').props.onClick());
    expect(root.root.findByType('details').props.open).toBe(true);
    expect(field('요청 제한 재시도 횟수').props.value).toBe('0');
    await type('동시 분석 요청 수', '4');
    await type('요청 제한 재시도 횟수', '');
    expect(field('요청 제한 재시도 횟수').props.placeholder).toBe('계속 재시도');
    await submit();
    expect(p.save.mock.calls[0]![0].analysisConcurrency).toBe(4);
    expect(p.save.mock.calls[0]![0]).not.toHaveProperty('rateLimitRetries');
    await act(async () => button('집 PC 모델 사용').props.onClick());
    expect(p.save.mock.calls[1]![0]).toMatchObject({ enabled: false, analysisConcurrency: 4 });
  });

  it('hides analysis limits for a casting model', async () => {
    await setup([{ ...saved, purpose: 'casting' }]);
    act(() => button('집 PC 모델 수정').props.onClick());
    expect(text()).not.toContain('동시 분석 요청 수');
    expect(text()).not.toContain('요청 제한 재시도 횟수');
  });
});
