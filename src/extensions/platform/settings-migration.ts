import { ControllerVm, type ControllerOptions } from './controller-vm';
import type { SettingsMigrationRunner } from './plugin-store';
import { requireStore } from '../ui/store-model';
/** Host-only adapter. The store supplies reviewed bytes; this transport has no installed session authority. */
export function settingsMigrationRunner(
  options: Pick<ControllerOptions, 'worker' | 'wasmUrl'>,
): SettingsMigrationRunner {
  return async ({ source, input, fence }, signal) => {
    requireStore(!signal.aborted, 'CANCELLED');
    const vm = new ControllerVm({ role: 'migration', fence }, source, {
      ...options,
      invocationMs: 5000,
      broker: async () => {
        throw Error('PERMISSION_DENIED');
      },
      onStop: () => {},
    });
    const abort = () => vm.stop('CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    try {
      requireStore(!signal.aborted, 'CANCELLED');
      return await vm.invoke('migrate', input);
    } finally {
      signal.removeEventListener('abort', abort);
      vm.stop();
    }
  };
}
