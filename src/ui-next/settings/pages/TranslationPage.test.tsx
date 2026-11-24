import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRANSLATION_SETTINGS, type TranslationConfiguration } from '../../../translation/contracts';
import { TranslationPage } from './TranslationPage';
const client = vi.hoisted(() => ({
  configuration: vi.fn(),
  save: vi.fn(),
  credential: vi.fn(),
  deleteCredential: vi.fn(),
  clear: vi.fn(),
}));
const session = vi.hoisted(() => ({ current: undefined as typeof client | undefined }));
vi.mock('../../components/dialogs', () => ({
  ConfirmSheet: (props: { open: boolean; onConfirm(): void }) =>
    props.open ? <button onClick={props.onConfirm}>삭제 확인</button> : null,
}));
vi.mock('../../../features/translation/translation-client', () => ({
  useTranslationClient: () => session.current ?? client,
  translationError: () => '다시 확인해 주세요.',
}));
let renderer: ReactTestRenderer;
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  session.current = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const config = () => ({
  settings: { ...DEFAULT_TRANSLATION_SETTINGS },
  revision: 1,
  credentials: {},
  usedCharacters: 0,
});
async function mount(initial: TranslationConfiguration | Error = config()) {
  vi.stubGlobal('window', new EventTarget());
  if (initial instanceof Error) client.configuration.mockRejectedValue(initial);
  else client.configuration.mockResolvedValue(initial);
  await act(async () => {
    renderer = create(
      <StrictMode>
        <TranslationPage />
      </StrictMode>,
    );
  });
}
function button(label: string) {
  return renderer.root.findAllByType('button').find((button) => button.children.join('') === label)!;
}
describe('translation settings', () => {
  it('saves the API key separately on the server and clears the draft', async () => {
    await mount();
    const key = renderer.root.findByProps({ 'aria-label': '번역 API 키' });
    act(() => key.props.onChange({ target: { value: 'test-private' } }));
    expect(button('번역 설정 저장').props.disabled).toBe(true);
    client.credential.mockResolvedValue({ saved: true });
    await act(async () => button('키 저장').props.onClick());
    expect(button('번역 설정 저장').props.disabled).toBe(false);
    expect(client.credential).toHaveBeenCalledWith('gemini', 'test-private');
    expect(renderer.root.findByProps({ 'aria-label': '번역 API 키' }).props.value).toBe('');
    expect(client.save).not.toHaveBeenCalled();
  });
  it.each(['save', 'delete'] as const)(
    'shows the confirmed key %s and retries only the settings lookup',
    async (action) => {
      const saving = action === 'save';
      const before = { ...config(), credentials: { gemini: { saved: !saving } } };
      await mount(before);
      const model = () => renderer.root.findByProps({ 'aria-label': '모델 ID' });
      act(() => model().props.onChange({ target: { value: 'draft-model' } }));
      const secret = () => renderer.root.findByProps({ 'aria-label': '번역 API 키' });
      client.configuration.mockRejectedValueOnce(new Error('offline'));
      if (saving) {
        act(() => secret().props.onChange({ target: { value: 'synthetic-key' } }));
        client.credential.mockResolvedValue({ saved: true });
        await act(async () => button('키 저장').props.onClick());
      } else {
        client.deleteCredential.mockResolvedValue({ saved: false });
        act(() => button('저장된 키 삭제').props.onClick());
        await act(async () => button('삭제 확인').props.onClick());
      }
      expect(Boolean(button('저장된 키 삭제'))).toBe(saving);
      expect(model().props.value).toBe('draft-model');
      expect(secret().props.value).toBe('');
      expect(JSON.stringify(renderer.toJSON())).toContain('설정 상태를 갱신하지 못했어요');
      client.configuration.mockResolvedValue({ ...before, revision: 3, credentials: { gemini: { saved: saving } } });
      act(() => secret().props.onChange({ target: { value: 'next-edit' } }));
      const queries = client.configuration.mock.calls.length;
      await act(async () => button('다시 불러오기').props.onClick());
      expect(client.configuration.mock.calls.length).toBe(queries + 1);
      expect(client.credential).toHaveBeenCalledTimes(saving ? 1 : 0);
      expect(client.deleteCredential).toHaveBeenCalledTimes(saving ? 0 : 1);
      expect(client.save).not.toHaveBeenCalled();
      expect(model().props.value).toBe('draft-model');
      expect(secret().props.value).toBe('next-edit');
      expect(JSON.stringify(renderer.toJSON())).not.toContain('설정 상태를 갱신하지 못했어요');
      act(() => button('입력 지우기').props.onClick());
      client.save.mockResolvedValue(before);
      await act(async () => button('번역 설정 저장').props.onClick());
      expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ model: 'draft-model' }), before.revision);
    },
  );

  it('preserves edits made before the first successful settings lookup', async () => {
    await mount(new Error('initial lookup failed'));
    const model = () => renderer.root.findByProps({ 'aria-label': '모델 ID' });
    act(() => model().props.onChange({ target: { value: 'edited-model' } }));
    act(() => renderer.root.findByProps({ 'aria-label': '번역 API 키' }).props.onChange({ target: { value: 'test' } }));
    client.credential.mockResolvedValue({ saved: true });
    const settings = { ...config().settings, targetLanguage: 'ja' };
    client.configuration.mockResolvedValue({
      ...config(),
      settings,
      revision: 7,
      credentials: { gemini: { saved: true } },
    });
    await act(async () => button('키 저장').props.onClick());
    expect(model().props.value).toBe('edited-model');
    expect(renderer.root.findByProps({ 'aria-label': '번역할 언어' }).props.value).toBe('ja');
  });

  it('keeps the edited key after a rejected write and isolates confirmed state by provider', async () => {
    await mount();
    const secret = () => renderer.root.findByProps({ 'aria-label': '번역 API 키' });
    act(() => secret().props.onChange({ target: { value: 'synthetic-key' } }));
    client.credential.mockRejectedValueOnce(new Error('offline'));
    const queries = client.configuration.mock.calls.length;
    await act(async () => button('키 저장').props.onClick());
    expect(secret().props.value).toBe('synthetic-key');
    expect(client.configuration.mock.calls.length).toBe(queries);
    expect(button('저장된 키 삭제')).toBeUndefined();

    client.credential.mockResolvedValueOnce({ saved: true });
    client.configuration.mockRejectedValueOnce(new Error('offline'));
    await act(async () => button('키 저장').props.onClick());
    act(() => renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'openai-compatible' } }));
    expect(button('저장된 키 삭제')).toBeUndefined();
    act(() => renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'gemini' } }));
    expect(button('저장된 키 삭제')).toBeDefined();
  });

  it('discards a previous account and its late key receipt when the client changes', async () => {
    await mount();
    const secret = () => renderer.root.findByProps({ 'aria-label': '번역 API 키' });
    act(() => secret().props.onChange({ target: { value: 'account-one' } }));
    let done!: (value: { saved: boolean }) => void;
    client.credential.mockImplementationOnce(() => new Promise((resolve) => (done = resolve)));
    act(() => button('키 저장').props.onClick());
    const previousReads = client.configuration.mock.calls.length;
    const next = { ...client, configuration: vi.fn().mockResolvedValue(config()) };
    session.current = next;
    await act(async () =>
      renderer.update(
        <StrictMode>
          <TranslationPage />
        </StrictMode>,
      ),
    );
    expect(secret().props.value).toBe('');
    expect(secret().props.disabled).toBe(false);
    act(() => secret().props.onChange({ target: { value: 'account-two' } }));
    await act(async () => done({ saved: true }));
    expect(client.configuration.mock.calls.length).toBe(previousReads);
    expect(secret().props.value).toBe('account-two');
    expect(button('저장된 키 삭제')).toBeUndefined();
  });

  it('discards late JSON reads after changing provider or clearing input', async () => {
    await mount();
    act(() => renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'vertex' } }));
    let resolve!: (text: string) => void;
    const text = new Promise<string>((done) => {
      resolve = done;
    });
    const input = renderer.root.findByProps({ type: 'file' });
    act(() =>
      input.props.onChange({
        target: { files: [{ size: 200, name: 'credential.json', text: () => text }], value: 'file' },
      }),
    );
    act(() => renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'gemini' } }));
    await act(async () =>
      resolve(
        JSON.stringify({
          type: 'service_account',
          private_key: 'private',
          project_id: 'project',
          client_email: 'email',
        }),
      ),
    );
    expect(renderer.root.findByProps({ 'aria-label': '번역 API 키' }).props.value).toBe('');
    expect(button('키 저장').props.disabled).toBe(true);
  });
  it('nests prefetch under automatic translation and saves its disabled state', async () => {
    await mount();
    const toggle = (label: string) => renderer.root.findByProps({ role: 'switch', 'aria-label': label });
    expect(renderer.root.findAllByProps({ role: 'switch', 'aria-label': '다음 화 미리 번역' })).toHaveLength(0);
    act(() => toggle('작품을 열면 자동 번역').props.onClick());
    expect(toggle('다음 화 미리 번역').props['aria-checked']).toBe(true);
    act(() =>
      renderer.root.findByProps({ 'aria-label': '미리 번역할 다음 화' }).props.onChange({ target: { value: '3' } }),
    );
    act(() => toggle('다음 화 미리 번역').props.onClick());
    expect(renderer.root.findAllByProps({ 'aria-label': '미리 번역할 다음 화' })).toHaveLength(0);
    client.save.mockImplementation(async (settings) => ({ ...config(), settings }));
    await act(async () => button('번역 설정 저장').props.onClick());
    expect(client.save).toHaveBeenLastCalledWith(expect.objectContaining({ automatic: true, nextChapters: 0 }), 1);
    act(() => toggle('다음 화 미리 번역').props.onClick());
    expect(renderer.root.findByProps({ 'aria-label': '미리 번역할 다음 화' }).props.value).toBe(3);
    act(() => toggle('작품을 열면 자동 번역').props.onClick());
    expect(renderer.root.findAllByProps({ role: 'switch', 'aria-label': '다음 화 미리 번역' })).toHaveLength(0);
  });
  it('keeps settings disabled by default and requires explicit save', async () => {
    await mount();
    expect(client.save).not.toHaveBeenCalled();
    client.save.mockResolvedValue(config());
    await act(async () => button('번역 설정 저장').props.onClick());
    expect(client.save).toHaveBeenCalledWith(DEFAULT_TRANSLATION_SETTINGS, 1);
  });
  it('keeps title translation separate from automatic chapters and removes the daily cap control', async () => {
    await mount();
    const toggle = renderer.root.findByProps({ role: 'switch', 'aria-label': '작품 제목도 번역' });
    expect(toggle.props['aria-checked']).toBe(false);
    act(() => toggle.props.onClick());
    client.save.mockImplementation(async (settings) => ({ ...config(), settings }));
    await act(async () => button('번역 설정 저장').props.onClick());
    expect(client.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ translateTitles: true, automatic: false }),
      1,
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('하루 원문 문자 한도');
  });
});
