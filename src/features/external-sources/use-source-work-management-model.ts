import { useEffect, useState } from 'react';
import type { Novel } from '../../domain/types';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import type { ExternalSourceController } from './external-source-controller-contract';
import { sourceWorkReadingSeconds } from './source-work-reading-time';
export interface SourceWorkManagementModelOptions {
  novel?: Novel;
  controller: ExternalSourceController;
  library: LibraryScreenProps;
}
export function useSourceWorkManagementModel({ novel, controller, library }: SourceWorkManagementModelOptions) {
  const [time, setTime] = useState<{ id: string; revision: number; seconds?: number }>();
  const id = controller.workReadingSessionId;
  const revision = controller.readingHistoryRevision ?? 0;
  useEffect(() => {
    if (!id) return;
    let active = true;
    void sourceWorkReadingSeconds(id).then(
      (seconds) => {
        if (active) setTime({ id, revision, seconds });
      },
      () => {
        if (active) setTime({ id, revision });
      },
    );
    return () => {
      active = false;
    };
  }, [id, revision]);
  const seconds = time?.id === id && time?.revision === revision ? time.seconds : undefined;
  const remove = async () => {
    if (novel) {
      await library.actions.books.remove(novel);
      controller.close();
    } else if (controller.activeSubscription) void controller.removeLibraryWork(controller.activeSubscription);
  };
  const editMetadata = () => {
    if (novel) library.actions.books.editMetadata(novel);
  };
  const downloadSource = () => {
    if (novel) return library.actions.books.downloadSource(novel);
  };
  const resetHistory = () => controller.resetCurrentWorkHistory?.();
  const resetDisabled =
    controller.busy || controller.importBusy || controller.blockingBusy || !controller.resetCurrentWorkHistory;
  const removeDisabled = controller.busy || controller.loading;
  return { id, time, seconds, remove, editMetadata, downloadSource, resetHistory, resetDisabled, removeDisabled };
}
export type SourceWorkManagementModel = ReturnType<typeof useSourceWorkManagementModel>;
