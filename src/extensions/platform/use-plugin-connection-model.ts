import { useEffect, useState } from 'react';
import type { ProductPluginSession } from './product-session';
import type { Installation } from './store-model';
import type { PluginConnectionStatus } from './plugin-http';
import { PLUGIN_HTTP_METHODS } from '../../../packages/extension-contracts/plugin-http';
export type PluginConnectionError = 'load_failed' | 'mutation_failed';
export interface PluginConnectionModelOptions {
  session: ProductPluginSession;
  row: Installation;
  slot: string;
}
export function usePluginConnectionModel({ session, row, slot }: PluginConnectionModelOptions) {
  const [saved, setSaved] = useState<PluginConnectionStatus>(),
    [endpoint, setEndpoint] = useState(''),
    [auth, setAuth] = useState('none'),
    [header, setHeader] = useState('x-api-key'),
    [allowedHeaders, setAllowedHeaders] = useState('accept, content-type, accept-language'),
    [secret, setSecret] = useState(''),
    [methods, setMethods] = useState<string[]>(['GET']),
    [roles, setRoles] = useState<string[]>([]),
    [error, setError] = useState<PluginConnectionError>(),
    [busy, setBusy] = useState(false);
  const { installationId, active, revision } = row;
  useEffect(() => {
    let alive = true;
    void session.http
      .list({ installationId, active, revision })
      .then((all) => {
        if (!alive) return;
        const old = all.find((c) => c.slot === slot);
        setSaved(old);
        if (old) {
          setEndpoint(old.endpoint);
          setMethods(old.methods);
          setAllowedHeaders(old.headers.join(', '));
          setRoles(old.roles);
        }
      })
      .catch(() => {
        if (alive) setError('load_failed');
      });
    return () => {
      alive = false;
    };
  }, [session, installationId, revision, active, slot]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setSecret('');
      setSaved((await session.http.list(row)).find((c) => c.slot === slot));
    } catch {
      setError('mutation_failed');
    } finally {
      setBusy(false);
    }
  };
  const approve = () => {
    return run(() =>
      session.http.host('approve', session.http.owner(row), {
        slot,
        endpoint,
        methods,
        headers: allowedHeaders
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean),
        roles,
        auth: auth === 'none' ? { kind: 'none' } : { kind: auth, header, value: secret },
      }),
    );
  };
  const revoke = () => run(() => session.http.revoke(row, slot));
  const methodOptions = PLUGIN_HTTP_METHODS;
  const roleOptions = (['controller', 'ui'] as const).filter((role) =>
    row.manifest?.entries[role]?.permissions.includes('http.request'),
  );
  const setMethod = (method: string, checked: boolean) =>
    setMethods((old) => (checked ? [...old, method] : old.filter((value) => value !== method)));
  const setRole = (role: string, checked: boolean) =>
    setRoles((old) => (checked ? [...old, role] : old.filter((value) => value !== role)));
  const disabled = busy || !row.enabled || session.off;
  return {
    saved,
    endpoint,
    setEndpoint,
    auth,
    setAuth,
    header,
    setHeader,
    allowedHeaders,
    setAllowedHeaders,
    secret,
    setSecret,
    methods,
    setMethods,
    roles,
    setRoles,
    busy,
    error,
    approve,
    revoke,
    methodOptions,
    roleOptions,
    setMethod,
    setRole,
    disabled,
  };
}
export type PluginConnectionModel = ReturnType<typeof usePluginConnectionModel>;
