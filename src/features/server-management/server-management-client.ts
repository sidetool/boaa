import type { ServerManagementRequest, ServerManagementStatus } from '../../../packages/contracts/server-management';
import { RemoteApiError } from '../../services/remote/remote-api-contracts';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';

const STATUS_TIMEOUT_MS = 15_000;

/** What POST /admin/system/requests returns. A missing id means the server cannot be tracked by request. */
export interface ServerManagementAcceptance {
  readonly id?: string;
}

/** Why the management screen cannot show server status. */
export type ServerManagementFailure =
  'unsupported' | 'forbidden' | 'offline' | 'conflict' | 'updater-unavailable' | 'updater-unconfigured' | 'failed';

export class ServerManagementError extends Error {
  constructor(
    public readonly kind: ServerManagementFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ServerManagementError';
  }
}

function failure(cause: unknown): ServerManagementError {
  if (cause instanceof ServerManagementError) return cause;
  if (cause instanceof RemoteApiError) {
    if (cause.status === 404 || cause.status === 501) return new ServerManagementError('unsupported', cause.message);
    if (cause.status === 401 || cause.status === 403) return new ServerManagementError('forbidden', cause.message);
    if (cause.status === 409 || cause.status === 423) return new ServerManagementError('conflict', cause.message);
    // The API answers for itself here: the updater behind it is missing or stopped, not the server restarting.
    if (cause.message === 'updater_unconfigured')
      return new ServerManagementError('updater-unconfigured', cause.message);
    if (cause.message === 'updater_unavailable') return new ServerManagementError('updater-unavailable', cause.message);
    if (cause.status >= 500) return new ServerManagementError('offline', cause.message);
    return new ServerManagementError('failed', cause.message);
  }
  // fetch() rejects with TypeError while the server restarts; timeouts look the same to the user.
  return new ServerManagementError('offline', cause instanceof Error ? cause.message : String(cause));
}

/** Admin-only server release and optional component API. Uses the signed-in session of the remote client. */
export class ServerManagementClient {
  constructor(private readonly api: Pick<RemoteApiClient, 'request'>) {}

  async status(signal?: AbortSignal): Promise<ServerManagementStatus> {
    try {
      return await this.api.request<ServerManagementStatus>('/admin/system', { signal }, STATUS_TIMEOUT_MS);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw failure(cause);
    }
  }

  /**
   * The server answers 202 `{ accepted, id }` and the updater runs the work; follow it through `status` until
   * `operation.id` matches and has completed.
   */
  async request(request: ServerManagementRequest, signal?: AbortSignal): Promise<ServerManagementAcceptance> {
    let body: unknown;
    try {
      body = await this.api.request<unknown>(
        '/admin/system/requests',
        { method: 'POST', body: JSON.stringify(request), signal },
        STATUS_TIMEOUT_MS,
      );
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw failure(cause);
    }
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (record.accepted === false) throw new ServerManagementError('failed', 'request_rejected');
    return { id: typeof record.id === 'string' && record.id ? record.id : undefined };
  }
}
