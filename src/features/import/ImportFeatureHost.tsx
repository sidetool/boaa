import { LoaderCircle, Plus } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { LayerPresence } from '../../shared/ui/LayerPresence';
import type { ImportFeatureController } from './useImportController';

const ImportDialog = lazy(() => import('../../ui-next/import/UiNextImportSheet'));

export interface ImportFeatureHostProps {
  controller: ImportFeatureController;
  showFloatingTrigger: boolean;
}

export function ImportFeatureHost({ controller, showFloatingTrigger }: ImportFeatureHostProps) {
  return (
    <>
      <LayerPresence open={controller.isOpen}>
        <Suspense fallback={null}>
          <ImportDialog controller={controller} />
        </Suspense>
      </LayerPresence>
      {showFloatingTrigger && (
        <button
          className={`floating-import${controller.tasks.length > 0 ? ' is-active' : ''}`}
          onClick={controller.open}
          title={controller.tasks.length > 0 ? '가져오기 진행 상태' : '책 가져오기'}
          aria-label={controller.tasks.length > 0 ? `가져오기 ${controller.tasks.length}개 진행 상태` : '책 가져오기'}
        >
          {controller.tasks.length > 0 ? <LoaderCircle size={24} className="spin" /> : <Plus size={24} />}
        </button>
      )}
    </>
  );
}
