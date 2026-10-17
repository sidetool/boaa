import { writeFile } from 'node:fs/promises';
import { BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import { verifyBrowserUiPackage } from '../../src/extensions/packages/browser-ui-package';
import { loadPublisherKey } from '../extensions/signing';
import { packBrowserUiProject, readBoundedUiFile } from './ui-package';

const usage =
  'Usage: pnpm plugin:ui pack <prebuilt-folder> --out <new.boaaext> [--key <publisher.pem>] | check <package.boaaext>';
async function main() {
  const [command, input, ...rest] = process.argv.slice(2);
  if (!input || input.startsWith('--')) throw new Error(usage);
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--out', '--key'].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--') || options.has(rest[i]))
      throw new Error(usage);
    options.set(rest[i], rest[i + 1]);
  }
  let verified;
  if (command === 'pack' && options.has('--out')) {
    verified = await packBrowserUiProject(
      input,
      options.has('--key') ? await loadPublisherKey(options.get('--key')!) : undefined,
    );
    await writeFile(options.get('--out')!, new Uint8Array(await verified.archive.arrayBuffer()), {
      flag: 'wx',
      mode: 0o600,
    });
  } else if (command === 'check' && options.size === 0) {
    const bytes = await readBoundedUiFile(input, BOAA_PACKAGE_LIMITS.archiveBytes);
    verified = await verifyBrowserUiPackage(new Blob([Uint8Array.from(bytes)]));
  } else throw new Error(usage);
  console.log(
    JSON.stringify(
      {
        inspectedOnly: true,
        id: verified.manifest.extension.id,
        version: verified.manifest.extension.version,
        digest: verified.digest,
        publisherFingerprint: verified.publisherFingerprint ?? null,
      },
      null,
      2,
    ),
  );
}
void main().catch((error: unknown) => {
  // Do not echo filesystem contents, plugin text, private keys or raw parse/crypto errors.
  const message = error instanceof Error ? error.message : '';
  console.error(
    message === usage || /^(?:ui_|invalid_|unsupported_|incomplete_|package_|publisher_)[a-z0-9_]+$/.test(message)
      ? message
      : 'ui_package_operation_failed',
  );
  process.exitCode = 1;
});
