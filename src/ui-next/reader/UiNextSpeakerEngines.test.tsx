import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeakerEngine, SpeakerEnginesPort } from '../../providers/speaker-engine';
import { DEFAULT_SPEAKER_ENGINE_URL, draftFrom, readDraft } from './speaker-engine-draft';
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
    probe: vi.fn(async () => ({ engineVersion: '1', models: ['model-a', 'model-b'] })),
    save: vi.fn(async (input: Parameters<SpeakerEnginesPort['save']>[0], _signal?: AbortSignal, id?: string) => {
      const { apiKey, engineToken, ...rest } = input;
      return {
        ...saved,
        ...rest,
        id: id ?? 'new',
        hasApiKey: apiKey === undefined ? saved.hasApiKey : Boolean(apiKey),
        hasEngineToken: engineToken === undefined ? saved.hasEngineToken : Boolean(engineToken),
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
});
