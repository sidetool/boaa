import type { UiJson } from './ui-json';
/** G0 draft: JSON wire data only; not exported by the product SDK. */
export interface PlatformFence {
  installationId: string;
  digest: string;
  scopeId: string;
  windowSessionId: string;
  instanceId: string;
  generation: number;
}
export interface PlatformContentBatch {
  readerSessionId: string;
  bookId: string;
  chapterId: string;
  theme: string;
  settings: { schemaVersion: number; revision: number; value: UiJson } | null;
  contentRevision: string;
  configRevision: number;
  jobId: string;
  blocks: readonly { id: string; text: string; textHash: string }[];
}
export interface PlatformDecorationResult {
  layers: readonly {
    id: string;
    ranges: readonly { paragraphId: string; start: number; end: number; styleId: string }[];
    palette: Readonly<Record<string, { color?: string; backgroundColor?: string; underline?: boolean }>>;
  }[];
}
export type PlatformWire =
  | { kind: 'call'; fence: PlatformFence; requestId: number; method: string; input: UiJson }
  | {
      kind: 'reply';
      fence: PlatformFence;
      requestId: number;
      result: { ok: true; value: UiJson } | { ok: false; code: string };
    }
  | { kind: 'cancel'; fence: PlatformFence; requestId: number }
  | { kind: 'event'; fence: PlatformFence; sequence: number; name: string; value: UiJson };
// Functions, AbortSignal and disposable subscriptions belong to guest SDK wrappers,
// never the structured-clone wire. Runtime methods are explicitly not implemented here.
