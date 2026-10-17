import { afterEach, expect, it, vi } from 'vitest';
import { archiveImageDimensions } from './archive-image-dimensions';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['load', 'abort', 'error'] as const)(
  'settles metadata on %s without eagerly decoding full pixels',
  async (mode) => {
    class TestImage {
      src = '';
      decoding = '';
      naturalWidth = 800;
      naturalHeight = 12000;
      onload?: (() => void) | null;
      onerror?: ((error: unknown) => void) | null;
      decode = vi.fn();
    }
    const image = new TestImage();
    vi.stubGlobal(
      'Image',
      vi.fn(function () {
        return image;
      }),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const abort = new AbortController();
    const result = archiveImageDimensions(new Blob(), abort.signal);
    if (mode === 'load') {
      image.onload!();
      expect(await result).toEqual({ width: 800, height: 12000 });
    } else if (mode === 'abort') {
      abort.abort();
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    } else {
      image.onerror!(new Error('synthetic decode failure'));
      await expect(result).rejects.toThrow('synthetic decode failure');
    }
    expect(image.decode).not.toHaveBeenCalled();
    expect(image.src).toBe('');
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:synthetic');
  },
);
