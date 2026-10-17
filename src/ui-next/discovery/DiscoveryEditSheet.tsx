import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2, Undo2 } from 'lucide-react';
import type { ExternalSourceView } from '../../features/external-sources/useExternalSourceController';
import { newTab, type DiscoveryConfig } from '../../features/discovery/discovery-config';
import { useDiscoveryEditorModel } from '../../features/discovery/use-discovery-editor-model';
import { cx, Segmented, Sheet, Switch } from '../components/primitives';
import { Notice, PrefField, PrefFold } from '../components/prefs';
import './discovery-tools.css';

/** 탐색 편집: tabs and the lists inside them. Nothing changes until 저장. */
export function DiscoveryEditSheet({
  config,
  sources,
  save,
  close,
}: {
  config: DiscoveryConfig;
  sources: readonly ExternalSourceView[];
  save(value: DiscoveryConfig, base: DiscoveryConfig): void | Promise<void>;
  close(): void;
}) {
  const model = useDiscoveryEditorModel({ config, sources, save, close });
  const { draft } = model;
  const sourceTitle = (id: string) => sources.find((source) => source.id === id)?.title;
  const error =
    model.error?.code === 'invalid_tabs'
      ? '탭마다 이름을 적고, 탭을 하나 이상 보이게 해 주세요.'
      : model.error?.code === 'save_failed'
        ? model.error.cause instanceof Error
          ? model.error.cause.message
          : '저장하지 못했어요. 다시 해 주세요.'
        : undefined;

  return (
    <Sheet
      open
      onClose={close}
      closeDisabled={model.saving}
      title="탐색 편집"
      footer={
        <>
          <button type="button" className="un-btn is-ghost" disabled={model.saving} onClick={close}>
            취소
          </button>
          <button type="button" className="un-btn is-primary" disabled={model.saving} onClick={model.submit}>
            {model.saving ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <fieldset className="un-dtools un-dedit" disabled={model.saving}>
        <div className="un-dedit-bar">
          <strong>탭 {draft.tabs.length}개</strong>
          <button
            type="button"
            className="un-btn is-ghost is-sm"
            disabled={draft.tabs.length >= 30}
            onClick={() => model.addTab(newTab())}
          >
            <Plus size={15} />탭 추가
          </button>
        </div>
        {model.undo && (
          <Notice
            action={
              <button type="button" className="un-btn is-text is-sm" onClick={model.restore}>
                <Undo2 size={14} />
                되돌리기
              </button>
            }
          >
            구성을 바꿨어요.
          </Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}

        {draft.tabs.map((tab, index) => {
          const open = model.expandedTab === tab.id;
          return (
            <section key={tab.id} className={cx('un-dedit-tab', open && 'is-open', tab.hidden && 'is-hidden')}>
              <div className="un-dedit-tab-head">
                <button
                  type="button"
                  className="un-dedit-toggle"
                  aria-expanded={open}
                  onClick={() => model.setExpandedTab(open ? undefined : tab.id)}
                >
                  <span>
                    <b>{tab.title || '이름 없는 탭'}</b>
                    <small>
                      목록 {tab.sections.length}개{tab.hidden ? ' · 숨김' : ''}
                    </small>
                  </span>
                  <ChevronDown size={18} aria-hidden="true" />
                </button>
                <Switch
                  label={`${tab.title} 탭 보이기`}
                  checked={!tab.hidden}
                  onChange={(on) => model.showTab(index, on)}
                />
              </div>
              {open && (
                <div className="un-dedit-body">
                  <PrefField label="탭 이름">
                    <input
                      ref={(node) => {
                        if (node && model.focusNewTab === tab.id) {
                          node.focus();
                          node.select();
                          model.setFocusNewTab(undefined);
                        }
                      }}
                      value={tab.title}
                      maxLength={40}
                      onChange={(event) => model.renameTab(index, event.target.value)}
                    />
                  </PrefField>
                  <div className="un-dedit-tools">
                    <button
                      type="button"
                      className="un-icon-btn is-sm"
                      aria-label={`${tab.title} 탭 위로`}
                      disabled={index === 0}
                      onClick={() => model.moveTab(index, -1)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="un-icon-btn is-sm"
                      aria-label={`${tab.title} 탭 아래로`}
                      disabled={index === draft.tabs.length - 1}
                      onClick={() => model.moveTab(index, 1)}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      type="button"
                      className="un-btn is-text is-sm un-dedit-remove"
                      onClick={() => model.removeTab(index)}
                    >
                      <Trash2 size={14} />탭 지우기
                    </button>
                  </div>

                  <ul className="un-dedit-lists">
                    {tab.sections.map((section, sectionIndex) => {
                      const sectionOpen = model.expandedSection === section.id;
                      const name = section.title || sourceTitle(section.sourceId) || '쓸 수 없는 소스';
                      return (
                        <li
                          key={section.id}
                          className={cx(sectionOpen && 'is-open')}
                          id={`discovery-row-${section.id}`}
                        >
                          <button
                            type="button"
                            className="un-dedit-toggle"
                            aria-expanded={sectionOpen}
                            onClick={() => model.setExpandedSection(sectionOpen ? undefined : section.id)}
                          >
                            <span>
                              <b>{name}</b>
                              <small>
                                {section.mode === 'popular' ? '인기' : '최신'}
                                {section.filters?.length ? ' · 분류 있음' : ''}
                              </small>
                            </span>
                            <ChevronDown size={16} aria-hidden="true" />
                          </button>
                          {sectionOpen && (
                            <div className="un-dedit-list-body">
                              <PrefField label="소스">
                                <select
                                  aria-label="목록 소스"
                                  value={section.sourceId}
                                  onChange={(event) => model.setSectionSource(index, sectionIndex, event.target.value)}
                                >
                                  {!sourceTitle(section.sourceId) && (
                                    <option value={section.sourceId}>쓸 수 없는 소스</option>
                                  )}
                                  {sources.map((source) => (
                                    <option key={source.id} value={source.id}>
                                      {source.title}
                                    </option>
                                  ))}
                                </select>
                              </PrefField>
                              <Segmented
                                label="목록 종류"
                                value={section.mode}
                                options={[
                                  { value: 'popular', label: '인기' },
                                  { value: 'latest', label: '최신' },
                                ]}
                                onChange={(mode) => model.setSectionMode(index, sectionIndex, mode)}
                              />
                              <PrefField label="목록 이름" help="비우면 소스 이름과 목록 종류로 보여요.">
                                <input
                                  value={section.title}
                                  maxLength={70}
                                  placeholder="자동"
                                  onChange={(event) => model.setSectionTitle(index, sectionIndex, event.target.value)}
                                />
                              </PrefField>
                              <div className="un-dedit-tools">
                                <button
                                  type="button"
                                  className="un-icon-btn is-sm"
                                  aria-label="목록 위로"
                                  disabled={!sectionIndex}
                                  onClick={() => model.moveSection(index, sectionIndex, -1)}
                                >
                                  <ArrowUp size={15} />
                                </button>
                                <button
                                  type="button"
                                  className="un-icon-btn is-sm"
                                  aria-label="목록 아래로"
                                  disabled={sectionIndex === tab.sections.length - 1}
                                  onClick={() => model.moveSection(index, sectionIndex, 1)}
                                >
                                  <ArrowDown size={15} />
                                </button>
                                <button
                                  type="button"
                                  className="un-btn is-text is-sm un-dedit-remove"
                                  onClick={() => model.removeSection(index, sectionIndex)}
                                >
                                  <Trash2 size={14} />
                                  목록 지우기
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {!tab.sections.length && <p className="un-dtools-note">소스를 골라 목록을 더해 보세요.</p>}
                  <button
                    type="button"
                    className="un-btn is-ghost is-sm un-dedit-add"
                    disabled={!sources.length || tab.sections.length >= 60}
                    onClick={() => model.addSection(index)}
                  >
                    <Plus size={15} />
                    목록 추가
                  </button>
                </div>
              )}
            </section>
          );
        })}

        <PrefFold title="추천 구성으로 다시 시작" summary="만화·소설·웹툰 탭">
          <div className="un-dedit-template">
            <p className="un-dtools-note">지금 구성을 기본 탭으로 바꿔요. 저장하기 전에는 되돌릴 수 있어요.</p>
            <button
              type="button"
              className="un-btn is-ghost is-sm"
              onClick={() => model.applyTemplate([newTab('만화'), newTab('소설'), newTab('웹툰')])}
            >
              연결한 소스로 만들기
            </button>
          </div>
        </PrefFold>
        <p className="un-dtools-note">탭을 지워도 소스와 받은 작품은 그대로예요.</p>
      </fieldset>
    </Sheet>
  );
}
