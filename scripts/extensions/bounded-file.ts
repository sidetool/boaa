import { readFile, stat } from 'node:fs/promises';

export async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum) throw new Error('project_file_limit');
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error('project_file_limit');
  return bytes;
}
