import { useMemo } from 'react';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import type { AppRuntime } from '../../app/runtime/app-runtime';
import { ServerManagementClient } from './server-management-client';

/**
 * Server administration exists only when this page is served by a BOAA server: not for the static web build,
 * not inside the desktop or mobile apps (their own update paths apply), and not for sync-only connections.
 */
export function serverManagementApi(runtime: AppRuntime | undefined) {
  if (!runtime || runtime.product) return undefined;
  if (runtime.platformRuntime.kind !== 'browser') return undefined;
  const reader = runtime.readerRuntime;
  if (reader.mode !== 'remote' || reader.managedByDesktop) return undefined;
  return reader.remoteApiClient;
}

export function useServerManagementClient(): ServerManagementClient | undefined {
  const api = serverManagementApi(useOptionalAppRuntime());
  return useMemo(() => (api ? new ServerManagementClient(api) : undefined), [api]);
}
