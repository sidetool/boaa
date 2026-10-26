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
