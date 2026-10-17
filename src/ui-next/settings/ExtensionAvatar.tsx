import type { CSSProperties } from 'react';

/** Letter tile with a stable hue per name, so a long list stays scannable without real icons. */
export function ExtensionAvatar({ name }: { name: string }) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span className="un-ext-avatar" style={{ '--un-ext-hue': hash % 360 } as CSSProperties} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
