import assert from 'node:assert/strict';
import test from 'node:test';
import { readHostedSetupCode, setupCodeFromLogs } from './hosted-setup-code.mjs';
test('uses the latest structured bootstrap event and ignores unrelated output', () => {
  const code = 'ABCD-2345-EFGH';
  const lines = [
    'unrelated output',
    JSON.stringify({ event: 'other', setupCode: code }),
    JSON.stringify({ event: 'owner_setup_code', setupCode: code }),
  ];
  assert.ok(setupCodeFromLogs(lines.join('\n')) === code);
  assert.equal(setupCodeFromLogs(JSON.stringify({ event: 'owner_setup_code', setupCode: 'invalid' })), undefined);
});
test('triggers lazy setup issuance, reads logs privately, and skips registered servers', async () => {
  let reads = 0;
  const options = {
    apiUrl: 'http://fixture.invalid/api',
    timeoutMs: 1000,
    fetchStatus: async () => ({ ok: true, json: async () => ({ setupRequired: true }) }),
    readLogs: () => {
      reads++;
      return JSON.stringify({ event: 'owner_setup_code', setupCode: 'ABCD-2345-EFGH' });
    },
  };
  assert.ok((await readHostedSetupCode(options)) === 'ABCD-2345-EFGH');
  assert.equal(
    await readHostedSetupCode({
      ...options,
      fetchStatus: async () => ({ ok: true, json: async () => ({ setupRequired: false }) }),
    }),
    undefined,
  );
  assert.equal(reads, 1);
});
test('missing codes fail closed without credential injection or network bypass', async () => {
  await assert.rejects(
    readHostedSetupCode({ apiUrl: 'http://fixture.invalid/api', timeoutMs: 0, readLogs: () => '' }),
    /not bypassed/,
  );
});
