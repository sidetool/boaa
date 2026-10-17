import type { PluginSession, SessionBinding } from './store-model';

/** Captured authority only; domain stores still authorize durable grants inside each transaction. */
export interface PlatformStoreAccess {
  host(): { scope: string; guard: () => void };
  session(session: PluginSession): { binding: SessionBinding; guard: () => void };
  /** Revoke synchronously, then issue a cleanup guard that permits suspended-session retirement. */
  retire(session: PluginSession): { binding: SessionBinding; guard: () => void };
}
