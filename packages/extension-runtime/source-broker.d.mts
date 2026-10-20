export interface BrokerAsset {
  bytes: Buffer;
  contentType: string;
}
export type SourceHttpTransport = (
  approved: { url: URL; address: { address: string; family: number } },
  request: { method: string; headers: Record<string, string>; body?: string; response?: 'text' | 'asset' },
  signal: AbortSignal,
) => Promise<{
  status: number;
  headers: Record<string, string | string[]>;
  body: import('node:stream').Readable;
}>;
export function createSourceBroker(
  grants: { origins: readonly string[]; allowDownloads?: boolean },
  transportOptions?: {
    authenticate?: (url: URL, signal: AbortSignal) => Promise<Record<string, string>>;
    lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
    transport?: SourceHttpTransport;
    session?: (
      approved: Parameters<SourceHttpTransport>[0],
      request: Parameters<SourceHttpTransport>[1],
      signal: AbortSignal,
      transport: SourceHttpTransport,
    ) => ReturnType<SourceHttpTransport>;
  },
): {
  methods: Record<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>;
  takeAsset(handle: string): BrokerAsset;
  dispose(): void;
};
