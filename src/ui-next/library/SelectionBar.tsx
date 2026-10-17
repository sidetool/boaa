import { FolderInput, Heart, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Shelf } from '../../domain/types';
import { ActionList, Sheet } from '../components/primitives';
import type { LibraryAction, LibraryBatchInput } from './contract';

type Batch = (input?: LibraryBatchInput) => readonly LibraryAction[];

function pick(actions: readonly LibraryAction[], id: string) {
  return actions.find((action) => action.id === id);
}

/** Floating bar for multi-select: the three most used commands, the rest in a sheet. */
export function SelectionBar({
  batch,
  shelves,
  inTrash,
}: {
  batch: Batch;
  shelves: readonly Shelf[];
  inTrash: boolean;
}) {
  const [sheet, setSheet] = useState<'more' | 'add_to_shelf' | 'remove_from_shelf' | 'tag' | null>(null);
  const [tag, setTag] = useState('');
  const actions = batch();
  const remove = pick(actions, inTrash ? 'restore' : 'remove');
  const favorite = pick(actions, 'favorite');
  const shelfProbe = shelves[0] ? batch({ shelfId: shelves[0].id }) : [];
  const close = () => setSheet(null);

  return (
    <>
      <div className="un-select-bar" role="toolbar" aria-label="선택한 작품">
        {!inTrash && shelves.length > 0 && (
          <button
            type="button"
            disabled={pick(shelfProbe, 'add_to_shelf')?.disabled}
            onClick={() => setSheet('add_to_shelf')}
          >
            <FolderInput size={20} />
            책장에 추가
          </button>
        )}
        {!inTrash && favorite && (
          <button type="button" disabled={favorite.disabled} onClick={() => void favorite.run()}>
            <Heart size={20} />
            즐겨찾기
          </button>
        )}
        {remove && (
          <button
            type="button"
            className={remove.danger ? 'is-danger' : undefined}
            disabled={remove.disabled}
            onClick={() => void remove.run()}
          >
            {inTrash ? <RotateCcw size={20} /> : <Trash2 size={20} />}
            {inTrash ? '복원' : '삭제'}
          </button>
        )}
        {!inTrash && (
          <button type="button" onClick={() => setSheet('more')}>
            <MoreHorizontal size={20} />
            더보기
          </button>
        )}
      </div>

      <Sheet open={sheet === 'more'} onClose={close} title="선택한 작품">
        <ActionList
          onDone={close}
          actions={[
            ...(shelves.length
              ? [
                  {
                    id: 'remove_from_shelf',
                    label: '책장에서 빼기',
                    run: () => setSheet('remove_from_shelf'),
                    disabled: pick(shelfProbe, 'remove_from_shelf')?.disabled,
                  },
                ]
              : []),
            ...[pick(actions, 'unfavorite'), pick(actions, 'export')].filter(
              (action): action is LibraryAction => !!action,
            ),
            {
              id: 'tag',
              label: '태그 붙이기·떼기',
              disabled: pick(batch({ tag: 'x' }), 'add_tag')?.disabled,
              run: () => setSheet('tag'),
            },
          ]}
        />
      </Sheet>

      <Sheet
        open={sheet === 'add_to_shelf' || sheet === 'remove_from_shelf'}
        onClose={close}
        title={sheet === 'remove_from_shelf' ? '어느 책장에서 뺄까요?' : '어느 책장에 넣을까요?'}
      >
        <ActionList
          onDone={close}
          actions={shelves.map((shelf) => {
            const action = pick(batch({ shelfId: shelf.id }), sheet ?? 'add_to_shelf')!;
            return { ...action, id: shelf.id, label: shelf.name };
          })}
        />
      </Sheet>

      <Sheet open={sheet === 'tag'} onClose={close} title="태그" variant="dialog">
        <form
          className="un-tag-form"
          onSubmit={(event) => {
            event.preventDefault();
            const add = pick(batch({ tag }), 'add_tag');
            if (add && !add.disabled) {
              void add.run();
              close();
            }
          }}
        >
          <input autoFocus value={tag} placeholder="태그 이름" onChange={(event) => setTag(event.target.value)} />
          <div>
            <button
              type="button"
              className="un-btn is-ghost"
              disabled={pick(batch({ tag }), 'remove_tag')?.disabled}
              onClick={() => {
                void pick(batch({ tag }), 'remove_tag')?.run();
                close();
              }}
            >
              떼기
            </button>
            <button type="submit" className="un-btn is-primary" disabled={pick(batch({ tag }), 'add_tag')?.disabled}>
              붙이기
            </button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
