import { isUiJson, type UiJson } from '@boaa/extension-contracts/ui-json';
import { requireStore } from '../ui/store-model';
import { PlatformPluginStore } from './plugin-store';
import { ControllerVm, type ControllerOptions } from './controller-vm';
import type { PluginSession } from './store-model';
import { RuntimeOwners } from './runtime-owners';
let runningTasks = 0;
export const taskResources = () => ({ running: runningTasks });
interface Task {
  owner: PluginSession;
  abort: AbortController;
  settled: Promise<void>;
}
/** One disposable pure-computation VM per call; ownership stays with the initiating controller invocation. */
export class PluginTaskRuntime {
  private jobs = new Set<Task>();
  private closed = false;
  constructor(
    private store: PlatformPluginStore,
    private owners: RuntimeOwners,
    private options: Pick<ControllerOptions, 'worker' | 'wasmUrl'>,
  ) {}
  async run(owner: PluginSession, input: UiJson, signal: AbortSignal): Promise<UiJson> {
    requireStore(!this.closed && !signal.aborted, 'CANCELLED');
    requireStore(owner.role === 'controller', 'PERMISSION_DENIED');
    requireStore(isUiJson(input, 65536), 'INPUT_LIMIT');
    requireStore(runningTasks < 2 && ![...this.jobs].some((j) => j.owner === owner), 'TASK_LIMIT');
    runningTasks++;
    let release!: () => void;
    const job: Task = {
      owner,
      abort: new AbortController(),
      settled: new Promise((resolve) => {
        release = resolve;
      }),
    };
    this.jobs.add(job);
    let session: PluginSession | undefined,
      vm: ControllerVm | undefined,
      poll: ReturnType<typeof setInterval> | undefined;
    let fault = false,
      clean = false,
      revoked = false;
    let finish: (() => Promise<void>) | undefined;
    const revoke = () => {
      if (!session || revoked) return;
      revoked = true;
      try {
        finish = this.store.retireSession(session);
      } catch {
        this.store.closeSession(session);
      }
    };
    const check = () => {
      requireStore(!this.closed && !job.abort.signal.aborted, 'CANCELLED');
    };
    const abort = () => job.abort.abort();
    signal.addEventListener('abort', abort, { once: true });
    job.abort.signal.addEventListener(
      'abort',
      () => {
        revoke();
        vm?.stop();
      },
      { once: true },
    );
    try {
      session = await this.store.openTaskSession(owner);
      check();
      await this.owners.assertLive(
        (await this.store.unfinishedMarkers())
          .filter((m) => m.role === 'task' && m.installationId === owner.fence.installationId)
          .map((m) => m.instanceId),
      );
      check();
      const source = await this.store.loadEntry(session);
      check();
      await this.store.startMarker(session);
      await this.store.assertSession(owner, owner.fence);
      check();
      this.owners.add(session.fence.instanceId);
      let polling = false;
      poll = setInterval(() => {
        if (polling) return;
        polling = true;
        void Promise.all([
          this.store.assertSession(owner, owner.fence),
          this.store.assertSession(session!, session!.fence),
        ])
          .catch(abort)
          .finally(() => {
            polling = false;
          });
      }, 250);
      vm = new ControllerVm(session, source, {
        ...this.options,
        invocationMs: 5000,
        broker: async () => {
          throw Error('METHOD_NOT_ALLOWED');
        },
        onStop: (reason) => {
          if (reason !== 'STOPPED') fault = true;
        },
      });
      const value = await vm.invoke('task', input);
      check();
      await this.store.assertSession(owner, owner.fence);
      await this.store.assertSession(session, session.fence);
      check();
      clean = true;
      return value;
    } finally {
      clearInterval(poll);
      signal.removeEventListener('abort', abort);
      // Revoke before terminating; keep only actual VM faults as recovery markers.
      revoke();
      vm?.stop();
      if (session) this.owners.remove(session.fence.instanceId);
      try {
        if (!fault || clean) await finish?.();
      } finally {
        runningTasks--;
        this.jobs.delete(job);
        release();
      }
    }
  }
  async close() {
    this.closed = true;
    const jobs = [...this.jobs];
    for (const job of jobs) job.abort.abort();
    await Promise.all(jobs.map((j) => j.settled));
  }
}
