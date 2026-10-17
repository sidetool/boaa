import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceStreamSession } from '../../external-sources/source-stream';
import FixedDocumentScreen from '../fixed-document/FixedDocumentScreen';
import { UiNextStreamLoading } from '../../ui-next/reader/UiNextStreamLoading';
import { deferred } from './source-command-test-fixtures';
import { SourceStreamReader, type SourceStreamReaderProps } from './SourceStreamReader';

vi.mock('../fixed-document/FixedDocumentScreen', () => ({ default: vi.fn(() => null) }));
vi.mock('./use-source-reading-preferences', () => ({
  useSourceReadingPreferences: () => ({ mode: 'stream', prefetch: 0 }),
}));
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
function session(): SourceStreamSession {
  return { pageCount: 4, loadPage: vi.fn().mockResolvedValue(new Blob(['page'])), close: vi.fn() };
}
function fixture(overrides: Partial<SourceStreamReaderProps> = {}) {
  const pending = deferred<SourceStreamSession>();
  const props: SourceStreamReaderProps = {
    title: '6화',
    workTitle: '테스트 작품',
    remoteId: 'six',
    port: { open: vi.fn(() => pending.promise) },
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { props, pending };
}
async function mount(props: SourceStreamReaderProps) {
  await act(async () => {
    renderer = create(<SourceStreamReader {...props} />);
  });
  return renderer!.root;
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, name: string) {
  return root.find((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node).trim()) === name);
}

describe('ComicStreamReader ui-next loading', () => {
  it('shows the comic loading stage before the stream opens', async () => {
    const { props } = fixture();
    const root = await mount(props);
    expect(root.findByType(UiNextStreamLoading).props).toMatchObject({
      workTitle: '테스트 작품',
      episodeTitle: '6화',
      onClose: props.onClose,
    });
    expect(root.findByType('main').props.className.split(' ')).toContain('is-comic');
    expect(text(root.findByProps({ role: 'status' }))).toBe('6화 여는 중');
    expect(root.findAllByType(FixedDocumentScreen)).toHaveLength(0);
    expect(props.port.open).toHaveBeenCalledExactlyOnceWith('six', expect.any(AbortSignal));
  });
  it('keeps loading after open until the viewer reports layoutReady=true', async () => {
    const { props, pending } = fixture();
    const root = await mount(props);
    await act(async () => {
      pending.resolve(session());
      await pending.promise;
    });
    const viewer = root.findByType(FixedDocumentScreen);
    expect(viewer.props.novel.title).toBe('테스트 작품');
    expect(root.findAllByType(UiNextStreamLoading)).toHaveLength(1);
    act(() => viewer.props.onLayoutStateChange({ layoutReady: false, retry: vi.fn() }));
    expect(root.findAllByType(UiNextStreamLoading)).toHaveLength(1);
    act(() => viewer.props.onLayoutStateChange({ layoutReady: true, retry: vi.fn() }));
    expect(root.findAllByType(UiNextStreamLoading)).toHaveLength(0);
    expect(root.findAllByType(FixedDocumentScreen)).toHaveLength(1);
  });
  it('shows layout errors and retries through the viewer-provided callback', async () => {
    const { props, pending } = fixture();
    const root = await mount(props);
    await act(async () => {
      pending.resolve(session());
      await pending.promise;
    });
    const viewer = root.findByType(FixedDocumentScreen);
    const retry = vi.fn();
    act(() => viewer.props.onLayoutStateChange({ layoutReady: false, error: new Error('layout failed'), retry }));
    const alert = root.findByProps({ role: 'alert' });
    expect(text(alert)).toContain('보기 방식을 정하지 못했어요. 다시 시도해 주세요.');
    act(() => button(alert, '다시 시도').props.onClick());
    expect(retry).toHaveBeenCalledExactlyOnceWith();
    act(() => button(alert, '목록으로').props.onClick());
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith();
    act(() => viewer.props.onLayoutStateChange({ layoutReady: true, retry }));
    expect(root.findAllByType(UiNextStreamLoading)).toHaveLength(0);
  });
  it('shows stream opening errors and reopens the stream on retry', async () => {
    const { props } = fixture({
      port: { open: vi.fn().mockRejectedValueOnce(new Error('회차 연결 실패')).mockResolvedValue(session()) },
    });
    const root = await mount(props);
    const alert = root.findByProps({ role: 'alert' });
    expect(text(alert)).toContain('회차 연결 실패');
    await act(async () => {
      button(alert, '다시 시도').props.onClick();
    });
    expect(props.port.open).toHaveBeenCalledTimes(2);
    expect(root.findByType(UiNextStreamLoading).props.error).toBeUndefined();
    expect(root.findAllByType(FixedDocumentScreen)).toHaveLength(1);
  });
});
