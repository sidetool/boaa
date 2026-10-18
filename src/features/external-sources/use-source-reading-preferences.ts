import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { useEffect, useState } from 'react';
import {
  sourceReadingPreferences,
  sourceReadingPreferenceEvent,
} from '../../external-sources/source-reading-preferences';

/** Apply device setting changes without restarting an active streaming reader. */
export function useSourceReadingPreferences(text = false) {
  const scope = useOptionalAppRuntime()?.readerRuntime.session?.storageScope;
  const [preferences, setPreferences] = useState(() => sourceReadingPreferences(scope));
  useEffect(() => {
    const refresh = () => setPreferences(sourceReadingPreferences(scope));
    window.addEventListener(sourceReadingPreferenceEvent, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(sourceReadingPreferenceEvent, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [scope]);
  return text
    ? { ...preferences, mode: preferences.textMode === 'library' ? ('download' as const) : ('stream' as const) }
    : preferences;
}
