import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { SelfHostAccountGate, useOptionalSelfHostAuth } from './SelfHostAccountGate';
import { SelfHostAuthClient } from './self-host-auth-client';
import { loadSharedParagraphPage } from '../reader/shared-paragraph-pages';
import {
  SELF_HOST_AUTH_ENDING_EVENT,
  SELF_HOST_AUTH_REQUIRED_EVENT,
} from '../../services/remote/self-host-auth-events';
import type { ReaderRuntime } from '../../repositories/reader-runtime';
import type { ParagraphPage } from '../../domain/types';

vi.mock('../../external-sources/local-state', () => ({ clearSourceMetadataCache: vi.fn(async () => {}) }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const page = (text: string) => ({ paragraphs: [{ index: 1, text }] }) as ParagraphPage;

it.each(['logout', 'expired'] as const)(
  'discards cached and pending body pages across %s and reauthentication',
  async (boundary) => {
    const events = new EventTarget();
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
    vi.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
    const account = { username: 'fixture', displayName: 'Fixture' };
    vi.spyOn(SelfHostAuthClient.prototype, 'status').mockResolvedValue({
      authenticated: true,
      account,
      setupRequired: false,
      legacyRecoveryEnabled: false,
      setupCodeRequired: false,
    });
    vi.spyOn(SelfHostAuthClient.prototype, 'login').mockResolvedValue(account);
    vi.spyOn(SelfHostAuthClient.prototype, 'logout').mockImplementation(async () => {
      dispatchEvent(new Event(SELF_HOST_AUTH_ENDING_EVENT));
    });
    let resolveOld!: (value: ParagraphPage) => void;
    const loader = vi.fn().mockResolvedValue(page('old'));
    const repository = { getParagraphPage: loader };
    const runtime = { mode: 'remote', apiBaseUrl: '/api', readerRepository: repository } as unknown as ReaderRuntime;
    let auth!: ReturnType<typeof useOptionalSelfHostAuth>;
    function Probe() {
      auth = useOptionalSelfHostAuth();
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <SelfHostAccountGate runtime={runtime}>
          <Probe />
        </SelfHostAccountGate>,
      );
    });
    try {
      await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0);
      loader.mockImplementationOnce(
        () =>
          new Promise<ParagraphPage>((resolve) => {
            resolveOld = resolve;
          }),
      );
      const oldPending = loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 1);
      const rejectedOld = expect(oldPending).rejects.toThrow('Reader session changed');
      await act(async () => {
        if (boundary === 'logout') await auth!.logout();
        else dispatchEvent(new Event(SELF_HOST_AUTH_REQUIRED_EVENT));
      });
      await act(async () => {
        await import('../../ui-next/auth/UiNextAuthScreen');
      });
      loader.mockResolvedValue(page('new'));
      // A load during the login screen must also be discarded when login succeeds.
      await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0);
      loader.mockResolvedValue(page('reauthenticated'));
      await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      const fresh = await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0);
      expect(fresh?.paragraphs[0].text).toBe('reauthenticated');
      resolveOld(page('late old'));
      await rejectedOld;
      expect(
        (await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 1))?.paragraphs[0]
          .text,
      ).toBe('reauthenticated');
      expect(await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0)).toBe(fresh);
      expect(loader).toHaveBeenCalledTimes(5);
    } finally {
      await act(async () => renderer.unmount());
    }
    const stable = await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0);
    dispatchEvent(new Event(SELF_HOST_AUTH_ENDING_EVENT));
    expect(await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0)).toBe(stable);
    expect(loader).toHaveBeenCalledTimes(5); // Gate removed both auth listeners.
  },
);
