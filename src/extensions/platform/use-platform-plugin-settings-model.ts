import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductPluginSession } from './product-session';
import type { ConfigRow, Installation, InstallReview } from './store-model';
import { declaredPluginGrants } from './plugin-presentation';
import { settingsMigrationRunner } from './settings-migration';
import { PluginSettingsError, pluginSettingsFailure, type PluginSettingsFailure } from './plugin-settings-failure';

export function usePlatformPluginSettingsModel(session: ProductPluginSession) {
  const [rows, setRows] = useState<Installation[]>([]),
    [error, setError] = useState<PluginSettingsFailure>(),
    [busy, setBusy] = useState(false);
  const [review, updateReview] = useState<InstallReview>();
  const reviewed = useRef<InstallReview | undefined>(undefined);
  const approving = useRef(false);
  const working = useRef(false);
  const setReview = (next: InstallReview | undefined) => {
    reviewed.current = next;
    updateReview(next);
  };
  const [preserve, setPreserve] = useState(false),
    [config, setConfig] = useState<{ row: Installation; value: ConfigRow }>();
  const [view, setView] = useState<{ id: string; view: string }>(),
    [faults, setFaults] = useState<ReturnType<ProductPluginSession['service']['status']>['faults']>([]);
  const [loading, setLoading] = useState(true);
  /** Plugins with interrupted runtime work that the user can acknowledge once the plugin is off. */
  const [recoveryIds, setRecoveryIds] = useState<ReadonlySet<string>>(() => new Set());
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const [all, markers] = await Promise.all([session.store.list(), session.store.unfinishedMarkers()]);
    if (alive.current) {
      setLoading(false);
      setRows(all.filter((r) => !r.tombstone));
      setRecoveryIds((previous) => {
        const next = new Set(markers.map((marker) => marker.pluginId));
        return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next;
      });
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
  const run = async (action: () => Promise<unknown>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(undefined);
    await action()
      .then(() => refresh())
      .catch((e) => {
        if (alive.current) setError(pluginSettingsFailure(e));
      })
      .finally(() => {
        working.current = false;
        if (alive.current) setBusy(false);
      });
  };
  const showReview = (next: InstallReview) => {
    setReview(next);
    setPreserve(next.expectedRevision > 0 && !next.publisherChanged && !next.sourceChanged);
  };
  const approve = async () => {
    if (!review || session.off || approving.current) return;
    approving.current = true;
    let committed = false;
    try {
      const guard = () => {
        if (reviewed.current !== review || session.signal.aborted) throw new PluginSettingsError('review_stale');
      };
      guard();
      const old = (await session.store.list()).find((r) => r.pluginId === review.pluginId);
      guard();
      if ((old?.revision ?? 0) !== review.expectedRevision) throw new PluginSettingsError('review_stale');
      const approval = {
        digest: review.digest,
        roles: declaredPluginGrants(review.manifest),
        enabled: true,
        data: preserve ? ('preserve' as const) : ('reset' as const),
        allowPublisherChange: review.publisherChanged,
        allowUnsignedDataReuse: preserve,
        allowDowngrade: review.downgrade,
        allowSameVersionReplacement: review.sameVersionReplacement,
      };
      const oldConfig = old ? await session.store.inspectConfig(old.pluginId, old.revision) : undefined;
      guard();
      if (preserve && oldConfig && old?.active !== review.digest) {
        if (old?.enabled) throw new PluginSettingsError('migration_requires_disabled');
        await session.store.installWithMigration(
          review,
          approval,
          settingsMigrationRunner(session.workerOptions),
          session.signal,
        );
      } else await session.store.install(review, approval);
      committed = true;
      if (reviewed.current === review) setReview(undefined);
      try {
        if (old?.manifest?.contributes.connections?.length) await session.http.retire(old);
      } catch {
        throw new PluginSettingsError('update_revoke_failed');
      }
      try {
        const installed = (await session.store.list()).find(
          (row) => row.pluginId === review.pluginId && !row.tombstone,
        );
        if (review.manifest.connections?.length) {
          if (!installed || installed.active !== review.digest || installed.revision !== review.expectedRevision + 1)
            throw new PluginSettingsError('review_stale');
          const connections = await session.http.list(installed);
          const roles = Object.entries(review.manifest.entries)
            .filter(([, entry]) => entry.permissions.includes('http.request'))
            .map(([role]) => role);
          for (const connection of review.manifest.connections) {
            if (connections.some((saved) => saved.slot === connection.id)) continue;
            await session.http.host('approve', session.http.owner(installed), {
              slot: connection.id,
              endpoint: connection.endpoint,
              roles,
              methods: connection.methods,
              headers: [
                'accept',
                'content-type',
                'accept-language',
                ...(review.manifest.features.required.includes('http.origin') ? ['origin'] : []),
              ],
              auth: { kind: 'none' },
              expectedRevision: null,
            });
          }
        }
      } catch {
        throw new PluginSettingsError('connection_setup_failed');
      }
    } finally {
      approving.current = false;
      if (committed) await session.service.reconcile();
    }
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
      await session.http.retire(row).catch(() => {
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
    recoveryIds,
    error,
    busy,
    review,
    setReview,
    grants: review ? declaredPluginGrants(review.manifest) : {},
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
