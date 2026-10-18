import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import UiNextSpokenTextFilters, { type UiNextSpokenTextFiltersProps } from './UiNextSpokenTextFilters';
let root: ReactTestRenderer;
afterEach(() => {
  if (root) act(() => root.unmount());
});
function setup(patch: Partial<UiNextSpokenTextFiltersProps> = {}) {
  const props = {
    rules: [],
    currentParagraphText: 'HP를 회복했다.',
    save: vi.fn(async () => {}),
    remove: vi.fn(),
    importFilters: vi.fn<NonNullable<UiNextSpokenTextFiltersProps['importFilters']>>(async () => {}),
    ...patch,
  };
  act(() => {
    root = create(<UiNextSpokenTextFilters {...props} />);
  });
  return props;
}
const text = () => JSON.stringify(root.toJSON());
const field = (label: string) =>
  root.root
    .findAllByType('label')
    .find((node) => node.findAllByType('span').some((span) => span.children.includes(label)))!
    .findByType('input');
it('renders a current-paragraph preview and saves a literal with spaces intact', async () => {
  const p = setup();
  expect(text()).toContain('HP를 회복했다.');
  act(() => field('찾을 말').props.onChange({ target: { value: 'HP' } }));
  act(() => field('읽을 말').props.onChange({ target: { value: ' 에이치피 ' } }));
  expect(text()).toContain('에이치피');
  await act(async () => {
    await root.root
      .findAllByType('button')
      .find((b) => b.children.includes('추가'))!
      .props.onClick();
  });
  expect(p.save).toHaveBeenCalledWith(
    expect.objectContaining({ scope: 'book', kind: 'replace_literal', pattern: 'HP', replacement: ' 에이치피 ' }),
  );
});
it('requires explicit consent to import the valid subset and preserves file order', async () => {
  const p = setup();
  await act(async () => {
    await root.root.findByProps({ 'aria-label': '.ttsfilter 파일' }).props.onChange({
      currentTarget: {
        value: 'x',
        files: [{ size: 32, name: 'synthetic.ttsfilter', text: async () => 'A#->#B\n(#->#x\nB#->#C' }],
      },
    });
  });
  const button = () => root.root.findAllByType('button').find((b) => b.children.includes('정상 2개만 추가'))!;
  expect(button().props.disabled).toBe(true);
  expect(p.importFilters).not.toHaveBeenCalled();
  act(() => root.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
  await act(async () => {
    await button().props.onClick();
  });
  expect(vi.mocked(p.importFilters).mock.calls[0][0].map((r: { pattern: string }) => r.pattern)).toEqual(['A', 'B']);
});
it('does not restore an import review after cancellation of a slow file read', async () => {
  setup();
  let resolve!: (s: string) => void;
  const reading = new Promise<string>((r) => {
    resolve = r;
  });
  let pending!: Promise<void>;
  act(() => {
    pending = root.root.findByProps({ 'aria-label': '.ttsfilter 파일' }).props.onChange({
      currentTarget: { value: '', files: [{ size: 10, name: 'slow.ttsfilter', text: () => reading }] },
    });
  });
  await act(async () => {
    await root.root.findByProps({ 'aria-label': '.ttsfilter 파일' }).props.onChange({
      currentTarget: { value: '', files: [{ size: 10, name: 'new.ttsfilter', text: async () => 'new#->#value' }] },
    });
  });
  await act(async () => {
    resolve('old#->#value');
    await pending;
  });
  expect(text()).toContain('new.ttsfilter');
  expect(text()).not.toContain('slow.ttsfilter');
});
it('reports excessive replacement output without crashing the panel', () => {
  setup({ currentParagraphText: 'x'.repeat(1000) });
  act(() => field('찾을 말').props.onChange({ target: { value: 'x' } }));
  act(() => field('읽을 말').props.onChange({ target: { value: 'y'.repeat(256) } }));
  expect(text()).toContain('너무 길어요');
});
