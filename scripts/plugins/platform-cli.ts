import { writeFile } from 'node:fs/promises';
import { BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import { verifyPlatformPackage } from '../../src/extensions/packages/platform-package';
import { loadPublisherKey } from '../extensions/signing';
import { readBoundedUiFile } from './ui-package';
import { packPlatformProject } from './platform-package';
import { verifyPlatformSingleJs } from '../../src/extensions/packages/platform-package';
import { SOURCE_LIMIT } from '../../src/extensions/packages/platform-single-js';
import { initializePlatformProject } from './platform-init';

const usage =
  'Usage: pnpm plugin:platform init <new-folder> --id org.example.plugin --name <name> | pack <prebuilt-folder> --out <new.boaaext> [--key <publisher.pem>] | check <package.boaaext> | check-js <plugin.js>';
async function main() {
  const [command, input, ...rest] = process.argv.slice(2);
  if (!input || input.startsWith('--')) throw new Error(usage);
  const options = new Map<string, string>();
  const allowed = command === 'init' ? ['--id', '--name'] : command === 'pack' ? ['--out', '--key'] : [];
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--') || options.has(rest[i]))
      throw new Error(usage);
    options.set(rest[i], rest[i + 1]);
  }
  if (command === 'init' && options.size === 2) {
    const manifest = await initializePlatformProject(input, options.get('--id')!, options.get('--name')!);
    console.log(
      JSON.stringify({ created: true, id: manifest.extension.id, version: manifest.extension.version }, null, 2),
    );
    return;
  }
  let verified;
  if (command === 'pack' && options.has('--out')) {
    verified = await packPlatformProject(
      input,
      options.has('--key') ? await loadPublisherKey(options.get('--key')!) : undefined,
    );
    await writeFile(options.get('--out')!, new Uint8Array(await verified.archive.arrayBuffer()), {
      flag: 'wx',
      mode: 0o600,
    });
  } else if (command === 'check' && options.size === 0) {
    const bytes = await readBoundedUiFile(input, BOAA_PACKAGE_LIMITS.archiveBytes);
    verified = await verifyPlatformPackage(new Blob([Uint8Array.from(bytes)]));
  } else if (command === 'check-js' && options.size === 0) {
    const bytes = await readBoundedUiFile(input, SOURCE_LIMIT);
    verified = await verifyPlatformSingleJs(new Blob([Uint8Array.from(bytes)]));
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
    message === usage ||
      /^(?:ui_|platform_|undeclared_|invalid_|unsupported_|incomplete_|package_|publisher_)[a-z0-9_]+$/.test(message)
      ? message
      : 'platform_package_operation_failed',
  );
  process.exitCode = 1;
});
