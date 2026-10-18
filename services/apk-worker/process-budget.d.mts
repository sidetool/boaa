import type { ChildProcess, SpawnOptions } from 'node:child_process';
export class ApkProcessBudget {
  constructor(limit?: number);
  readonly limit: number;
  readonly active: number;
  acquire(): () => void;
}
export function spawnWithBudget(
  command: string,
  args: string[],
  options: SpawnOptions,
  budget?: ApkProcessBudget,
): ChildProcess;
