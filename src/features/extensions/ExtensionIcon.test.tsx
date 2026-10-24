import { act, create } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { ExtensionIcon } from './ExtensionIcon';
it('renders decorative logos and restores a stable fallback on failure, retrying a changed URL', () => {
  let view!: ReturnType<typeof create>;
  act(() => {
    view = create(<ExtensionIcon name="Example" iconUrl="https://repo.example/a.png" />);
  });
  expect(view.root.findByType('img').props.referrerPolicy).toBe('no-referrer');
  act(() => view.root.findByType('img').props.onError());
  expect(view.root.findAllByType('img')).toHaveLength(0);
  expect(view.root.findByType('span').children).toEqual(['E']);
  act(() => view.update(<ExtensionIcon name="Example" iconUrl="https://repo.example/b.png" />));
  expect(view.root.findByType('img').props.src).toBe('https://repo.example/b.png');
  act(() => view.unmount());
});
