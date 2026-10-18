import type { ApkProcessBudget } from './process-budget.mjs';
import type { ApkTools, ApkMetadata } from './installations.mjs';
export interface JavaApkTools extends ApkTools {
  networkIdentity?(state: string): string;
  worker(
    path: string,
    metadata: ApkMetadata,
    state: string,
  ): {
    readonly busy: boolean;
    request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    close(): void;
  };
}
export function createJavaApkTools(
  java: string,
  build: string,
  options?: { processBudget?: ApkProcessBudget; systemRoot?: string; resolveDefaultProxy?: () => string | undefined },
): Promise<JavaApkTools>;
