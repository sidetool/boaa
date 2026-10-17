import type { Shelf } from '../../domain/types';
import { useLibraryWorkModel, type LibraryWorkEdit } from '../../features/library/use-library-work-model';
import { Sheet } from '../components/primitives';
import { Notice, PrefOptions } from '../components/prefs';
import './library-tools.css';

/** 제목 바꾸기 or 책장 옮기기 for one work. The sheet stays while saving. */
export function UiNextLibraryWorkSheet({
  edit,
  shelves,
  close,
}: {
  edit: LibraryWorkEdit;
  shelves: readonly Shelf[];
  close(): void;
}) {
  const model = useLibraryWorkModel({ edit, shelves, close });
  const error =
    model.error?.code === 'shelf_missing'
      ? '고른 책장이 지워졌어요. 다른 책장을 골라 주세요.'
      : model.error?.code === 'save_failed'
        ? model.error.cause instanceof Error
          ? model.error.cause.message
          : '바꾸지 못했어요. 다시 해 주세요.'
        : undefined;
  const title = edit.kind === 'title';
  return (
    <Sheet
      open
      variant={title ? 'dialog' : 'auto'}
      onClose={close}
      closeDisabled={model.busy}
      title={title ? '제목 바꾸기' : '책장 옮기기'}
      footer={
        <>
          <button type="button" className="un-btn is-ghost" disabled={model.busy} onClick={close}>
            취소
          </button>
          <button
            type="submit"
            form="un-library-work"
            className="un-btn is-primary"
            disabled={model.busy || (title && !model.value.trim())}
          >
            {model.busy ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <form
        id="un-library-work"
        className="un-tools"
        onSubmit={(event) => {
          event.preventDefault();
          void model.submit();
        }}
      >
        {title ? (
          <input
            className="un-input"
            aria-label="작품 제목"
            maxLength={300}
            required
            value={model.value}
            disabled={model.busy}
            onChange={(event) => model.setValue(event.target.value)}
          />
        ) : (
          <>
            <p className="un-tools-note">‘{edit.title}’을 옮길 책장을 골라요. 전체 서재에서는 계속 보여요.</p>
            <PrefOptions
              label="옮길 책장"
              value={model.value}
              disabled={model.busy}
              options={[
                { value: '', label: '책장 없음' },
                ...shelves.map((shelf) => ({
                  value: shelf.id,
                  label: shelf.name,
                  leading: <span className="un-shelf-dot" style={{ background: shelf.color ?? 'var(--un-text-3)' }} />,
                })),
              ]}
              onChange={model.setValue}
            />
          </>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Sheet>
  );
}
