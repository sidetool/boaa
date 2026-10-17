import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { LibrarySourceFilesController, type LibrarySourceFilesPorts } from './library-source-files-controller';

export function useLibrarySourceFilesController(
  ports: LibrarySourceFilesPorts,
  owner: { readonly runtime: object; readonly account?: string; readonly settingsScope: string },
): LibrarySourceFilesController {
  const { assets, reader, workspace, documentIo, browser, refresh, notify } = ports;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const notifyCurrent = useCallback<LibrarySourceFilesPorts['notify']>(
    (message, tone) => notifyRef.current(message, tone),
    [],
  );
  const session = useMemo(
    () => ({ runtime: owner.runtime, account: owner.account, settingsScope: owner.settingsScope }),
    [owner.runtime, owner.account, owner.settingsScope],
  );
  const currentSession = useRef(session);
  currentSession.current = session;
  const current = useRef<LibrarySourceFilesController>();
  const controller = useMemo(() => {
    const instance: LibrarySourceFilesController = new LibrarySourceFilesController(
      { assets, reader, workspace, documentIo, browser, refresh, notify: notifyCurrent },
      () => current.current === instance && currentSession.current === session,
    );
    return instance;
    // Runtime and account delimit ownership even when repositories are reused.
  }, [assets, reader, workspace, documentIo, browser, refresh, notifyCurrent, session]);
  current.current = controller;
  useLayoutEffect(() => {
    controller.activate();
    return () => controller.deactivate();
  }, [controller]);
  return controller;
}
