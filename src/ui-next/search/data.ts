import type { BookWorkspaceScreensProps } from '../../features/book-workspace/BookWorkspaceScreens';
import type { ReaderSettingsController } from '../../features/reader-settings/useReaderSettingsDraft';

export interface SearchData {
  discovery?: BookWorkspaceScreensProps['discovery'];
  externalSources: BookWorkspaceScreensProps['externalSources'];
  controller: BookWorkspaceScreensProps['controller'];
  preferences: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
}
