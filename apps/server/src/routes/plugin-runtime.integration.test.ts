import { afterAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrate.js';
import { seedDefaultUser } from '../db/pool.js';
import { PostgresSelfHostAuthStore, SelfHostAuthService } from '../services/self-host-auth-service.js';
import {
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../services/id-v2-migration/postgres-integration-harness.js';
import { pluginScope, pluginShell } from './plugin-runtime.js';
import { pluginOriginFromEnv } from '../config.js';
const harness = await startPostgresIntegrationHarness();
afterAll(() => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
describe.skipIf(!harness)('trusted plugin scope', () => {
  it('persists deployment IDs, rejects invalid/revoked sessions and rotates a recreated account', async () => {
    await withPostgresSchema(harness!, 'plugin_scope', async (pool) => {
      await migrateDatabase(pool);
      await seedDefaultUser(pool, 'owner');
      const auth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), 'owner');
      const account = await auth.register({ username: 'plugin-owner', password: 'Very-long-password-2026!' });
      const before = await pluginScope(pool, account.token, 'owner');
      expect(before?.accountId).toBeTruthy();
      expect(await pluginScope(pool, account.token, 'owner')).toEqual(before);
      expect(await pluginScope(pool, 'invalid', 'owner')).toBeUndefined();
      expect(await pluginScope(pool, account.token, 'another-user')).toBeUndefined();
      await auth.logout(account.token);
      expect(await pluginScope(pool, account.token, 'owner')).toBeUndefined();
      await pool.query('delete from self_host_accounts');
      const replacement = await auth.register({ username: 'plugin-owner', password: 'Very-long-password-2026!' });
      const after = await pluginScope(pool, replacement.token, 'owner');
      expect(after?.serverId).toBe(before?.serverId);
      expect(after?.libraryId).toBe(before?.libraryId);
      expect(after?.accountId).not.toBe(before?.accountId);
    });
  }, 30000);
});
it('binds shell policy to configured origin and forbids untrusted origins', () => {
  for (const origin of [
    'http://public.example',
    'https://example.com/path',
    'https://evil.test/#',
    'https://user@foo.test',
  ])
    expect(() => pluginOriginFromEnv(origin)).toThrow();
  const result = pluginShell('console.log("</script>")', 'https://boaa.example');
  expect(result.csp).toContain('frame-ancestors https://boaa.example');
  expect(result.csp).toContain("connect-src 'none'");
  expect(result.csp).not.toContain('unsafe-eval');
  expect(result.html.match(/<\/script>/g)).toHaveLength(1);
});
