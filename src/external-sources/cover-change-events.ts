/** Framework-free cover change signal, safe to import from server-bundled source code. */
let revision = 0;
const listeners = new Set<() => void>();
/** Emitted only when background revalidation replaces an existing cover's bytes. */
export function publishCoverChange() {
  revision++;
  listeners.forEach((listener) => listener());
}
export function subscribeCoverChanges(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const coverChangeRevision = () => revision;
