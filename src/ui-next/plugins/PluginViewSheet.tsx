import type { PluginSettingsFailure } from '../../extensions/platform/plugin-settings-failure';
import type { ProductPluginSession } from '../../extensions/platform/product-session';
import { pluginContributionLabel } from '../../extensions/platform/plugin-presentation';
import { usePluginViewModel } from '../../extensions/platform/use-platform-plugin-editor-models';
import { Sheet } from '../components/primitives';
import { Notice } from '../components/prefs';
import { failureText } from './failure-text';
import './plugins.css';

function viewFailureText(issue: PluginSettingsFailure) {
  const code = issue.cause instanceof Error ? issue.cause.message : '';
  switch (code) {
    case 'UNKNOWN_VIEW':
      return '플러그인이 꺼져 있거나 이 화면을 더 이상 제공하지 않아요.';
    case 'VIEW_LIMIT':
      return '플러그인 화면이 이미 열려 있어요. 열린 화면을 닫고 다시 시도해 주세요.';
    case 'PLUGINS_DISABLED':
    case 'VIEW_UNAVAILABLE':
      return '지금은 플러그인을 사용할 수 없어요.';
    case 'VIEW_CLOSED':
      return '플러그인 화면이 닫혔어요. 다시 열어 주세요.';
    default:
      return failureText(issue);
  }
}

/** A declared plugin view in its sandboxed frame. Shared by settings and home row actions. */
export function PluginViewSheet({
  session,
  id,
  view,
  title,
  close,
}: {
  session: ProductPluginSession;
  id: string;
  view: string;
  /** Defaults to the view's contribution label. */
  title?: string;
  close(): void;
}) {
  const model = usePluginViewModel(session, id, view);
  return (
    <Sheet
      open
      onClose={close}
      title={title || pluginContributionLabel('view', view, [view])}
      className="un-plugin-sheet"
    >
      {model.error && (
        <div className="un-plugin-sheet-notice">
          <Notice tone="danger">{viewFailureText(model.error)}</Notice>
        </div>
      )}
      <div className="product-plugin-view un-plugin-view" ref={model.container} />
    </Sheet>
  );
}
