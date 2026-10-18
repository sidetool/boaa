import { accountStorage } from '../../storage/account-storage';
import { readBrandStorage } from '@boaa/extension-contracts/brand-compat';
import type { DownloadPolicy } from '../../domain/types';

/** Import the browser's old policy only when no shared policy has been saved yet. */
export function legacyDownloadPolicy(scope: string): DownloadPolicy {
  try {
    const storage = scope.startsWith('hosted-account:') ? accountStorage(localStorage, scope) : localStorage;
    const retention = JSON.parse(readBrandStorage(localStorage, `boaa.download-retention.v1:${scope}`) ?? '{}');
    const count = Number(readBrandStorage(storage, 'boaa.next-release-download-count.v1'));
    return {
      autoNext: readBrandStorage(storage, 'boaa.next-release-download.v1') === 'true',
      nextCount: count === 2 || count === 3 ? count : 1,
      retentionEnabled: retention?.enabled === true,
      keepRead: retention?.keep === 10 || retention?.keep === 20 ? retention.keep : 5,
    };
  } catch {
    return { autoNext: false, nextCount: 1, retentionEnabled: false, keepRead: 5 };
  }
}
