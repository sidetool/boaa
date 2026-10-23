import type { PluginSettingsFailure } from '../../extensions/platform/plugin-settings-failure';

/** User-facing text for plugin settings and view failures. */
export function failureText(issue: PluginSettingsFailure) {
  switch (issue.code) {
    case 'migration_requires_disabled':
      return '설정을 옮기려면 먼저 플러그인을 끄고 파일을 다시 검토해 주세요.';
    case 'disable_revoke_failed':
      return '플러그인은 멈췄어요. 서버에 닿지 않아 보관된 연결 정보가 지워졌는지는 확인하지 못했어요.';
    case 'remove_revoke_failed':
      return '플러그인은 지웠어요. 서버에 닿지 않아 보관된 연결 정보가 지워졌는지는 확인하지 못했어요.';
    case 'review_stale':
      return '다른 기기에서 플러그인이 변경됐거나 검토가 끝났어요. 파일을 다시 선택해 주세요.';
    case 'update_revoke_failed':
      return '업데이트는 완료했어요. 이전 연결 정리는 확인하지 못했어요. 외부 서비스 연결을 확인해 주세요.';
    case 'connection_setup_failed':
      return '플러그인은 설치했어요. 아래 외부 서비스에서 연결을 다시 저장해 주세요.';
    case 'missing_config':
      return '작성자가 공통 설정을 주지 않았어요. 플러그인 화면을 확인해 주세요.';
    default:
      return issue.cause instanceof Error ? issue.cause.message : '처리하지 못했어요.';
  }
}
