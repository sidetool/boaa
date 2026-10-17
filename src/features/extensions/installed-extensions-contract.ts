import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import type { SourceExtensionManager } from '../../external-sources/extension-management';

export interface InstalledExtensionsPanelProps {
  manager: InstalledExtensionManager;
  updatesRequest?: number;
  suwayomi?: SourceExtensionManager;
  sourceTarget?: 'device' | 'server';
  onSourceTargetChange?: (target: 'device' | 'server') => void;
}
