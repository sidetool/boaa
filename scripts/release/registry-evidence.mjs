import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { signedEvidence, verifyFile } from './evidence.mjs';

// Used by the Python registry checker before trusting any reusable CI receipt.
export async function registryEvidence(directory, key) {
  const evidence = signedEvidence(
    await readFile(path.join(directory, 'server-evidence.json')),
    await readFile(path.join(directory, 'server-evidence.json.sig'), 'utf8'),
    key,
  );
  await verifyFile(path.join(directory, 'images.json'), evidence.artifacts['images.json']);
  const images = JSON.parse(await readFile(path.join(directory, 'images.json')));
  const eligible = [];
  for (const arch of ['amd64', 'arm64']) {
    const name = `integration-${arch}.json`;
    await verifyFile(path.join(directory, name), evidence.artifacts[name]);
    const integration = JSON.parse(await readFile(path.join(directory, name)));
    if (integration.commit !== evidence.commit || integration.architecture !== arch || integration.passed !== true)
      throw new Error('registry_integration_invalid');
    for (const row of evidence.images.filter((item) => item.architecture === arch)) {
      if (images[row.component]?.digest !== row.indexDigest) throw new Error('registry_image_index_mismatch');
      const pulls = (integration.pulls || []).filter(
        (pull) => pull.component === row.component && pull.architecture === arch,
      );
      if (pulls.length === 1 && pulls[0].anonymous === true && pulls[0].digest === row.childDigest)
        eligible.push(`${row.component}/${arch}`);
    }
  }
  return eligible;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(
    JSON.stringify(
      await registryEvidence(
        path.resolve(process.argv[2] || 'release'),
        await readFile(new URL('../../deploy/release-public.pub', import.meta.url)),
      ),
    ),
  );
}
