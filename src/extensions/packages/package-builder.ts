import { verifyBoaaExtension } from './package-archive';
import { writePackageArchive, type PackageBuildInput } from './package-archive-writer';
export async function buildBoaaExtension(input: PackageBuildInput): Promise<Blob> {
  const archive = await writePackageArchive(input, 'dist/main.js');
  await verifyBoaaExtension(archive);
  return archive;
}
