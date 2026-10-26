import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TTSAudiobookControls } from '../../features/tts/TTSAddonPanel';
import type { AudiobookEstimate, AudiobookPort, SavedAudiobook } from '../../providers/plain-audiobook';
import UiNextAudiobookPanel from './UiNextAudiobookPanel';

// The node test environment has no window; the panel's poll timer uses window.setTimeout as in the browser.
if (typeof window === 'undefined') vi.stubGlobal('window', globalThis);

const chapters = [
  { id: 'c1', title: '1화' },
  { id: 'c2', title: '2화' },
  { id: 'c3', title: '3화' },
];
const generation: TTSAudiobookControls['generation'] = {
  voiceId: 'voice-a',
  modelRevision: 'rev-1',
  chunking: 'paragraph',
  footnotePlayback: 'skip',
  rules: [],
};
const estimate = (overrides: Partial<AudiobookEstimate> = {}): AudiobookEstimate => ({
  fingerprint: 'fp-1',
  chapterCount: 1,
  itemCount: 4,
  characters: 2400,
  voiceLabel: '목소리 A',
  providerName: '엔진 A',
  paid: false,
  firstChapterTitle: '2화',
  lastChapterTitle: '2화',
  ...overrides,
});
const saved = (overrides: Partial<SavedAudiobook> = {}): SavedAudiobook => ({
  ...estimate(),
  id: 'book-1',
  bookId: 'novel-1',
  title: '테스트 작품',
  status: 'completed',
  completedItems: 4,
  bytes: 3 * 1024 * 1024,
  playbackIndex: 0,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  ...overrides,
});

function port(list: () => Promise<SavedAudiobook[]>, overrides: Partial<AudiobookPort> = {}) {
  return {
    list: vi.fn(list),
    estimate: vi.fn(async () => estimate()),
    create: vi.fn(async () => saved({ status: 'queued', completedItems: 0, bytes: 0 })),
    control: vi.fn(async (id: string, action: 'pause' | 'resume') =>
      saved({ id, status: action === 'pause' ? 'paused' : 'queued' }),
    ),
    remove: vi.fn(async () => undefined),
    audio: vi.fn(async (_id: string, index: number) => new Blob([`part-${index}`])),
    progress: vi.fn(async () => undefined),
    reader: vi.fn(async () => undefined),
    resolve: vi.fn(async () => new Blob(['audio'])),
    ...overrides,
  } satisfies AudiobookPort;
}
function controls(overrides: Partial<TTSAudiobookControls> = {}): TTSAudiobookControls {
  return {
    key: 'account-1:novel-1',
    port: port(async () => []),
    chapters,
    currentChapterId: 'c2',
    generation,
    rate: 1.2,
    listen: vi.fn(),
    ...overrides,
  };
}

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
});
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}
async function mount(props: TTSAudiobookControls) {
  act(() => {
    renderer = create(<UiNextAudiobookPanel controls={props} />);
  });
  await flush();
  return renderer!.root;
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, name: string | RegExp) {
  return root.find((node) => {
    if (node.type !== 'button') return false;
    const label = node.props['aria-label'] ?? text(node).trim();
    return typeof name === 'string' ? name === label : name.test(label);
  });
}
const hasButton = (root: ReactTestInstance, name: string | RegExp) =>
  root.findAll((node) => {
    if (node.type !== 'button') return false;
    const label = node.props['aria-label'] ?? text(node).trim();
    return typeof name === 'string' ? name === label : name.test(label);
  }).length > 0;
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
  await flush();
}

describe('UiNextAudiobookPanel creating', () => {
  it('estimates the current chapter, then asks for explicit paid consent before creating', async () => {
    const api = port(async () => [], { estimate: vi.fn(async () => estimate({ paid: true })) });
    const root = await mount(controls({ port: api }));

    await click(button(root, '글자 수 확인'));
    expect(api.estimate).toHaveBeenCalledWith({ ...generation, chapterIds: ['c2'] }, expect.any(AbortSignal));
    expect(text(root.findByProps({ 'aria-label': '생성 확인' }))).toContain('2,400');
    expect(button(root, '생성 시작').props.disabled).toBe(true);

    act(() => root.findByType('input').props.onChange({ target: { checked: true } }));
    vi.mocked(api.list).mockResolvedValue([saved({ status: 'queued', completedItems: 0, bytes: 0 })]);
    await click(button(root, '생성 시작'));
    expect(api.create).toHaveBeenCalledWith(
      { ...generation, chapterIds: ['c2'] },
      'fp-1',
      true,
      expect.any(AbortSignal),
    );
    expect(text(root)).toContain('대기 중');
    expect(hasButton(root, '글자 수 확인')).toBe(true);
  });

  it('drops an estimate and its consent when the range changes', async () => {
    const api = port(async () => [], { estimate: vi.fn(async () => estimate({ paid: true })) });
    const root = await mount(controls({ port: api }));
    await click(button(root, '글자 수 확인'));
    act(() => root.findByType('input').props.onChange({ target: { checked: true } }));

    await click(button(root, '전체'));
    expect(hasButton(root, '생성 시작')).toBe(false);
    await click(button(root, '글자 수 확인'));
    expect(api.estimate).toHaveBeenLastCalledWith(
      { ...generation, chapterIds: ['c1', 'c2', 'c3'] },
      expect.any(AbortSignal),
    );
    expect(button(root, '생성 시작').props.disabled).toBe(true);
  });

  it('reloads the list after a failed create because the server may already hold the job', async () => {
    const api = port(async () => [], {
      create: vi.fn(async () => {
        throw new Error('요청 시간이 초과됐어요.');
      }),
    });
    const root = await mount(controls({ port: api }));
    await click(button(root, '글자 수 확인'));
    vi.mocked(api.list).mockResolvedValueOnce([saved({ status: 'running', completedItems: 1 })]);
    await click(button(root, '생성 시작'));

    expect(text(root)).toContain('요청 시간이 초과됐어요.');
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(text(root)).toContain('만드는 중');
  });

  it('keeps saved audio playable without a ready server voice', async () => {
    const root = await mount(controls({ generation: undefined, port: port(async () => [saved()]) }));
    expect(hasButton(root, '글자 수 확인')).toBe(false);
    expect(hasButton(root, '전체')).toBe(false);
    expect(text(root)).toContain('엔진이 꺼져 있어도 들을 수 있어요');
    expect(hasButton(root, '본문에서 듣기')).toBe(true);
  });
});

describe('UiNextAudiobookPanel saved jobs', () => {
  it('pauses a running job and offers delete only after it stops', async () => {
    const api = port(async () => [saved({ status: 'running', completedItems: 2 })]);
    const root = await mount(controls({ port: api }));
    expect(hasButton(root, '음성 삭제')).toBe(false);

    await click(button(root, '멈추기'));
    expect(api.control).toHaveBeenCalledWith('book-1', 'pause');
  });

  it('confirms paid resume and delete inline', async () => {
    const api = port(async () => [saved({ status: 'failed', paid: true, completedItems: 2, error: '연결 실패' })]);
    const root = await mount(controls({ port: api }));
    expect(text(root)).toContain('연결 실패');

    await click(button(root, '이어 만들기'));
    expect(api.control).not.toHaveBeenCalled();
    expect(text(root)).toContain('남은 2개 구간');
    await click(button(root, '이어 만들기'));
    expect(api.control).toHaveBeenCalledWith('book-1', 'resume', true);

    vi.mocked(api.list).mockResolvedValue([saved({ status: 'paused', completedItems: 2 })]);
    await click(button(root, '저장 목록 새로고침'));
    await click(button(root, '음성 삭제'));
    expect(api.remove).not.toHaveBeenCalled();
    await click(button(root, '삭제'));
    expect(api.remove).toHaveBeenCalledWith('book-1');
  });

  it('starts no request after closing while an action is still answering', async () => {
    let answer: (value: SavedAudiobook) => void = () => undefined;
    const api = port(async () => [saved({ status: 'running', completedItems: 1 })], {
      control: vi.fn(() => new Promise<SavedAudiobook>((resolve) => (answer = resolve))),
    });
    const root = await mount(controls({ port: api }));
    await click(button(root, '멈추기'));
    act(() => renderer?.unmount());
    renderer = undefined;

    answer(saved({ status: 'paused', completedItems: 1 }));
    await flush();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('keeps polling running jobs after a failed refresh', async () => {
    vi.useFakeTimers();
    const api = port(async () => [saved({ status: 'running', completedItems: 1 })]);
    await mount(controls({ port: api }));
    vi.mocked(api.list).mockRejectedValueOnce(new Error('잠시 연결이 끊겼어요.'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(api.list).toHaveBeenCalledTimes(3);
  });
});

describe('UiNextAudiobookPanel reader playback', () => {
  it.each([0, 2, 4])(
    'hands the recording to the reader at %i completed items without an independent audio player',
    async (completedItems) => {
      const item = saved({ status: 'paused', completedItems, chapterIds: ['c1', 'c2'] });
      const api = port(async () => [item]);
      const listen = vi.fn();
      const root = await mount(controls({ port: api, listen, generation: undefined }));
      await click(button(root, '본문에서 듣기'));
      expect(listen).toHaveBeenCalledExactlyOnceWith(item);
      expect(api.audio).not.toHaveBeenCalled();
      expect(api.resolve).not.toHaveBeenCalled();
      expect(api.progress).not.toHaveBeenCalled();
    },
  );
  it('keeps a handoff failure on its card and permits retry', async () => {
    const listen = vi.fn().mockRejectedValueOnce(new Error('본문이 변경됐어요')).mockResolvedValue(undefined);
    const root = await mount(controls({ port: port(async () => [saved()]), listen }));
    await click(button(root, '본문에서 듣기'));
    expect(text(root.findByType('li'))).toContain('본문이 변경됐어요');
    await click(button(root, '본문에서 듣기'));
    expect(listen).toHaveBeenCalledTimes(2);
  });
  it('does not offer the previous account recording after the owner changes', async () => {
    const first = port(async () => [saved()]);
    await mount(controls({ port: first }));
    const second = port(async () => []);
    act(() =>
      renderer!.update(<UiNextAudiobookPanel controls={controls({ key: 'account-2:novel-1', port: second })} />),
    );
    await flush();
    expect(second.list).toHaveBeenCalledTimes(1);
    expect(text(renderer!.root)).toContain('아직 미리 만든 음성이 없어요');
    expect(hasButton(renderer!.root, '본문에서 듣기')).toBe(false);
  });
});
