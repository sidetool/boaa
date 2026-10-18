import { expect, it, vi } from 'vitest';
import { RemoteReaderPersonalizationRepository } from './remote-reader-personalization-repository';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import type { SelfHostSession } from '../features/auth/self-host-session';
import type { UserFontAsset } from '../domain/types';

it('preserves the legacy owner font ID and gives members distinct IDs for the same font bytes', async () => {
  const stored = new Map<string, UserFontAsset>();
  const request = vi.fn(async (path: string, init: RequestInit) => {
    const id = decodeURIComponent(path.slice('/fonts/'.length));
    if (init.method === 'PATCH') stored.set(id, { ...stored.get(id)!, ...JSON.parse(String(init.body)) });
    else stored.set(id, { id, familyLabel: 'Fixture' } as UserFontAsset);
    return { font: stored.get(id) };
  });
  const client = { request } as unknown as RemoteApiClient;
  const session = (userId: string, legacyDataOwner = false) =>
    ({ context: { account: { userId }, legacyDataOwner } }) as SelfHostSession;
  const owner = new RemoteReaderPersonalizationRepository(client, session('owner', true));
  const a = new RemoteReaderPersonalizationRepository(client, session('a'));
  const b = new RemoteReaderPersonalizationRepository(client, session('b'));
  const input = {
    asset: {
      id: 'legacy-content-id',
      contentHash: 'same-content',
      familyLabel: 'Fixture',
      fileName: 'fixture.woff',
    } as UserFontAsset,
    blob: new Blob(['same-font']),
  };
  const original = await owner.installUserFont(input);
  const fontA = await a.installUserFont(input);
  const fontB = await b.installUserFont(input);
  expect(original.id).toBe(input.asset.id);
  expect(new Set([original.id, fontA.id, fontB.id]).size).toBe(3);
  await a.updateUserFont(fontA.id, { familyLabel: 'Only A' });
  expect(stored.get(fontB.id)?.familyLabel).toBe('Fixture');
  expect(stored.get(fontA.id)?.familyLabel).toBe('Only A');
});
