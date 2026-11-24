import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/reader-addons.css';
import '../../src/styles/responsive.css';
import '../../src/ui-next/settings/pages/pages.css';
import { UiNextReaderTools } from '../../src/ui-next/reader/UiNextReaderTools.tsx';
import { Sheet } from '../../src/ui-next/components/primitives.tsx';

const h = React.createElement;
const tabs = [
  { id: 'outline', label: '목차', icon: 'list' },
  { id: 'notes', label: '주석', icon: 'notes' },
];
window.sheetProbe = { first: null, commits: 0 };
window.sheetSnapshot = () => {
  const layer = document.querySelector('.un-tools-layer, .un-layer');
  const panel = layer.querySelector('[role="dialog"]');
  const backdrop = getComputedStyle(layer);
  const style = getComputedStyle(panel);
  return {
    fixed: backdrop.position === 'fixed',
    opacity: backdrop.opacity,
    modal: panel.getAttribute('aria-modal'),
    transform: style.transform,
    height: panel.getBoundingClientRect().height,
    width: panel.getBoundingClientRect().width,
  };
};
function FirstCommit() {
  useLayoutEffect(() => {
    window.sheetProbe.first = window.sheetSnapshot();
    window.sheetProbe.commits += 1;
  }, []);
  return null;
}
function Fixture() {
  const [kind, setKind] = useState(null);
  const [activeTab, setActiveTab] = useState('outline');
  const children = h(
    React.Fragment,
    null,
    h(FirstCommit),
    h('p', null, activeTab === 'outline' ? '목차 내용' : '주석 내용'),
    ...Array.from({ length: 30 }, (_, index) => h('p', { key: index }, `합성 본문 ${index + 1}`)),
    h('button', { id: 'last-control' }, '마지막 항목'),
  );
  return h(
    React.Fragment,
    null,
    h(
      'main',
      { style: { minHeight: '100vh' } },
      ...['reader', 'settings', 'files'].map((value) =>
        h('button', { key: value, id: `open-${value}`, onClick: () => setKind(value) }, value),
      ),
    ),
    kind === 'reader'
      ? h(UiNextReaderTools, { activeTab, tabs, setActiveTab, close: () => setKind(null) }, children)
      : h(
          Sheet,
          {
            open: kind !== null,
            title: '설정',
            className: kind === 'files' ? 'un-rfadd-sheet' : undefined,
            onClose: () => setKind(null),
          },
          children,
        ),
  );
}
const root = document.createElement('div');
document.body.append(root);
createRoot(root).render(h(Fixture));
