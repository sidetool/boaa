import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { TTSConnection, TTSConnectionsPort } from '../../providers/tts-connections';
import UiNextTTSConnections, { formatVoices, parseVoices } from './UiNextTTSConnections';

let root: ReactTestRenderer;
afterEach(() => {
  if (root) act(() => root.unmount());
});

const saved: TTSConnection = {
  id: 'c1',
  name: '집 PC',
  protocol: 'local',
  url: 'http://192.168.0.10:8080',
  modelId: 'kokoro',
  voices: [{ id: 'v1', label: '차분한 목소리', lang: 'ko' }],
  maxInputCharacters: 1000,
  maxInputSegments: 8,
  paid: false,
  enabled: true,
  hasApiKey: true,
  revision: 'r1',
};

function port(list: TTSConnection[] = []): { [K in keyof TTSConnectionsPort]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => list),
    probe: vi.fn(async () => ({ models: ['tts-1', 'tts-1-hd'], voices: [{ id: 'alloy', label: 'Alloy' }] })),
    save: vi.fn(async (input, _signal, id) => ({
      ...saved,
      ...input,
      id: id ?? 'new',
      hasApiKey: 'apiKey' in input ? Boolean(input.apiKey) : true,
    })),
    remove: vi.fn(async () => {}),
  };
}

async function setup(list: TTSConnection[] = [], onChanged = vi.fn()) {
  const p = port(list);
  await act(async () => {
    root = create(<UiNextTTSConnections port={p as unknown as TTSConnectionsPort} onChanged={onChanged} />);
  });
  return { p, onChanged };
}
const text = () => JSON.stringify(root.toJSON());
const button = (label: string) =>
  root.root.findAll(
    (node) => node.type === 'button' && (node.props['aria-label'] === label || flat(node).includes(label)),
  )[0]!;
const flat = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : flat(child))).join('');
const field = (label: string) =>
  root.root
    .findAllByType('label')
    .find((node) => node.findAllByType('span')[0] && flat(node.findAllByType('span')[0]!) === label)!
    .find((node) => node.type === 'input' || node.type === 'textarea');
const type = (label: string, value: string) => act(() => field(label).props.onChange({ target: { value } }));

it('parses id, label and language per line, and rejects duplicates', () => {
  expect(parseVoices('alloy, Alloy\n\nnova\nko-1, 한국어, ko').voices).toEqual([
    { id: 'alloy', label: 'Alloy' },
    { id: 'nova', label: 'nova' },
    { id: 'ko-1', label: '한국어', lang: 'ko' },
  ]);
  expect(parseVoices('a\na').error).toContain('a');
  expect(
    formatVoices([
      { id: 'nova', label: 'nova' },
      { id: 'k', label: 'K', lang: 'ko' },
    ]),
  ).toBe('nova\nk, K, ko');
});

it('adds an OpenAI-compatible server with discovered model and voices, defaulting to paid', async () => {
  const { p, onChanged } = await setup();
  expect(text()).toContain('저장된 서버가 없어요');
  act(() => button('서버 추가').props.onClick());
  act(() =>
    root.root
      .findByProps({ role: 'radiogroup', 'aria-label': '서버 종류' })
      .findAllByType('button')[1]!
      .props.onClick(),
  );
  type('주소', 'https://tts.example.com/v1');
  type('API 키 (선택)', 'sk-secret');
  await act(async () => button('연결 확인').props.onClick());
  // Probing never needs a model and sends the typed key for this request only.
  expect(p.probe.mock.calls[0]![0]).toMatchObject({ protocol: 'openai', modelId: '', apiKey: 'sk-secret', paid: true });
  expect(text()).toContain('모델 2개, 목소리 1개');
  act(() => button('tts-1-hd').props.onClick());
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(p.save).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'tts.example.com',
      modelId: 'tts-1-hd',
      voices: [{ id: 'alloy', label: 'Alloy' }],
      maxInputCharacters: 1000,
      maxInputSegments: 8,
      paid: true,
      enabled: true,
      apiKey: 'sk-secret',
    }),
    expect.any(AbortSignal),
    undefined,
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(text()).not.toContain('sk-secret');
});

it('requires a model and a voice to save, with manual entry when discovery is empty', async () => {
  const { p } = await setup();
  act(() => button('서버 추가').props.onClick());
  type('주소', 'http://pc.local:8080/synthesize');
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(p.save).not.toHaveBeenCalled();
  expect(text()).toContain('모델 ID를 넣어 주세요');
  type('모델 ID', 'kokoro');
  type('목소리', 'af_heart, 하트');
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(p.save.mock.calls[0]![0]).toMatchObject({
    protocol: 'local',
    paid: false,
    voices: [{ id: 'af_heart', label: '하트' }],
  });
  expect(p.save.mock.calls[0]![0]).not.toHaveProperty('apiKey');
});

it('keeps the stored key on edit unless cleared, toggles and removes in place', async () => {
  const { p, onChanged } = await setup([saved]);
  await act(async () => root.root.findByProps({ role: 'switch' }).props.onClick());
  expect(p.save.mock.calls[0]![0]).toMatchObject({ enabled: false });
  expect(p.save.mock.calls[0]![0]).not.toHaveProperty('apiKey');
  expect(p.save.mock.calls[0]![2]).toBe('c1');

  act(() => button('집 PC 수정').props.onClick());
  type('이름', '거실 PC');
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(p.save.mock.calls[1]![0]).toMatchObject({ name: '거실 PC' });
  expect(p.save.mock.calls[1]![0]).not.toHaveProperty('apiKey');

  act(() => button('거실 PC 수정').props.onClick());
  const clear = root.root
    .findAllByType('input')
    .find((node) => node.props.type === 'checkbox' && flat(node.parent!).includes('저장된 API 키 지우기'))!;
  act(() => clear.props.onChange({ target: { checked: true } }));
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(p.save.mock.calls[2]![0]).toMatchObject({ apiKey: '' });

  act(() => button('거실 PC 수정').props.onClick());
  act(() => button('삭제').props.onClick());
  expect(text()).toContain('삭제할까요?');
  await act(async () =>
    root.root.findByProps({ 'aria-label': '서버 삭제 확인' }).findAllByType('button')[0]!.props.onClick(),
  );
  expect(p.remove).toHaveBeenCalledWith('c1', expect.any(AbortSignal));
  expect(text()).toContain('저장된 서버가 없어요');
  expect(onChanged).toHaveBeenCalledTimes(4);
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
const submit = () => act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));

it("starts fresh for a new port and ignores the old port's late answers", async () => {
  const late = deferred<TTSConnection[]>();
  const first = port();
  first.list.mockReturnValueOnce(late.promise);
  await act(async () => {
    root = create(<UiNextTTSConnections port={first as unknown as TTSConnectionsPort} />);
  });
  act(() => button('서버 추가').props.onClick());
  type('API 키 (선택)', 'sk-old-account');
  const second = port([saved]);
  await act(async () => root.update(<UiNextTTSConnections port={second as unknown as TTSConnectionsPort} />));
  expect(first.list.mock.calls[0]![0].aborted).toBe(true);
  await act(async () => late.resolve([{ ...saved, id: 'old', name: '이전 계정 서버' }]));
  expect(root.root.findAllByType('form')).toHaveLength(0);
  expect(text()).toContain('집 PC');
  expect(text()).not.toContain('이전 계정 서버');
  expect(text()).not.toContain('sk-old-account');
});

it('drops a pending probe when the address changes or the form closes', async () => {
  const { p } = await setup();
  const answer = deferred<{ models: string[]; voices: { id: string; label: string }[] }>();
  p.probe.mockReturnValue(answer.promise);
  act(() => button('서버 추가').props.onClick());
  type('주소', 'http://a.local:8080');
  act(() => void button('연결 확인').props.onClick());
  type('주소', 'http://b.local:8080');
  expect(p.probe.mock.calls[0]![1].aborted).toBe(true);
  await act(async () => answer.resolve({ models: ['m'], voices: [{ id: 'stale', label: 'Stale' }] }));
  expect(field('목소리').props.value).toBe('');
  expect(text()).not.toContain('연결됐어요');

  act(() => void button('연결 확인').props.onClick());
  act(() => button('취소').props.onClick());
  expect(p.probe.mock.calls[1]![1].aborted).toBe(true);
});

it('says when the server has no model or voice list, and keeps manual entry', async () => {
  const { p } = await setup();
  p.probe.mockResolvedValue({ models: [], voices: [] });
  act(() => button('서버 추가').props.onClick());
  type('주소', 'http://pc.local:8080');
  await act(async () => button('연결 확인').props.onClick());
  expect(text()).toContain('ID를 직접 넣어 주세요');
  expect(text()).not.toContain('목록을 알려주지 않는 서버는 직접 넣어 주세요');
  expect(field('모델 ID').props.disabled).toBeFalsy();
});

it('keeps a successful save when the parent refresh throws', async () => {
  const onChanged = vi.fn(() => {
    throw new Error('catalog down');
  });
  const { p } = await setup([saved], onChanged);
  act(() => button('집 PC 수정').props.onClick());
  type('이름', '거실 PC');
  await submit();
  expect(p.save).toHaveBeenCalledOnce();
  expect(onChanged).toHaveBeenCalledOnce();
  expect(root.root.findAllByType('form')).toHaveLength(0);
  expect(text()).toContain('거실 PC');
  expect(text()).not.toContain('저장하지 못했어요');
});

it('asks for a new key or an explicit clear when the stored key would go to another origin', async () => {
  const { p } = await setup([saved]);
  act(() => button('집 PC 수정').props.onClick());
  type('주소', 'http://192.168.0.10:8080/synthesize');
  expect(text()).not.toContain('새 주소로 보내지 않아요');
  type('주소', 'http://other.local:8080');
  expect(text()).toContain('새 주소로 보내지 않아요');
  await submit();
  expect(p.save).not.toHaveBeenCalled();
  type('API 키 (선택)', 'sk-new');
  await submit();
  expect(p.save.mock.calls[0]![0]).toMatchObject({ url: 'http://other.local:8080', apiKey: 'sk-new' });
});

const kind = (label: string) =>
  act(() =>
    root.root
      .findByProps({ role: 'radiogroup', 'aria-label': '서버 종류' })
      .findAll((node) => node.type === 'button' && flat(node).includes(label))[0]!
      .props.onClick(),
  );
const model = (label: string) =>
  act(() =>
    root.root
      .findByProps({ role: 'radiogroup', 'aria-label': '모델' })
      .findAll((node) => node.type === 'button' && flat(node) === label)[0]!
      .props.onClick(),
  );
const plain = () => flat(root.root);
const paidBox = () =>
  root.root
    .findAllByType('input')
    .find((node) => node.props.type === 'checkbox' && flat(node.parent!).includes('사용량 요금이 있는 서버'))!;

it('sets up Fish Audio from a preset, needs its key and an accepted model, and never picks voices itself', async () => {
  const { p } = await setup();
  p.probe.mockResolvedValue({
    models: ['s2.1-pro'],
    voices: [
      { id: 'ref-a', label: '차분한 남성' },
      { id: 'ref-b', label: '밝은 여성' },
    ],
  });
  act(() => button('서버 추가').props.onClick());
  kind('Fish Audio');
  expect(field('주소').props.value).toBe('https://api.fish.audio');
  await act(async () => button('연결 확인').props.onClick());
  expect(p.probe).not.toHaveBeenCalled();
  expect(text()).toContain('Fish Audio API 키를 넣어 주세요');

  type('API 키', 'fish-key');
  await act(async () => button('연결 확인').props.onClick());
  // Neither the model nor any voice is chosen on the person's behalf.
  expect(field('모델 ID').props.value).toBe('');
  expect(field('목소리').props.value).toBe('');
  expect(text()).toContain('목소리 2개를 찾았어요');
  act(() => root.root.findByProps({ 'aria-label': '찾은 목소리' }).findAllByType('button')[1]!.props.onClick());
  expect(field('목소리').props.value).toBe('ref-b, 밝은 여성');

  model('S2.1 Pro무료');
  expect(paidBox().props.checked).toBe(false);
  expect(plain()).toContain('Fish S2 모델이에요');
  type('모델 ID', 's2.1-pro-turbo');
  await submit();
  expect(p.save).not.toHaveBeenCalled();
  expect(text()).toContain('Fish Audio 모델 ID는 s2-pro, s2.1-pro, s2.1-pro-free, drama-3 중 하나예요');
  model('Drama 3');
  expect(paidBox().props.checked).toBe(true);
  await submit();
  expect(p.save.mock.calls[0]![0]).toMatchObject({
    name: 'api.fish.audio',
    protocol: 'fish',
    url: 'https://api.fish.audio',
    modelId: 'drama-3',
    apiKey: 'fish-key',
    voices: [{ id: 'ref-b', label: '밝은 여성' }],
    paid: true,
  });
  expect(p.save.mock.calls[0]![0]).not.toHaveProperty('speechModel');
});

it('carries a preset over to OpenRouter, marks only its exact free model free, and sends a manual model family', async () => {
  const { p } = await setup();
  act(() => button('서버 추가').props.onClick());
  kind('Fish Audio');
  model('S2.1 Pro무료');
  kind('OpenRouter');
  expect(field('주소').props.value).toBe('https://openrouter.ai/api/v1');
  expect(field('모델 ID').props.value).toBe('fish-audio/s2.1-pro-free:free');
  expect(paidBox().props.checked).toBe(false);

  // A relay's other name is never assumed free, and the family is left for the person to set.
  type('모델 ID', 'my-relay/fish-free');
  expect(paidBox().props.checked).toBe(true);
  expect(plain()).toContain('기본 낭독용 모델이에요');
  act(() => root.root.findByType('select').props.onChange({ target: { value: 'fish-drama' } }));
  type('API 키', 'or-key');
  type('목소리', 'ref-a, 주인공');
  await submit();
  expect(p.save.mock.calls[0]![0]).toMatchObject({
    protocol: 'openrouter',
    modelId: 'my-relay/fish-free',
    speechModel: 'fish-drama',
    paid: true,
  });

  // A local server ignores the family, and an address typed by hand stays when the service changes.
  act(() => button('서버 추가').props.onClick());
  kind('OpenRouter');
  type('주소', 'https://relay.example.com/v1');
  kind('로컬 서버');
  expect(field('주소').props.value).toBe('https://relay.example.com/v1');
});

it('turns 유료 back on when moving to a paid Fish model, but keeps a mark the person set', async () => {
  const fish: TTSConnection = {
    ...saved,
    id: 'f1',
    name: 'Fish',
    protocol: 'fish',
    url: 'https://api.fish.audio',
    modelId: 's2.1-pro-free',
    paid: false,
  };
  const { p } = await setup([fish]);
  expect(plain()).toContain('Fish Audio · S2.1 Pro 무료 · 목소리 1개');
  expect(plain()).not.toContain('유료 API');
  act(() => button('Fish 수정').props.onClick());
  model('S2.1 Pro');
  expect(paidBox().props.checked).toBe(true);
  model('S2.1 Pro무료');
  // Back on a free model the notice stays as it was; turning it off is the person's call.
  expect(paidBox().props.checked).toBe(true);
  act(() => paidBox().props.onChange({ target: { checked: false } }));
  await submit();
  expect(p.save.mock.calls[0]![0]).toMatchObject({ modelId: 's2.1-pro-free', paid: false });
  expect(p.save.mock.calls[0]![0]).not.toHaveProperty('apiKey');
});

it('clears finished lists, a relay override and a typed key once they belong to another server or model', async () => {
  const { p } = await setup();
  act(() => button('서버 추가').props.onClick());
  kind('Fish Audio');
  type('API 키', 'fish-key');
  // A key typed for Fish never travels to OpenRouter's address.
  kind('OpenRouter');
  expect(field('주소').props.value).toBe('https://openrouter.ai/api/v1');
  expect(field('API 키').props.value).toBe('');

  type('API 키', 'or-key');
  p.probe.mockResolvedValue({
    models: ['fish-audio/s2.1-pro', 'openai/gpt-4o-mini-tts'],
    voices: [{ id: 'alloy', label: 'Alloy' }],
  });
  type('모델 ID', 'openai/gpt-4o-mini-tts');
  await act(async () => button('연결 확인').props.onClick());
  expect(plain()).toContain('목소리 1개를 찾았어요');
  expect(plain()).toContain('모델이 지원하는 목소리 이름을 넣어요');
  expect(plain()).not.toContain('reference_id');

  // OpenRouter lists voices per model: another model keeps the model list but not the old voices or status.
  act(() => button('openai/gpt-4o-mini-tts').props.onClick());
  expect(root.root.findAllByProps({ 'aria-label': '찾은 목소리' })).toHaveLength(1);
  model('S2.1 Pro');
  expect(root.root.findAllByProps({ 'aria-label': '찾은 목소리' })).toHaveLength(0);
  expect(root.root.findAllByProps({ 'aria-label': '찾은 모델' })).toHaveLength(1);
  expect(plain()).not.toContain('연결됐어요');

  // An override chosen for an alias gives way to a recognised name.
  type('모델 ID', 'relay/fish-alias');
  act(() => root.root.findByType('select').props.onChange({ target: { value: 'fish-s2' } }));
  model('Drama 3');
  expect(root.root.findByType('select').props.disabled).toBe(true);
  expect(plain()).toContain('Fish Drama 모델이에요');
  type('목소리', 'ref-a');
  await submit();
  expect(p.save.mock.calls[0]![0]).toMatchObject({ modelId: 'fish-audio/drama-3', apiKey: 'or-key' });
  expect(p.save.mock.calls[0]![0]).not.toHaveProperty('speechModel');

  // A new address drops the finished answer entirely.
  act(() => button('서버 추가').props.onClick());
  type('주소', 'http://a.local:8080');
  await act(async () => button('연결 확인').props.onClick());
  expect(plain()).toContain('연결됐어요');
  type('주소', 'http://b.local:8080');
  expect(plain()).not.toContain('연결됐어요');
  expect(root.root.findAllByProps({ 'aria-label': '찾은 모델' })).toHaveLength(0);
});
