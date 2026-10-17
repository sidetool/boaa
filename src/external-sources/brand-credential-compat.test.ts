import { expect, it } from 'vitest';
import {
  createExternalSourceCredentialKey,
  sealExternalSourceCredential,
  unsealExternalSourceCredential,
} from './device-credential-crypto';
it('opens a pre-BOAA encrypted source credential with the original device key', async () => {
  const key = await createExternalSourceCredentialKey();
  const credential = { accessToken: 'synthetic migration token' };
  const envelope = JSON.parse(await sealExternalSourceCredential(credential, key));
  envelope.format = 'noveldesk-external-source-credential';
  await expect(unsealExternalSourceCredential(JSON.stringify(envelope), key)).resolves.toEqual(credential);
});
