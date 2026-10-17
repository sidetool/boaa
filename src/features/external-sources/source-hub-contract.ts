import type { DownloadSelectionRequest } from './use-download-selection-focus';
import type { SourceTextReaderOptions } from './SourceTextStreamReader';
import type { Novel } from '../../domain/types';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import type { ExternalSourceController } from './external-source-controller-contract';

export interface SourceHubScreenProps {
  readonly downloadRequest?: DownloadSelectionRequest;
  readonly textReader?: SourceTextReaderOptions;
  readonly controller: ExternalSourceController;
  readonly library: LibraryScreenProps;
  readonly openSourceSettings: () => void;
  readonly openLocalSeriesImport?: (novel: Novel) => void;
  readonly localSeriesNovel?: Novel;
  readonly localSeriesTitleEditor?: {
    readonly editing: boolean;
    readonly draft: string;
    start(): void;
    cancel(): void;
    setDraft(value: string): void;
    save(): void | Promise<void>;
  };
}
