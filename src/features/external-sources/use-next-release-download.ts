import { readBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { useEffect, useRef, useState } from 'react';

const KEY = 'boaa.next-release-download.v1';
const COUNT_KEY = 'boaa.next-release-download-count.v1';
export type NextReleaseCount = 1 | 2 | 3;

/** One attempt per reading section. A commit must never start a chain of downloads. */
export function useNextReleaseDownload(input: {
  policy?: import('../../domain/types').DownloadPolicy;
  updatePolicy?: (patch: Partial<import('../../domain/types').DownloadPolicy>) => void;
  readingKey?: string;
  /** Replacing the authenticated storage owner retires only metadata preparation. */
  scope?: unknown;
  busy: boolean;
  run(signal: AbortSignal, count: NextReleaseCount): Promise<void>;
  reportError(): void;
}) {
  const [localEnabled, setEnabled] = useState(() => {
    try {
      return readBrandStorage(localStorage, KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [localCount, updateCount] = useState<NextReleaseCount>(() => {
    try {
      const value = Number(readBrandStorage(localStorage, COUNT_KEY));
      return value === 2 || value === 3 ? value : 1;
    } catch {
      return 1;
    }
  });
  const enabled = input.policy?.autoNext ?? localEnabled;
  const count = input.policy?.nextCount ?? localCount;
  const latest = useRef(input);
  latest.current = input;
  const attempted = useRef<string>();
  const running = useRef(false);
  const activeAbort = useRef<AbortController>();
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    attempted.current = undefined;
    return () => activeAbort.current?.abort();
  }, [enabled, count, input.readingKey, input.scope]);
  useEffect(() => {
    if (!enabled || !input.readingKey) {
      attempted.current = undefined;
      return;
    }
    if (input.busy || running.current || attempted.current === input.readingKey) return;
    const abort = new AbortController();
    activeAbort.current = abort;
    const key = input.readingKey;
    attempted.current = key;
    running.current = true;
    const request = latest.current;
    void request
      .run(abort.signal, count)
      .catch(() => {
        if (!abort.signal.aborted) request.reportError();
      })
      .finally(() => {
        running.current = false;
        setSettled((value) => value + 1);
      });
  }, [enabled, count, input.readingKey, input.busy, settled, input.scope]);
  return {
    enabled,
    count,
    setCount(value: NextReleaseCount) {
      if (![1, 2, 3].includes(value)) return;
      if (input.updatePolicy) {
        input.updatePolicy({ nextCount: value });
        return;
      }
      try {
        writeBrandStorage(localStorage, COUNT_KEY, String(value));
      } catch {
        /* session preference */
      }
      updateCount(value);
    },
    setEnabled(value: boolean) {
      if (input.updatePolicy) {
        input.updatePolicy({ autoNext: value });
        return;
      }
      try {
        writeBrandStorage(localStorage, KEY, String(value));
      } catch {
        /* session preference still works */
      }
      setEnabled(value);
    },
  };
}
