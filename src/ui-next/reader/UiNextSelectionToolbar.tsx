import { AudioLines, Copy, Eraser, StickyNote, X } from 'lucide-react';
import { useState } from 'react';
import type { ReaderSelectionToolbarProps } from '../../features/reader/reader-selection-contract';
import type { ReaderHighlightColor } from '../../features/reader/reader-screen-contract';
import { formatCount } from '../../utils/format';
import { cx } from '../components/primitives';
import '../styles/tokens.css';
import './selection.css';

const palette: readonly { color: ReaderHighlightColor; label: string }[] = [
  { color: 'yellow', label: '노랑' },
  { color: 'green', label: '초록' },
  { color: 'blue', label: '파랑' },
  { color: 'pink', label: '분홍' },
];

/** ui-next text selection bar: colours first, then labelled actions people reach for (memo, listen, copy). */
export function UiNextSelectionToolbar({
  selection,
  location,
  screenHandle,
  onClear,
  pluginAction,
}: ReaderSelectionToolbarProps) {
  const actions = screenHandle.getActions();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const highlight = async (color: ReaderHighlightColor | 'remove') => {
    if (!location || busy) return;
    setBusy(true);
    try {
      await actions.highlightSelection(location, selection, color);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    let done: boolean;
    try {
      await navigator.clipboard.writeText(selection.text);
      done = true;
    } catch {
      // Without clipboard permission, copy the live selection the classic way.
      done = document.execCommand('copy');
    }
    setCopied(done);
    if (done) window.setTimeout(onClear, 600);
  };

  return (
    <div
      className={cx('selection-action-bar ui-next un-textsel', Boolean(pluginAction) && 'has-plugin-actions')}
      role="toolbar"
      aria-label={`${formatCount(selection.text.length)}자 선택`}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="un-textsel-swatches" role="group" aria-label="선택 문장 하이라이트">
        {palette.map((item) => (
          <button
            key={item.color}
            type="button"
            className={cx('un-textsel-swatch', `is-${item.color}`)}
            disabled={busy || !location}
            onClick={() => void highlight(item.color)}
            aria-label={`${item.label} 하이라이트`}
          />
        ))}
        <button
          type="button"
          className="un-textsel-swatch is-erase"
          disabled={busy || !location}
          onClick={() => void highlight('remove')}
          aria-label="선택 범위의 하이라이트 삭제"
        >
          <Eraser size={15} />
        </button>
      </div>
      <i className="un-textsel-divider" aria-hidden="true" />
      <button type="button" className="un-textsel-action" onClick={() => actions.openSelectionNote(selection)}>
        <StickyNote size={18} aria-hidden="true" />
        메모
      </button>
      <button
        type="button"
        className="un-textsel-action"
        onClick={() => {
          actions.previewSelectionTTS(selection);
          onClear();
        }}
        aria-label="선택 문장 듣기"
      >
        <AudioLines size={18} aria-hidden="true" />
        듣기
      </button>
      <button type="button" className="un-textsel-action" onClick={() => void copy()} aria-label="선택 문장 복사">
        <Copy size={18} aria-hidden="true" />
        {copied ? '복사됨' : '복사'}
      </button>
      {pluginAction}
      <button type="button" className="un-textsel-close" onClick={onClear} aria-label="선택 해제">
        <X size={16} />
      </button>
    </div>
  );
}
