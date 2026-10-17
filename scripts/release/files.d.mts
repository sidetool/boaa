import type { ServerManagementRequest } from '../../packages/contracts/server-management';
export function readJson<T = unknown>(file: string, fallback?: T, limit?: number): Promise<T>;
export function atomicJson(file: string, value: unknown, mode?: number): Promise<void>;
export function validateRequest(value: unknown): ServerManagementRequest;
