import type { Novel } from '../../domain/types';
import type { PlatformDocumentIo } from '../../platform/document-io';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { formatBytes } from '../../utils/format';
import type { BookWorkspaceController } from '../book-workspace/book-workspace-controller';
import type { BookWorkspaceNoticeTone } from '../book-workspace/book-workspace-contract';

export interface LibrarySourceFilesPorts {
  readonly assets?: BookAssetRepository;
  readonly reader: Pick<ReaderRepository, 'getNovel'>;
  readonly workspace: Pick<BookWorkspaceController, 'getSnapshot' | 'subscribe' | 'openNovel'>;
  readonly documentIo: Pick<PlatformDocumentIo, 'saveDocument'>;
  readonly browser: boolean;
  refresh(): Promise<unknown>;
  notify(message: string, tone: BookWorkspaceNoticeTone): void;
}

function navigationKey(workspace: LibrarySourceFilesPorts['workspace']): string {
  const state = workspace.getSnapshot();
  return JSON.stringify([
    state.view,
    state.selectedNovel?.id,
    state.selectedNovel?.activeContentRevisionId,
    state.currentChapter?.id,
    state.navigationPending,
    state.readerOpenRequestVersion,
  ]);
}

/** Session-owned commands; dialog subscriptions stay in their host, outside App. */
export class LibrarySourceFilesController {
  private active = true;
  private generation = 0;
  private dialog?: Novel;
  private readonly listeners = new Set<() => void>();
  constructor(
    readonly ports: LibrarySourceFilesPorts,
    private readonly ownsSession: () => boolean,
  ) {}
  readonly getSnapshot = () => this.dialog;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate() {
    this.active = true;
  }
  deactivate() {
    this.active = false;
    this.generation += 1;
    this.close();
  }
  private current(generation = this.generation) {
    return this.active && this.ownsSession() && generation === this.generation;
  }
  readonly close = () => {
    this.dialog = undefined;
    this.listeners.forEach((listener) => listener());
  };
  readonly exportSource = (novel: Novel): void | Promise<void> => {
    if (!this.current()) return;
    const { assets, browser } = this.ports;
    if (browser && assets?.listOriginalFiles && assets.createOriginalFileDownload) {
      this.dialog = novel;
      this.listeners.forEach((listener) => listener());
      return;
    }
    return this.exportLegacy(novel);
  };
  readonly exportDialogLegacy = () => {
    const novel = this.dialog;
    this.close();
    if (novel) return this.exportLegacy(novel);
  };
  readonly exportLegacy = async (novel: Novel) => {
    const generation = this.generation;
    if (!this.current(generation)) return;
    const { assets, documentIo, notify } = this.ports;
    if (!assets) {
      notify('이 실행 환경에서는 원본 다운로드를 지원하지 않습니다.', 'warning');
      return;
    }
    try {
      const { exportPortableBookSource } = await import('../../repositories/comic-source-export');
      if (!this.current(generation)) return;
      const source = await exportPortableBookSource(assets, novel.id);
      if (!this.current(generation)) return;
      if (!source) {
        notify('보관된 원본 파일이 없습니다. 원본을 다시 가져와 보강하세요.', 'warning');
        return;
      }
      const result = await documentIo.saveDocument({
        suggestedName: source.metadata.fileName || novel.sourceFileName || `${novel.title}.txt`,
        mimeType: source.metadata.contentType || 'application/octet-stream',
        blob: source.blob,
      });
      if (!this.current(generation)) return;
      notify(
        result === 'cancelled'
          ? '원본 파일 저장을 취소했습니다.'
          : `원본 ${formatBytes(source.metadata.byteLength)}을(를) 다운로드했습니다.`,
        result === 'cancelled' ? 'info' : 'success',
      );
    } catch (error) {
      if (this.current(generation))
        notify(error instanceof Error ? error.message : '원본 파일을 다운로드하지 못했습니다.', 'danger');
    }
  };
  readonly reselectSource = (novel: Novel, file: File) => this.mutate(novel, file);
  readonly reconstructSource = (novel: Novel) => this.mutate(novel);
  private async mutate(novel: Novel, file?: File) {
    const generation = this.generation;
    if (!this.current(generation)) return;
    const { assets, workspace, reader, refresh, notify } = this.ports;
    if (!assets || (!file && !assets.reconstructCanonicalSource)) {
      notify(
        file
          ? '이 실행 환경에서는 원본 다시 선택을 지원하지 않습니다.'
          : '이 실행 환경에서는 source 재구성을 지원하지 않습니다.',
        'warning',
      );
      return;
    }
    // Track transitions, including A → B → A. Catalog refresh alone is not navigation.
    const initialNavigation = navigationKey(workspace);
    let navigated = false;
    const unsubscribe = workspace.subscribe(() => {
      navigated ||= navigationKey(workspace) !== initialNavigation;
    });
    try {
      const source = file
        ? await assets.reselectOriginalSource(novel.id, {
            fileName: file.name,
            contentType: file.type || 'text/plain',
            blob: file,
          })
        : await assets.reconstructCanonicalSource!(novel.id);
      if (!this.current(generation)) return;
      await refresh();
      if (!this.current(generation)) return;
      if (!navigated) {
        const updated = await reader.getNovel(novel.id);
        if (!this.current(generation)) return;
        if (updated && !navigated) await workspace.openNovel(updated);
      }
      if (!this.current(generation)) return;
      notify(
        file
          ? `원본 ${formatBytes(file.size)}을(를) 연결했습니다.`
          : `재구성 source ${formatBytes(source.byteLength)}을(를) 만들었습니다.`,
        'success',
      );
    } catch (error) {
      if (this.current(generation))
        notify(
          error instanceof Error
            ? error.message
            : file
              ? '원본 파일을 연결하지 못했습니다.'
              : 'source를 재구성하지 못했습니다.',
          'danger',
        );
    } finally {
      unsubscribe();
    }
  }
}
