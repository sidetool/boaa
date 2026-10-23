import sharp from 'sharp';
import {
  PLUGIN_IMAGE_BYTES,
  PLUGIN_IMAGE_WIDTH,
  PLUGIN_IMAGE_HEIGHT,
} from '../../../../packages/extension-contracts/plugin-images';
let running = 0;
const waiting: Array<() => void> = [];
/** Bounded static display images. Never return unchecked originals after a decoder failure. */
export async function pluginImageThumbnail(image: { mime: string; data: string }, signal: AbortSignal) {
  signal.throwIfAborted();
  if (running >= 2) {
    if (waiting.length >= 8) throw Error('IMAGE_BUSY');
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        const index = waiting.indexOf(ready);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(ready);
      signal.addEventListener('abort', cancel, { once: true });
    });
  } else running++;
  try {
    signal.throwIfAborted();
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > PLUGIN_IMAGE_BYTES) throw Error('IMAGE_LIMIT');
    const decoder = sharp(bytes, { limitInputPixels: 8_000_000, pages: 1 });
    const metadata = await decoder.metadata();
    signal.throwIfAborted();
    if (
      !['png', 'jpeg', 'webp'].includes(metadata.format ?? '') ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8192 ||
      metadata.height > 8192 ||
      metadata.width * metadata.height > 8_000_000 ||
      (metadata.pages ?? 1) > 1
    )
      throw Error('INVALID_IMAGE');
    const output = await decoder
      .rotate()
      .resize(PLUGIN_IMAGE_WIDTH, PLUGIN_IMAGE_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 1 })
      .timeout({ seconds: 5 })
      .toBuffer({ resolveWithObject: true });
    signal.throwIfAborted();
    if (output.data.length > PLUGIN_IMAGE_BYTES) throw Error('IMAGE_LIMIT');
    return {
      mime: 'image/webp',
      data: output.data.toString('base64'),
      width: output.info.width,
      height: output.info.height,
    };
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}
