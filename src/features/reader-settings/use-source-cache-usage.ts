import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { useEffect, useState } from 'react';
import { readSourceMetadataCacheUsage } from '../../external-sources/local-state';

export type SourceCacheUsage =
  | { status: 'idle' | 'loading' | 'unavailable'; bytes?: undefined; entries?: undefined }
  | { status: 'ready'; bytes: number; entries: number };

export function useSourceCacheUsage(enabled: boolean): SourceCacheUsage {
  const scope = useOptionalAppRuntime()?.readerRuntime.session?.storageScope;
  const [usage, setUsage] = useState<SourceCacheUsage>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setUsage({ status: 'loading' });
    void readSourceMetadataCacheUsage(scope).then(
      (next) => {
        if (active) setUsage({ status: 'ready', ...next });
      },
      () => {
        if (active) setUsage({ status: 'unavailable' });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, scope]);
  return enabled ? usage : { status: 'idle' };
}
