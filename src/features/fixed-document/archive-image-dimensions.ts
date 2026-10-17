import type { ContinuousImageDimensions } from './continuous-scroll';

/** Resolve geometry before displaying a newly loaded image in the episode flow. */
export async function archiveImageDimensions(blob: Blob, signal: AbortSignal): Promise<ContinuousImageDimensions> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = 'async';
  let rejectLoad: (reason: unknown) => void = () => undefined;
  const cancel = () => {
    image.src = '';
    rejectLoad(signal.reason);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // Geometry needs metadata, not an eagerly decoded full-resolution pixel buffer.
    // Browser intrinsic dimensions also preserve EXIF orientation and format support.
    await new Promise<void>((resolve, reject) => {
      rejectLoad = reject;
      image.onload = () => resolve();
      image.onerror = reject;
      image.src = url;
    });
    signal.throwIfAborted();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    signal.removeEventListener('abort', cancel);
    image.onload = image.onerror = null;
    image.src = '';
    URL.revokeObjectURL(url);
  }
}
