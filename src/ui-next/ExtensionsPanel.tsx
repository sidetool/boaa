import { lazy, type ComponentType } from 'react';
import type { InstalledExtensionsPanelProps } from '../features/extensions/installed-extensions-contract';

type Props = InstalledExtensionsPanelProps;

// App already lazy-loads this module, so export a plain component that picks the panel once.
const Panel = lazy<ComponentType<Props>>(() =>
  import('./settings/UiNextExtensionsPanel').then((module) => ({ default: module.UiNextExtensionsPanel })),
);

export default function ExtensionsPanel(props: Props) {
  return <Panel {...props} />;
}
