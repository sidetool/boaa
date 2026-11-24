import { describe, expect, it } from 'vitest';
import { validSourceWebViewRequest } from '../../../../packages/extension-contracts/source-webview.js';
import { renderedParagraphs } from './source-browser-paragraphs.js';

describe('rendered source paragraphs', () => {
  const strings = [
    '#document',
    'SECTION',
    'DIV',
    'P',
    '#text',
    'visible',
    '1',
    '0',
    'First ',
    'paragraph',
    'Hidden',
    'Second paragraph',
    'Elsewhere',
    'hidden',
  ];
  const chapter = {
    nodes: {
      backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      parentIndex: [-1, 0, 1, 2, 3, 3, 2, 6, 7, 2, 9, 1, 11],
      nodeType: [9, 1, 1, 1, 3, 3, 1, 1, 3, 1, 3, 1, 3],
      nodeName: [0, 1, 2, 3, 4, 4, 2, 3, 4, 3, 4, 3, 4],
    },
    layout: {
      nodeIndex: [1, 4, 5, 6, 8, 10, 12],
      text: [-1, 8, 9, -1, 10, 11, 12],
      styles: [
        [5, 6],
        [5, 6],
        [5, 6],
        [5, 7],
        [5, 6],
        [5, 6],
        [5, 6],
      ],
    },
  };

  it('keeps inline runs and paragraphs in order and excludes other or transparent content', () => {
    expect(renderedParagraphs(chapter, strings, 3)).toBe('First paragraph\n\nSecond paragraph');
    expect(renderedParagraphs(chapter, strings, 100)).toBe('');
  });

  it('excludes text when an ancestor above the selected container is transparent', () => {
    const hiddenChapter = structuredClone(chapter);
    hiddenChapter.layout.styles[0][1] = 7;
    expect(renderedParagraphs(hiddenChapter, strings, 3)).toBe('');
  });

  it('accepts both existing scripts and a bounded selector', () => {
    const request = { url: 'https://example.org/chapter', script: 'null' };
    expect(validSourceWebViewRequest(request)).toBe(true);
    expect(validSourceWebViewRequest({ ...request, renderedParagraphs: '.chapter' })).toBe(true);
    expect(validSourceWebViewRequest({ ...request, renderedParagraphs: ' ' })).toBe(false);
    expect(validSourceWebViewRequest({ ...request, renderedParagraphs: 'x'.repeat(257) })).toBe(false);
  });
});
