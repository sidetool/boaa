import { useState } from 'react';
import { extensionIconUrl } from '../../../packages/extension-contracts/extension-icon';
export function ExtensionIcon({ name, iconUrl, className }: { name: string; iconUrl?: string; className?: string }) {
  const [failed, setFailed] = useState<string>();
  const url = extensionIconUrl(iconUrl);
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        width: 40,
        height: 40,
        borderRadius: 12,
        overflow: 'hidden',
        background: `hsl(${hash % 360} 45% 26%)`,
        color: '#fff',
        fontSize: 16,
        fontWeight: 800,
      }}
    >
      {url && failed !== url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(url)}
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: 'var(--un-surface, transparent)' }}
        />
      ) : (
        name.trim().charAt(0).toUpperCase() || '?'
      )}
    </span>
  );
}
