import { ChevronLeft, ChevronRight, GripVertical, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx, Switch } from '../components/primitives';
import type { HomeRowConfig, HomeRowOption, HomeSourceRowSection, UiNextHomeAdapter } from './contract';
import { HomeRowBuilder } from './HomeRowBuilder';

const ROW_HEIGHT = 64;

function move(rows: readonly HomeRowConfig[], id: string, delta: number) {
  const from = rows.findIndex((row) => row.id === id);
  const to = Math.max(0, Math.min(rows.length - 1, from + delta));
  if (from < 0 || from === to) return rows;
  const next = [...rows];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function configFromOption(option: HomeRowOption): HomeRowConfig {
  return {
    id: [option.kind, option.shelfId ?? option.discoveryTabId].filter(Boolean).join(':'),
    kind: option.kind,
    visible: true,
    shelfId: option.shelfId,
    discoveryTabId: option.discoveryTabId,
  };
}

/** Reorder by dragging the handle (mouse or touch) or with arrow keys; toggle, add and remove rows. */
export function HomeEditor({ adapter }: { adapter: UiNextHomeAdapter }) {
  const [rows, setRows] = useState(adapter.config);
  const [drag, setDrag] = useState<{ id: string; offset: number } | null>(null);
  const [adding, setAdding] = useState(false);
  /** Source row being built (new) or edited (existing row id). */
  const [building, setBuilding] = useState<{ sourceId: string; rowId?: string } | null>(null);
  const origin = useRef(0);

  // Follow external changes (sync, reset) unless a drag is in progress.
  useEffect(() => {
    if (!drag) setRows(adapter.config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter.config]);

  const commit = (next: readonly HomeRowConfig[]) => {
    setRows(next);
    adapter.setConfig(next);
  };

  const builder = adapter.rowBuilder;
  if (building && builder) {
    const source = builder.sources.find((candidate) => candidate.id === building.sourceId);
    const editing = building.rowId ? rows.find((row) => row.id === building.rowId) : undefined;
    if (source)
      return (
        <HomeRowBuilder
          key={building.rowId ?? building.sourceId}
          source={source}
          sourceView={builder.sourceView(source.id)}
          session={builder.session}
          initial={editing?.section}
          onBack={() => setBuilding(null)}
          onSave={(section: HomeSourceRowSection) => {
            commit(
              editing
                ? rows.map((row) => (row.id === editing.id ? { ...row, section } : row))
                : [
                    ...rows,
                    {
                      // Several rows may come from one source; the id only has to be unique.
                      id: `source:${section.sourceId}:${Date.now().toString(36)}`,
                      kind: 'source',
                      visible: true,
                      section,
                    },
                  ],
            );
            setBuilding(null);
            setAdding(false);
          }}
        />
      );
  }

  if (adding) {
    const groups: { title: string; options: HomeRowOption[] }[] = [
      { title: '내 서재', options: adapter.rowOptions.filter((option) => !option.shelfId && !option.discoveryTabId) },
      { title: '책장', options: adapter.rowOptions.filter((option) => option.shelfId) },
      { title: '탐색 탭에서', options: adapter.rowOptions.filter((option) => option.discoveryTabId) },
    ].filter((group) => group.options.length > 0);
    return (
      <div className="un-home-editor">
        <button type="button" className="un-btn is-text un-home-editor-back" onClick={() => setAdding(false)}>
          <ChevronLeft size={18} />
          편집으로
        </button>
        {builder && builder.sources.length > 0 && (
          <>
            <h4 className="un-home-editor-group">소스에서 새 줄 만들기</h4>
            <ul className="un-home-editor-list">
              {builder.sources.map((source) => (
                <li key={source.id} className="un-home-editor-row">
                  <button
                    type="button"
                    className="un-home-editor-pick"
                    onClick={() => setBuilding({ sourceId: source.id })}
                  >
                    <span className="un-row-builder-avatar is-sm" aria-hidden="true">
                      {source.title.slice(0, 1)}
                    </span>
                    <span className="un-home-editor-text">
                      <b>{source.title}</b>
                      <small>목록과 필터를 골라 줄을 만들어요</small>
                    </span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {groups.map((group) => (
          <section key={group.title}>
            <h4 className="un-home-editor-group">{group.title}</h4>
            <ul className="un-home-editor-list">
              {group.options.map((option) => (
                <li key={configFromOption(option).id} className="un-home-editor-row">
                  <span className="un-home-editor-text">
                    <b>{option.label}</b>
                    <small>{option.hint}</small>
                  </span>
                  <button
                    type="button"
                    className="un-btn is-ghost is-sm"
                    onClick={() => {
                      commit([...rows, configFromOption(option)]);
                      setAdding(false);
                    }}
                  >
                    <Plus size={16} />
                    넣기
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && !builder?.sources.length && (
          <p className="un-home-editor-hint">더 넣을 수 있는 줄이 없어요.</p>
        )}
      </div>
    );
  }

  return (
    <div className="un-home-editor">
      <p className="un-home-editor-hint">손잡이를 끌어 순서를 바꾸고, 스위치로 줄을 숨기거나 보이게 해요.</p>
      <ul className="un-home-editor-list">
        <li className="un-home-editor-row is-fixed">
          <span className="un-home-editor-handle" aria-hidden="true" />
          <span className="un-home-editor-text">
            <b>이어 읽기</b>
            <small>맨 위 큰 배너 · 최근에 읽은 작품</small>
          </span>
        </li>
        {rows.map((row) => {
          const label = adapter.rowLabel(row);
          const removable = row.kind === 'shelf' || row.kind === 'discovery' || row.kind === 'source';
          const editable =
            row.kind === 'source' &&
            row.section &&
            builder?.sources.some((source) => source.id === row.section?.sourceId);
          return (
            <li
              key={row.id}
              className={cx('un-home-editor-row', drag?.id === row.id && 'is-dragging', !row.visible && 'is-hidden')}
              style={drag?.id === row.id ? { transform: `translateY(${drag.offset}px)` } : undefined}
            >
              <button
                type="button"
                className="un-home-editor-handle"
                aria-label={`${label} 순서 바꾸기`}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  origin.current = event.clientY;
                  setDrag({ id: row.id, offset: 0 });
                }}
                onPointerMove={(event) => {
                  if (drag?.id !== row.id) return;
                  let offset = event.clientY - origin.current;
                  const steps = Math.trunc(offset / ROW_HEIGHT + Math.sign(offset) * 0.5);
                  if (steps !== 0) {
                    const next = move(rows, row.id, steps);
                    if (next !== rows) {
                      setRows(next);
                      origin.current += steps * ROW_HEIGHT;
                      offset -= steps * ROW_HEIGHT;
                    }
                  }
                  setDrag({ id: row.id, offset });
                }}
                onPointerUp={() => {
                  setDrag(null);
                  adapter.setConfig(rows);
                }}
                onPointerCancel={() => {
                  setDrag(null);
                  setRows(adapter.config);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  commit(move(rows, row.id, event.key === 'ArrowUp' ? -1 : 1));
                }}
              >
                <GripVertical size={18} />
              </button>
              <span className="un-home-editor-text">
                <b>{label}</b>
                {row.kind === 'source' && row.section?.summary && <small>{row.section.summary}</small>}
              </span>
              {editable && (
                <button
                  type="button"
                  className="un-icon-btn is-sm"
                  aria-label={`${label} 줄 고치기`}
                  onClick={() => setBuilding({ sourceId: row.section!.sourceId, rowId: row.id })}
                >
                  <Pencil size={16} />
                </button>
              )}
              {removable && (
                <button
                  type="button"
                  className="un-icon-btn is-sm"
                  aria-label={`${label} 줄 빼기`}
                  onClick={() => commit(rows.filter((item) => item.id !== row.id))}
                >
                  <X size={16} />
                </button>
              )}
              <Switch
                label={`${label} 표시`}
                checked={row.visible}
                onChange={(visible) => commit(rows.map((item) => (item.id === row.id ? { ...item, visible } : item)))}
              />
            </li>
          );
        })}
      </ul>
      <div className="un-home-editor-actions">
        <button type="button" className="un-btn is-ghost" onClick={() => setAdding(true)}>
          <Plus size={18} />줄 추가
        </button>
        <button type="button" className="un-btn is-text" onClick={adapter.resetConfig}>
          기본값으로
        </button>
      </div>
    </div>
  );
}
