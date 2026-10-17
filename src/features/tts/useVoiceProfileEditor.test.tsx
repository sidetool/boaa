import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useVoiceProfileEditor, type VoiceProfileEditorInput } from './useVoiceProfileEditor';
import { voiceProfilesRevision } from '../../domain/resource-revisions';
import type { VoiceProfile } from '../../domain/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
});
function harness() {
  const profiles = { current: [] as VoiceProfile[] };
  const input: VoiceProfileEditorInput = {
    bookId: 'book-a',
    contentRevision: 'revision-1',
    profiles,
    repository: { saveVoiceProfiles: vi.fn(async () => {}), listVoiceProfiles: vi.fn(async () => []) },
    setProfiles: vi.fn(),
    voices: [{ id: 'one', label: 'Voice one', lang: 'en' }],
    hostedProvider: { providerId: 'synthetic-provider', displayName: 'Synthetic' },
    refreshAfterSave: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    invalidateReadiness: vi.fn(),
    notify: vi.fn(),
  };
  let editor!: ReturnType<typeof useVoiceProfileEditor>;
  function Harness({ value }: { value: VoiceProfileEditorInput }) {
    editor = useVoiceProfileEditor(value);
    return null;
  }
  act(() => {
    renderer = create(<Harness value={input} />);
  });
  return {
    input,
    profiles,
    get editor() {
      return editor;
    },
    update(value: VoiceProfileEditorInput) {
      act(() => renderer!.update(<Harness value={value} />));
    },
  };
}
const narrator = { role: 'narrator' as const, label: 'Narrator' };
it('serializes optimistic writes using each predecessor revision and preserves provider identity', async () => {
  const h = harness();
  const first = deferred<void>();
  vi.mocked(h.input.repository.saveVoiceProfiles).mockImplementationOnce(() => first.promise);
  const one = h.editor.saveSystemVoice(narrator, 'one');
  const firstProfiles = h.profiles.current;
  const two = h.editor.saveHostedVoice(narrator, '  two  ');
  await Promise.resolve();
  await Promise.resolve();
  expect(h.input.repository.saveVoiceProfiles).toHaveBeenCalledTimes(1);
  expect(h.profiles.current.map((p) => p.providerVoiceId)).toEqual(['one', 'two']);
  first.resolve();
  await one;
  await two;
  expect(h.input.repository.saveVoiceProfiles).toHaveBeenNthCalledWith(1, 'book-a', firstProfiles, {
    expectedRevision: voiceProfilesRevision([]),
  });
  expect(h.input.repository.saveVoiceProfiles).toHaveBeenNthCalledWith(2, 'book-a', h.profiles.current, {
    expectedRevision: voiceProfilesRevision(firstProfiles),
  });
  expect(h.input.notify).toHaveBeenCalledTimes(1);
  expect(h.input.reconcile).toHaveBeenCalledTimes(2);
});
it('keeps an in-flight write on its original book but suppresses replacement-book state and followups', async () => {
  const h = harness();
  const write = deferred<void>();
  vi.mocked(h.input.repository.saveVoiceProfiles).mockImplementationOnce(() => write.promise);
  const pending = h.editor.saveSystemVoice(narrator, 'one');
  await Promise.resolve();
  await Promise.resolve();
  h.update({ ...h.input, bookId: 'book-b' });
  h.profiles.current = [];
  write.reject(new Error('offline'));
  await pending;
  expect(h.input.repository.saveVoiceProfiles).toHaveBeenCalledWith('book-a', expect.any(Array), expect.any(Object));
  expect(h.input.repository.listVoiceProfiles).not.toHaveBeenCalled();
  expect(h.input.setProfiles).toHaveBeenCalledTimes(1);
  expect(h.profiles.current).toEqual([]);
  expect(h.input.notify).not.toHaveBeenCalled();
  expect(h.input.reconcile).not.toHaveBeenCalled();
});
it('rechecks ownership after rollback reads and after content revision changes', async () => {
  const h = harness();
  const rollback = deferred<VoiceProfile[]>();
  vi.mocked(h.input.repository.saveVoiceProfiles).mockRejectedValueOnce(new Error('conflict'));
  vi.mocked(h.input.repository.listVoiceProfiles).mockImplementationOnce(() => rollback.promise);
  const pending = h.editor.saveSystemVoice(narrator, 'one');
  await vi.waitFor(() => expect(h.input.repository.listVoiceProfiles).toHaveBeenCalled());
  h.update({ ...h.input, contentRevision: 'revision-2' });
  h.profiles.current = [];
  rollback.resolve([]);
  await pending;
  expect(h.input.setProfiles).toHaveBeenCalledTimes(1);
  expect(h.input.notify).not.toHaveBeenCalled();
});
it('recovers the queue after a failed save and preserves the restored CAS baseline', async () => {
  const h = harness();
  vi.mocked(h.input.repository.saveVoiceProfiles).mockRejectedValueOnce(new Error('conflict'));
  await h.editor.saveSystemVoice(narrator, 'one');
  expect(h.profiles.current).toEqual([]);
  await h.editor.saveHostedVoice(narrator, 'two');
  expect(h.input.repository.saveVoiceProfiles).toHaveBeenLastCalledWith('book-a', h.profiles.current, {
    expectedRevision: voiceProfilesRevision([]),
  });
  expect(h.profiles.current[0].providerVoiceId).toBe('two');
});
it('does not publish completion or start reconciliation after unmount', async () => {
  const h = harness();
  const write = deferred<void>();
  vi.mocked(h.input.repository.saveVoiceProfiles).mockImplementationOnce(() => write.promise);
  const pending = h.editor.saveSystemVoice(narrator, 'one');
  await Promise.resolve();
  await Promise.resolve();
  act(() => renderer!.unmount());
  renderer = undefined;
  write.resolve();
  await pending;
  expect(h.input.refreshAfterSave).not.toHaveBeenCalled();
  expect(h.input.reconcile).not.toHaveBeenCalled();
  expect(h.input.notify).not.toHaveBeenCalled();
});
it('preserves hosted options and treats repeating a saved choice as a no-op', async () => {
  const h = harness();
  await h.editor.saveHostedVoice(narrator, 'two');
  await h.editor.saveHostedOption(narrator, { optionKey: 'temperature', valueType: 'number' }, 0.5);
  expect(h.profiles.current[0].providerOptions).toEqual({ temperature: 0.5 });
  expect(h.profiles.current[0].providerVoiceId).toBe('two');
  const count = vi.mocked(h.input.repository.saveVoiceProfiles).mock.calls.length;
  await h.editor.saveHostedVoice(narrator, 'two');
  expect(h.input.repository.saveVoiceProfiles).toHaveBeenCalledTimes(count);
});
it('rejects an action retained from a previous book generation', async () => {
  const h = harness();
  const old = h.editor;
  h.update({ ...h.input, bookId: 'book-b' });
  await old.saveSystemVoice(narrator, 'one');
  expect(h.input.repository.saveVoiceProfiles).not.toHaveBeenCalled();
  expect(h.input.setProfiles).not.toHaveBeenCalled();
});
