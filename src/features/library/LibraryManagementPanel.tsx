import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from 'lucide-react';
import { useShelfEditorModel } from './use-shelf-editor-model';
import { Dialog } from '../../shared/ui/Dialog';

import type { LibraryManagementController } from './useLibraryManagementController';

import type { BookEnrichmentController } from '../book-enrichment/useBookEnrichmentController';

function ShelfEditor({ controller }: { controller: LibraryManagementController }) {
  const { newName, setNewName, newColor, setNewColor, drafts, setDraft, moveShelf, create, rename } =
    useShelfEditorModel(controller);

  return (
    <div className="library-management-body shelf-editor">
      <div className="shelf-create-row">
        <input
          value={newName}
          maxLength={80}
          placeholder="새 책장 이름"
          onChange={(event) => setNewName(event.target.value)}
        />
        <input
          type="color"
          value={newColor}
          aria-label="새 책장 색상"
          onChange={(event) => setNewColor(event.target.value)}
        />
        <button className="primary-btn" disabled={!newName.trim() || controller.busy} onClick={() => void create()}>
          <Plus size={16} /> 추가
        </button>
      </div>
      <div className="shelf-editor-list">
        {controller.shelves.map((shelf, index) => (
          <div className="shelf-editor-row" key={shelf.id}>
            <span className="shelf-color" style={{ backgroundColor: shelf.color }} />
            <input
              value={drafts[shelf.id] ?? shelf.name}
              onChange={(event) => setDraft(shelf.id, event.target.value)}
            />
            <button
              className="icon-btn"
              title="책장 이름 저장"
              aria-label={`${shelf.name} 이름 저장`}
              onClick={() => void rename(shelf)}
            >
              <Check size={17} />
            </button>
            <button
              className="icon-btn"
              disabled={index === 0 || controller.busy}
              title="위로 이동"
              aria-label={`${shelf.name} 위로 이동`}
              onClick={() => void moveShelf(index, -1)}
            >
              <ArrowUp size={17} />
            </button>
            <button
              className="icon-btn"
              disabled={index === controller.shelves.length - 1 || controller.busy}
              title="아래로 이동"
              aria-label={`${shelf.name} 아래로 이동`}
              onClick={() => void moveShelf(index, 1)}
            >
              <ArrowDown size={17} />
            </button>
            <button
              className="icon-btn danger"
              title="책장 삭제"
              aria-label={`${shelf.name} 삭제`}
              onClick={() => void controller.deleteShelf(shelf)}
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
        {controller.shelves.length === 0 && <p className="field-help">사용자 책장이 없습니다.</p>}
      </div>
    </div>
  );
}

export default function LibraryManagementPanel({
  controller,
}: {
  controller: LibraryManagementController;
  bookEnrichment: BookEnrichmentController;
}) {
  if (!controller.panel) return null;
  return (
    <Dialog
      open
      title="책장 관리"
      onClose={controller.closePanel}
      className="library-management-dialog"
      backdropClassName="library-management-backdrop"
      closeLabel="닫기"
      closeDisabled={controller.busy}
    >
      <ShelfEditor controller={controller} />
      {controller.error && <p className="dialog-status danger">{controller.error}</p>}
    </Dialog>
  );
}
