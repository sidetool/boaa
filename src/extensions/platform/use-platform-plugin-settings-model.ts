import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntryRole, PlatformPermission } from '@boaa/extension-contracts/platform-package';
import type { ProductPluginSession } from './product-session';
import type { ConfigRow, Installation, InstallReview, RoleGrants } from './store-model';
import { settingsMigrationRunner } from './settings-migration';
import { PluginSettingsError, pluginSettingsFailure, type PluginSettingsFailure } from './plugin-settings-failure';

export function usePlatformPluginSettingsModel(session: ProductPluginSession) {
  const [rows, setRows] = useState<Installation[]>([]),
    [error, setError] = useState<PluginSettingsFailure>(),
    [busy, setBusy] = useState(false);
  const [review, setReview] = useState<InstallReview>(),
    [grants, setGrants] = useState<RoleGrants>({});
  const [preserve, setPreserve] = useState(false),
    [config, setConfig] = useState<{ row: Installation; value: ConfigRow }>();
  const [view, setView] = useState<{ id: string; view: string }>(),
    [faults, setFaults] = useState<ReturnType<ProductPluginSession['service']['status']>['faults']>([]);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const all = await session.store.list();
    if (alive.current) {
      setLoading(false);
      setRows(all.filter((r) => !r.tombstone));
      const status = session.service.status();
      setFaults([
        ...status.faults,
        ...Object.entries(status.reader?.errors ?? {}).map(([id, code]) => ({ id, code, revision: 0 })),
      ]);
    }
  }, [session]);
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e) => {
      if (alive.current) {
        setLoading(false);
        setError(pluginSettingsFailure(e));
      }
    });
    const poll = setInterval(() => void refresh().catch(() => {}), 1000);
    return () => {
      alive.current = false;
      clearInterval(poll);
    };
  }, [refresh]);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    void action()
      .then(() => refresh())
      .catch((e) => {
        if (alive.current) setError(pluginSettingsFailure(e));
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };
  const showReview = (next: InstallReview) => {
    setReview(next);
    setGrants(Object.fromEntries(Object.keys(next.manifest.entries).map((role) => [role, []])));
    setPreserve(next.expectedRevision > 0 && !next.publisherChanged && !next.sourceChanged);
  };
  const setPermission = (role: EntryRole, permission: PlatformPermission, checked: boolean) =>
    setGrants((old) => ({
      ...old,
      [role]: checked ? [...(old[role] ?? []), permission] : (old[role] ?? []).filter((item) => item !== permission),
    }));
  const approve = async () => {
    if (!review || session.off) return;
    const old = rows.find((r) => r.pluginId === review.pluginId);
    const approval = {
      digest: review.digest,
      roles: grants,
      enabled: true,
      data: preserve ? ('preserve' as const) : ('reset' as const),
      allowPublisherChange: review.publisherChanged,
      allowUnsignedDataReuse: preserve,
      allowDowngrade: review.downgrade,
      allowSameVersionReplacement: review.sameVersionReplacement,
    };
    if (old?.manifest?.contributes.connections?.length) await session.http.revoke(old);
    const oldConfig = old ? await session.store.inspectConfig(old.pluginId, old.revision) : undefined;
    if (preserve && oldConfig && old?.active !== review.digest) {
      if (old?.enabled) throw new PluginSettingsError('migration_requires_disabled');
      await session.store.installWithMigration(
        review,
        approval,
        settingsMigrationRunner(session.workerOptions),
        session.signal,
      );
    } else await session.store.install(review, approval);
    setReview(undefined);
    await session.service.reconcile();
  };
  const inspectFile = (file: File) =>
    run(async () =>
      showReview(
        await session.store.inspect(
          file,
          file.name.toLowerCase().endsWith('.js') ? 'single-js' : 'package',
          'local-file',
        ),
      ),
    );
  const disable = async (row: Installation, remove = false) => {
    await session.store.disable(row.pluginId, row.revision, remove || undefined);
    await session.service.reconcile();
    if (row.manifest?.contributes.connections?.length)
      await session.http.revoke(row).catch(() => {
        throw new PluginSettingsError(remove ? 'remove_revoke_failed' : 'disable_revoke_failed');
      });
  };
  const toggle = (row: Installation) =>
    run(async () => {
      if (row.enabled) await disable(row);
      else showReview(await session.store.inspectRetained(row.pluginId, 'active'));
    });
  const remove = (row: Installation) => run(() => disable(row, true));
  const openConfig = (row: Installation) =>
    run(async () => {
      await session.service.settings(row.pluginId);
      const value = await session.store.inspectConfig(row.pluginId, row.revision);
      if (!value) throw new PluginSettingsError('missing_config');
      setConfig({ row, value });
    });
  const reviewPrevious = (row: Installation) =>
    run(async () => showReview(await session.store.inspectRetained(row.pluginId, 'previous')));
  const acknowledge = (row: Installation) => run(() => session.store.acknowledgeMarkers(row.pluginId, row.revision));
  const command = (row: Installation, name: string) =>
    run(() => session.service.command(row.pluginId, name, null, session.signal));
  return {
    rows,
    loading,
    setPermission,
    error,
    busy,
    review,
    setReview,
    grants,
    setGrants,
    preserve,
    setPreserve,
    config,
    setConfig,
    view,
    setView,
    faults,
    refresh,
    run,
    showReview,
    approve,
    inspectFile,
    toggle,
    remove,
    openConfig,
    reviewPrevious,
    acknowledge,
    command,
  };
}
export type PlatformPluginSettingsModel = ReturnType<typeof usePlatformPluginSettingsModel>;
