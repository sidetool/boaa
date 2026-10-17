import type { DiscoveryController } from '../../features/discovery/useDiscoveryController';
import { useSaveDiscoveryListModel } from '../../features/discovery/use-save-discovery-list-model';
import type { ExternalSourceController } from '../../features/external-sources/useExternalSourceController';
import { Sheet } from '../components/primitives';
import { Notice, PrefField, PrefGroup } from '../components/prefs';
import './discovery-tools.css';

/** 탐색에 목록 저장: keep this source and its filters as a list in a discovery tab (search words excluded). */
export function SaveListSheet({
  discovery,
  source,
  close,
}: {
  discovery: DiscoveryController;
  source: ExternalSourceController;
  close(): void;
}) {
  const model = useSaveDiscoveryListModel({ discovery, source, close });
  const error =
    model.error?.code === 'section_limit'
      ? '한 탭에는 목록을 60개까지 넣을 수 있어요.'
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
      title="탐색에 목록 저장"
      footer={
        <button
          type="button"
          className="un-btn is-primary un-dtools-wide"
          disabled={model.disabled}
          onClick={() => void model.submit()}
        >
          {model.saving ? '저장 중…' : '저장'}
        </button>
      }
    >
      <div className="un-dtools">
        <p className="un-dtools-note">지금 보는 소스와 분류를 저장해요. 검색어는 빠져요.</p>
        <PrefGroup>
          <PrefField label="넣을 탭">
            <select
              value={model.target}
              disabled={model.saving}
              onChange={(event) => model.setTarget(event.target.value)}
            >
              {model.tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.title}
                  {tab.hidden ? ' (숨김)' : ''}
                </option>
              ))}
            </select>
          </PrefField>
          <PrefField label="목록 이름" help="비워 두면 알아서 이름을 붙여요.">
            <input
              value={model.title}
              maxLength={70}
              disabled={model.saving}
              placeholder="자동"
              onChange={(event) => model.setTitle(event.target.value)}
            />
          </PrefField>
        </PrefGroup>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Sheet>
  );
}
