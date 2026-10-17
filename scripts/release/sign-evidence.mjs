import { readFile, writeFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
const key = createPrivateKey(process.env.RELEASE_PRIVATE_KEY || '');
const trusted = createPublicKey(await readFile('deploy/release-public.pub'));
if (
  key.asymmetricKeyType !== 'ed25519' ||
  createPublicKey(key).export({ format: 'pem', type: 'spki' }) !== trusted.export({ format: 'pem', type: 'spki' })
)
  throw new Error('release_trust_mismatch');
const data = await readFile('release/server-evidence.json');
const signature = sign(null, data, key);
if (!verify(null, data, trusted, signature)) throw new Error('evidence_signature_invalid');
await writeFile('release/server-evidence.json.sig', signature.toString('base64') + '\n');
