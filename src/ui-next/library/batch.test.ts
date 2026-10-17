import { describe, expect, it } from 'vitest';
import { actions, model, novel } from '../test-fixtures';
import { batchLibraryActions } from './actions';

describe('batch action data', () => {
  function fixture() {
    const props = { model: model([novel()]), actions: actions() };
    props.model.management.selectionMode = true;
    props.model.management.selectedBookIds = new Set(['novel-1']);
    props.model.management.shelves = [
      { id: 'shelf-1', name: '책장', createdAt: '', updatedAt: '', sortOrder: 0, revision: 0 },
    ];
    return props;
  }
  it('exposes every existing batch command with its parameters', () => {
    const props = fixture();
    const list = batchLibraryActions(props, { shelfId: 'shelf-1', tag: '태그' });
    list.forEach((action) => action.run());
    expect(props.actions.controls.applyBatch).toHaveBeenCalledWith({ kind: 'add_to_shelf', shelfId: 'shelf-1' });
    expect(props.actions.controls.applyBatch).toHaveBeenCalledWith({ kind: 'remove_from_shelf', shelfId: 'shelf-1' });
    expect(props.actions.controls.applyBatch).toHaveBeenCalledWith({ kind: 'add_tag', tag: '태그' });
    expect(props.actions.controls.applyBatch).toHaveBeenCalledWith({ kind: 'remove_tag', tag: '태그' });
    expect(props.actions.controls.applyBatch).toHaveBeenCalledWith({ kind: 'set_favorite', favorite: true });
    expect(props.actions.controls.applyBatch).toHaveBeenCalledWith({ kind: 'set_favorite', favorite: false });
    expect(props.actions.controls.applyBatch).toHaveBeenCalledWith({ kind: 'move_to_trash' });
    expect(props.actions.controls.exportSelectedMetadata).toHaveBeenCalledOnce();
    props.model.filter = 'trash';
    batchLibraryActions(props)
      .find((action) => action.id === 'restore')!
      .run();
    expect(props.actions.controls.applyBatch).toHaveBeenCalledWith({ kind: 'restore_from_trash' });
  });
  it('guards empty/busy selections and invalid shelf/tag inputs', () => {
    const props = fixture();
    expect(
      batchLibraryActions(props, { shelfId: 'missing', tag: ' ' })
        .filter((action) => action.disabled)
        .map((action) => action.id),
    ).toEqual(['add_to_shelf', 'remove_from_shelf', 'add_tag', 'remove_tag']);
    for (const state of [{ selectedBookIds: new Set<string>() }, { busy: true }, { selectionMode: false }]) {
      Object.assign(props.model.management, state);
      const list = batchLibraryActions(props, { tag: '태그' });
      expect(list.every((action) => action.disabled)).toBe(true);
      list.forEach((action) => action.run());
    }
    expect(props.actions.controls.applyBatch).not.toHaveBeenCalled();
  });
  it('allows external shelf/trash commands while disabling unsupported metadata operations', () => {
    const props = fixture();
    props.model.management.selectedBookIds = new Set(['novel-1', 'external:remote-1']);
    const list = batchLibraryActions(props, { tag: '태그' });
    expect(list.filter((action) => !action.disabled).map((action) => action.id)).toEqual([
      'add_to_shelf',
      'remove_from_shelf',
      'remove',
    ]);
    list.forEach((action) => action.run());
    expect(props.actions.controls.applyBatch).toHaveBeenCalledTimes(3);
    expect(props.actions.controls.exportSelectedMetadata).not.toHaveBeenCalled();
  });
});
