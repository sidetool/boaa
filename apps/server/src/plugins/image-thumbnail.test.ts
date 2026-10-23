import { expect, it } from 'vitest';
import sharp from 'sharp';
import { pluginImageThumbnail } from './image-thumbnail';
const signal = () => new AbortController().signal;
const input = (bytes: Buffer) => ({ mime: 'image/png', data: bytes.toString('base64') });
it('decodes and bounds raster dimensions, strips metadata and returns a real static thumbnail', async () => {
  const bytes = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  const output = await pluginImageThumbnail(input(bytes), signal());
  expect(output).toMatchObject({ mime: 'image/webp', width: 320, height: 480 });
  const decoded = await sharp(Buffer.from(output.data, 'base64')).metadata();
  expect(decoded.format).toBe('webp');
  expect(decoded.exif).toBeUndefined();
  expect(decoded.pages ?? 1).toBe(1);
});
it('does not upscale small images', async () => {
  const bytes = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  expect(await pluginImageThumbnail(input(bytes), signal())).toMatchObject({ width: 20, height: 30 });
});
it('rejects compressed byte overflow, corrupt bytes, excessive dimensions and decoded pixel bombs', async () => {
  await expect(pluginImageThumbnail(input(Buffer.alloc(512 * 1024 + 1)), signal())).rejects.toThrow('IMAGE_LIMIT');
  await expect(pluginImageThumbnail(input(Buffer.from('not an image')), signal())).rejects.toThrow();
  for (const [width, height] of [
    [8193, 1],
    [3000, 3000],
  ]) {
    const bytes = await sharp({ create: { width, height, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    await expect(pluginImageThumbnail(input(bytes), signal())).rejects.toThrow();
  }
});
it('honors preabort and remains usable after decoder failures', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(pluginImageThumbnail(input(Buffer.alloc(1)), abort.signal)).rejects.toThrow();
  await Promise.all(
    Array.from({ length: 8 }, () => pluginImageThumbnail(input(Buffer.alloc(1)), signal()).catch(() => {})),
  );
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  expect(await pluginImageThumbnail(input(bytes), signal())).toMatchObject({ width: 1, height: 1 });
});
