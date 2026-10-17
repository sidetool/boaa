import { useSaveDiscoveryListModel } from './use-save-discovery-list-model';
import { ModalDrawer } from '../../shared/ui/ModalDrawer';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { DiscoveryController } from './useDiscoveryController';
export function SaveDiscoveryList({
  discovery,
  source,
  close,
}: {
  discovery: DiscoveryController;
  source: ExternalSourceController;
  close(): void;
}) {
  const {
    target,
    setTarget,
    title,
    setTitle,
    saving,
    error: issue,
    disabled,
    submit,
  } = useSaveDiscoveryListModel({ discovery, source, close });
  const error =
    issue?.code === 'section_limit'
      ? '한 탭에는 목록을 60개까지 추가할 수 있습니다.'
      : issue?.code === 'save_failed'
        ? issue.cause instanceof Error
          ? issue.cause.message
          : '저장하지 못했습니다. 다시 시도해 주세요.'
        : '';

  return (
    <ModalDrawer
      open
      title="탐색에 목록 추가"
      onClose={close}
      closeDisabled={saving}
      className="discovery-editor"
      footer={
        <button
          type="button"
          className="primary-btn"
          disabled={disabled}
          onClick={async () => {
            await submit();
          }}
        >
          {saving ? '저장 중…' : '추가'}
        </button>
      }
    >
      <fieldset disabled={saving} className="discovery-edit-fields">
        <p>소스와 분류를 저장합니다. 검색어는 제외됩니다.</p>
        <label>
          탭
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {discovery.config.tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.title}
                {tab.hidden ? ' (숨김)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          목록 이름
          <input
            value={title}
            maxLength={70}
            placeholder="자동으로 이름 지정"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </ModalDrawer>
  );
}
