import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Shelf } from '../../domain/types';
import { useShelfEditorModel } from '../../features/library/use-shelf-editor-model';
import type { LibraryManagementController } from '../../features/library/useLibraryManagementController';
import { PromptSheet } from '../components/dialogs';
import { cx, Sheet } from '../components/primitives';
import { EmptyState, Notice, PrefSection } from '../components/prefs';
import './library-tools.css';

const COLORS = ['#4f7d65', '#5b8cff', '#a970ff', '#ff6f91', '#f5a524', '#34c3b5', '#8b8b93'];

/** 책장 관리: make shelves, rename them, change their order, delete them. Books stay when a shelf goes. */
export default function UiNextShelfSheet({ controller }: { controller: LibraryManagementController }) {
  const model = useShelfEditorModel(controller);
  const [renaming, setRenaming] = useState<Shelf>();
  const open = Boolean(controller.panel);
  const busy = controller.busy;
  return (
    <Sheet open={open} onClose={controller.closePanel} closeDisabled={busy} title="책장 관리">
      <div className="un-tools">
        <form
          className="un-shelf-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (model.newName.trim()) void model.create();
          }}
        >
          <div className="un-shelf-create-row">
            <input
              className="un-input"
              aria-label="새 책장 이름"
              placeholder="새 책장 이름"
              maxLength={80}
              value={model.newName}
              onChange={(event) => model.setNewName(event.target.value)}
            />
            <button type="submit" className="un-btn is-primary" disabled={!model.newName.trim() || busy}>
              <Plus size={16} />
              만들기
            </button>
          </div>
          <div className="un-shelf-colors" role="radiogroup" aria-label="새 책장 색">
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={model.newColor === color}
                aria-label={color}
                className={cx('un-shelf-color', model.newColor === color && 'is-active')}
                style={{ background: color }}
                onClick={() => model.setNewColor(color)}
              />
            ))}
            <label className={cx('un-shelf-color is-custom', !COLORS.includes(model.newColor) && 'is-active')}>
              <input
                type="color"
                aria-label="직접 고른 색"
                value={model.newColor}
                onChange={(event) => model.setNewColor(event.target.value)}
              />
            </label>
          </div>
        </form>

        <PrefSection title={`내 책장 ${controller.shelves.length}개`}>
          {controller.shelves.length ? (
            <ul className="un-shelf-list">
              {controller.shelves.map((shelf, index) => (
                <li key={shelf.id}>
                  <span className="un-shelf-dot" style={{ background: shelf.color ?? 'var(--un-text-3)' }} />
                  <span className="un-shelf-name">{shelf.name}</span>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${shelf.name} 이름 바꾸기`}
                    disabled={busy}
                    onClick={() => setRenaming(shelf)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${shelf.name} 위로`}
                    disabled={index === 0 || busy}
                    onClick={() => void model.moveShelf(index, -1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${shelf.name} 아래로`}
                    disabled={index === controller.shelves.length - 1 || busy}
                    onClick={() => void model.moveShelf(index, 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${shelf.name} 지우기`}
                    disabled={busy}
                    onClick={() => void model.remove(shelf)}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="아직 책장이 없어요" body="이름을 적고 만들면 서재에서 작품을 나눠 담을 수 있어요." />
          )}
          <p className="un-tools-note">책장을 지워도 안에 있던 책은 서재에 남아요.</p>
        </PrefSection>
        {controller.error && <Notice tone="danger">{controller.error}</Notice>}
      </div>
      <PromptSheet
        open={Boolean(renaming)}
        title="책장 이름 바꾸기"
        label="책장 이름"
        initial={renaming?.name}
        maxLength={80}
        confirmLabel="바꾸기"
        onSubmit={(name) => renaming && void controller.updateShelf(renaming, { name })}
        onClose={() => setRenaming(undefined)}
      />
    </Sheet>
  );
}
