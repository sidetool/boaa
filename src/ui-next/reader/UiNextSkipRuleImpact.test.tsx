import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { SpokenTextRule } from '../../domain/types';
import UiNextSkipRuleImpact from './UiNextSkipRuleImpact';

const skipRule: SpokenTextRule = {
  id: 'skip-author-note',
  scope: 'book',
  bookId: 'book-1',
  kind: 'skip_prefix',
  pattern: '[작가의 말]',
  enabled: true,
  priority: 0,
  updatedAt: '2026-08-01T00:00:00.000Z',
};

it('stays hidden without active skip rules', () => {
  const renderer = create(<UiNextSkipRuleImpact rules={[]} inspect={vi.fn()} />);
  expect(renderer.toJSON()).toBeNull();
});

it('shows a bounded whole-book impact summary for active skip rules', async () => {
  const inspect = vi.fn(async () => ({
    scannedParagraphCount: 120,
    affectedParagraphCount: 4,
    fullySkippedParagraphCount: 3,
    skippedRangeCount: 4,
    samples: [{ chapterTitle: '3화', paragraphIndex: 7, source: '[작가의 말] 다음 화에서 계속' }],
  }));
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<UiNextSkipRuleImpact rules={[skipRule]} inspect={inspect} />);
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '책 전체 건너뛰기 영향 확인' }).props.onClick();
  });

  const output = JSON.stringify(renderer.toJSON());
  expect(inspect).toHaveBeenCalledOnce();
  expect(output).toContain('120');
  expect(output).toContain('3화');
  expect(output).toContain('[작가의 말] 다음 화에서 계속');
  // A changed rule set drops the stale answer.
  act(() => renderer.update(<UiNextSkipRuleImpact rules={[{ ...skipRule, pattern: '[공지]' }]} inspect={inspect} />));
  expect(JSON.stringify(renderer.toJSON())).not.toContain('3화');
});
