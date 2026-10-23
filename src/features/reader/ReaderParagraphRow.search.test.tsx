import { ReaderTranslationContext } from '../translation/reader-translation-context';
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

it('keeps source text, inline marks and offsets intact across retained page edges', () => {
  const props: ReaderParagraphRowProps = {
    paragraph: {
      id: 'p',
      novelId: 'book',
      chapterId: 'chapter',
      index: 1,
      text: '앞 문장. 뒤 문장. 마지막 문장.',
      inlineMarks: [{ kind: 'strong', start: 3, end: 12 }],
    } as Paragraph,
    virtualIndex: 0,
    start: 0,
    isSpeaking: false,
    mode: 'read',
    searchQuery: '문장',
    decorationStore: new ReaderDecorationStore(),
    measureElement: vi.fn(),
    onSelectCorrectionSegment: vi.fn(),
    flowBreaks: [6, 12],
  };
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(<ReaderParagraphRow {...props} />);
  });
  try {
    const paragraph = app.root.findByType('p');
    const text = (node: typeof paragraph | string): string =>
      typeof node === 'string' ? node : node.children.map(text).join('');
    expect(text(paragraph)).toBe(props.paragraph.text);
    expect(paragraph.props['data-reader-source-offset']).toBe(0);
    const blocks = paragraph.findAll((node) => node.type === 'span' && node.props.style?.display === 'block');
    expect(blocks.map(text)).toEqual(['앞 문장. ', '뒤 문장. ', '마지막 문장.']);
    expect(paragraph.findAllByType('strong').map(text).join('')).toBe(props.paragraph.text.slice(3, 12));
    expect(paragraph.findAllByType('mark').map(text).join('')).toBe('문장문장문장');
    act(() => app.update(<ReaderParagraphRow {...props} start={400} />));
    expect(text(app.root.findByType('p'))).toBe(props.paragraph.text);
  } finally {
    act(() => app.unmount());
  }
});

it('does not apply original page offsets to translated text', () => {
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(
      <ReaderTranslationContext.Provider value={new Map([['p', '길이가 다른 번역 문장입니다.']])}>
        <ReaderParagraphRow
          paragraph={{ id: 'p', novelId: 'book', chapterId: 'chapter', index: 1, text: 'original text' } as Paragraph}
          virtualIndex={0}
          start={0}
          isSpeaking={false}
          mode="read"
          searchQuery=""
          decorationStore={new ReaderDecorationStore()}
          measureElement={vi.fn()}
          onSelectCorrectionSegment={vi.fn()}
          flowBreaks={[4, 7]}
        />
      </ReaderTranslationContext.Provider>,
    );
  });
  try {
    expect(app.root.findAll((node) => node.type === 'span' && node.props.style?.display === 'block')).toHaveLength(0);
    expect(app.root.findByProps({ className: 'reader-translated-text' }).children).toEqual([
      '길이가 다른 번역 문장입니다.',
    ]);
  } finally {
    act(() => app.unmount());
  }
});
