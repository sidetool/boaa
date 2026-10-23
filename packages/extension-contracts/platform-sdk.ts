/** Public guest declarations for the current plugin API. Import these with `import type`; the host supplies BoaaPlugin. */
import type { UiJson } from './ui-json';
import type { PluginHttpRequest, PluginHttpResult } from './plugin-http';
import type { PlatformContentBatch, PlatformDecorationResult } from './plugin-platform-sdk';
import type { PluginImageInput } from './plugin-images';
import type { HomeFeed } from './home-feed';
export type { UiJson, PluginHttpRequest, PluginHttpResult, HomeFeed };
export type { HomeFeedItem, HomeFeedSection } from './home-feed';
export type { PlatformManifest, PlatformPermission, PlatformFeature } from './plugin-platform-manifest';

/** Controller signals intentionally expose only these methods, not browser AbortSignal extensions. */
export interface PlatformAbortSignal {
  readonly aborted: boolean;
  throwIfAborted(): void;
  addEventListener(name: 'abort', listener: () => void): void;
  removeEventListener(name: 'abort', listener: () => void): void;
}
export interface PlatformDisposable {
  dispose(): void;
}
export interface PlatformAsyncDisposable {
  dispose(): Promise<void>;
}
export type PlatformSettingsField = { label?: string; description?: string } & (
  | { type: 'boolean'; default: boolean }
  | { type: 'number'; default: number; min?: number; max?: number }
  | { type: 'string'; default: string; maxLength?: number }
  | { type: 'color'; default: string }
  | { type: 'enum'; default: string; options: string[] }
  | { type: 'list'; default: UiJson[]; item: PlatformSettingsField; maxItems: number }
  | { type: 'group'; fields: Record<string, PlatformSettingsField> }
);
export interface PlatformSettingsSchema {
  version: number;
  fields: Record<string, PlatformSettingsField>;
}
export type PlatformSettingsSnapshot = {
  schemaVersion: number;
  revision: number;
  value: Record<string, UiJson>;
} | null;
export interface PlatformStorage {
  get(key: string): Promise<{ found: false } | { found: true; value: UiJson; revision: number }>;
  /** null (the default) creates an absent key. Updating requires the revision returned by get(). */
  set(key: string, value: UiJson, expectedRevision?: number | null): Promise<{ revision: number }>;
  remove(key: string, expectedRevision: number): Promise<{ revision: number }>;
  /** Lexicographic keys only; values are fetched with get(). Default limit 32, maximum 128. */
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: { key: string; revision: number }[]; nextCursor?: string }>;
}
/** Separate disposable server cache: 256KiB/64 entries per installation, 48KiB per value.
 * A stale hit may be displayed while the caller awaits a separate refresh. Never detach QuickJS work. */
export interface PlatformCache {
  get(key: string): Promise<import('./plugin-cache').PluginCacheResult>;
  set(key: string, value: UiJson, options?: { ttlSeconds?: number; staleSeconds?: number }): Promise<unknown>;
  remove(key: string): Promise<unknown>;
}
export interface PlatformSettings {
  get(): Promise<PlatformSettingsSnapshot>;
  set(expectedRevision: number, value: Record<string, UiJson>): Promise<PlatformSettingsSnapshot>;
}
export interface PlatformHttp {
  request(input: PluginHttpRequest, signal?: PlatformAbortSignal): Promise<PluginHttpResult>;
}
export type PlatformEvent =
  | 'app.ready'
  | 'reader.entered'
  | 'reader.exited'
  | 'reader.contextChanged'
  | 'settings.changed'
  | 'view.opened'
  | 'view.closed';
export type PlatformHandler = (value: UiJson, signal: PlatformAbortSignal) => UiJson | void | Promise<UiJson | void>;
export type PlatformAnnotationKind = 'bookmark' | 'highlight' | 'note';
export interface PlatformContentPage {
  bookId: string;
  contentRevision: string;
  blocks: { id: string; chapterId: string; index: number; text: string; textHash: string }[];
  cursor: string | null;
}
export interface PlatformReader {
  /** Current reader state only. There is no arbitrary book ID or app navigation API. */
  state(): Promise<UiJson>;
  content: {
    read(cursor?: string): Promise<PlatformContentPage>;
    search(query: string, cursor?: string): Promise<PlatformContentPage>;
  };
  annotations: {
    list(
      kind: PlatformAnnotationKind,
      cursor?: string,
    ): Promise<{ entries: { handle: string; value: UiJson }[]; nextCursor: string | null }>;
    create(
      kind: PlatformAnnotationKind,
      paragraphId: string,
      textHash: string,
      fields: Record<string, UiJson>,
      requestId: string,
    ): Promise<UiJson>;
    update(handle: string, fields: Record<string, UiJson>): Promise<UiJson>;
    delete(handle: string): Promise<UiJson>;
  };
  auto: {
    /** interactionId comes from a user-authorized reader input command, not a fabricated gesture. */
    start(interactionId: string, speed: number): Promise<{ leaseId: string }>;
    update(leaseId: string, speed: number): Promise<null>;
    stop(leaseId: string): Promise<null>;
  };
}
export type PlatformDecorationInput = Readonly<
  PlatformContentBatch & { mode?: 'block' | 'ordered-chapter'; checkpoint?: UiJson }
>;
export type PlatformDecoration = Omit<PlatformDecorationResult['layers'][number], 'id'> & { checkpoint?: UiJson };
export interface PlatformControllerContext {
  readonly cache: PlatformCache;
  readonly home: {
    register(id: string, handler: (signal: PlatformAbortSignal) => HomeFeed | Promise<HomeFeed>): PlatformDisposable;
  };
  readonly storage: PlatformStorage;
  readonly settings: PlatformSettings;
  readonly http: PlatformHttp;
  readonly reader: PlatformReader;
  readonly commands: { register(id: string, handler: PlatformHandler): PlatformDisposable };
  readonly events: { on(id: PlatformEvent, handler: PlatformHandler): PlatformDisposable };
  readonly handlers: { register(id: string, handler: PlatformHandler): PlatformDisposable };
  readonly decorations: {
    register(
      id: string,
      handler: (
        input: PlatformDecorationInput,
        signal: PlatformAbortSignal,
      ) => PlatformDecoration | null | void | Promise<PlatformDecoration | null | void>,
      options?: { mode?: 'block' | 'ordered-chapter' },
    ): Promise<PlatformAsyncDisposable>;
    invalidate(): Promise<null>;
  };
  readonly tasks: { run(input: UiJson): Promise<UiJson> };
  readonly jobs: { sleep(ms: number): Promise<null> };
}
export interface PlatformControllerDefinition {
  apiVersion: 2;
  settings?: PlatformSettingsSchema;
  activate(context: PlatformControllerContext): void | Promise<void>;
}
export interface PlatformControllerApi {
  register(definition: PlatformControllerDefinition): void;
}

/** UI code has DOM access only inside its sandbox. Supply HTMLElement as Root in a DOM-enabled project. */
export interface PlatformViewContext<Root = unknown> {
  readonly cache: PlatformCache;
  /** Approved public image, local to this frame. Dispose when no longer displayed. */
  readonly images: {
    load(input: PluginImageInput, signal?: PlatformAbortSignal): Promise<{ readonly url: string; dispose(): void }>;
  };
  /** Opens BOAA title search after a user action; requires app.search. */
  readonly app: { search(query: string): Promise<void> };
  readonly view: { readonly id: string; readonly root: Root | null };
  readonly controller: {
    call(handler: string, value?: UiJson, options?: { signal?: PlatformAbortSignal }): Promise<UiJson>;
  };
  readonly storage: PlatformStorage;
  readonly http: PlatformHttp;
  readonly settings: PlatformSettings & {
    register(schema: PlatformSettingsSchema): Promise<PlatformSettingsSnapshot>;
    subscribe(listener: (snapshot: PlatformSettingsSnapshot) => void | Promise<void>): Promise<PlatformAsyncDisposable>;
  };
}
export interface PlatformViewApi<Root = unknown> {
  register(definition: { apiVersion: 2; activate(context: PlatformViewContext<Root>): void | Promise<void> }): void;
}
/** Task entries are pure computation; no settings, HTTP, DOM or other host context. */
export interface PlatformTaskApi {
  register(definition: { apiVersion: 2; run(input: UiJson): UiJson | void | Promise<UiJson | void> }): void;
}
