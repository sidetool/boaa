import { useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';

/** QR path and copy action for a library address. No credentials in the QR. */
export function useServerAccessLink(url: string) {
  const [message, setMessage] = useState<'copied' | 'select'>();
  const input = useRef<HTMLInputElement>(null);
  const qr = useMemo(() => {
    const value = new URL(url);
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash)
      return undefined;
    const address = value.href;
    if (address.length > 2048) return undefined;
    const code = qrcode(0, 'M');
    code.addData(address);
    code.make();
    const size = code.getModuleCount();
    const pixels = [];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (code.isDark(y, x)) pixels.push(`M${x + 4},${y + 4}h1v1h-1z`);
      }
    return { size: size + 8, path: pixels.join('') };
  }, [url]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage('copied');
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage('select');
    }
  };
  return { qr, copy, message, input };
}
