import { readBrandStorage, removeBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { isUiJson, uiRecord } from '@boaa/extension-contracts/ui-json';
import type { RuntimeMarker } from './store-model';
export type Retirement = Pick<RuntimeMarker, 'scope' | 'installationId' | 'instanceId' | 'fence'>;
export interface RetirementJournal {
  remember(value: Retirement): void;
  forget(value: Retirement): void;
  pending(): Retirement[];
}
const prefix = 'boaa.plugin-stopped.v1:';
/** Host-only proof of an actually terminated instance, NOT a lease/heartbeat/dead-owner inference.
 * pagehide cannot await IndexedDB. A synchronous receipt lets the next authenticated
 * session finish that exact deletion. Failed/unknown instances never get a receipt. */
export function retirementJournal(storage: Storage): RetirementJournal {
  const pending = (): Retirement[] => {
    const rows: Retirement[] = [];
    try {
      for (let i = 0; i < storage.length && rows.length < 128; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const raw = readBrandStorage(storage, key);
        if (!raw || raw.length > 8192) continue;
        try {
          const row: unknown = JSON.parse(raw);
          if (
            isUiJson(row, 8192) &&
            uiRecord(row) &&
            typeof row.scope === 'string' &&
            typeof row.installationId === 'string' &&
            typeof row.instanceId === 'string' &&
            uiRecord(row.fence) &&
            key === prefix + row.instanceId
          )
            rows.push(row as unknown as Retirement);
        } catch {
          /* A damaged receipt never authorizes cleanup. */
        }
      }
    } catch {
      /* Storage unavailable: retain recovery markers. */
    }
    return rows;
  };
  return {
    pending,
    remember(value) {
      try {
        if (pending().length < 128) writeBrandStorage(storage, prefix + value.instanceId, JSON.stringify(value));
      } catch {
        /* Fail closed on next startup. */
      }
    },
    forget(value) {
      try {
        removeBrandStorage(storage, prefix + value.instanceId);
      } catch {
        /* Exact deletion is idempotent. */
      }
    },
  };
}
