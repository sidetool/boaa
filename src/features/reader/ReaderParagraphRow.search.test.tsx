import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Paragraph } from '../../domain/types';
import { decorateReaderText } from '../../reader/text-decorations';
import { ReaderParagraphRow, type ReaderParagraphRowProps } from './ReaderParagraphRow';
import { ReaderDecorationStore } from './reader-decoration-store';
vi.mock('../../reader/text-decorations', async (original) => {
  const actual = await original<typeof import('../../reader/text-decorations')>();
  return { ...actual, decorateReaderText: vi.fn(actual.decorateReaderText) };
});
it('reuses text highlights while virtual rows move, but updates them when the query changes', () => {
  const props: ReaderParagraphRowProps = {
    paragraph: { id: 'p', novelId: 'book', chapterId: 'chapter', index: 1, text: 'needle text' } as Paragraph,
    virtualIndex: 0,
    start: 0,
    isSpeaking: false,
    mode: 'read',
    searchQuery: 'needle',
    decorationStore: new ReaderDecorationStore(),
    measureElement: vi.fn(),
    onSelectCorrectionSegment: vi.fn(),
  };
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(<ReaderParagraphRow {...props} />);
  });
  try {
    const calls = vi.mocked(decorateReaderText).mock.calls.length;
    act(() => app.update(<ReaderParagraphRow {...props} start={400} />));
    expect(decorateReaderText).toHaveBeenCalledTimes(calls);
    act(() => app.update(<ReaderParagraphRow {...props} start={400} searchQuery="text" />));
    expect(decorateReaderText).toHaveBeenCalledTimes(calls + 1);
  } finally {
    act(() => app.unmount());
  }
});
