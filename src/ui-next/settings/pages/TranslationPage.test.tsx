import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRANSLATION_SETTINGS } from '../../../translation/contracts';
import { TranslationPage } from './TranslationPage';
const client = vi.hoisted(() => ({
  configuration: vi.fn(),
  save: vi.fn(),
  credential: vi.fn(),
  deleteCredential: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('../../../features/translation/translation-client', () => ({
  useTranslationClient: () => client,
  translationError: () => '다시 확인해 주세요.',
}));
let renderer: ReactTestRenderer;
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const config = () => ({
  settings: { ...DEFAULT_TRANSLATION_SETTINGS },
  revision: 1,
  credentials: {},
  usedCharacters: 0,
});
async function mount() {
  vi.stubGlobal('window', new EventTarget());
  client.configuration.mockResolvedValue(config());
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
    client.credential.mockResolvedValue(undefined);
    await act(async () => button('키 저장').props.onClick());
    expect(client.credential).toHaveBeenCalledWith('gemini', 'test-private');
    expect(renderer.root.findByProps({ 'aria-label': '번역 API 키' }).props.value).toBe('');
    expect(client.save).not.toHaveBeenCalled();
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
