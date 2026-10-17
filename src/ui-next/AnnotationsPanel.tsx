import { lazy, type ComponentType } from 'react';
import type { AnnotationsController } from '../features/annotations/useAnnotationsController';

type Props = { controller: AnnotationsController };

// App already lazy-loads this module, so export a plain component that picks the panel once.
const Panel = lazy<ComponentType<Props>>(() => import('./reader/UiNextAnnotationsPanel'));

export default function AnnotationsPanel(props: Props) {
  return <Panel {...props} />;
}
