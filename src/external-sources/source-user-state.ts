import { externalItemKeyId, type ExternalItemKey } from './contracts';

export interface SourceReleasePreference {
  readonly lastReadWork?: { readonly title: string; readonly author?: string };
  readonly id: string;
  readonly kind: 'releasePreference';
  readonly source: ExternalItemKey;
  readonly title?: string;
  readonly read?: boolean;
  readonly readChangedAt?: string;
  /** Actual reader visits, independent of manual read/unread and background downloads. */
  readonly lastReadAt?: string;
  /** Source metadata at the last actual visit, separate from the user's title override. */
  readonly lastReadRelease?: { readonly title: string; readonly number: number };
  readonly readingMode?: 'stream' | 'download';
  readonly collectionRemoteId?: string;
  readonly updatedAt: string;
}

export interface SourceDownloadQueue {
  readonly id: string;
  readonly kind: 'downloadQueue';
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly collectionRemoteId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly items: readonly {
    readonly key: ExternalItemKey;
    readonly remoteRevision?: string;
    readonly title: string;
    readonly sectionId: string;
  }[];
}

export function releasePreferenceId(key: ExternalItemKey): string {
  return `release-preference:${externalItemKeyId(key)}`;
}

export function sourceDownloadQueueId(key: ExternalItemKey, collectionRemoteId: string): string {
  return `download-queue:${JSON.stringify([key.connectorId, key.accountConnectionId ?? '', collectionRemoteId])}`;
}

export function validLastReadRelease(value: unknown): value is NonNullable<SourceReleasePreference['lastReadRelease']> {
  if (!value || typeof value !== 'object') return false;
  const item = value as NonNullable<SourceReleasePreference['lastReadRelease']>;
  return typeof item.title === 'string' && item.title.length <= 200 && Number.isFinite(item.number) && item.number >= 0;
}

export function validReleasePreference(value: unknown): value is SourceReleasePreference {
  if (!value || typeof value !== 'object') return false;
  const item = value as SourceReleasePreference;
  return (
    item.kind === 'releasePreference' &&
    typeof item.source?.connectorId === 'string' &&
    item.source.connectorId.length > 0 &&
    item.source.connectorId.length <= 256 &&
    typeof item.source.remoteId === 'string' &&
    item.source.remoteId.length > 0 &&
    item.source.remoteId.length <= 1024 &&
    (item.source.accountConnectionId === undefined ||
      (typeof item.source.accountConnectionId === 'string' && item.source.accountConnectionId.length <= 256)) &&
    item.id === releasePreferenceId(item.source) &&
    typeof item.updatedAt === 'string' &&
    Number.isFinite(Date.parse(item.updatedAt)) &&
    (item.readChangedAt === undefined ||
      (typeof item.readChangedAt === 'string' && Number.isFinite(Date.parse(item.readChangedAt)))) &&
    (item.lastReadRelease === undefined || validLastReadRelease(item.lastReadRelease)) &&
    (item.lastReadWork === undefined || validLastReadWork(item.lastReadWork)) &&
    (item.readingMode === undefined || item.readingMode === 'stream' || item.readingMode === 'download') &&
    (item.lastReadAt === undefined ||
      (typeof item.lastReadAt === 'string' &&
        Number.isFinite(Date.parse(item.lastReadAt)) &&
        typeof item.collectionRemoteId === 'string' &&
        item.collectionRemoteId.length > 0)) &&
    (item.collectionRemoteId === undefined ||
      (typeof item.collectionRemoteId === 'string' &&
        item.collectionRemoteId.length > 0 &&
        item.collectionRemoteId.length <= 1024)) &&
    (item.title === undefined ||
      (typeof item.title === 'string' && item.title.trim().length > 0 && item.title.length <= 200)) &&
    (item.read === undefined || typeof item.read === 'boolean')
  );
}

export function normalizeReleasePreference(item: SourceReleasePreference): SourceReleasePreference {
  return {
    id: item.id,
    kind: 'releasePreference',
    source: {
      connectorId: item.source.connectorId,
      remoteId: item.source.remoteId,
      ...(item.source.accountConnectionId !== undefined
        ? { accountConnectionId: item.source.accountConnectionId }
        : {}),
    },
    updatedAt: item.updatedAt,
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.read !== undefined ? { read: item.read } : {}),
    ...(item.readChangedAt ? { readChangedAt: item.readChangedAt } : {}),
    ...(item.lastReadAt ? { lastReadAt: item.lastReadAt } : {}),
    ...(item.lastReadWork
      ? {
          lastReadWork: {
            title: item.lastReadWork.title,
            ...(item.lastReadWork.author ? { author: item.lastReadWork.author } : {}),
          },
        }
      : {}),
    ...(item.lastReadRelease
      ? { lastReadRelease: { title: item.lastReadRelease.title, number: item.lastReadRelease.number } }
      : {}),
    ...(item.readingMode ? { readingMode: item.readingMode } : {}),
    ...(item.collectionRemoteId ? { collectionRemoteId: item.collectionRemoteId } : {}),
  };
}

export function validLastReadWork(value: unknown): value is NonNullable<SourceReleasePreference['lastReadWork']> {
  if (!value || typeof value !== 'object') return false;
  const work = value as Record<string, unknown>;
  return (
    typeof work.title === 'string' &&
    work.title.length <= 200 &&
    (work.author === undefined || (typeof work.author === 'string' && work.author.length <= 200))
  );
}
