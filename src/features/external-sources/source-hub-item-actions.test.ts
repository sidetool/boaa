import { expect, it, vi } from 'vitest';
import type { ExternalSourceController, ExternalSourceItemView } from './external-source-controller-contract';
import type { ImportTaskView } from '../import/import-task-projection';
import { releaseDownloadAction, sourceHubItemActions } from './source-hub-item-actions';
const item: ExternalSourceItemView = {
  key: { connectorId: 'fixture.source', remoteId: 'episode' },
  title: '회차',
  kind: 'file',
  importState: 'available',
  importability: 'supported',
  selected: false,
};
function controller(patch: Partial<ExternalSourceController> = {}) {
  return {
    busy: false,
    loading: false,
    blockingBusy: false,
    importBusy: false,
    canQueueItem: vi.fn(() => false),
    canStreamItem: vi.fn(() => false),
    cancel: vi.fn(),
    importItem: vi.fn(),
    importAndOpen: vi.fn(),
    deleteDownloads: vi.fn(),
    openImported: vi.fn(),
    setReleasesRead: vi.fn(),
    markPreviousReleasesRead: vi.fn(),
    renameRelease: vi.fn(),
    ...patch,
  } as unknown as ExternalSourceController;
}
it('keeps active/cancelling task precedence over saved-item deletion', () => {
  const c = controller();
  const saved = { ...item, localBookId: 'book', importState: 'imported' as const };
  const action = releaseDownloadAction(saved, c, { phase: 'cancelling' } as ImportTaskView);
  expect(action).toMatchObject({ id: 'cancel', disabled: true, title: '취소 중' });
  action.run();
  expect(c.cancel).toHaveBeenCalledOnce();
  expect(releaseDownloadAction(saved, c, { phase: 'failed' } as ImportTaskView).id).toBe('delete-download');
  expect(releaseDownloadAction(item, c, { phase: 'failed' } as ImportTaskView).id).toBe('retry');
});
it('routes queue and update to import, streaming to read, and keeps blocked labels', () => {
  const c = controller({ importBusy: true });
  expect(releaseDownloadAction(item, c)).toMatchObject({ disabled: true, title: '다른 작품 다운로드 중' });
  c.canQueueItem = () => true;
  const queued = releaseDownloadAction(item, c);
  queued.run();
  expect(queued).toMatchObject({ id: 'queue', disabled: false });
  expect(c.importItem).toHaveBeenCalledWith(item);
  c.canStreamItem = () => true;
  releaseDownloadAction(item, c).run();
  expect(c.importAndOpen).toHaveBeenCalledWith(item);
  const update = { ...item, importState: 'update_available' as const };
  releaseDownloadAction(update, c).run();
  expect(c.importItem).toHaveBeenLastCalledWith(update);
});
it('exposes saved read, menu read-state changes, deletion and caller-owned title editing', () => {
  const c = controller();
  const saved = { ...item, localBookId: 'book', importState: 'imported' as const, readingState: 'read' as const };
  const actions = sourceHubItemActions(saved, c);
  actions.read?.run();
  actions.menu.find((action) => action.id === 'toggle-read')!.run();
  actions.menu.find((action) => action.id === 'read-previous')!.run();
  actions.menu.find((action) => action.id === 'delete-download')!.run();
  actions.rename('새 제목');
  expect(c.openImported).toHaveBeenCalledWith(saved);
  expect(c.setReleasesRead).toHaveBeenCalledWith([saved], false);
  expect(c.markPreviousReleasesRead).toHaveBeenCalledWith(saved);
  expect(c.deleteDownloads).toHaveBeenCalledWith([saved]);
  expect(c.renameRelease).toHaveBeenCalledWith(saved, '새 제목');
  expect(actions.showReleaseDownload).toBe(false);
});
