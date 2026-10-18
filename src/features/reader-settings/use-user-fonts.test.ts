import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import type { UserFontAsset } from '../../domain/types';
import { useUserFonts, type UserFontsModel } from './use-user-fonts';
import { prepareUserFont, verifyFontCanLoad } from './user-font-service';
import { unloadUserFont } from './user-font-runtime';
vi.mock('./user-font-service', () => ({ prepareUserFont: vi.fn(), verifyFontCanLoad: vi.fn() }));
vi.mock('./user-font-runtime', () => ({ unloadUserFont: vi.fn() }));
let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.resetAllMocks();
});
it('exposes installation phase errors and preserves selection on failure', async () => {
  const font = { id: 'font-a', contentHash: 'hash', familyLabel: 'Font', licenseNote: 'license' } as UserFontAsset;
  const repository = {
    listUserFonts: vi.fn().mockResolvedValue([]),
    installUserFont: vi.fn().mockResolvedValue({ ...font, id: 'owner-scoped-font' }),
    updateUserFont: vi.fn(),
    deleteUserFont: vi.fn(),
  } as unknown as ReaderPersonalizationRepository;
  const selectFont = vi.fn();
  let model!: UserFontsModel;
  function Harness() {
    model = useUserFonts({ repository, activeFontId: font.id, selectFont });
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  const file = new File(['test'], 'font.ttf');
  for (const [message, code] of [
    ['font_size_invalid', 'size_invalid'],
    ['font_format_invalid', 'format_invalid'],
    ['font_extension_mismatch', 'format_invalid'],
  ]) {
    vi.mocked(prepareUserFont).mockRejectedValueOnce(new Error(message));
    await act(async () => {
      await model.install(file);
    });
    expect(model.error).toBe(code);
    expect(model.busy).toBe(false);
  }
  vi.mocked(prepareUserFont).mockResolvedValue({ asset: font, blob: file });
  vi.mocked(verifyFontCanLoad).mockRejectedValueOnce(new Error('decode'));
  await act(async () => {
    await model.install(file);
  });
  expect(model.error).toBe('load_failed');
  vi.mocked(repository.installUserFont).mockRejectedValueOnce(new Error('quota'));
  await act(async () => {
    await model.install(file);
  });
  expect(model.error).toBe('save_failed');
  expect(selectFont).not.toHaveBeenCalled();
  vi.mocked(repository.listUserFonts).mockResolvedValue([font]);
  await act(async () => {
    await model.install(file);
  });
  expect(selectFont).toHaveBeenCalledWith('owner-scoped-font');
  expect(model.error).toBeUndefined();
  await act(async () => {
    await model.install(file);
  });
  expect(model.error).toBe('duplicate');
  await act(async () => {
    await model.rename(font.id, ' Renamed ');
  });
  expect(repository.updateUserFont).toHaveBeenCalledWith(font.id, { familyLabel: 'Renamed', licenseNote: 'license' });
  await act(async () => {
    await model.remove(font.id);
  });
  expect(selectFont).toHaveBeenLastCalledWith('builtin-serif');
  expect(unloadUserFont).toHaveBeenCalledWith(font.id, expect.anything());
  expect(repository.deleteUserFont).toHaveBeenCalledWith(font.id);
  vi.mocked(repository.updateUserFont).mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    await model.rename(font.id, 'Again');
  });
  expect(model.operationError).toBe('rename_failed');
});
