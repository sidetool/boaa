import type { ServerManagementRequest } from '../../../packages/contracts/server-management';

export type MessageTone = 'info' | 'warning' | 'danger';
export interface ManagementMessage {
  readonly tone: MessageTone;
  readonly text: string;
}

/** The operator guide; site-specific providers and recovery steps live there, never in the app. */
export const RELEASE_GUIDE = 'deploy/release-management.md';
/** Runtime worker contract, including where private metadata providers are mounted. Ships in the install bundle. */
export const RUNTIME_GUIDE = 'services/runtime-components/README.md';

const FALLBACK: Record<ServerManagementRequest['action'], string> = {
  check: '새 버전을 확인하지 못했어요. 잠시 후 다시 확인해 주세요.',
  update: '업데이트를 마치지 못했어요. 지금 서버 버전과 상태를 다시 확인해 주세요.',
  // The updater saves the channel before checking, so a failed check may still have switched it.
  channel: '버전 확인을 마치지 못했어요. 선택한 받을 버전과 서버 상태를 다시 확인해 주세요.',
  component: '추가 기능을 바꾸지 못했어요. 다시 시도해 주세요.',
};

/**
 * Server and updater error codes in words: what happened and what to do. Unknown codes fall back to the action's
 * generic sentence so raw helper text never reaches the screen. Checks failing is mild; installs failing is not.
 */
export function managementErrorMessage(
  code: string | undefined,
  action: ServerManagementRequest['action'] = 'update',
): ManagementMessage {
  // Lookups (a check, or the check that follows a channel switch) failing is mild; installs failing is not.
  const checkTone: MessageTone = action === 'check' || action === 'channel' ? 'warning' : 'danger';
  switch (code) {
    case 'release_rate_limited':
      return { tone: 'warning', text: 'GitHub 조회 한도에 걸렸어요. 한 시간쯤 뒤에 다시 확인해 주세요.' };
    case 'release_not_found':
      return { tone: checkTone, text: '이 채널에서 받을 수 있는 릴리즈를 찾지 못했어요. 나중에 다시 확인해 주세요.' };
    case 'release_download_failed':
      return {
        tone: checkTone,
        text: '릴리즈 정보를 받지 못했어요. 서버의 인터넷 연결을 확인한 뒤 다시 시도해 주세요.',
      };
    case 'release_platform_unsupported':
      return { tone: 'warning', text: '이 서버의 CPU 종류에 맞는 버전이 아직 없어요.' };
    case 'release_trust_unconfigured':
    case 'release_configuration_invalid':
    case 'release_repository_invalid':
    case 'release_key_invalid':
      return {
        tone: 'warning',
        text: `서버의 릴리즈 확인 설정이 완전하지 않아요. 서버 관리자가 ${RELEASE_GUIDE}의 설치 안내를 확인해야 해요.`,
      };
    case 'release_signature_invalid':
    case 'release_trust_mismatch':
    case 'release_digest_invalid':
    case 'release_mutated':
    case 'release_manifest_invalid':
    case 'release_index_invalid':
    case 'release_image_manifest_invalid':
    case 'release_download_invalid':
    case 'release_tag_mismatch':
    case 'release_version_invalid':
    case 'release_version_mismatch':
    case 'release_size_limit':
      return {
        tone: 'danger',
        text: '받은 릴리즈의 서명이나 내용이 맞지 않아 설치하지 않았어요. 서버는 그대로예요. 계속되면 서버 관리자에게 알려 주세요.',
      };
    case 'update_jobs_active':
      return {
        tone: 'warning',
        text: '진행 중인 가져오기·다운로드가 제때 끝나지 않아 적용하지 않았어요. 작업이 끝난 뒤 다시 시도해 주세요.',
      };
    case 'management_request_expired':
      return {
        tone: 'warning',
        text: '요청이 오래 기다리다 실행되지 않고 만료됐어요. 서버는 바뀌지 않았으니 다시 시도해 주세요.',
      };
    case 'management_unavailable':
      return {
        tone: 'danger',
        text: `관리 도구가 요청을 처리할 수 없는 상태예요. 서버의 updater 상태를 확인해 주세요(${RELEASE_GUIDE} ‘운영과 복구’).`,
      };
    case 'update_interrupted':
      return {
        tone: 'warning',
        text: '요청이 적용 전에 중단됐어요. 지금 서버 상태를 다시 확인한 뒤 필요하면 다시 시도해 주세요.',
      };
    case 'update_space_required':
      return {
        tone: 'danger',
        text: '서버 디스크 공간이 부족해 적용하지 않았어요. 공간을 비운 뒤 다시 시도해 주세요.',
      };
    case 'update_migration_required':
      return {
        tone: 'warning',
        text: `이 버전은 데이터 구조가 바뀌어 화면에서 설치할 수 없어요. 서버 관리자가 ${RELEASE_GUIDE}에 따라 직접 전환해야 해요.`,
      };
    case 'update_backup_failed':
      return {
        tone: 'danger',
        text: '백업을 만들지 못해 적용하지 않았어요. 서버 디스크와 updater 로그를 확인해 주세요.',
      };
    case 'update_health_failed':
    case 'update_rolled_back':
      return {
        tone: 'danger',
        text: '새 버전이 정상적으로 뜨지 않아 이전 버전으로 되돌렸어요. 서재와 설정은 그대로예요.',
      };
    case 'update_recovery_required':
      return {
        tone: 'danger',
        text: `업데이트를 되돌리지 못해 서버 관리자의 복구가 필요해요. ${RELEASE_GUIDE}의 ‘운영과 복구’를 따라 주세요.`,
      };
    case 'deployment_drift':
      return {
        tone: 'danger',
        text: `서버 구성이 기록과 달라 변경을 멈췄어요. ${RELEASE_GUIDE}의 ‘운영과 복구’를 따라 구성을 맞춰 주세요.`,
      };
    case 'component_start_failed':
    case 'component_unavailable':
      return { tone: 'danger', text: '실행기가 응답하지 않아요. 다시 시도해도 계속되면 updater 로그를 확인해 주세요.' };
    case 'component_unsupported':
      return { tone: 'warning', text: '이 서버의 CPU 종류에서는 이 실행기를 쓸 수 없어요.' };
    case 'component_external':
      return { tone: 'info', text: '서버 설정에서 직접 관리하는 실행기라 여기서 바꾸지 않아요.' };
    default:
      return { tone: checkTone, text: FALLBACK[action] };
  }
}
