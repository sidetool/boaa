import { isTextStream, type SourceReadingPort } from '../../external-sources/source-text-stream';
/** A saved/remote source must never deliver resources into a replaced account owner. */
export function ownedSourceStreamPort(port: SourceReadingPort, assertCurrent: () => void): SourceReadingPort {
  if (isTextStream(port))
    return {
      kind: 'text',
      async open(remoteId, signal, revision) {
        signal.throwIfAborted();
        assertCurrent();
        const result = await port.open(remoteId, signal, revision);
        signal.throwIfAborted();
        assertCurrent();
        return result;
      },
    };
  return {
    async open(remoteId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      assertCurrent();
      const session = await port.open(remoteId, signal);
      try {
        signal.throwIfAborted();
        assertCurrent();
      } catch (error) {
        session.close();
        throw error;
      }
      return {
        initialPosition: session.initialPosition,
        get pageCount() {
          return session.pageCount;
        },
        ...(session.invalidatePage ? { invalidatePage: (index: number) => session.invalidatePage!(index) } : {}),
        async loadPage(index: number, pageSignal: AbortSignal) {
          pageSignal.throwIfAborted();
          assertCurrent();
          const page = await session.loadPage(index, pageSignal);
          pageSignal.throwIfAborted();
          assertCurrent();
          return page;
        },
        close: () => session.close(),
      };
    },
  };
}
