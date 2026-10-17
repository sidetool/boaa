import { expect, it, vi } from 'vitest';
import { LocalInstalledExtensions } from './local-installed-extensions';

it('routes compatibility-source memory covers to the same owner as cover resolution', () => {
  const provider = { peekExternalSourceCover: vi.fn(() => 'blob:compatible') };
  const client = { compatible: () => provider } as unknown as LocalInstalledExtensions;
  const context = { brokers: { get: () => undefined } };
  const key = { connectorId: 'sample.source', remoteId: 'work' };
  expect(LocalInstalledExtensions.prototype.peekExternalSourceCover.call(client, 'sample.source', context, key)).toBe(
    'blob:compatible',
  );
  expect(provider.peekExternalSourceCover).toHaveBeenCalledWith('sample.source', context, key);
});
