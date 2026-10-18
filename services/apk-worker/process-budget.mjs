import { spawn } from 'node:child_process';
/** Shared across owner catalogs; capacity includes children waiting to exit after kill. */
export class ApkProcessBudget {
  #active = 0;
  constructor(limit = 4) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_process_budget');
    this.limit = limit;
  }
  get active() {
    return this.#active;
  }
  acquire() {
    if (this.#active >= this.limit) throw new Error('apk_worker_busy');
    this.#active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#active--;
      }
    };
  }
}
export function spawnWithBudget(command, args, options, budget) {
  const release = budget?.acquire();
  try {
    const child = spawn(command, args, options);
    // 'close' also follows spawn errors and runs only after stdio is closed.
    child.once('close', () => release?.());
    return child;
  } catch (error) {
    release?.();
    throw error;
  }
}
