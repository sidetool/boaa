import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeCommands, type SelectionCapture } from './runtime-commands';
import { validateBrowserUiManifest } from '../../../packages/extension-contracts/ui-package-manifest';
import { uiManifestFixture } from '../../../packages/extension-contracts/ui-test-fixture';
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
function fixture() {
  const authorize = vi.fn(async () => {});
  const send = vi.fn();
  const reader = { key: 'r', bookId: 'b', documentRevision: 'v' };
  const parsed = validateBrowserUiManifest(uiManifestFixture());
  if (!parsed.ok) throw new Error('Invalid test manifest');
  const commands = new RuntimeCommands(
    parsed.manifest,
    's',
    authorize,
    () => true,
    () => reader,
    send,
  );
  commands.register('org.example.wordbook.capture', 'handler');
  disposers.push(() => commands.close());
  const now = Date.now();
  const capture: SelectionCapture = {
    contextKey: 'r',
    selection: {
      schemaVersion: 1,
      text: '선택한 문장',
      textSource: 'original',
      capturedAt: new Date(now).toISOString(),
      location: { schemaVersion: 1, bookId: 'b', documentRevision: 'v', locator: 'opaque' },
    },
  };
  return { commands, authorize, send, capture, now };
}
it.each([-30000, 60000])('does not issue a token for expired or future captures (%s ms)', async (offset) => {
  const f = fixture();
  f.capture.selection.capturedAt = new Date(f.now + offset).toISOString();
  await expect(f.commands.invoke('org.example.wordbook.capture', f.capture)).rejects.toMatchObject({
    code: 'CONTEXT_STALE',
  });
  expect(f.send).not.toHaveBeenCalled();
});
it('includes authorization/lazy-start delay in the capture lifetime', async () => {
  const f = fixture();
  f.authorize.mockImplementation(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(f.now + 30000);
  });
  await expect(f.commands.invoke('org.example.wordbook.capture', f.capture)).rejects.toMatchObject({
    code: 'CONTEXT_STALE',
  });
  expect(f.send).not.toHaveBeenCalled();
});
it('does not renew an almost expired snapshot when an invocation starts', async () => {
  const f = fixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now + 29900);
  const pending = f.commands.invoke('org.example.wordbook.capture', f.capture);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  const message = f.send.mock.calls[0][0];
  vi.spyOn(Date, 'now').mockReturnValue(f.now + 30000);
  expect(() => f.commands.consume(message.selectionToken)).toThrow('CONTEXT_STALE');
  await f.commands.complete({
    wireVersion: 1,
    kind: 'invocationResult',
    sessionId: 's',
    requestId: message.requestId,
    ok: true,
  });
  await rejected;
});
