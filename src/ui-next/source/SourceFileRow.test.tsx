import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { externalItemKeyId } from '../../external-sources/contracts';
import type {
  ExternalSourceController,
  ExternalSourceItemView,
} from '../../features/external-sources/external-source-controller-contract';
import { episode } from '../../features/external-sources/source-command-test-fixtures';
import { sourceHubItemActions } from '../../features/external-sources/source-hub-item-actions';
import type { ImportTaskView } from '../../features/import/import-task-projection';
import { SourceFileRow } from './SourceFileRow';

let controller: ExternalSourceController;

beforeEach(() => {
  controller = {
    busy: false,
    loading: false,
    blockingBusy: false,
    importBusy: false,
    canRemoveItems: false,
    cancel: vi.fn(),
    importItem: vi.fn(),
    openImported: vi.fn(),
    deleteDownloads: vi.fn(),
    toggleItem: vi.fn(),
    removeItem: vi.fn(),
    isWorkInLibrary: vi.fn(() => false),
  } as unknown as ExternalSourceController;
});

function file(overrides: Partial<ExternalSourceItemView> = {}): ExternalSourceItemView {
  return { ...episode(), title: '테스트 파일', release: undefined, collection: undefined, ...overrides };
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function buttons(root: ReactTestInstance, name: string) {
  return root.findAll(
    (node) => node.type === 'button' && (node.props['aria-label'] ?? text(node).replace(/\s+/g, ' ').trim()) === name,
  );
}
function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
}
function render(overrides: Partial<ImportTaskView> | undefined, item = file()) {
  const task: ImportTaskView | undefined = overrides && {
    id: 'task-1',
    batchId: 'batch-1',
    source: 'external_source',
    title: item.title,
    externalItemKey: externalItemKeyId(item.key),
    phase: 'downloading',
    ...overrides,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SourceFileRow
        item={item}
        controller={controller}
        actions={sourceHubItemActions(item, controller, task)}
        task={task}
      />,
    );
  });
  return { item, row: renderer.root.findByType('div') };
}

describe('SourceFileRow import tasks', () => {
  it('shows an indeterminate transfer and cancels instead of importing twice', () => {
    const { item, row } = render({ phase: 'downloading' });
    expect(row.props['aria-busy']).toBe(true);
    expect(text(row)).toContain('다운로드 중');
    expect(text(row)).not.toContain('%');
    const bar = row.findByProps({ role: 'progressbar' });
    expect(bar.props['aria-valuenow']).toBeUndefined();
    expect(bar.props.className).toContain('is-indeterminate');
    expect(buttons(row, '가져오기')).toHaveLength(0);
    click(buttons(row, `${item.title} 가져오기 중단`)[0]);
    expect(controller.cancel).toHaveBeenCalledOnce();
    expect(controller.importItem).not.toHaveBeenCalled();
  });

  it('shows measured progress only when the task knows it', () => {
    const { row } = render({
      phase: 'saving',
      percent: 25,
      measurement: { phase: 'saving', completed: 1, total: 4, unit: 'items' },
    });
    expect(row.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(25);
    expect(text(row)).toContain('저장 중');
    expect(text(row)).toContain('25% · 1 / 4개');
  });

  it('keeps a queued file quiet until work starts', () => {
    const { row } = render({ phase: 'queued' });
    expect(text(row)).toContain('대기 중');
    expect(row.findAllByProps({ role: 'progressbar' })).toHaveLength(0);
  });

  it('locks cancellation while cancelling', () => {
    const { item, row } = render({ phase: 'cancelling' });
    expect(buttons(row, `${item.title} 취소 중`)[0].props.disabled).toBe(true);
  });

  it('explains a failure and retries through the normal import path', () => {
    const { item, row } = render({ phase: 'failed', error: '서버 연결이 끊겼어요' });
    expect(row.props['aria-busy']).toBeUndefined();
    expect(text(row.findByProps({ role: 'alert' }))).toContain('가져오지 못했어요');
    expect(text(row)).toContain('서버 연결이 끊겼어요');
    click(buttons(row, '다시 시도')[0]);
    expect(controller.importItem).toHaveBeenCalledExactlyOnceWith(item);
  });

  it('retries a failed update of a saved file through the import path', () => {
    const saved = file({ importState: 'update_available', localBookId: 'saved' });
    const { item, row } = render({ phase: 'failed', error: '실패' }, saved);
    expect(buttons(row, '열기')).toHaveLength(0);
    click(buttons(row, '다시 시도')[0]);
    expect(controller.importItem).toHaveBeenCalledExactlyOnceWith(item);
    expect(controller.openImported).not.toHaveBeenCalled();
    expect(controller.deleteDownloads).not.toHaveBeenCalled();
  });

  it('still opens an imported file that has no task', () => {
    const { item, row } = render(undefined, file({ importState: 'imported', localBookId: 'saved' }));
    click(buttons(row, '열기')[0]);
    expect(controller.openImported).toHaveBeenCalledExactlyOnceWith(item);
    expect(controller.deleteDownloads).not.toHaveBeenCalled();
  });

  it('marks a completed import before the list refresh lands', () => {
    const { row } = render({ phase: 'complete' });
    expect(text(row)).toContain('가져오기 완료');
    expect(buttons(row, '가져오기')).toHaveLength(0);
  });
});
