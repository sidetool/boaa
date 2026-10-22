import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReaderTranslationController } from '../../features/translation/use-reader-translation';
import { ReaderTranslationControls } from './ReaderTranslationControls';

// Sheet focus/portal behavior is covered separately; these tests exercise the activity lifecycle.
vi.mock('../components/primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/primitives')>()),
  Sheet: () => null,
}));

let view: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => view?.unmount());
  view = undefined;
  vi.useRealTimers();
});
function state(overrides: Partial<ReaderTranslationController> = {}): ReaderTranslationController {
  return {
    available: true,
    busy: false,
    open: false,
    result: undefined,
    error: '',
    sourceLanguage: 'en',
    configuration: undefined,
    displaying: false,
    texts: undefined,
    setOpen: vi.fn(),
    setSourceLanguage: vi.fn(),
    start: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    showTranslation: vi.fn(),
    showOriginal: vi.fn(),
    ...overrides,
  };
}
function render(controller: ReaderTranslationController) {
  act(() => {
    const element = <ReaderTranslationControls controller={controller} listening={false} />;
    if (view) view.update(element);
    else view = create(element);
  });
}
const activity = () =>
  view!.root.findAll((node) => node.type === 'p' && String(node.props.className).includes('un-reader-activity'));
it('clears a previous failure warning on chapter reset instead of stranding a cancelled timer', async () => {
  vi.useFakeTimers();
  render(state({ busy: true }));
  render(state({ error: 'Synthetic failed request' }));
  expect(activity()).toHaveLength(1);
  render(state());
  expect(activity()).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(activity()).toHaveLength(0);
});
it('hides activity while the sheet is open and clears a failure warning after four seconds', async () => {
  vi.useFakeTimers();
  render(state({ busy: true, open: false }));
  expect(activity()).toHaveLength(1);
  render(state({ busy: true, open: true }));
  expect(activity()).toHaveLength(0);
  render(state({ error: 'Synthetic failed request' }));
  expect(activity()).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(activity()).toHaveLength(0);
});
