import { useCallback, useEffect, useRef, useState } from 'react';
import type { Novel } from '../../domain/types';
import {
  ImportCommittedRefreshError,
  type ImportResult,
  type ImportService,
} from '../../services/import/import-service';
import type { StoredUploadSessionEntry } from '../../services/import/server-upload-import-service';
import type { ToastTone } from '../../shared/ui/ToastHost';

interface ImportServiceWithUploadSessions extends ImportService {
  listStoredUploadSessions(): StoredUploadSessionEntry[];
  forgetStoredUploadSession(key: string): Promise<void> | void;
  retryStoredUploadSession?(key: string): Promise<ImportResult>;
}

export interface ImportUploadSessionLifecycle {
  sessions: readonly StoredUploadSessionEntry[];
  retryingKeys: readonly string[];
  refresh(): void;
  hasCompleted(): boolean;
  forget(key: string): Promise<boolean>;
  retry(key: string): Promise<void>;
}

function supportsUploadSessions(service: ImportService): service is ImportServiceWithUploadSessions {
  const candidate = service as Partial<ImportServiceWithUploadSessions>;
  return (
    typeof candidate.listStoredUploadSessions === 'function' &&
    typeof candidate.forgetStoredUploadSession === 'function'
  );
}

export function useImportUploadSessions(
  service: ImportService,
  notify: (message: string, tone?: ToastTone) => void,
  onRecovered?: (novel: Novel) => Promise<void>,
): ImportUploadSessionLifecycle {
  const dependenciesRef = useRef({ service, notify, onRecovered });
  dependenciesRef.current = { service, notify, onRecovered };
  const [sessionState, setSessions] = useState<{ service: ImportService; entries: StoredUploadSessionEntry[] }>({
    service,
    entries: [],
  });
  const [retryState, setRetryingKeys] = useState<{ service: ImportService; keys: string[] }>({ service, keys: [] });
  const pendingRef = useRef({ service, keys: new Set<string>() });
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, [service]);

  const refresh = useCallback(() => {
    const currentService = dependenciesRef.current.service;
    setSessions({
      service: currentService,
      entries: supportsUploadSessions(currentService) ? currentService.listStoredUploadSessions() : [],
    });
  }, []);

  const hasCompleted = useCallback(() => {
    const currentService = dependenciesRef.current.service;
    return (
      supportsUploadSessions(currentService) &&
      currentService.listStoredUploadSessions().some((session) => Boolean(session.completion))
    );
  }, []);

  const forget = useCallback(async (key: string) => {
    const { service: currentService, notify: currentNotify } = dependenciesRef.current;
    const generation = generationRef.current;
    const isCurrent = () =>
      mountedRef.current && generation === generationRef.current && dependenciesRef.current.service === currentService;
    if (
      !supportsUploadSessions(currentService) ||
      (pendingRef.current.service === currentService && pendingRef.current.keys.has(key))
    )
      return false;
    try {
      await currentService.forgetStoredUploadSession(key);
      if (!isCurrent()) return false;
      setSessions({ service: currentService, entries: currentService.listStoredUploadSessions() });
      currentNotify('서버 업로드 기록을 지웠습니다.', 'info');
      return true;
    } catch {
      if (isCurrent()) currentNotify('서버 업로드 기록을 지우지 못했습니다.', 'danger');
      return false;
    }
  }, []);

  const retry = useCallback(async (key: string) => {
    const { service: currentService, notify: currentNotify, onRecovered: recover } = dependenciesRef.current;
    if (
      !supportsUploadSessions(currentService) ||
      !currentService.retryStoredUploadSession ||
      (pendingRef.current.service === currentService && pendingRef.current.keys.has(key))
    )
      return;
    const generation = generationRef.current;
    const isCurrent = () =>
      mountedRef.current && generation === generationRef.current && dependenciesRef.current.service === currentService;
    if (pendingRef.current.service !== currentService)
      pendingRef.current = { service: currentService, keys: new Set<string>() };
    const pending = pendingRef.current.keys;
    pending.add(key);
    setRetryingKeys({ service: currentService, keys: [...pending] });
    try {
      const result = await currentService.retryStoredUploadSession(key);
      if (!isCurrent()) return;
      await recover?.(result.novel);
      if (!isCurrent()) return;
      currentNotify('저장된 작품 정보를 갱신했습니다.', 'success');
    } catch (error) {
      if (!isCurrent()) return;
      currentNotify(
        error instanceof ImportCommittedRefreshError
          ? error.message
          : '작품은 저장되어 있습니다. 완료 정보를 다시 갱신해 주세요.',
        'warning',
      );
    } finally {
      pending.delete(key);
      if (isCurrent()) {
        setRetryingKeys({ service: currentService, keys: [...pending] });
        setSessions({ service: currentService, entries: currentService.listStoredUploadSessions() });
      }
    }
  }, []);

  return {
    sessions: sessionState.service === service ? sessionState.entries : [],
    retryingKeys: retryState.service === service ? retryState.keys : [],
    refresh,
    hasCompleted,
    forget,
    retry,
  };
}
