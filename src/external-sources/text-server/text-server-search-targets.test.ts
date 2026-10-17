import { expect, it, vi } from 'vitest';
import type { ExternalSourceCredentialRecord } from '../contracts';
import type { ExternalSourceLocalState } from '../local-state';
import { createExternalSourceCredentialKey } from '../device-credential-crypto';
import { TextServerSourceAccountBroker } from './text-server-source-account-broker';
import { textServerNamespace } from './text-server-client';

it('enumerates searchable child catalogs across pages and searches them independently with opaque locations', async () => {
  const identity = { instanceId: 'fixture', dataNamespace: 'test', label: 'Fixture' };
  const namespace = textServerNamespace(identity);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'X-Boaa-Source-Namespace': namespace },
    });
  const key = await createExternalSourceCredentialKey();
  let credential: ExternalSourceCredentialRecord | undefined;
  const state = {
    getOrCreateCredentialKey: async () => key,
    getCredential: async () => credential,
    saveCredential: async (value: ExternalSourceCredentialRecord) => {
      credential = value;
    },
    clearCache: vi.fn(async () => undefined),
  } as unknown as ExternalSourceLocalState;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/health'))
      return json({ ...identity, protocolVersion: 1, capabilities: ['catalog', 'txt-content'] });
    if (url.pathname === '/v1/sources')
      return json(
        url.searchParams.has('cursor')
          ? { items: [{ id: 'second', title: 'Second' }] }
          : {
              items: [
                { id: 'first', title: 'First', capabilities: ['search'] },
                { id: 'offline', title: 'Offline', available: false },
                { id: 'browse', title: 'Browse', capabilities: ['catalog'] },
              ],
              nextCursor: 'next',
            },
      );
    expect(url.searchParams.get('query')).toBe('term');
    expect(url.pathname).toMatch(/^\/v1\/sources\/(first|second)\/works$/u);
    return json({ items: [{ id: 'work', title: url.pathname }] });
  });
  const broker = new TextServerSourceAccountBroker('fixture.catalog', state, { fetchImpl });
  await broker.connect({ endpoint: 'https://text.test' });
  const signal = new AbortController().signal;
  const targets = await broker.listSearchTargets(signal);
  expect(targets.map(({ id, title }) => ({ id, title }))).toEqual([
    { id: 'first', title: 'First' },
    { id: 'second', title: 'Second' },
  ]);
  const result = await Promise.all(
    targets.map((target) =>
      broker.list(
        {
          accountConnectionId: broker.status().accountConnectionId,
          parentRef: target.parentRef,
          query: 'term',
          browseMode: 'search',
        },
        signal,
      ),
    ),
  );
  expect(result.map((value) => value.items[0].key.remoteId)).toEqual([
    'text:["first","work"]',
    'text:["second","work"]',
  ]);
  const abort = new AbortController();
  abort.abort();
  await expect(broker.listSearchTargets(abort.signal)).rejects.toThrow();
  broker.dispose();
});
