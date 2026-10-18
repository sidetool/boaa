import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MangayomiExtensionHost } from './host.js';
import { fixtureRow, fixtureSource } from './test-fixture.js';
import { EncryptedSourceCredentialVault } from '../source-credential-vault.js';
import type { compatibilityHttp } from './http.js';

it('provisions reviewed synthetic JS to separate empty owner bindings and preserves them after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-provision-fixture-'));
  const hosts: MangayomiExtensionHost[] = [];
  const transport: typeof compatibilityHttp = async (input) => ({
    bytes: Buffer.from(input.url.endsWith('.json') ? JSON.stringify([fixtureRow]) : fixtureSource),
    statusCode: 200,
    headers: {},
    contentType: 'text/plain',
    url: input.url,
  });
  const open = async (owner: string) => {
    const host = await MangayomiExtensionHost.open(
      join(root, owner, 'host'),
      new EncryptedSourceCredentialVault(join(root, owner, 'vault'), Buffer.alloc(32, owner.charCodeAt(0))),
      transport,
    );
    hosts.push(host);
    return host;
  };
  try {
    const admin = await open('admin'),
      a = await open('a'),
      b = await open('b');
    const signal = AbortSignal.timeout(10000),
      repo = 'https://repo.example/index.json';
    await admin.refreshRepository(repo, signal);
    const entry = admin.snapshot().repositories[0].entries[0];
    const review = await admin.inspect(repo, entry.pkg, entry.code, signal);
    await admin.install(review.id, review.revision, signal);
    await admin.savePreferences(
      entry.pkg,
      admin.snapshot().revision,
      { enabled: true, access_key: 'admin-private' },
      [],
    );
    for (const target of [a, b]) {
      await target.provisionFrom(admin, entry.pkg, signal);
      expect(target.snapshot().repositories).toEqual([]);
      expect(target.preferences(entry.pkg).fields.find((field) => field.key === 'enabled')?.value).toBe(false);
      expect(JSON.stringify(target.preferences(entry.pkg))).not.toContain('admin-private');
      expect(target.snapshot().packages[0].activation).not.toBe(admin.snapshot().packages[0].activation);
    }
    await a.savePreferences(entry.pkg, a.snapshot().revision, { enabled: true }, []);
    expect(b.preferences(entry.pkg).fields.find((field) => field.key === 'enabled')?.value).toBe(false);
    a.close();
    const reopened = await open('a');
    expect(reopened.preferences(entry.pkg).fields.find((field) => field.key === 'enabled')?.value).toBe(true);
    await expect(b.provisionFrom(admin, entry.pkg, signal)).rejects.toThrow('source_binding_exists');
  } finally {
    hosts.forEach((host) => host.close());
    await rm(root, { recursive: true, force: true });
  }
});
