import { StrictMode, useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCatalogItem, ProviderSecretStatus } from '../../providers/provider-jobs';
import type { ProviderSettingsDraft } from '../../providers/provider-settings-ui';
import ProviderSettingsPanel, { type ProviderSettingsPanelController } from './ProviderSettingsPanel';

const KEY = 'tts_synthesis:gemini-vertex-tts:service_account_json';
const VALID = JSON.stringify({
  type: 'service_account',
  project_id: 'boaa-tts',
  client_email: 'tts@boaa-tts.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n',
});

const provider = (providerId: string): ProviderCatalogItem =>
  ({
    providerId,
    displayName: providerId,
    kind: 'hosted_tts',
    executionTarget: 'server',
    secretPolicy: 'server_secret_required',
    implemented: true,
    enabled: true,
    secretConfigured: false,
    models: [],
    capabilities: {},
  }) as unknown as ProviderCatalogItem;
const status = (providerId: string, configured = false): ProviderSecretStatus => ({
  scope: 'tts_synthesis',
  providerId,
  secretName: 'service_account_json',
  configured,
  source: configured ? 'user_encrypted' : undefined,
});
const draft: ProviderSettingsDraft = {
  scope: 'tts_synthesis',
  defaultProviderId: 'gemini-vertex-tts',
  enabledProviderIds: ['gemini-vertex-tts'],
  selectedProviderId: 'gemini-vertex-tts',
  modelByProvider: {},
  providerOptionsTextByProvider: {},
};

function controller(overrides: Partial<ProviderSettingsPanelController> = {}): ProviderSettingsPanelController {
  return {
    available: true,
    loading: false,
    secretStatuses: [status('gemini-vertex-tts'), status('google-cloud-tts')],
    secretDrafts: {},
    desktopMode: false,
    analysisRunning: false,
    hostedTTSBusy: false,
    updateDraft: vi.fn(),
    updateSecretDraft: vi.fn(),
    refresh: vi.fn(),
    saveSettings: vi.fn(),
    saveSecret: vi.fn(),
    deleteSecret: vi.fn(),
    testSecret: vi.fn(),
    runDesktopLLMSample: vi.fn(),
    playDesktopTTSSample: vi.fn(),
    ...overrides,
  };
}

// Keeps drafts in state like the real controller so the panel sees its own picks.
function Harness({ base }: { base: ProviderSettingsPanelController }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const updateSecretDraft = (key: string, value: string) => {
    (base.updateSecretDraft as (key: string, value: string) => void)(key, value);
    setDrafts((current) => ({ ...current, [key]: value }));
  };
  return (
    <ProviderSettingsPanel
      scope="tts_synthesis"
      title="TTS 엔진"
      providers={[provider('gemini-vertex-tts'), provider('google-cloud-tts')]}
      draft={draft}
      controller={{ ...base, secretDrafts: drafts, updateSecretDraft }}
    />
  );
}

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function mount(base = controller()) {
  act(() => {
    renderer = create(<Harness base={base} />);
  });
  return { root: renderer!.root, base };
}
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
const jsonControl = (root: ReactTestInstance) =>
  root.find(
    (node) =>
      node.props.className === 'provider-secret-control' &&
      node.findAllByProps({ 'aria-label': '서비스 계정 JSON 파일' }).length > 0,
  );
const button = (root: ReactTestInstance, label: string) =>
  jsonControl(root).find((node) => node.type === 'button' && text(node).trim() === label);
const fileInput = (root: ReactTestInstance) => root.findByProps({ 'aria-label': '서비스 계정 JSON 파일' });
async function pick(root: ReactTestInstance, body: string, size = body.length) {
  const target = { value: 'C:\\fakepath\\key.json', files: [{ name: 'key.json', size, text: async () => body }] };
  await act(async () => fileInput(root).props.onChange({ currentTarget: target }));
  expect(target.value).toBe('');
}

describe('ProviderSettingsPanel service account JSON', () => {
  it.each([
    ['desktop builds', controller({ desktopMode: true })],
    ['servers without the status', controller({ secretStatuses: [] })],
  ])('hides the JSON upload for %s', (_, base) => {
    const { root } = mount(base);
    expect(root.findAllByProps({ 'aria-label': '서비스 계정 JSON 파일' })).toHaveLength(0);
  });

  it('keeps a valid file only as an in-memory draft and saves it under service_account_json', async () => {
    const { root, base } = mount();
    expect(button(root, '저장').props.disabled).toBe(true);
    await pick(root, VALID);
    expect(base.updateSecretDraft).toHaveBeenLastCalledWith(KEY, VALID);
    const shown = text(root);
    expect(shown).toContain('key.json · project boaa-tts');
    expect(shown).not.toContain('PRIVATE KEY');
    expect(shown).not.toContain('tts@boaa-tts');
    expect(shown).toContain('IAM 권한이나 실제 합성 성공을 뜻하지 않습니다');
    act(() => button(root, '저장').props.onClick());
    expect(base.saveSecret).toHaveBeenCalledExactlyOnceWith(
      'tts_synthesis',
      'gemini-vertex-tts',
      'service_account_json',
    );
    act(() => button(root, '취소').props.onClick());
    expect(base.updateSecretDraft).toHaveBeenLastCalledWith(KEY, '');
    expect(button(root, '저장').props.disabled).toBe(true);
  });

  it.each([
    ['oversized', VALID, 64 * 1024 + 1, '64KiB'],
    ['non-JSON', 'not json', undefined, 'JSON 형식이 아닙니다'],
    ['non service account', JSON.stringify({ type: 'authorized_user' }), undefined, 'service_account'],
    [
      'incomplete',
      JSON.stringify({ type: 'service_account', project_id: 'p', client_email: 'e' }),
      undefined,
      'private_key',
    ],
  ] as const)('rejects an %s file without drafting it', async (_, body, size, message) => {
    const { root, base } = mount();
    await pick(root, body, size);
    expect(text(root)).toContain(message);
    expect(base.updateSecretDraft).not.toHaveBeenCalledWith(KEY, body);
    expect(button(root, '저장').props.disabled).toBe(true);
  });

  it('clears the draft when the panel closes', async () => {
    const { root, base } = mount();
    await pick(root, VALID);
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(base.updateSecretDraft).toHaveBeenLastCalledWith(KEY, '');
  });

  const deferred = () => {
    let resolve!: (body: string) => void;
    let reject!: (error: Error) => void;
    const text = () =>
      new Promise<string>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
    return { text, resolve: (body: string) => resolve(body), reject: (error: Error) => reject(error) };
  };
  const startPick = (root: ReactTestInstance, name: string, text: () => Promise<string>) => {
    let done!: Promise<void>;
    act(() => {
      done = fileInput(root).props.onChange({ currentTarget: { value: '', files: [{ name, size: 10, text }] } });
    });
    return done;
  };

  it('drops a late read after a newer pick or panel close', async () => {
    const { root, base } = mount();
    const first = deferred();
    const firstDone = startPick(root, 'late.json', first.text);
    // A newer pick (here an invalid one) invalidates the pending read.
    await pick(root, 'not json');
    await act(async () => {
      first.resolve(VALID);
      await firstDone;
    });
    expect(base.updateSecretDraft).not.toHaveBeenCalledWith(KEY, VALID);
    expect(text(root)).not.toContain('late.json');

    const second = deferred();
    const secondDone = startPick(root, 'closed.json', second.text);
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      second.resolve(VALID);
      await secondDone;
    });
    expect(base.updateSecretDraft).not.toHaveBeenCalledWith(KEY, VALID);
    expect(base.updateSecretDraft).toHaveBeenLastCalledWith(KEY, '');
  });

  it('keeps the newest pick when an earlier read finishes later', async () => {
    const { root, base } = mount();
    const slow = deferred();
    const slowDone = startPick(root, 'old.json', slow.text);
    const newer = VALID.replace('boaa-tts"', 'boaa-new"');
    await pick(root, newer);
    await act(async () => {
      slow.resolve(VALID);
      await slowDone;
    });
    expect(base.updateSecretDraft).toHaveBeenLastCalledWith(KEY, newer);
    expect(text(root)).toContain('project boaa-new');
  });

  it('reports a failed read without drafting anything', async () => {
    const { root, base } = mount();
    const failing = deferred();
    const done = startPick(root, 'broken.json', failing.text);
    await act(async () => {
      failing.reject(new Error('{"private_key":"leak"}'));
      await done;
    });
    expect(text(root)).toContain('파일을 읽지 못했습니다');
    expect(text(root)).not.toContain('leak');
    expect(base.updateSecretDraft).not.toHaveBeenCalledWith(KEY, expect.stringContaining('{'));
  });

  it('still clears drafts after a StrictMode effect re-run', async () => {
    const base = controller();
    act(() => {
      renderer = create(
        <StrictMode>
          <Harness base={base} />
        </StrictMode>,
      );
    });
    await pick(renderer!.root, VALID);
    expect(base.updateSecretDraft).toHaveBeenLastCalledWith(KEY, VALID);
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(base.updateSecretDraft).toHaveBeenLastCalledWith(KEY, '');
  });

  it('allows deleting a stored JSON to fall back to path/token auth', () => {
    const { root, base } = mount(controller({ secretStatuses: [status('gemini-vertex-tts', true)] }));
    expect(text(root)).toContain('UI 저장 · 우선 사용');
    act(() => button(root, '삭제').props.onClick());
    expect(base.deleteSecret).toHaveBeenCalledWith('tts_synthesis', 'gemini-vertex-tts', 'service_account_json');
  });
});
