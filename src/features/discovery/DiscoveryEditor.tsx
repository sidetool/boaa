import { useDiscoveryEditorModel } from './use-discovery-editor-model';
import { ModalDrawer } from '../../shared/ui/ModalDrawer';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import { newTab, type DiscoveryConfig } from './discovery-config';

export function DiscoveryEditor({
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
  const {
    draft,
    saving,
    expandedTab,
    setExpandedTab,
    expandedSection,
    setExpandedSection,
    focusNewTab,
    setFocusNewTab,
    error: issue,
    undo,
    submit,
    addTab,
    applyTemplate,
    restore,
    moveTab,
    dropTab,
    renameTab,
    removeTab,
    showTab,
    moveSection,
    dropSection,
    setSectionSource,
    setSectionMode,
    setSectionTitle,
    removeSection,
    addSection,
  } = useDiscoveryEditorModel({ config, sources, save, close });
  const error =
    issue?.code === 'invalid_tabs'
      ? '각 탭의 이름을 입력하고 탭을 하나 이상 표시해 주세요.'
      : issue?.code === 'save_failed'
        ? issue.cause instanceof Error
          ? issue.cause.message
          : '저장하지 못했습니다. 다시 시도해 주세요.'
        : '';

  return (
    <ModalDrawer
      open
      title="탐색 편집"
      onClose={close}
      closeDisabled={saving}
      closeLabel="탐색 편집 닫기"
      className="discovery-editor"
      footer={
        <>
          <button type="button" className="ghost-btn" disabled={saving} onClick={close}>
            취소
          </button>
          <button type="button" className="primary-btn" disabled={saving} onClick={submit}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <fieldset disabled={saving} className="discovery-edit-fields">
        <div className="discovery-editor-toolbar">
          <strong>탭 {draft.tabs.length}개</strong>
          <button
            type="button"
            className="primary-btn"
            disabled={draft.tabs.length >= 30}
            onClick={() => addTab(newTab())}
          >
            탭 추가
          </button>
          <button type="button" className="ghost-btn" onClick={() => setExpandedTab(undefined)}>
            모두 접기
          </button>
        </div>
        <details className="discovery-editor-template">
          <summary>처음부터 추천 구성으로 시작</summary>
          <p className="discovery-footnote">현재 구성을 기본 탭으로 바꿉니다. 저장 전에는 취소할 수 있습니다.</p>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => applyTemplate([newTab('만화'), newTab('소설'), newTab('웹툰')])}
          >
            연결된 소스로 추천 구성 만들기
          </button>
        </details>
        {error && <p role="alert">{error}</p>}
        {undo && (
          <button type="button" onClick={restore}>
            변경 되돌리기
          </button>
        )}
        {draft.tabs.map((tab, index) => (
          <section
            className="discovery-editor-tab"
            key={tab.id}
            aria-label={`${tab.title} 탭 편집`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              dropTab(event.dataTransfer.getData('text/boaa-tab'), index);
            }}
          >
            <button
              type="button"
              className="discovery-editor-toggle"
              aria-expanded={expandedTab === tab.id}
              aria-controls={`discovery-tab-${tab.id}`}
              onClick={() => setExpandedTab(expandedTab === tab.id ? undefined : tab.id)}
            >
              <span>
                <strong>{tab.title || '이름 없는 탭'}</strong>
                <small>
                  목록 {tab.sections.length}개 · {tab.hidden ? '숨김' : '표시 중'}
                </small>
              </span>
              <span aria-hidden="true">{expandedTab === tab.id ? '⌃' : '⌄'}</span>
            </button>
            <div id={`discovery-tab-${tab.id}`} hidden={expandedTab !== tab.id} className="discovery-editor-tab-body">
              <div className="discovery-editor-heading">
                <button
                  type="button"
                  draggable
                  aria-label={`${tab.title} 탭 순서 끌기`}
                  title="드래그하거나 옆의 위·아래 버튼으로 순서를 바꿀 수 있습니다"
                  onDragStart={(event) => event.dataTransfer.setData('text/boaa-tab', tab.id)}
                >
                  ↕
                </button>
                <label>
                  탭 이름
                  <input
                    ref={(node) => {
                      if (node && focusNewTab === tab.id) {
                        node.focus();
                        node.select();
                        setFocusNewTab(undefined);
                      }
                    }}
                    value={tab.title}
                    maxLength={40}
                    onChange={(e) => renameTab(index, e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  aria-label={`${tab.title} 탭 위로`}
                  disabled={index === 0}
                  onClick={() => moveTab(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`${tab.title} 탭 아래로`}
                  disabled={index === draft.tabs.length - 1}
                  onClick={() => moveTab(index, 1)}
                >
                  ↓
                </button>
                <button type="button" onClick={() => removeTab(index)}>
                  탭 삭제
                </button>
              </div>
              <div className="discovery-editor-heading">
                <label>
                  <input type="checkbox" checked={!tab.hidden} onChange={(e) => showTab(index, e.target.checked)} />
                  표시
                </label>
              </div>
              {tab.sections.map((section, sectionIndex) => (
                <div
                  key={section.id}
                  className="discovery-editor-section"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    dropSection(index, event.dataTransfer.getData('text/boaa-section'), sectionIndex);
                  }}
                >
                  <button
                    type="button"
                    className="discovery-editor-toggle"
                    aria-expanded={expandedSection === section.id}
                    aria-controls={`discovery-row-${section.id}`}
                    onClick={() => setExpandedSection(expandedSection === section.id ? undefined : section.id)}
                  >
                    <span>
                      <strong>
                        {section.title ||
                          sources.find((s) => s.id === section.sourceId)?.title ||
                          '사용할 수 없는 소스'}
                      </strong>
                      <small>
                        {section.mode === 'popular' ? '인기' : '최신 업데이트'}
                        {section.filters?.length ? ' · 분류 적용' : ''}
                      </small>
                    </span>
                    <span aria-hidden="true">{expandedSection === section.id ? '⌃' : '⌄'}</span>
                  </button>
                  <div
                    id={`discovery-row-${section.id}`}
                    hidden={expandedSection !== section.id}
                    className="discovery-editor-row-body"
                  >
                    <label>
                      소스
                      <select
                        aria-label="목록 소스"
                        value={section.sourceId}
                        onChange={(e) => setSectionSource(index, sectionIndex, e.target.value)}
                      >
                        {!sources.some((s) => s.id === section.sourceId) && (
                          <option value={section.sourceId}>사용할 수 없는 소스</option>
                        )}
                        {sources.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      목록
                      <select
                        value={section.mode}
                        onChange={(e) => setSectionMode(index, sectionIndex, e.target.value as 'popular' | 'latest')}
                      >
                        <option value="popular">인기</option>
                        <option value="latest">최신 업데이트</option>
                      </select>
                    </label>
                    <label>
                      목록 이름
                      <input
                        value={section.title}
                        placeholder="소스 이름과 목록 종류로 표시"
                        maxLength={70}
                        onChange={(e) => setSectionTitle(index, sectionIndex, e.target.value)}
                      />
                    </label>
                    {section.filters?.length ? <span>저장한 분류 적용 중</span> : null}
                    <div className="discovery-editor-heading">
                      <button
                        type="button"
                        draggable
                        aria-label="목록 순서 끌기"
                        title="드래그하거나 위·아래 버튼으로 이동"
                        onDragStart={(event) => {
                          event.stopPropagation();
                          event.dataTransfer.setData('text/boaa-section', section.id);
                        }}
                      >
                        ↕
                      </button>
                      <button
                        type="button"
                        aria-label="목록 위로"
                        disabled={!sectionIndex}
                        onClick={() => moveSection(index, sectionIndex, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label="목록 아래로"
                        disabled={sectionIndex === tab.sections.length - 1}
                        onClick={() => moveSection(index, sectionIndex, 1)}
                      >
                        ↓
                      </button>
                      <button type="button" onClick={() => removeSection(index, sectionIndex)}>
                        목록 삭제
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {!tab.sections.length && <p className="discovery-footnote">소스를 선택해 목록을 추가하세요.</p>}
              <button
                type="button"
                className="ghost-btn"
                disabled={!sources.length || tab.sections.length >= 60}
                onClick={() => {
                  const id = addSection(index);
                  if (!id) return;
                  requestAnimationFrame(() => {
                    const field = document.getElementById(`discovery-row-${id}`)?.querySelector('select');
                    field?.focus();
                  });
                }}
              >
                목록 추가
              </button>
            </div>
          </section>
        ))}
        <p>탭을 삭제해도 소스와 다운로드는 유지됩니다.</p>
      </fieldset>
    </ModalDrawer>
  );
}
