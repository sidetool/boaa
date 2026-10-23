import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReaderChapterLead, ReaderChapterSeparator } from '../../src/features/reader/ReaderChapterSeparator.tsx';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/reader-content.css';

// Render inside the real text reader's typography scope, not an isolated UI card.
const query = new URLSearchParams(location.search);
const article = document.createElement('article');
article.className = 'reader-document';
article.style.cssText = `--reading-font-size:${query.get('font') || 20}px;--reading-line-height:${query.get('line') || 3};--reading-letter-spacing:.3em;--reading-word-spacing:1em;--reading-font-style:italic;--reading-font-weight:800;max-width:340px`;
document.body.append(article);
createRoot(article).render(
  React.createElement(
    React.Fragment,
    null,
    ...['ready', 'loading', 'error', 'end'].map((status) =>
      React.createElement(ReaderChapterSeparator, {
        key: status,
        unit: '화',
        currentTitle: '1화 · 긴 제목의 합성 회차 경계 확인',
        nextTitle: '2화 · 이어지는 합성 본문 제목',
        status,
        onRetry: () => {},
      }),
    ),
    ...['idle', 'loading', 'error', 'start'].map((status) =>
      React.createElement(ReaderChapterLead, { key: status, unit: '화', status, onRetry: () => {} }),
    ),
  ),
);
