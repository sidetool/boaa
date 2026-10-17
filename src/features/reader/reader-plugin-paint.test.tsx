import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReaderParagraphRow } from './ReaderParagraphRow';
import { ReaderDecorationStore } from './reader-decoration-store';
import type { Paragraph } from '../../domain/types';
const paragraph: Paragraph = {
  id: 'p',
  novelId: 'book',
  chapterId: 'chapter',
  index: 0,
  text: '東京 link',
  textHash: 'hash',
  startOffsetInChapter: 0,
  endOffsetInChapter: 7,
  inlineMarks: [{ kind: 'link', start: 3, end: 7, href: '#note' }],
  inlineSemantics: [{ kind: 'ruby', start: 0, end: 2, value: 'とうきょう' }],
};
it('preserves EPUB ruby and links while composing plugin color and search', () => {
  const store = new ReaderDecorationStore();
  store.plugins.replace(store.plugins.prepare('test', 0, [{ id: 'p', text: paragraph.text }]), {
    layers: [
      {
        id: 'paint',
        palette: {
          ink: { color: '#123456', underline: true, fontWeight: 700, fontStyle: 'italic', strikethrough: true },
        },
        ranges: [{ paragraphId: 'p', start: 1, end: 6, styleId: 'ink' }],
      },
    ],
  });
  const render = (searchQuery: string) =>
    renderToStaticMarkup(
      <ReaderParagraphRow
        paragraph={paragraph}
        virtualIndex={0}
        start={0}
        isSpeaking={false}
        mode="read"
        searchQuery={searchQuery}
        decorationStore={store}
        measureElement={() => {}}
        onSelectCorrectionSegment={() => {}}
      />,
    );
  const html = render('link');
  expect(html.match(/<rt>/g)).toHaveLength(1);
  expect(html).toContain('とうきょう');
  expect(html).toContain('href="#note"');
  expect(html).toContain('<mark');
  expect(html).toContain('color:#123456');
  expect(html).toContain('font-weight:700');
  expect(html).toContain('font-style:italic');
  expect(html).toContain('underline line-through');
  expect(html).toContain('data-reader-source-offset="0"');
  store.plugins.remove('test');
  const unpainted = render('link');
  expect(unpainted).not.toContain('#123456');
  expect(unpainted).toContain('<rt>');
  expect(unpainted).toContain('href="#note"');
});
