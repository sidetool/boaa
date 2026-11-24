import { useEffect, useId, useRef, useState } from 'react';
import type { ExternalSourceItemView } from '../../features/external-sources/external-source-controller-contract';
import { canSelectItem } from '../../features/external-sources/source-hub-item-model';
import { Sheet } from '../components/primitives';

export function ReleaseNavigation({
  items,
  episodeNumber,
  mode,
  partial,
  onClose,
  onJump,
  onSelect,
}: {
  items: readonly ExternalSourceItemView[];
  episodeNumber(item: ExternalSourceItemView): number;
  mode: 'jump' | 'range';
  partial: boolean;
  onClose(): void;
  onJump(item: ExternalSourceItemView, index: number): void;
  onSelect(items: ExternalSourceItemView[]): void;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');
  const range = mode === 'range';
  const current = items.findIndex((item) => item.readingState === 'current');
  const formId = useId();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // After the sheet takes focus, so closing still returns it to the opener.
    const timer = setTimeout(() => first.current?.focus());
    return () => clearTimeout(timer);
  }, [mode]);
  const field = (label: string, value: string, setValue: (value: string) => void, leading = false) => (
    <label>
      <span>{label}</span>
      <input
        ref={leading ? first : undefined}
        className="un-input"
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        required
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError('');
        }}
      />
    </label>
  );
  return (
    <Sheet
      open
      variant="dialog"
      title={range ? '다운로드할 회차 선택' : '회차 이동'}
      onClose={onClose}
      footer={
        <>
          {!range && current >= 0 ? (
            <button type="button" className="un-btn is-ghost" onClick={() => onJump(items[current], current)}>
              읽던 화로 이동
            </button>
          ) : (
            <button type="button" className="un-btn is-ghost" onClick={onClose}>
              취소
            </button>
          )}
          <button type="submit" form={formId} className="un-btn is-primary" disabled={!start || (range && !end)}>
            {range ? '선택에 추가' : '이동'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="un-dialog-body un-release-navigation"
        onSubmit={(event) => {
          event.preventDefault();
          const from = Number(start);
          const to = Number(end);
          if (range) {
            const selected = items.filter((item) => {
              const number = episodeNumber(item);
              return canSelectItem(item) && item.importState !== 'imported' && number >= from && number <= to;
            });
            if (selected.length) onSelect(selected);
            else
              setError(
                to < from ? '마지막 회차는 시작 회차보다 앞설 수 없어요.' : '이 범위에 다운로드할 회차가 없어요.',
              );
          } else {
            const index = items.findIndex((item) => episodeNumber(item) === from);
            if (index >= 0) onJump(items[index], index);
            else setError('불러온 목차에서 해당 번호를 찾을 수 없어요.');
          }
        }}
      >
        {partial && <p>지금까지 불러온 목차 안에서 찾아요.</p>}
        <div className={range ? 'un-release-range' : undefined}>
          {field(range ? '시작 회차' : '회차 번호', start, setStart, true)}
          {range && field('마지막 회차', end, setEnd)}
        </div>
        {error && (
          <small className="un-dialog-error" role="alert">
            {error}
          </small>
        )}
      </form>
    </Sheet>
  );
}
