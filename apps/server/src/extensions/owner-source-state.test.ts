import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { EncryptedSourceCredentialVault } from './source-credential-vault.js';
import { PreparedImageDownloads } from '../services/prepared-image-downloads.js';

it('keeps identical source scopes, browser cookies and prepared handles owner-bound across vault restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-owner-fixture-'));
  const master = randomBytes(32);
  const key = (owner: string) => createHmac('sha256', master).update('boaa-owner-source-v1\0').update(owner).digest();
  const open = (owner: string) => new EncryptedSourceCredentialVault(join(root, owner), key(owner));
  const a = open('a'),
    b = open('b');
  const preparedA = new PreparedImageDownloads(),
    preparedB = new PreparedImageDownloads();
  try {
    for (const kind of ['login', 'browser']) {
      const scope = JSON.stringify(['org.example.source', kind, 'same-epoch']);
      a.write(scope, { secret: 'a-only' });
      b.write(scope, { secret: 'b-only' });
      expect(open('a').read(scope)?.secret).toBe('a-only');
      expect(open('b').read(scope)?.secret).toBe('b-only');
      expect(() => new EncryptedSourceCredentialVault(join(root, 'a'), key('b')).read(scope)).toThrow(
        'source_vault_unavailable',
      );
    }
    const receipt = await preparedA.put(
      'same-source',
      'same-work',
      new File(['a-only'], 'source.txt'),
      new AbortController().signal,
      'same-generation',
    );
    preparedB.discard(receipt.artifactId, 'same-source');
    await expect(
      preparedB.consume(receipt.artifactId, 'same-source', 'same-work', async (file) => file.text(), 'same-generation'),
    ).rejects.toThrow('prepared_download_unavailable');
    expect(
      await preparedA.consume(
        receipt.artifactId,
        'same-source',
        'same-work',
        async (file) => file.text(),
        'same-generation',
      ),
    ).toBe('a-only');
  } finally {
    preparedA.close();
    preparedB.close();
    await rm(root, { recursive: true, force: true });
  }
});
