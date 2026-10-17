import { useEffect, useMemo, useRef } from 'react';

import type {
  ExternalSourceLibraryWork,
  UseExternalSourceControllerOptions,
} from './external-source-controller-contract';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { createSourceWorkMetadataLoader, sourceWorkMetadata } from './source-work-metadata';

/** Adds titleUnknown and a lazy requestMetadata command. No request happens until a visible adapter asks. */
export function useSourceWorkMetadata(
  works: readonly ExternalSourceLibraryWork[],
  options: UseExternalSourceControllerOptions,
  publish: (record: ExternalSourceSubscriptionRecord) => void,
) {
  const latest = useRef({ options, publish });
  latest.current = { options, publish };
  const loader = useMemo(
    () => ({
      owner: {
        state: options.state,
        settingsScope: options.settingsScope,
        extensionRevision: options.extensionRevision,
        registry: options.registry,
      },
      current: undefined as ReturnType<typeof createSourceWorkMetadataLoader> | undefined,
    }),
    [options.state, options.settingsScope, options.extensionRevision, options.registry],
  );
  useEffect(
    () => () => {
      loader.current?.dispose();
      loader.current = undefined;
    },
    [loader],
  );
  return useMemo(
    () =>
      works.map((work) => {
        const metadata = sourceWorkMetadata(work);
        return {
          ...work,
          ...metadata,
          requestMetadata: metadata.titleUnknown
            ? () =>
                (loader.current ??= createSourceWorkMetadataLoader(
                  { ...latest.current.options, ...loader.owner },
                  (record) => latest.current.publish(record),
                )).request(work)
            : undefined,
        };
      }),
    [works, loader],
  );
}
