import {
  REMOTE_FILE_MAX_BYTES,
  remoteFilePath,
  type RemoteFileConnectionStatus,
  type RemoteFilePage,
} from '../../../packages/extension-contracts/remote-files';
import type {
  ExternalSourceBroker,
  ExternalSourceConnectionForm,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
  ExternalItemPage,
} from '../contracts';
import { remoteFileSourceId } from './remote-file-source';
export type RemoteFileFetch = (
  id: string | undefined,
  action: 'statuses' | 'status' | 'connect' | 'update' | 'disconnect' | 'list' | 'download',
  body: unknown,
  signal: AbortSignal,
) => Promise<Response>;
export const remoteFileErrors: Record<string, string> = {
  connection_limit: '파일 서버는 계정당 최대 16개까지 등록할 수 있어요.',
  invalid_connection: '서버 주소와 계정 정보를 확인해 주세요.',
  invalid_path: '설정한 폴더 안의 경로만 열 수 있어요.',
  invalid_host: '이 주소는 파일 서버로 사용할 수 없어요.',
  https_required: 'HTTPS 주소를 입력하거나, HTTP 사용을 직접 허용해 주세요.',
  credentials_required: '비밀번호 또는 SSH 개인키를 입력해 주세요.',
  authentication: '사용자 이름·비밀번호와 읽기 권한을 확인해 주세요.',
  host_key_changed:
    '저장한 SSH 서버 지문과 달라 연결을 중단했어요. 서버가 바뀐 것이 맞는지 확인한 뒤 연결을 해제하고 다시 등록해 주세요.',
  invalid_host_key: '서버 지문은 SHA256: 형식으로 입력해 주세요.',
  not_found: '폴더나 파일을 찾지 못했어요.',
  not_directory: '시작 경로에 파일이 아닌 폴더를 지정해 주세요.',
  redirect: '리디렉션되지 않는 WebDAV 폴더 주소를 입력해 주세요.',
  listing_limit: '폴더가 5만 항목 또는 목록 용량 한도를 넘었어요. 하위 폴더로 나누어 열어 주세요.',
  listing_expired: '보관한 폴더 목록이 만료됐어요. 새로고침해 주세요.',
  invalid_response: '서버의 폴더 응답을 읽지 못했어요.',
  timeout: '서버 응답 시간이 초과됐어요. 주소와 네트워크를 확인해 주세요.',
  size_limit: '파일은 최대 512MB까지 가져올 수 있어요.',
  connection_changed: '다른 곳에서 연결 설정이 바뀌었어요. 소스 화면을 다시 열어 주세요.',
  not_connected: '먼저 서버를 연결해 주세요.',
  busy: '다른 파일 요청을 처리하고 있어요. 잠시 후 다시 시도해 주세요.',
  unsupported_file: '이 파일 형식은 가져올 수 없어요.',
  unavailable: '서버에 연결하지 못했어요. 주소·인증 정보·TLS 인증서를 확인해 주세요.',
  upstream: '파일 서버가 요청을 처리하지 못했어요.',
};
export class RemoteFileBroker implements ExternalSourceBroker {
  private saved: RemoteFileConnectionStatus;
  private readonly lifetime = new AbortController();
  private form: ExternalSourceConnectionForm;
  private ready = true;
  constructor(
    saved: RemoteFileConnectionStatus,
    private readonly fetcher: RemoteFileFetch,
    private readonly removed: () => void = () => undefined,
  ) {
    this.saved = saved;
    this.form = this.makeForm();
  }
  dispose() {
    this.lifetime.abort();
    this.saved = { connected: false };
  }
  private signal(signal?: AbortSignal, download = false, listing = false) {
    return AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(download ? 300_000 : listing ? 125_000 : 35_000),
      ...(signal ? [signal] : []),
    ]);
  }
  private async request(action: Parameters<RemoteFileFetch>[1], body?: unknown, signal?: AbortSignal) {
    if (!this.fetcher) throw new Error('BOAA 서버에 연결한 뒤 사용할 수 있어요.');
    const response = await this.fetcher(
      this.saved.id,
      action,
      body,
      this.signal(signal, action === 'download', action === 'list'),
    );
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(
        remoteFileErrors[String(value.error).replace(/^remote_files_/, '')] ?? '파일 서버 요청을 완료하지 못했어요.',
      );
    }
    return response;
  }
  async initialize() {
    if (!this.fetcher) return;
    try {
      this.saved = await (await this.request('status')).json();
    } finally {
      this.ready = true;
      this.form = this.makeForm();
    }
  }
  status(): ExternalSourceConnectionStatus {
    if (!this.fetcher) return { state: 'unavailable', reason: 'BOAA 서버에 연결하면 사용할 수 있어요.' };
    return {
      state: this.saved.connected ? 'connected' : 'disconnected',
      scope: 'server',
      accountConnectionId: this.saved.id,
      connectionGeneration: this.saved.generation,
      label: this.saved.endpoint,
      reason: !this.ready ? '연결 정보를 확인하는 중이에요.' : undefined,
    };
  }
  connectionForm() {
    return this.form;
  }
  private makeForm(): ExternalSourceConnectionForm {
    const sftp = this.saved.protocol === 'sftp';
    return {
      submitLabel: '연결하고 저장',
      help: sftp
        ? '연결 정보는 BOAA 서버에 암호화해 저장해요. 첫 연결의 SSH 서버 지문을 기억하며, 이후 지문이 달라지면 연결을 차단해요. 파일은 읽기만 해요.'
        : 'WebDAV 폴더 주소를 입력해 주세요. 연결 정보는 BOAA 서버에 암호화해 저장하고, 파일은 읽기만 해요.',
      fields: [
        {
          id: 'endpoint',
          label: sftp ? 'SFTP 서버 주소' : 'WebDAV 폴더 주소',
          type: 'text',
          required: true,
          placeholder: sftp ? 'sftp://nas.local:22' : 'https://nas.example.com/dav/books/',
          defaultValue: this.saved.endpoint,
        },
        { id: 'username', label: '사용자 이름', type: 'text', required: true, defaultValue: this.saved.username },
        {
          id: 'password',
          label: '비밀번호',
          type: 'password',
          help: sftp ? '개인키로 접속하면 비워 두세요.' : undefined,
        },
        ...(sftp
          ? [
              {
                id: 'root',
                label: '시작 폴더',
                type: 'text' as const,
                placeholder: '/books',
                defaultValue: this.saved.root ?? '/',
              },
              {
                id: 'privateKey',
                label: 'SSH 개인키 (선택)',
                type: 'textarea' as const,
                placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
                help: '서버 파일 경로 대신 개인키 내용을 붙여넣어 주세요.',
              },
              { id: 'passphrase', label: '개인키 암호 (선택)', type: 'password' as const },
              {
                id: 'hostKey',
                label: '서버 지문 (선택)',
                type: 'text' as const,
                placeholder: 'SHA256:…',
                defaultValue: this.saved.hostKey,
                help: '서버 관리자가 알려준 지문이 있으면 입력해 첫 연결부터 확인할 수 있어요.',
              },
            ]
          : [
              {
                id: 'allowHttp',
                label: '연결 보안',
                type: 'select' as const,
                defaultValue: this.saved.endpoint?.startsWith('http:') ? 'true' : 'false',
                options: [
                  { value: 'false', label: 'HTTPS만 사용 (권장)' },
                  { value: 'true', label: 'HTTP도 허용 — 암호화되지 않음' },
                ],
              },
            ]),
      ],
    };
  }
  async connect(input?: ExternalSourceConnectionInput) {
    this.saved = await (
      await this.request('update', { ...input, name: this.saved.name, protocol: this.saved.protocol })
    ).json();
    this.ready = true;
    this.form = this.makeForm();
  }
  async disconnect() {
    await this.request('disconnect');
    this.removed();
    this.dispose();
    this.form = this.makeForm();
  }
  private assertConnection(id?: string) {
    if (!this.saved.connected || (id && id !== this.saved.id)) throw new Error(remoteFileErrors.connection_changed);
  }
  async list(input: ExternalSourceListInput, signal: AbortSignal): Promise<ExternalItemPage> {
    this.assertConnection(input.accountConnectionId);
    const generation = this.saved.generation;
    const page: RemoteFilePage = await (
      await this.request(
        'list',
        {
          path: input.parentRef ?? '/',
          query: input.query,
          cursor: input.cursor,
          generation,
          ...(input.cacheMode === 'reload' && !input.cursor ? { reload: true } : {}),
        },
        signal,
      )
    ).json();
    signal.throwIfAborted();
    if (generation !== this.saved.generation) throw new Error(remoteFileErrors.connection_changed);
    return {
      items: page.entries.map((e) => ({
        key: { connectorId: remoteFileSourceId(this.saved.id!), accountConnectionId: this.saved.id, remoteId: e.path },
        kind: e.directory ? 'folder' : 'file',
        title: e.name,
        navigationRef: e.directory ? e.path : undefined,
        byteLength: e.directory ? undefined : e.size,
        updatedAt: e.modified,
        remoteRevision: e.revision,
        importability: e.directory ? 'unsupported' : 'supported',
        formatHint: e.name.split('.').pop()?.toLowerCase(),
      })),
      nextCursor: page.nextCursor,
    };
  }
  async download(ref: ExternalSourceDownloadRef, signal: AbortSignal) {
    this.assertConnection(ref.key.accountConnectionId);
    if (ref.key.connectorId !== remoteFileSourceId(this.saved.id!)) throw new Error(remoteFileErrors.invalid_path);
    const generation = this.saved.generation,
      path = remoteFilePath(ref.key.remoteId),
      requestSignal = this.signal(signal, true);
    if (ref.context?.connectionGeneration && ref.context.connectionGeneration !== generation)
      throw new Error(remoteFileErrors.connection_changed);
    const response = await this.request('download', { path, generation }, requestSignal);
    if (!response.body) throw new Error(remoteFileErrors.unavailable);
    const reader = response.body.getReader(),
      chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    requestSignal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        requestSignal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > Math.min(REMOTE_FILE_MAX_BYTES, ref.context?.maxBytes ?? REMOTE_FILE_MAX_BYTES))
          throw new Error(remoteFileErrors.size_limit);
        chunks.push(new Uint8Array(part.value));
      }
      requestSignal.throwIfAborted();
      if (generation !== this.saved.generation) throw new Error(remoteFileErrors.connection_changed);
      return { file: new File(chunks, path.split('/').pop()!) };
    } finally {
      requestSignal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
