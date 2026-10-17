import { migrateBrandStorage } from '@boaa/extension-contracts/brand-compat';

/** Runs before module-level preferences are read, including key-enumerating resume migrations. */
for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    const storage = globalThis[name];
    if (storage) migrateBrandStorage(storage);
  } catch {
    // Per-key readers still fall back to the original values in restricted browser contexts.
  }
}
