import { describe, expect, it, vi } from 'vitest';
import { clearWebAppRuntimeState } from './web-app-cache';

describe('web app runtime cache cleanup', () => {
  it('removes BOAA service workers and app-shell caches without touching unrelated caches', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const deleteCache = vi.fn().mockResolvedValue(true);

    await expect(
      clearWebAppRuntimeState({
        registrations: [{ unregister }],
        cacheNames: ['boaa-app-shell-v3', 'boaa-app-shell-v4', 'unrelated-cache'],
        deleteCache,
      }),
    ).resolves.toEqual({
      unregisteredCount: 1,
      deletedCacheNames: ['boaa-app-shell-v3', 'boaa-app-shell-v4'],
    });
    expect(unregister).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenNthCalledWith(1, 'boaa-app-shell-v3');
    expect(deleteCache).toHaveBeenNthCalledWith(2, 'boaa-app-shell-v4');
    expect(deleteCache).not.toHaveBeenCalledWith('unrelated-cache');
  });

  it('can clear every cache for the packaged desktop migration', async () => {
    const deleteCache = vi.fn().mockResolvedValue(true);

    await clearWebAppRuntimeState({
      registrations: [],
      cacheNames: ['boaa-app-shell-v4', 'legacy-desktop-cache'],
      deleteCache,
      deleteAllCaches: true,
    });

    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenCalledWith('legacy-desktop-cache');
  });
});
