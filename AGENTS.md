# BOAA 작업 시작점

## 기준 확인

- 요청한 작업의 기준 버전부터 확인한다. 운영 검토는 실행 중인 배포의 커밋과 추가 패치를 기준으로 하며, `origin/main`이나 다른 작업 브랜치가 운영과 같다고 가정하지 않는다.
- 현재 동작은 해당 기준본의 실행 진입점·공유 타입·DB migration·설정에서 확인한다. 관련 행동 테스트는 검증 근거이며, 오래된 테스트의 문자열/파일 구조 기대가 제품 요구사항보다 우선하지 않는다.
- [문서 색인](docs/README.md)과 [현재 아키텍처](docs/architecture/current-architecture.md)에서 필요한 영역만 읽는다. 버전별 릴리스 기록, 지난 감사, Git 이력의 계획서는 현행 구현 지시가 아니다.

## 코드 찾기

| 작업 | 시작 위치 |
| --- | --- |
| 서버 웹/PWA, 인증 후 앱 구성 | `src/main.tsx`, `src/features/auth/`, `src/app/runtime/` |
| 화면과 독서 기능 | `src/App.tsx`, `src/ui-next/`, `src/features/` |
| API·DB·작업 큐 | `apps/server/src/server.ts`, `apps/server/src/routes/`, `apps/server/src/worker.ts` |
| 공통 계약·알고리즘 | `packages/`, `src/repositories/`의 port |
| 서버 없는 정적 웹 | `apps/web/src/main.tsx`, `apps/web/src/web-runtime.ts` |
| Windows·Android | [플랫폼 구조](docs/platforms/desktop.md), `src-tauri/` |

서버 웹, 정적 웹, 내장 서버 데스크톱은 저장·인증 경로가 다르다. 공유 코드의 다른 소비자를 확인하고 수정한다.
사이트별 확장 개발은 상위 `AGENTS.md`의 비공개 경계와 해당 비공개 작업 폴더 정책을 따른다. 이 저장소에는 사이트 중립 호스트 코드만 둔다.

## 검증과 문서

- 실행 명령·버전은 `package.json`, `pnpm-workspace.yaml`, 해당 CI workflow가 기준이다. [검증 가이드](docs/maintenance/testing.md)에 따라 변경 경계부터 검사한다.
- 공통 계약·인증/소유권·저장/복원·취소/재시도 변경은 관련 행동 및 통합 검증을 유지한다. 문서 수정 때문에 전체 브라우저/네이티브 빌드를 반복하지 않는다.
- 현행 동작을 바꾸면 담당 문서를 함께 수정한다. 완료된 구현의 계획서와 매 실행 로그를 새 영구 문서로 쌓지 않는다. [문서 관리 기준](docs/maintenance/documentation-policy.md)을 따른다.
- 구조 정리 후보는 [2026-10-25 유지보수 감사](docs/maintenance/2026-10-25-maintainability-audit.md)에 있다. 보고서의 제안과 이미 적용된 변경을 구별한다.
