import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteFileAddPort } from '../../../external-sources/remote-files/remote-file-manager';
import { RemoteFileAddSheet } from './RemoteFileAddSheet';

// Sheets portal to document.body; render inline so the form can be driven here.
vi.mock('../../components/primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/primitives')>()),
  Sheet: (props: { children: ReactNode; footer?: ReactNode; onClose(): void }) => (
    <div>
      {props.children}
      {props.footer}
      <button type="button" data-dismiss onClick={props.onClose} />
    </div>
  ),
}));

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function mount(port: RemoteFileAddPort, onClose = vi.fn()) {
  act(() => {
    renderer = create(<RemoteFileAddSheet port={port} onClose={onClose} />);
  });
  const root = renderer!.root;
  const fields = () => root.findAll((node) => node.type === 'input' || node.type === 'textarea');
  const type = (index: number, value: string) => act(() => fields()[index].props.onChange({ target: { value } }));
  const submit = async () => {
    await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }));
  };
  const button = (match: (node: { props: Record<string, unknown> }) => boolean) =>
    root.find((node) => node.type === 'button' && match(node));
  return { root, onClose, type, submit, button };
}

it('sends a WebDAV payload with http only after explicit opt-in', async () => {
  const add = vi.fn<RemoteFileAddPort['add']>().mockResolvedValue();
  const view = mount({ add });
  view.type(0, ' 내 NAS ');
  view.type(1, 'http://192.168.0.2/dav');
  view.type(2, 'me');
  view.type(3, 'pw');
  await view.submit();
  expect(add).not.toHaveBeenCalled();

  act(() => view.button((node) => node.props.role === 'switch').props.onClick());
  await view.submit();
  expect(add).toHaveBeenCalledWith(
    {
      protocol: 'webdav',
      name: '내 NAS',
      endpoint: 'http://192.168.0.2/dav',
      username: 'me',
      password: 'pw',
      allowHttp: 'true',
    },
    expect.any(AbortSignal),
  );
  expect(view.onClose).toHaveBeenCalledTimes(1);
});

it('keeps SFTP-only fields out of WebDAV and shows a rejected add', async () => {
  const add = vi.fn<RemoteFileAddPort['add']>().mockRejectedValue(new Error('서버에 접속하지 못했어요.'));
  const view = mount({ add });
  act(() => view.button((node) => node.props.children === 'SFTP').props.onClick());
  view.type(0, '집 서버');
  view.type(1, 'sftp://host');
  view.type(2, 'me');
  await view.submit();
  expect(add).not.toHaveBeenCalled();

  view.type(5, '-----BEGIN KEY-----');
  await view.submit();
  expect(add.mock.calls[0][0]).toEqual({
    protocol: 'sftp',
    name: '집 서버',
    endpoint: 'sftp://host',
    username: 'me',
    privateKey: '-----BEGIN KEY-----',
  });
  expect(view.onClose).not.toHaveBeenCalled();
  const notices = view.root.findAll((node) => node.props.className === 'un-notice-text');
  expect(notices.map((node) => node.props.children)).toContain('서버에 접속하지 못했어요.');
});

it('aborts a pending add when dismissed', async () => {
  let signal: AbortSignal | undefined;
  const add = vi.fn<RemoteFileAddPort['add']>((_, s) => {
    signal = s;
    return new Promise(() => undefined);
  });
  const view = mount({ add });
  view.type(0, 'a');
  view.type(1, 'https://host/dav');
  view.type(2, 'me');
  void view.submit();
  await act(async () => undefined);
  act(() => view.button((node) => node.props['data-dismiss'] === true).props.onClick());
  expect(signal?.aborted).toBe(true);
  expect(view.onClose).toHaveBeenCalledTimes(1);
});
