import type { SourceAuthentication, SourceAuthenticationStatus } from '@boaa/extension-contracts/package';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import { InstalledSourceAuthentication } from './InstalledSourceAuthentication';

const auth: SourceAuthentication = {
  sourceId: 'example.first',
  origin: 'https://example.test',
  label: '테스트 연결',
  scheme: 'basic',
  verification: { path: '/status', field: ['ok'], equals: true },
};

function deferredStatus() {
  let resolve!: (value: SourceAuthenticationStatus) => void;
  const promise = new Promise<SourceAuthenticationStatus>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(initialStatus = Promise.resolve<SourceAuthenticationStatus>({ state: 'missing' })) {
  const authenticate = vi
    .fn<NonNullable<InstalledExtensionManager['authenticate']>>()
    .mockResolvedValue({ state: 'missing' })
    .mockReturnValueOnce(initialStatus);
  const manager = { target: 'device', authenticate } as unknown as InstalledExtensionManager;
  const screen = (source = auth, owner = manager) => (
    <InstalledSourceAuthentication auth={source} manager={owner} disabled={false} />
  );
  let view!: ReactTestRenderer;
  act(() => {
    view = create(screen());
  });
  const fields = () => view.root.findAllByType('input');
  const values = () => fields().map((field) => field.props.value);
  const enter = (username: string, secret: string) =>
    act(() => {
      fields()[0].props.onChange({ target: { value: username } });
      fields()[1].props.onChange({ target: { value: secret } });
    });
  const save = () => view.root.findByType('form').props.onSubmit({ preventDefault() {} });
  return { authenticate, manager, screen, view, values, enter, save };
}

it('keeps unsuccessful credentials for retry and lets a late initial lookup finish without replacing a save result', async () => {
  const lookup = deferredStatus();
  const form = fixture(lookup.promise);
  try {
    form.enter('example-user', 'example-secret');
    form.authenticate.mockRejectedValueOnce(new Error('offline'));
    await act(async () => form.save());
    expect(form.values()).toEqual(['example-user', 'example-secret']);
    expect(form.view.root.findByProps({ role: 'status' }).children[0]).toContain('잠시 후');

    form.authenticate.mockResolvedValueOnce({ state: 'invalid' });
    await act(async () => form.save());
    expect(form.values()).toEqual(['example-user', 'example-secret']);

    form.authenticate.mockResolvedValueOnce({ state: 'saved' });
    const check = form.view.root.findAllByType('button').find((button) => button.children.includes('연결 확인'))!;
    await act(async () => check.props.onClick());
    expect(form.authenticate.mock.lastCall?.[1]).toEqual({ action: 'check' });
    expect(form.values()).toEqual(['example-user', 'example-secret']);

    const save = deferredStatus();
    form.authenticate.mockReturnValueOnce(save.promise);
    act(() => {
      form.save();
      form.save();
    });
    expect(form.authenticate).toHaveBeenCalledTimes(5);
    expect(form.values()).toEqual(['example-user', 'example-secret']);
    expect(form.authenticate.mock.lastCall?.[1]).toEqual({
      action: 'save',
      credential: { username: 'example-user', secret: 'example-secret' },
    });
    await act(async () => save.resolve({ state: 'valid' }));
    expect(form.values()).toEqual(['', '']);
    await act(async () => lookup.resolve({ state: 'missing' }));
    expect(form.view.root.findByProps({ role: 'status' }).children).toContain('인증을 확인했습니다.');
    expect(form.authenticate.mock.calls[0][2]?.aborted).toBe(true);
  } finally {
    act(() => form.view.unmount());
  }
});

it.each(['source', 'manager'] as const)(
  'discards old drafts and ignores late saves after a %s change',
  async (scope) => {
    const form = fixture();
    const oldSave = deferredStatus();
    try {
      await act(async () => {});
      form.enter('first-user', 'first-secret');
      form.authenticate.mockReturnValueOnce(oldSave.promise);
      act(() => form.save());
      const oldSignal = form.authenticate.mock.lastCall?.[2];
      const next =
        scope === 'source'
          ? form.screen({ ...auth, sourceId: 'example.second' })
          : form.screen(auth, { ...form.manager });
      await act(async () => form.view.update(next));
      expect(oldSignal?.aborted).toBe(true);
      expect(form.values()).toEqual(['', '']);
      form.enter('second-user', 'second-secret');
      await act(async () => oldSave.resolve({ state: 'valid' }));
      expect(form.values()).toEqual(['second-user', 'second-secret']);
      expect(form.view.root.findByProps({ role: 'status' }).children).toContain('저장된 연결이 없습니다.');
    } finally {
      act(() => form.view.unmount());
    }
  },
);

it('aborts a pending save on disposal and opens the same source without the disposed draft', async () => {
  const form = fixture();
  const save = deferredStatus();
  await act(async () => {});
  form.enter('closing-user', 'closing-secret');
  form.authenticate.mockReturnValueOnce(save.promise);
  act(() => form.save());
  const signal = form.authenticate.mock.lastCall?.[2];
  act(() => form.view.unmount());
  expect(signal?.aborted).toBe(true);
  let reopened!: ReactTestRenderer;
  try {
    await act(async () => {
      reopened = create(form.screen());
    });
    await act(async () => save.resolve({ state: 'valid' }));
    expect(reopened.root.findAllByType('input').map((input) => input.props.value)).toEqual(['', '']);
    expect(reopened.root.findByProps({ role: 'status' }).children).toContain('저장된 연결이 없습니다.');
  } finally {
    act(() => reopened?.unmount());
  }
});
