import { errorCode } from './runtime-policy';
export function readerPluginError(error: unknown): string {
  switch (errorCode(error)) {
    case 'CONTEXT_STALE':
      return '선택한 글이 바뀌었거나 시간이 지났습니다. 다시 선택해 주세요.';
    case 'PACKAGE_GENERATION_CHANGED':
    case 'PERMISSION_DENIED':
      return '플러그인이 변경되었거나 권한이 해제되었습니다. 설치 상태를 확인해 주세요.';
    case 'CAPABILITY_UNAVAILABLE':
      return '현재 이 플러그인을 실행할 수 없습니다.';
    case 'TIMEOUT':
      return '플러그인의 응답 시간이 초과되었습니다. 패널을 닫고 설치 상태를 확인해 주세요.';
    default:
      return '플러그인 실행이 중단되었습니다. 패널을 닫고 설치 상태를 확인해 주세요.';
  }
}
