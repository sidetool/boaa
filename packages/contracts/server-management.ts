/** Public status only. Deployment paths, credentials and raw helper logs never cross this boundary. */
export type ReleaseChannel = 'stable' | 'beta';
export type OptionalComponentId = 'apk' | 'browser' | 'metadata';
export type ManagementPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'preflight'
  | 'backup'
  | 'applying'
  | 'verifying'
  | 'complete'
  | 'failed'
  | 'rolling-back'
  | 'recovery-required';

export interface ServerRelease {
  version: string;
  publishedAt: string;
  notes: string;
  url: string;
}

export interface ServerComponent {
  id: OptionalComponentId;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  supported: boolean;
  managed: boolean;
  downloadBytes?: number;
  version?: string;
  error?: string;
}

/** Retained by request id across updater restarts and subsequent operations. */
export interface ServerManagementOperationResult {
  id: string;
  action: 'check' | 'update' | 'channel' | 'component';
  componentId?: OptionalComponentId;
  enabled?: boolean;
  startedAt: string;
  completedAt: string;
  outcome: 'complete' | 'failed' | 'recovery-required';
  error?: string;
}

export interface ServerManagementStatus {
  available: boolean;
  reason?: string;
  currentVersion: string;
  channel: ReleaseChannel;
  phase: ManagementPhase;
  busy: boolean;
  checkedAt?: string;
  release?: ServerRelease;
  error?: string;
  operation?: {
    id: string;
    action: 'check' | 'update' | 'channel' | 'component';
    componentId?: OptionalComponentId;
    enabled?: boolean;
    startedAt: string;
    completedAt?: string;
  };
  components: ServerComponent[];
  operationResults?: ServerManagementOperationResult[];
}

export interface ServerManagementRequest {
  action: 'check' | 'update' | 'channel' | 'component';
  channel?: ReleaseChannel;
  componentId?: OptionalComponentId;
  enabled?: boolean;
}
