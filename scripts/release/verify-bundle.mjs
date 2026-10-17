import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
const [archive, signatureFile, keyFile] = process.argv.slice(2);
if (!archive || !signatureFile || !keyFile)
  throw new Error('Usage: node verify-bundle.mjs archive.tar.gz archive.tar.gz.sig trusted-public.pem');
const key = createPublicKey(await readFile(keyFile));
const signature = (await readFile(signatureFile, 'utf8')).trim();
if (
  key.asymmetricKeyType !== 'ed25519' ||
  !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
  !verify(null, await readFile(archive), key, Buffer.from(signature, 'base64'))
)
  throw new Error('release_signature_invalid');
console.log('Release archive signature verified.');
