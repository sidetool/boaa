import { readBrandStorage, removeBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import { RemoteApiError } from '../../services/remote/remote-api-contracts';
import { AIExecutionLane, type AIExecutionToken } from './ai-execution-lane';
import type { BookAnalysisWorkflow } from './book-analysis-workflow-gateway';
import type { BookAITTSPreparationRunner } from './book-ai-tts-preparation-runner';
import { isTerminalBookAIWorkflow, recordValue } from './book-ai-workflow-view';

type NotificationTone = 'success' | 'warning' | 'danger' | 'info';

export interface BookAIWorkflowIdStore {
  get(bookId: string): string | undefined;
  set(bookId: string, workflowId: string): void;
  delete(bookId: string): void;
}

export interface BookAIWorkflowControllerInput {
  readonly runner?: BookAITTSPreparationRunner;
  readonly sessionOwner?: object;
  readonly bookId?: string;
  readonly chapterIds: readonly string[];
  readonly beforeRun: (bookId: string, chapterIds: readonly string[], current: () => boolean) => Promise<boolean>;
  readonly onTerminal: (
    bookId: string,
    workflow: BookAnalysisWorkflow,
    current: () => boolean,
  ) => Promise<boolean | void>;
  readonly onCancelled: (bookId: string, workflow: BookAnalysisWorkflow, current: () => boolean) => Promise<void>;
  readonly openAIAddon: () => void;
  readonly notify: (message: string, tone: NotificationTone) => void;
  readonly store?: BookAIWorkflowIdStore;
  readonly pollIntervalMs?: number;
  readonly pollAttempts?: number;
}

interface BookAIWorkflowState {
  readonly workflow?: BookAnalysisWorkflow;
  readonly plan?: BookAIWorkflowPlan;
  readonly loading: boolean;
  readonly running: boolean;
  readonly error?: string;
}

interface WorkflowOperationResult {
  readonly workflow?: BookAnalysisWorkflow;
  readonly plan?: BookAIWorkflowPlan;
  readonly confirmsTTSReadiness?: boolean;
}

interface StartBookAIWorkflowOptions {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

const INITIAL_STATE: BookAIWorkflowState = {
  loading: false,
  running: false,
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function browserWorkflowIdStore(runner: BookAITTSPreparationRunner): BookAIWorkflowIdStore {
  const runnerKey = encodeURIComponent(runner.id);
  const versionKey = encodeURIComponent(runner.workflowVersion);
  const key = (bookId: string) => `boaa.book_ai_workflow.${runner.runtime}.${runnerKey}.${versionKey}.${bookId}`;
  const previousDefinitionKey = (bookId: string) => `boaa.book_ai_workflow.${runner.runtime}.${runnerKey}.${bookId}`;
  const previousRuntimeKey = (bookId: string) => `boaa.book_ai_workflow.${runner.runtime}.${bookId}`;
  const legacyKey = (bookId: string) => `boaa.book_ai_workflow.${bookId}`;
  const readsLegacyKeys = runner.restoresLegacyWorkflowIds === true;
  return {
    get: (bookId) => {
      const current = readBrandStorage(window.localStorage, key(bookId));
      if (current || !readsLegacyKeys) return current ?? undefined;
      const migrated =
        readBrandStorage(window.localStorage, previousDefinitionKey(bookId)) ??
        readBrandStorage(window.localStorage, previousRuntimeKey(bookId)) ??
        (runner.runtime === 'hosted' ? readBrandStorage(window.localStorage, legacyKey(bookId)) : null);
      if (!migrated) return undefined;
      writeBrandStorage(window.localStorage, key(bookId), migrated);
      removeBrandStorage(window.localStorage, previousDefinitionKey(bookId));
      removeBrandStorage(window.localStorage, previousRuntimeKey(bookId));
      if (runner.runtime === 'hosted') removeBrandStorage(window.localStorage, legacyKey(bookId));
      return migrated;
    },
    set: (bookId, workflowId) => {
      writeBrandStorage(window.localStorage, key(bookId), workflowId);
      if (readsLegacyKeys) {
        removeBrandStorage(window.localStorage, previousDefinitionKey(bookId));
        removeBrandStorage(window.localStorage, previousRuntimeKey(bookId));
        if (runner.runtime === 'hosted') removeBrandStorage(window.localStorage, legacyKey(bookId));
      }
    },
    delete: (bookId) => {
      removeBrandStorage(window.localStorage, key(bookId));
      if (readsLegacyKeys) {
        removeBrandStorage(window.localStorage, previousDefinitionKey(bookId));
        removeBrandStorage(window.localStorage, previousRuntimeKey(bookId));
        if (runner.runtime === 'hosted') removeBrandStorage(window.localStorage, legacyKey(bookId));
      }
    },
  };
}

function workflowIsNewer(current: BookAnalysisWorkflow | undefined, candidate: BookAnalysisWorkflow): boolean {
  if (!current) return true;
  if (current.id !== candidate.id) return false;
  const currentTime = Date.parse(current.updatedAt);
  const candidateTime = Date.parse(candidate.updatedAt);
  return !Number.isFinite(currentTime) || !Number.isFinite(candidateTime) || candidateTime >= currentTime;
}

function withoutTTSReadiness(workflow: BookAnalysisWorkflow): BookAnalysisWorkflow {
  const progress = recordValue(workflow.progress);
  if (!progress?.ttsCacheReadiness && !progress?.ttsReadiness && workflow.readiness.outcome === 'pending') {
    return workflow;
  }
  const remainingProgress = { ...progress };
  delete remainingProgress.ttsCacheReadiness;
  delete remainingProgress.ttsReadiness;
  return {
    ...workflow,
    progress: remainingProgress as BookAnalysisWorkflow['progress'],
    readiness: { outcome: 'pending', reviewItems: [] },
  };
}

export function useBookAIWorkflowController(input: BookAIWorkflowControllerInput) {
  const { runner, bookId } = input;
  const [state, setState] = useState<BookAIWorkflowState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const inputRef = useRef(input);
  const sessionOwner = input.sessionOwner;
  const scope = useMemo(
    () => ({ sessionOwner, bookId, runner, active: false, lane: new AIExecutionLane() }),
    [sessionOwner, bookId, runner],
  );
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const ownsScope = useCallback(() => scope.active && latestScope.current === scope, [scope]);
  const lane = scope.lane;
  const isCurrent = useCallback(
    (token: AIExecutionToken, targetBookId: string) => ownsScope() && lane.isCurrent(token, targetBookId),
    [lane, ownsScope],
  );
  const operationBusyRef = useRef(false);
  const ttsReadinessDirtyRef = useRef(false);
  const browserStoreRef = useRef<{
    readonly runnerId: string;
    readonly runnerVersion: string;
    readonly runtime: BookAITTSPreparationRunner['runtime'];
    readonly store: BookAIWorkflowIdStore;
  }>();
  if (
    runner &&
    typeof window !== 'undefined' &&
    (browserStoreRef.current?.runtime !== runner.runtime ||
      browserStoreRef.current.runnerId !== runner.id ||
      browserStoreRef.current.runnerVersion !== runner.workflowVersion)
  ) {
    browserStoreRef.current = {
      runnerId: runner.id,
      runnerVersion: runner.workflowVersion,
      runtime: runner.runtime,
      store: browserWorkflowIdStore(runner),
    };
  }
  const store = input.store ?? browserStoreRef.current?.store;
  const storeRef = useRef(store);
  stateRef.current = state;
  inputRef.current = input;
  storeRef.current = store;

  const commitWorkflow = useCallback(
    (token: AIExecutionToken, workflow: BookAnalysisWorkflow, confirmsTTSReadiness = false) => {
      if (!isCurrent(token, workflow.novelId)) return false;
      if (confirmsTTSReadiness) ttsReadinessDirtyRef.current = false;
      const nextWorkflow = ttsReadinessDirtyRef.current ? withoutTTSReadiness(workflow) : workflow;
      setState((previous) => ({ ...previous, workflow: nextWorkflow, plan: workflow.plan }));
      storeRef.current?.set(workflow.novelId, workflow.id);
      return true;
    },
    [isCurrent],
  );

  const finishOperation = useCallback(
    (token: AIExecutionToken) => {
      if (!ownsScope() || !lane.complete(token)) return;
      operationBusyRef.current = false;
      setState((previous) => ({ ...previous, loading: false, running: false }));
    },
    [lane, ownsScope],
  );

  useLayoutEffect(() => {
    scope.active = true;
    lane.invalidate();
    operationBusyRef.current = false;
    ttsReadinessDirtyRef.current = false;
    setState(INITIAL_STATE);
    if (runner && bookId && store) {
      const workflowId = store.get(bookId);
      if (workflowId || runner) {
        const token = lane.begin(bookId);
        const restore = runner.restore(bookId, workflowId, token.controller.signal);
        operationBusyRef.current = true;
        setState((previous) => ({ ...previous, loading: true }));
        void Promise.resolve(restore)
          .then(async (workflow) => {
            if (!workflow) {
              if (workflowId && isCurrent(token, bookId)) store.delete(bookId);
              return;
            }
            if (workflowId && workflow.id !== workflowId && isCurrent(token, bookId)) {
              store.delete(bookId);
            }
            if (workflow.novelId !== bookId) {
              if (isCurrent(token, bookId)) store.delete(bookId);
              return;
            }
            if (!commitWorkflow(token, workflow)) return;
            if (isTerminalBookAIWorkflow(workflow)) {
              if (workflow.status === 'succeeded' || workflow.status === 'needs_review') {
                await inputRef.current.onTerminal(bookId, workflow, () => isCurrent(token, bookId));
              }
              return;
            }
            setState((previous) => ({ ...previous, running: true }));
            const finalWorkflow = await runner.monitor(workflow.id, {
              signal: token.controller.signal,
              attempts: inputRef.current.pollAttempts,
              pollIntervalMs: inputRef.current.pollIntervalMs,
              onProgress: (progress) => commitWorkflow(token, progress),
            });
            if (!isCurrent(token, bookId)) return;
            if (finalWorkflow.status === 'succeeded' || finalWorkflow.status === 'needs_review') {
              await inputRef.current.onTerminal(bookId, finalWorkflow, () => isCurrent(token, bookId));
            }
            if (!isCurrent(token, bookId)) return;
            inputRef.current.notify(
              finalWorkflow.status === 'succeeded'
                ? '이전에 실행한 작품 전체 AI/TTS workflow가 완료되었습니다.'
                : finalWorkflow.status === 'needs_review'
                  ? '이전에 실행한 작품 전체 AI/TTS workflow에 검토가 필요한 항목이 있습니다.'
                  : `이전에 실행한 작품 전체 AI/TTS workflow가 ${finalWorkflow.status} 상태로 종료되었습니다.`,
              finalWorkflow.status === 'succeeded' ? 'success' : 'warning',
            );
          })
          .catch((error) => {
            if (!isAbortError(error) && isCurrent(token, bookId)) {
              setState((previous) => ({
                ...previous,
                error: '이전 workflow 자동 모니터링을 이어가지 못했습니다. 상태 새로고침으로 다시 연결할 수 있습니다.',
              }));
            }
          })
          .finally(() => finishOperation(token));
      }
    }

    return () => {
      scope.active = false;
      lane.invalidate();
      operationBusyRef.current = false;
    };
  }, [bookId, commitWorkflow, finishOperation, runner, store, scope, lane, isCurrent]);

  const poll = useCallback(
    (workflowId: string, token: AIExecutionToken) =>
      runner!.monitor(workflowId, {
        signal: token.controller.signal,
        attempts: inputRef.current.pollAttempts,
        pollIntervalMs: inputRef.current.pollIntervalMs,
        onProgress: (workflow) => commitWorkflow(token, workflow),
      }),
    [commitWorkflow, runner],
  );

  const runWorkflow = useCallback(
    async (mode: 'start' | 'retry', options: StartBookAIWorkflowOptions = {}) => {
      if (!ownsScope() || !runner || !bookId) return;
      const existing = stateRef.current.workflow;
      const storedWorkflowId = storeRef.current?.get(bookId);
      if (mode === 'start' && existing && !isTerminalBookAIWorkflow(existing)) {
        inputRef.current.notify('이미 실행 중인 작품 전체 AI/TTS workflow가 있습니다.', 'warning');
        return;
      }
      if (mode === 'retry' && !existing) return;
      if (mode === 'start' && storedWorkflowId && !existing) {
        inputRef.current.notify('저장된 작품 workflow 상태를 먼저 새로고침하거나 정리해야 합니다.', 'warning');
        return;
      }
      if (operationBusyRef.current) {
        inputRef.current.notify('작품 전체 AI/TTS 요청이 이미 진행 중입니다.', 'info');
        return;
      }

      operationBusyRef.current = true;
      const token = lane.begin(bookId);
      setState((previous) => ({ ...previous, loading: true, running: true, error: undefined }));
      inputRef.current.openAIAddon();
      try {
        const ready = await inputRef.current.beforeRun(bookId, inputRef.current.chapterIds, () =>
          isCurrent(token, bookId),
        );
        if (!ready || !isCurrent(token, bookId)) return;

        let workflow: BookAnalysisWorkflow;
        if (mode === 'start') {
          const plan = await runner.getPlan(bookId, undefined, token.controller.signal);
          if (!isCurrent(token, bookId)) return;
          setState((previous) => ({ ...previous, plan }));
          workflow = await runner.start(
            { bookId, ...options, force: Boolean(existing && isTerminalBookAIWorkflow(existing)) },
            token.controller.signal,
          );
        } else {
          workflow = await runner.retry(existing!.id, token.controller.signal);
        }
        if (!isCurrent(token, bookId)) {
          try {
            await runner.cancel(workflow.id);
          } catch {
            // A detached workflow remains restorable from its durable runtime; cancellation is best effort.
          }
          return;
        }
        if (!commitWorkflow(token, workflow)) return;
        inputRef.current.notify(
          mode === 'start'
            ? '작품 전체 Character Graph 분석을 시작했습니다.'
            : '작품 전체 AI/TTS workflow 재시도를 시작했습니다.',
          'success',
        );

        const finalWorkflow = await poll(workflow.id, token);
        if (!isCurrent(token, bookId)) return;
        commitWorkflow(token, finalWorkflow, true);
        if (finalWorkflow.status !== 'succeeded' && finalWorkflow.status !== 'needs_review') {
          throw new Error(finalWorkflow.errorMessage ?? `Book AI workflow ${finalWorkflow.status}`);
        }
        const refreshed = await inputRef.current.onTerminal(bookId, finalWorkflow, () => isCurrent(token, bookId));
        if (refreshed === false || !isCurrent(token, bookId)) return;
        if (finalWorkflow.status === 'needs_review') {
          setState((previous) => ({ ...previous, error: undefined }));
          inputRef.current.notify('작품 전체 AI/TTS workflow에 사용자 검토가 필요한 항목이 있습니다.', 'warning');
          return;
        }
        inputRef.current.notify(
          mode === 'start'
            ? '작품 전체 AI/TTS workflow가 라벨/음성 매핑 준비 상태로 완료되었습니다.'
            : '작품 전체 AI/TTS workflow 재시도가 완료되었습니다.',
          'success',
        );
      } catch (error) {
        if (isAbortError(error) || !isCurrent(token, bookId)) return;
        const message = errorMessage(error, '작품 전체 AI/TTS workflow 요청에 실패했습니다.');
        setState((previous) => ({ ...previous, error: message }));
        inputRef.current.notify(
          `${mode === 'start' ? '작품 전체 AI/TTS workflow 실패' : '작품 전체 AI/TTS workflow 재시도 실패'}: ${message}`,
          'danger',
        );
      } finally {
        finishOperation(token);
      }
    },
    [bookId, commitWorkflow, finishOperation, poll, runner, ownsScope, lane, isCurrent],
  );

  const runPassiveOperation = useCallback(
    async (
      operation: (
        workflowRunner: BookAITTSPreparationRunner,
        workflowId: string | undefined,
        signal: AbortSignal,
      ) => Promise<WorkflowOperationResult>,
      success: (result: WorkflowOperationResult) => void,
      failurePrefix: string,
    ) => {
      if (!ownsScope() || !runner || !bookId) return;
      if (operationBusyRef.current) {
        inputRef.current.notify('작품 전체 AI/TTS 요청이 이미 진행 중입니다.', 'info');
        return;
      }
      operationBusyRef.current = true;
      const token = lane.begin(bookId);
      setState((previous) => ({ ...previous, loading: true, error: undefined }));
      try {
        const result = await operation(
          runner,
          stateRef.current.workflow?.id ?? store?.get(bookId),
          token.controller.signal,
        );
        if (!isCurrent(token, bookId)) return;
        if (result.workflow && !commitWorkflow(token, result.workflow, result.confirmsTTSReadiness)) return;
        else if (result.plan) setState((previous) => ({ ...previous, plan: result.plan }));
        success(result);
      } catch (error) {
        if (isAbortError(error) || !isCurrent(token, bookId)) return;
        const message = errorMessage(error, failurePrefix);
        setState((previous) => ({ ...previous, error: message }));
        inputRef.current.notify(`${failurePrefix}: ${message}`, 'danger');
      } finally {
        finishOperation(token);
      }
    },
    [bookId, commitWorkflow, finishOperation, runner, store, ownsScope, lane, isCurrent],
  );

  const refreshPlan = useCallback(
    () =>
      runPassiveOperation(
        async (workflowRunner, workflowId, signal) => {
          const [plan, restoredWorkflow] = await Promise.all([
            workflowRunner.getPlan(bookId!, undefined, signal),
            workflowId ? workflowRunner.refresh(workflowId, signal).catch(() => undefined) : undefined,
          ]);
          return {
            plan,
            workflow: restoredWorkflow?.novelId === bookId ? restoredWorkflow : undefined,
          };
        },
        () => undefined,
        '작품 전체 AI/TTS 계획을 불러오지 못했습니다',
      ),
    [bookId, runPassiveOperation],
  );

  const refreshStatus = useCallback(async () => {
    const workflowId = stateRef.current.workflow?.id ?? (bookId ? store?.get(bookId) : undefined);
    if (!workflowId) {
      await refreshPlan();
      return;
    }
    await runPassiveOperation(
      async (workflowRunner, _workflowId, signal) => ({ workflow: await workflowRunner.refresh(workflowId, signal) }),
      () => undefined,
      '작품 전체 AI/TTS 상태를 새로고침하지 못했습니다',
    );
  }, [bookId, refreshPlan, runPassiveOperation, store]);

  const cancel = useCallback(async () => {
    const workflow = stateRef.current.workflow;
    if (!ownsScope() || !runner || !bookId) return;
    if (!workflow) {
      lane.invalidate();
      operationBusyRef.current = false;
      setState((previous) => ({ ...previous, loading: false, running: false }));
      return;
    }
    operationBusyRef.current = true;
    const token = lane.begin(bookId);
    setState((previous) => ({ ...previous, loading: true, running: false, error: undefined }));
    try {
      const cancelledWorkflow = await runner.cancel(workflow.id, token.controller.signal);
      if (!commitWorkflow(token, cancelledWorkflow)) return;
      inputRef.current.notify('작품 전체 AI/TTS workflow를 취소했습니다.', 'warning');
      await inputRef.current.onCancelled(bookId, cancelledWorkflow, () => isCurrent(token, bookId));
    } catch (error) {
      if (isAbortError(error) || !isCurrent(token, bookId)) return;
      let failure = error;
      if (error instanceof RemoteApiError && error.status === 409) {
        try {
          const latest = await runner.refresh(workflow.id, token.controller.signal);
          if (!commitWorkflow(token, latest)) return;
          if (latest.status === 'cancelled') {
            await inputRef.current.onCancelled(bookId, latest, () => isCurrent(token, bookId));
          } else if (latest.status === 'succeeded' || latest.status === 'needs_review') {
            await inputRef.current.onTerminal(bookId, latest, () => isCurrent(token, bookId));
          }
          if (!isCurrent(token, bookId)) return;
          inputRef.current.notify('작품 전체 AI/TTS workflow가 이미 종료되어 최신 상태를 불러왔습니다.', 'info');
          return;
        } catch (refreshError) {
          failure = refreshError;
        }
      }
      if (!isCurrent(token, bookId)) return;
      const message = errorMessage(failure, '작품 전체 AI/TTS workflow 취소에 실패했습니다.');
      setState((previous) => ({ ...previous, error: message }));
      inputRef.current.notify(`작품 전체 AI/TTS workflow 취소 실패: ${message}`, 'danger');
    } finally {
      finishOperation(token);
    }
  }, [bookId, commitWorkflow, finishOperation, runner, ownsScope, lane, isCurrent]);

  const refreshCacheReadiness = useCallback(
    () =>
      runPassiveOperation(
        async (workflowRunner, workflowId, signal) => {
          if (!workflowId) throw new Error('확인할 작품 workflow가 없습니다.');
          if (!workflowRunner.refreshCacheReadiness) {
            throw new Error('현재 실행 환경은 TTS 오디오 cache 상태 확인을 지원하지 않습니다.');
          }
          const workflow = await workflowRunner.refreshCacheReadiness(workflowId, signal);
          return { workflow, confirmsTTSReadiness: true };
        },
        ({ workflow }) => {
          const readiness = recordValue(recordValue(workflow?.progress)?.ttsCacheReadiness);
          inputRef.current.notify(
            readiness?.ok === true
              ? 'TTS 오디오 cache 준비 상태가 확인되었습니다.'
              : 'TTS 오디오 cache가 아직 모두 준비되지 않았습니다.',
            readiness?.ok === true ? 'success' : 'warning',
          );
        },
        'TTS 오디오 cache 상태 확인 실패',
      ),
    [runPassiveOperation],
  );

  const resumeMonitoring = useCallback(
    async (workflow: BookAnalysisWorkflow) => {
      if (!ownsScope() || !runner || !bookId || workflow.novelId !== bookId) return;
      if (operationBusyRef.current) {
        inputRef.current.notify('작품 전체 AI/TTS 상태 확인이 이미 진행 중입니다.', 'info');
        return;
      }
      operationBusyRef.current = true;
      const token = lane.begin(bookId);
      setState((previous) => ({
        ...previous,
        loading: false,
        running: !isTerminalBookAIWorkflow(workflow),
        error: undefined,
      }));
      try {
        if (!commitWorkflow(token, workflow)) return;
        const finalWorkflow = isTerminalBookAIWorkflow(workflow) ? workflow : await poll(workflow.id, token);
        if (!commitWorkflow(token, finalWorkflow, true)) return;
        if (finalWorkflow.status === 'succeeded' || finalWorkflow.status === 'needs_review') {
          await inputRef.current.onTerminal(bookId, finalWorkflow, () => isCurrent(token, bookId));
        }
        if (!isCurrent(token, bookId)) return;
        inputRef.current.notify(
          finalWorkflow.status === 'succeeded'
            ? '승인된 지점부터 이어진 작품 분석이 완료되었습니다.'
            : finalWorkflow.status === 'needs_review'
              ? '다음 분석 window에서 추가 검토가 필요합니다.'
              : `작품 전체 AI/TTS workflow가 ${finalWorkflow.status} 상태로 종료되었습니다.`,
          finalWorkflow.status === 'succeeded' ? 'success' : 'warning',
        );
      } catch (error) {
        if (isAbortError(error) || !isCurrent(token, bookId)) return;
        const message = errorMessage(error, '승인 후 작품 분석 상태를 이어서 확인하지 못했습니다.');
        setState((previous) => ({ ...previous, error: message }));
        inputRef.current.notify(message, 'danger');
      } finally {
        finishOperation(token);
      }
    },
    [bookId, commitWorkflow, finishOperation, poll, runner, ownsScope, lane, isCurrent],
  );

  const adoptWorkflow = useCallback(
    (workflow: BookAnalysisWorkflow, options: { confirmsTTSReadiness?: boolean } = {}) => {
      if (!ownsScope() || !bookId || workflow.novelId !== bookId) return false;
      if (!workflowIsNewer(stateRef.current.workflow, workflow)) return false;
      if (options.confirmsTTSReadiness) ttsReadinessDirtyRef.current = false;
      const nextWorkflow = ttsReadinessDirtyRef.current ? withoutTTSReadiness(workflow) : workflow;
      setState((previous) => ({ ...previous, workflow: nextWorkflow, plan: workflow.plan }));
      store?.set(bookId, workflow.id);
      return true;
    },
    [bookId, store, ownsScope],
  );

  const invalidateTTSReadiness = useCallback(() => {
    if (!ownsScope()) return;
    ttsReadinessDirtyRef.current = true;
    setState((previous) => {
      if (!previous.workflow) return previous;
      const workflow = withoutTTSReadiness(previous.workflow);
      if (workflow === previous.workflow) return previous;
      return {
        ...previous,
        workflow,
      };
    });
  }, [ownsScope]);

  return {
    ...state,
    start: (options?: StartBookAIWorkflowOptions) => runWorkflow('start', options),
    retry: () => runWorkflow('retry'),
    cancel,
    refreshPlan,
    refreshStatus,
    refreshCacheReadiness,
    resumeMonitoring,
    adoptWorkflow,
    invalidateTTSReadiness,
  };
}
