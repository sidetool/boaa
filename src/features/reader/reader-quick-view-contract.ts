import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import type { ReaderRuntimeFlow } from './ReaderViewport';

export interface ReaderQuickViewProps {
  readonly saveState?: { readonly saving: boolean; readonly dirty: boolean; readonly error: boolean };
  readonly onRetrySave?: () => void;
  readonly open: boolean;
  readonly profile: ReadingProfile;
  readonly readingFlow: ReaderRuntimeFlow;
  readonly bookOverrideEnabled: boolean;
  readonly onClose: () => void;
  readonly onUpdate: (patch: ReadingProfileOverride) => void;
  readonly onSetBookOverride: (enabled: boolean) => void;
  readonly onOpenAllSettings: () => void;
}
