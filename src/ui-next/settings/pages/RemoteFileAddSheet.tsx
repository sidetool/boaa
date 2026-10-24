import type { RemoteFileCreateInput, RemoteFileProtocol } from '../../../../packages/extension-contracts/remote-files';
import { LoaderCircle, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { RemoteFileAddPort } from '../../../external-sources/remote-files/remote-file-manager';
import { Sheet } from '../../components/primitives';
import { Notice, PrefChips, PrefField, PrefFold, PrefGroup, PrefSwitch } from '../../components/prefs';

type Values = Record<
  'name' | 'endpoint' | 'username' | 'password' | 'root' | 'privateKey' | 'passphrase' | 'hostKey',
  string
>;

const EMPTY: Values = {
  name: '',
  endpoint: '',
  username: '',
  password: '',
  root: '',
  privateKey: '',
  passphrase: '',
  hostKey: '',
};

const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;

function buildInput(protocol: RemoteFileProtocol, values: Values, allowHttp: boolean): RemoteFileCreateInput {
  const optional = (value: string) => value || undefined;
  return {
    protocol,
    name: values.name.trim(),
    endpoint: values.endpoint.trim(),
    username: values.username,
    password: optional(values.password),
    ...(protocol === 'sftp'
      ? {
          root: optional(values.root.trim()),
          privateKey: optional(values.privateKey),
          passphrase: optional(values.passphrase),
          hostKey: optional(values.hostKey.trim()),
        }
      : { allowHttp: allowHttp ? 'true' : undefined }),
  };
}

/**
 * Adds one named WebDAV or SFTP server. The server tests the connection before saving; secrets live only in
 * this sheet's state and are gone once it closes.
 */
export function RemoteFileAddSheet({ port, onClose }: { port: RemoteFileAddPort; onClose(): void }) {
  const formId = useId();
  const [protocol, setProtocol] = useState<RemoteFileProtocol>('webdav');
  const [values, setValues] = useState<Values>(EMPTY);
  const [allowHttp, setAllowHttp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => pending.current?.abort(), []);

  const sftp = protocol === 'sftp';
  const endpoint = values.endpoint.trim();
  const httpBlocked = !sftp && /^http:\/\//i.test(endpoint) && !allowHttp;
  const hostKey = values.hostKey.trim();
  const hostKeyInvalid = sftp && Boolean(hostKey) && !HOST_KEY.test(hostKey);
  const credentialsMissing = sftp && !values.password && !values.privateKey;

  const set = (key: keyof Values) => (event: { target: { value: string } }) => {
    const { value } = event.target;
    setValues((current) => ({ ...current, [key]: value }));
    setError(undefined);
  };

  const dismiss = () => {
    pending.current?.abort();
    onClose();
  };

  const submit = async () => {
    if (busy || httpBlocked || hostKeyInvalid) return;
    if (credentialsMissing) {
      setError('비밀번호나 SSH 개인키 중 하나는 넣어 주세요.');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await port.add(buildInput(protocol, values, allowHttp), controller.signal);
      if (controller.signal.aborted) return;
      pending.current = null;
      onClose();
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error && reason.message ? reason.message : '서버를 추가하지 못했어요.');
      setBusy(false);
    }
  };

  return (
    <Sheet
      topLayer
      open
      onClose={dismiss}
      title="파일 서버 추가"
      className="un-rfadd-sheet"
      footer={
        <>
          <button type="button" className="un-btn is-ghost" onClick={dismiss}>
            취소
          </button>
          <button
            type="submit"
            form={formId}
            className="un-btn is-primary"
            disabled={busy || httpBlocked || hostKeyInvalid}
          >
            {busy ? <LoaderCircle size={16} className="un-spin" /> : <Plus size={16} />}
            {busy ? '연결 확인 중' : '확인하고 추가'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="un-rfadd"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <PrefChips
          label="서버 종류"
          value={protocol}
          disabled={busy}
          options={[
            { value: 'webdav', label: 'WebDAV' },
            { value: 'sftp', label: 'SFTP' },
          ]}
          onChange={(value) => {
            setProtocol(value);
            setError(undefined);
          }}
        />
        <p className="un-rfadd-lead">
          {sftp
            ? 'SSH로 접속하는 서버예요. 추가하기 전에 한 번 접속해 확인해요.'
            : 'NAS나 클라우드의 WebDAV 주소예요. 추가하기 전에 한 번 접속해 확인해요.'}{' '}
          접속 정보는 BOAA 서버 계정에 암호화해 저장하고, 이 기기에는 남기지 않아요.
        </p>

        <PrefField label="이름" help="목록에 보일 이름이에요.">
          <input
            type="text"
            value={values.name}
            required
            maxLength={80}
            disabled={busy}
            placeholder={sftp ? '집 서버' : '내 NAS'}
            autoComplete="off"
            onChange={set('name')}
          />
        </PrefField>
        <PrefField
          label="주소"
          error={httpBlocked ? 'http 주소는 아래에서 암호화 없는 연결을 허용해야 쓸 수 있어요.' : undefined}
          help={sftp ? '예: sftp://192.168.0.10:22 (포트 생략 시 22)' : '예: https://nas.example.com/dav/books'}
        >
          <input
            type="text"
            inputMode="url"
            value={values.endpoint}
            required
            maxLength={2048}
            disabled={busy}
            placeholder={sftp ? 'sftp://호스트:22' : 'https://주소/경로'}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={set('endpoint')}
          />
        </PrefField>
        <PrefField label="사용자 이름">
          <input
            type="text"
            value={values.username}
            required
            maxLength={256}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={set('username')}
          />
        </PrefField>
        <PrefField label="비밀번호" help={sftp ? '개인키로 접속하면 비워 두세요.' : undefined}>
          <input
            type="password"
            value={values.password}
            maxLength={4096}
            disabled={busy}
            autoComplete="new-password"
            onChange={set('password')}
          />
        </PrefField>

        {sftp ? (
          <>
            <PrefField label="시작 폴더" help="비워 두면 / 에서 시작해요.">
              <input
                type="text"
                value={values.root}
                maxLength={4096}
                disabled={busy}
                placeholder="/books"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={set('root')}
              />
            </PrefField>
            <PrefFold title="SSH 키와 서버 지문" summary="선택">
              <div className="un-rfadd-fold">
                <PrefField label="SSH 개인키" help="키 파일 경로가 아니라 내용을 붙여넣어 주세요.">
                  <textarea
                    value={values.privateKey}
                    maxLength={16384}
                    disabled={busy}
                    rows={4}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={set('privateKey')}
                  />
                </PrefField>
                <PrefField label="개인키 암호">
                  <input
                    type="password"
                    value={values.passphrase}
                    maxLength={4096}
                    disabled={busy}
                    autoComplete="new-password"
                    onChange={set('passphrase')}
                  />
                </PrefField>
                <PrefField
                  label="서버 지문"
                  error={hostKeyInvalid ? 'SHA256: 으로 시작하는 지문 형식이 아니에요.' : undefined}
                  help="비워 두면 첫 연결 때 받은 지문을 저장하고, 다음부터 바뀌면 연결을 멈춰요. 관리자가 알려준 지문을 넣으면 첫 연결부터 확인해요."
                >
                  <input
                    type="text"
                    value={values.hostKey}
                    maxLength={128}
                    disabled={busy}
                    placeholder="SHA256:…"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={set('hostKey')}
                  />
                </PrefField>
              </div>
            </PrefFold>
          </>
        ) : (
          <>
            <PrefGroup>
              <PrefSwitch
                title="암호화 없는 http 주소 허용"
                help="집 안 네트워크처럼 믿을 수 있는 곳에서만 켜세요."
                checked={allowHttp}
                disabled={busy}
                onChange={(on) => {
                  setAllowHttp(on);
                  setError(undefined);
                }}
              />
            </PrefGroup>
            {allowHttp && <Notice tone="warning">http로 연결하면 비밀번호와 파일이 암호화되지 않은 채 오가요.</Notice>}
          </>
        )}

        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Sheet>
  );
}
