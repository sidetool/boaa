import type {
  RemoteFileCreateInput,
  RemoteFileConnectionStatus,
} from '../../../packages/extension-contracts/remote-files';
import { RemoteFileBroker, remoteFileErrors, type RemoteFileFetch } from './remote-file-broker';
import { remoteFileBuiltInSource, remoteFileSourceId } from './remote-file-source';
export const isRemoteFileSourceId = (id: string): boolean => id.startsWith('boaa.external.remote-file.');
export interface RemoteFileAddPort {
  add(input: RemoteFileCreateInput, signal?: AbortSignal): Promise<void>;
}
/** Server-owned named connections. This catalog never writes credentials to browser storage. */
export class RemoteFileManager implements RemoteFileAddPort {
  private lifetime = new AbortController();
  private connections = new Map<string, { status: RemoteFileConnectionStatus; broker: RemoteFileBroker }>();
  private listeners = new Set<() => void>();
  private revision = 0;
  constructor(private readonly fetcher: RemoteFileFetch) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private upsert(status: RemoteFileConnectionStatus) {
    if (!status.connected || !status.id || !status.name || !status.protocol)
      throw new Error('파일 서버 정보를 읽지 못했어요.');
    const id = status.id,
      previous = this.connections.get(id);
    if (previous?.status.generation === status.generation) return;
    previous?.broker.dispose();
    const broker = new RemoteFileBroker(status, this.fetcher, () => {
      this.revision++;
      this.connections.delete(id);
      this.emit();
    });
    this.connections.set(id, { status, broker });
  }
  private async request(action: 'statuses' | 'connect', body?: unknown, signal?: AbortSignal) {
    const combined = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]);
    const response = await this.fetcher(undefined, action, body, combined);
    const result = await response.json();
    combined.throwIfAborted();
    if (!response.ok)
      throw new Error(
        remoteFileErrors[String(result.error).replace(/^remote_files_/, '')] ?? '파일 서버 요청을 완료하지 못했어요.',
      );
    return result;
  }
  async refresh() {
    const revision = this.revision;
    const result = await this.request('statuses');
    if (revision !== this.revision) return;
    const statuses = result.connections as RemoteFileConnectionStatus[];
    const ids = new Set(statuses.map((c) => c.id));
    const changed =
      statuses.length !== this.connections.size ||
      statuses.some((c) => this.connections.get(c.id!)?.status.generation !== c.generation);
    for (const [id, entry] of this.connections)
      if (!ids.has(id)) {
        entry.broker.dispose();
        this.connections.delete(id);
      }
    for (const status of statuses) this.upsert(status);
    this.revision++;
    if (changed) this.emit();
  }
  async add(input: RemoteFileCreateInput, signal?: AbortSignal) {
    const status = (await this.request('connect', input, signal)) as RemoteFileConnectionStatus;
    this.revision++;
    this.upsert(status);
    this.emit();
  }
  sources() {
    return [...this.connections.values()].map((entry) => remoteFileBuiltInSource(entry.status));
  }
  broker(id: string) {
    return [...this.connections.values()].find((entry) => remoteFileSourceId(entry.status.id!) === id)?.broker;
  }
  dispose() {
    this.lifetime.abort();
    for (const entry of this.connections.values()) entry.broker.dispose();
    this.connections.clear();
    this.listeners.clear();
  }
}
