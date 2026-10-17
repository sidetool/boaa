import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  OptionalComponentId,
  ReleaseChannel,
  ServerManagementOperationResult,
  ServerManagementRequest,
  ServerManagementStatus,
} from '../../../packages/contracts/server-management';
import {
  ServerManagementError,
  type ServerManagementClient,
  type ServerManagementFailure,
} from './server-management-client';
import { managementErrorMessage, RELEASE_GUIDE, type ManagementMessage } from './server-management-messages';
import { compareVersions } from './server-versions';

/** The updater reads requests every second; follow it at the same pace while something is happening. */
const ACTIVE_POLL_MS = 1_000;
const RECONNECT_POLL_MS = 3_000;
const SLOW_RECONNECT_POLL_MS = 10_000;
/** The updater refreshes runtime health every 30 seconds; an open screen follows it at that pace. */
const IDLE_POLL_MS = 30_000;
/** After this the screen says the restart is taking long but keeps trying. */
export const RECONNECT_PATIENCE_MS = 5 * 60_000;
/**
 * A request nobody reports on (no current operation, no result, nothing busy) is released after this long, as
 * "could not confirm" rather than success or failure. Measured on this device's clock only.
 */
export const UNRESOLVED_AFTER_MS = 30_000;
const UNRESOLVED_MIN_CHECKS = 3;
/** Servers that return no request id: give the updater this long to start before treating it as done. */
const UNTRACKED_GRACE_MS = 5_000;

export type PendingRequest = 'check' | 'update' | 'channel' | `component:${OptionalComponentId}`;
/** sending: POST in flight · queued: accepted, updater has not started it · running: the updater reports it. */
export type PendingStage = 'sending' | 'queued' | 'running';

interface TrackedRequest {
  readonly key: PendingRequest;
  readonly request: ServerManagementRequest;
  readonly id?: string;
  /** Accepted by an older server that returns no id; only then may a quiet updater be read as done. */
  readonly legacy?: boolean;
  readonly fromVersion?: string;
  readonly createdAt: number;
  stage: PendingStage;
  idleChecks: number;
  idleSince?: number;
}

type Settlement =
  | { kind: 'waiting' }
  | { kind: 'final'; outcome: ServerManagementOperationResult['outcome']; error?: string }
  | { kind: 'unresolved' };

export interface ActionNotice extends ManagementMessage {
  readonly key: PendingRequest;
  /** The outcome is unknown; offer a fresh look instead of a verdict. */
  readonly unresolved?: boolean;
}

function pendingKey(request: ServerManagementRequest): PendingRequest {
  return request.action === 'component' ? `component:${request.componentId ?? 'apk'}` : request.action;
}

function isFailedPhase(status: ServerManagementStatus): boolean {
  return status.phase === 'failed' || status.phase === 'recovery-required';
}

/** Where a tracked request stands in a fresh status. Mutates the idle bookkeeping on `tracked`. */
function settle(tracked: TrackedRequest, status: ServerManagementStatus, now: number): Settlement {
  const idle = (): Settlement => {
    tracked.idleChecks += 1;
    tracked.idleSince ??= now;
    if (tracked.legacy && tracked.stage === 'running')
      return { kind: 'final', outcome: isFailedPhase(status) ? 'failed' : 'complete', error: status.error };
    if (tracked.legacy && tracked.stage !== 'running' && now - tracked.createdAt >= UNTRACKED_GRACE_MS)
      return { kind: 'final', outcome: 'complete' };
    if (tracked.idleChecks >= UNRESOLVED_MIN_CHECKS && now - tracked.idleSince >= UNRESOLVED_AFTER_MS)
      return { kind: 'unresolved' };
    return { kind: 'waiting' };
  };
  const progress = (stage: PendingStage): Settlement => {
    tracked.stage = stage;
    tracked.idleChecks = 0;
    tracked.idleSince = undefined;
    return { kind: 'waiting' };
  };

  if (tracked.id) {
    const result = status.operationResults?.find((entry) => entry.id === tracked.id);
    if (result) return { kind: 'final', outcome: result.outcome, error: result.error };
    const operation = status.operation;
    if (operation?.id === tracked.id) {
      if (operation.completedAt)
        return {
          kind: 'final',
          outcome:
            status.phase === 'recovery-required' ? 'recovery-required' : isFailedPhase(status) ? 'failed' : 'complete',
          error: status.error,
        };
      // Busy false with our operation still open is contradictory; let the idle clock decide.
      return status.busy ? progress('running') : idle();
    }
    // Another operation is running ahead of ours: still queued, but something is moving.
    if (status.busy) return progress('queued');
    return idle();
  }
  if (status.busy) return progress('running');
  return idle();
}

function sendFailure(kind: ServerManagementFailure): ManagementMessage {
  switch (kind) {
    case 'forbidden':
      return { tone: 'danger', text: '서버 관리자만 할 수 있어요. 관리자 계정으로 다시 로그인해 주세요.' };
    case 'conflict':
      return { tone: 'warning', text: '다른 작업이 진행 중이에요. 끝난 뒤 다시 시도해 주세요.' };
    case 'updater-unavailable':
      return {
        tone: 'danger',
        text: `서버의 updater가 응답하지 않아 요청을 보내지 못했어요. updater 서비스가 실행 중인지 확인해 주세요(${RELEASE_GUIDE}).`,
      };
    case 'updater-unconfigured':
      return { tone: 'warning', text: `이 서버에는 updater가 설정돼 있지 않아요. ${RELEASE_GUIDE}를 참고해 주세요.` };
    case 'offline':
      return { tone: 'danger', text: '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' };
    default:
      return { tone: 'danger', text: '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.' };
  }
}

/**
 * Server release and optional component state for the admin screen. Each accepted request is followed by its id
 * until the server reports a result; the API restarts during updates and component changes, so lost connections
 * turn into reconnecting rather than errors while a request is open. `busy` alone decides whether work is running.
 */
export function useServerManagement(client: ServerManagementClient | undefined, webVersion: string) {
  const [status, setStatus] = useState<ServerManagementStatus>();
  const [loadError, setLoadError] = useState<ServerManagementFailure>();
  const [loading, setLoading] = useState(Boolean(client));
  const [tracked, setTracked] = useState<TrackedRequest>();
  /** Bumped when the tracked request's stage changes in place. */
  const [, setTrackedRevision] = useState(0);
  const [actionError, setActionError] = useState<ActionNotice>();
  /** Version before an update that finished from this screen. */
  const [updatedFrom, setUpdatedFrom] = useState<string>();
  const [reconnectingSince, setReconnectingSince] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const inFlight = useRef<AbortController>();
  const trackedRef = useRef<TrackedRequest>();
  trackedRef.current = tracked;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, []);

  const release = useCallback((request: TrackedRequest) => {
    if (trackedRef.current === request) trackedRef.current = undefined;
    setTracked((current) => (current === request ? undefined : current));
  }, []);

  /**
   * `background` refreshes (timers, tab return) never cancel a GET still on its way: on slow links a 1-second
   * poll that aborts each time would never see progress. Explicit refreshes replace the one in flight.
   */
  const refresh = useCallback(
    async (mode: 'background' | 'force' = 'force') => {
      if (!client) return;
      if (mode === 'background' && inFlight.current) return;
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      try {
        const next: ServerManagementStatus = await client.status(controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        setStatus(next);
        setLoadError(undefined);
        setReconnectingSince(undefined);
        const request = trackedRef.current;
        if (!request || request.stage === 'sending') return;
        const before = request.stage;
        const settlement = settle(request, next, Date.now());
        if (settlement.kind === 'waiting') {
          if (request.stage !== before) setTrackedRevision((value) => value + 1);
          return;
        }
        release(request);
        if (settlement.kind === 'unresolved') {
          // Not even a version change proves this request did it; another tab or automation may have.
          setActionError({
            key: request.key,
            tone: 'warning',
            text: '요청 결과를 확인하지 못했어요. 지금 상태를 다시 확인해 주세요.',
            unresolved: true,
          });
          return;
        }
        if (settlement.outcome === 'complete') {
          if (request.request.action === 'update' && request.fromVersion)
            if (compareVersions(next.currentVersion, request.fromVersion) !== 0) setUpdatedFrom(request.fromVersion);
          return;
        }
        // Recovery has its own page-level notice driven by `phase`.
        if (settlement.outcome === 'failed')
          setActionError({ key: request.key, ...managementErrorMessage(settlement.error, request.request.action) });
      } catch (cause) {
        if (controller.signal.aborted || !mounted.current) return;
        const kind = cause instanceof ServerManagementError ? cause.kind : 'offline';
        if (kind === 'offline' && trackedRef.current) {
          setReconnectingSince((since) => since ?? Date.now());
        } else {
          setLoadError(kind);
        }
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = undefined;
          if (mounted.current) setLoading(false);
        }
      }
    },
    [client, release],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = Boolean(status?.busy);
  const reconnecting = reconnectingSince !== undefined;
  const slow = reconnecting && now - reconnectingSince >= RECONNECT_PATIENCE_MS;

  useEffect(() => {
    if (!client) return;
    const following = active || Boolean(tracked);
    // Idle screens wait for the first status; hidden tabs skip idle refreshes and catch up on return.
    if (!following && !reconnecting && !status) return;
    const delay = reconnecting
      ? slow
        ? SLOW_RECONNECT_POLL_MS
        : RECONNECT_POLL_MS
      : following
        ? ACTIVE_POLL_MS
        : IDLE_POLL_MS;
    const timer = globalThis.setTimeout(() => {
      setNow(Date.now());
      if (!following && !reconnecting && typeof document !== 'undefined' && document.visibilityState === 'hidden')
        return;
      void refresh('background');
    }, delay);
    return () => globalThis.clearTimeout(timer);
  }, [client, active, reconnecting, slow, tracked, status, reconnectingSince, now, refresh]);

  useEffect(() => {
    if (!client || typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh('background');
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [client, refresh]);

  const send = useCallback(
    async (request: ServerManagementRequest) => {
      if (!client || trackedRef.current) return;
      const key = pendingKey(request);
      const draft: TrackedRequest = {
        key,
        request,
        fromVersion: request.action === 'update' ? status?.currentVersion : undefined,
        createdAt: Date.now(),
        stage: 'sending',
        idleChecks: 0,
      };
      trackedRef.current = draft;
      setTracked(draft);
      setActionError(undefined);
      setUpdatedFrom(undefined);
      try {
        const accepted = await client.request(request);
        if (!mounted.current) return;
        const following: TrackedRequest = {
          ...draft,
          id: accepted.id,
          legacy: !accepted.id,
          stage: 'queued',
          createdAt: Date.now(),
        };
        trackedRef.current = following;
        setTracked(following);
        await refresh();
      } catch (cause) {
        if (!mounted.current) return;
        const kind = cause instanceof ServerManagementError ? cause.kind : 'failed';
        // The API may restart as soon as it hands the request over; keep following it.
        if (kind === 'offline' && (request.action === 'update' || request.action === 'component')) {
          const following: TrackedRequest = { ...draft, stage: 'queued', createdAt: Date.now() };
          trackedRef.current = following;
          setTracked(following);
          setReconnectingSince((since) => since ?? Date.now());
          return;
        }
        trackedRef.current = undefined;
        setTracked(undefined);
        setActionError({ key, ...sendFailure(kind) });
      }
    },
    [client, refresh, status],
  );

  const derived = useMemo(() => {
    const latest = status?.release;
    const updateAvailable = Boolean(status && latest && compareVersions(latest.version, status.currentVersion) > 0);
    const updated = Boolean(status && updatedFrom && compareVersions(status.currentVersion, updatedFrom) !== 0);
    // The browser still runs the old bundle after the server changed under it.
    const staleWeb = Boolean(status && compareVersions(status.currentVersion, webVersion) !== 0);
    return { updateAvailable, updated, staleWeb };
  }, [status, updatedFrom, webVersion]);

  return {
    status,
    loading,
    loadError,
    pending: tracked?.key,
    pendingStage: tracked?.stage,
    pendingEnabled: tracked?.request.enabled,
    actionError,
    active,
    /** Update and rollback both failed: the API refuses changes (409) until an admin restores the server. */
    recoveryRequired: status?.phase === 'recovery-required',
    reconnecting,
    slowReconnect: slow,
    ...derived,
    refresh: () => refresh('force'),
    check: () => send({ action: 'check' }),
    update: () => send({ action: 'update' }),
    setChannel: (channel: ReleaseChannel) => send({ action: 'channel', channel }),
    setComponent: (componentId: OptionalComponentId, enabled: boolean) =>
      send({ action: 'component', componentId, enabled }),
    dismissError: () => setActionError(undefined),
  };
}

export type ServerManagementModel = ReturnType<typeof useServerManagement>;
