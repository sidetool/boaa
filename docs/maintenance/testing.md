# 테스트와 CI 유지보수

검토 기준: 운영 배포 `0550c99`, 2026-10-25. 운영 원격 파일 목록 캐시 수정도 포함한 별도 검토 작업 폴더에서 확인했다. 이 문서는 현재 실행 경로와 이번 정리 범위를 설명한다. 전체 테스트 통과나 운영 배포 완료를 뜻하지 않는다.

## 최초 문서·실행기 정리의 규모와 실제 문제

파일 수는 실행기별 발견 결과를 기준으로 한다. Rust 내장 테스트, Python, `.check.mjs`, fixture는 이 수치에 합산하지 않는다.

| 대상                                | 정리 전 | 정리 후 | 해석                                                                                                    |
| ----------------------------------- | ------: | ------: | ------------------------------------------------------------------------------------------------------- |
| 기본 Vitest 발견 파일               |   1,004 |     965 | 잘못 섞인 `node:test` 39개 제거. 38개는 별도 실행기로 유지하고 사용하지 않는 selector 테스트 1개만 삭제 |
| Quality CI의 Vitest 파일            |     520 |     520 | 발견 파일 집합을 비교하여 추가·누락 없음 확인                                                           |
| 남은 `node:test`의 `.test.mjs` 파일 |      39 |      38 | 아래 실행 경로에 38개 모두 대응                                                                         |
| 수동 Full checks 실질 작업/단계     |  5 / 47 |  5 / 47 | 사용하지 않는 변경 범위 선택 작업만 제거                                                                |

기본 `vitest run`은 Node 실행기용 파일까지 읽었다. 실제로 Node 테스트가 성공한 뒤 Vitest가 `No test suite found`로 실패하는 것을 재현했다. 브라우저·패키지 빌드 검사가 기본 단위 테스트 발견에 섞여 있어 개발 환경에 따라 불필요한 실패와 작업이 생길 수 있었다. 이제 TypeScript 테스트와 실제 Vitest를 사용하는 `scripts/performance/*.test.mjs`만 발견한다.

자동 Quality CI는 이미 `scripts/ci/quality-tests.mjs`로 12개 작업용 묶음의 합집합을 실행하고 있었다. 169개 명시 필터 중 19개 중복이 있으나 이 실행기가 제거한다. 이를 새로운 중복 실행 문제로 계산하지 않는다. `check:web-server`의 5개 묶음은 명시 필터 125개가 서로 다르다.

## 최초 문서·실행기 정리

- `Full checks`는 `workflow_dispatch` 전용인데 존재하지 않는 `pull_request.base.sha`를 변경 기준으로 사용했다. 항상 전체 선택이므로 `quality-scope.mjs`, 전용 테스트, 선택 작업 및 항상 참인 조건을 제거했다. 5개 실제 작업과 47개 단계는 유지했다. 선택기의 9개 테스트는 제거한 기능만 검증하므로 함께 삭제했다.
- `vite.config.ts`에서 Vitest와 Node 테스트의 실행 범위를 분리했다. Node 실행이 필요한 기존 검사와 브라우저 검사를 Vitest로 대신 실행하지 않는다.
- `test:tooling`을 추가해 기존 도구 검사 6개 파일을 한 명령으로 실행한다. 기본 `test`에도 연결했다. CI 전체 실행 범위는 늘리지 않았다.
- `check:web-server` 마지막 `build`를 `vite build`로 바꿨다. 앞선 `typecheck`에 웹 TypeScript 검사가 이미 있으므로 같은 타입 검사를 반복하지 않는다. 독립 `build` 명령의 타입 검사는 유지한다.
- Compose 보안 테스트에서 주석 문구를 요구하는 assertion만 제거했다. 실제 loopback 바인딩, 노출 설정, API 포트 비공개 검사는 유지했다.
- 리더 성능 검사 사전 계약을 현재 화면 연결에 맞췄다. `ImportFeatureHost → UiNextImportSheet`, `App → ReaderFeatureHost → ReaderScreen`, 공유 `packages/reader-core/search-policy.ts`를 확인한다. 이전 UI 파일, 오래된 콜백 식, 옮겨진 검색 정책 때문에 실패하던 4개 항목을 수정했다. 검색 한도 200/300과 실제 성능 예산은 바꾸지 않았다. 검사 항목 수를 고정하는 assertion도 제거했다.

제품 동작 테스트나 데이터 보호 테스트는 삭제하지 않았다.

## 후속 리팩토링의 검증 정리

사용자 승인 후 옛 UI 11개를 제거하면서 기존 UI 테스트 5개를 실제 화면인 `src/ui-next/`로 옮겼다.
백업 충돌·가져오기 처리 상태·인코딩·시리즈 계획·비동기 저장·원본 다운로드·닫기 검증을 유지했다.
`original-files-smoke.mjs`도 현재 `UiNextOriginalFilesSheet`를 사용한다. Chromium에서 320/390/1366px
화면, 다운로드 바이트·파일명, 페이지 추가, Escape 닫기와 콘솔 오류 없음을 확인했다.

대부분의 새 회귀 조건은 기존 테스트 파일에 추가했다. 실제 PostgreSQL에서 bulk INSERT의 원자성과
책장 작업의 소유권·부분 성공·동시 멱등 요청을 검증하는 `hosted-bulk-write.integration.test.ts`만
새 테스트 파일이다. 복구 큐의 오래된 응답·초기 실패 후 재시도, 계정 전환, 업로드 저장 후 갱신 실패,
ETag·본문 버전 충돌 검증을 유지한다. 자동 Quality에 빠져 있던 관련 파일도 명시 필터로 연결했다.
합집합 실행 방식은 유지하므로 중첩 필터가 같은 파일을 여러 번 실행하지 않는다.
현재 Quality는 532개 파일을 선택한다. 옛 원본 파일 UI의 개별 필터는 제거했고 현재 테스트는
기존 `src/ui-next` 디렉터리 선택에 포함된다. 리더 viewport의 옛 콜백 인자 개수 assertion도
불필요한 optional 인자 표기에 결합되지 않도록 실제 복원 페이지 요청 검증으로 바꿨다.

구체적인 구현 검증 결과와 미검증 범위는 [유지보수 감사](2026-10-25-maintainability-audit.md)의
후속 적용 현황을 따른다. 아래 최초 정리의 520개와 현재 선택 파일 수를 혼동하지 않는다.

## 실행 경로

수정한 영역을 먼저 좁혀 실행한다. 전체 실행은 변경 범위나 릴리스 검증이 필요할 때 사용한다.

| 목적                                                        | 명령 / 위치                                                                                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 특정 동작 회귀                                              | `pnpm exec vitest run <파일 또는 디렉터리> --maxWorkers=2`                                                                                                                                            |
| 자동 Quality와 같은 Vitest 합집합                          | `node scripts/ci/quality-tests.mjs`; 현재 파일 수와 목록은 `--list`로 확인                                                                                                                            |
| 기본 Vitest 전체 + 도구 + 확장 런타임                       | `pnpm test`                                                                                                                                                                                           |
| CI 참조·환경 초기화·설정 코드·공개 경계·내장 서버 공유/터널 | `pnpm test:tooling` — 6개 Node 파일                                                                                                                                                                   |
| 릴리스 도구 + APK worker + runtime-components               | `node --test --test-concurrency=2 scripts/release/*.test.mjs services/apk-worker/*.test.mjs services/runtime-components/runtime.test.mjs` — 18개 Node 파일                                            |
| 확장 SDK/CLI 빌드                                           | `pnpm test:extension-sdk`, `pnpm test:extension-cli` — 2개 Node 파일                                                                                                                                  |
| text-source companion                                       | `services/text-source-server`에서 `npm test` — 8개 Node 파일, 해당 서비스 의존성 필요                                                                                                                 |
| 리더 CSP·폰트·선택 브라우저 검사                            | `node --test --test-concurrency=1 scripts/desktop/source-cover-csp.test.mjs scripts/desktop/user-font-csp.test.mjs scripts/desktop/reader-selection.test.mjs` — 3개 Node 파일, Full checks에서도 실행 |
| 자동 읽기 오버레이 브라우저 검사                            | `node --test scripts/desktop/auto-reading-overlay.test.mjs` — 1개 Node 파일, Chromium 필요                                                                                                            |
| 확장 QuickJS 런타임                                         | `pnpm test:extension-runtime` — `.check.mjs`, 위 38개에 미포함                                                                                                                                        |
| 브라우저·Compose·Windows 종합                               | GitHub Actions `Full checks` 수동 실행                                                                                                                                                                |

Python/runtime 및 릴리스 검사는 각각 `python3 -m unittest discover -s services/runtime-components -p 'test_*.py'`, `python3 -m unittest discover -s scripts/release -p 'test_*.py'`로 유지한다. Rust와 실제 브라우저 검사는 기존 개별 명령과 워크플로를 유지한다.

## 남겨둔 개선 후보

| 후보                                                | 근거와 다음 조치                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy-hash-import-guard.test.ts`의 고정 허용 목록 | 운영 기준에서 7개 추가 import로 이미 실패한다. 해당 사용이 기존 식별자 호환성인지 검토해야 한다. 허용 목록을 무작정 늘리거나 검사를 지우지 않았다. 목록 전체 동일성은 레거시 의존성을 줄여도 실패하므로 향후에는 허용되지 않은 추가만 막는 방식이 적합하다.                                                     |
| SQL 원문 검증 테스트                                | `fixed-document-*`, `speaker-workflow-lineage`, `self-host-auth`, `voice-casting` 등은 SQL 문자열에 결합되어 있다. 제약 조건·데이터 이행을 실제 PostgreSQL로 확인하는 테스트와 항목별 대응표를 만든 뒤 중복만 합친다. DB 없는 환경에서 제공하는 신호가 있어 일괄 삭제하지 않았다.                               |
| 리더 CSS 문자열 assertion                           | `reader-hot-path.test.tsx` 마지막 이미지 크기 검사는 CSS 표현에 결합되어 있다. 실제 이미지·페이지 넘김 기하 검증으로 대체할 때 기존 회귀 조건을 이전해야 한다. 이번에는 유지했다.                                                                                                                               |
| 리더 성능 사전 계약의 문자열 검사                   | 현재 연결 오류는 고쳤지만 소스 표현에 결합된 방식은 남아 있다. 실제 성능 게이트의 import 취소, worker 사용, 저장, 가상화, 검색 제한 측정과 대응시킨 뒤 중복 문자열 검사를 줄인다.                                                                                                                               |
| Quality의 선택 실행 범위                            | 자동 Quality는 Vitest 전체가 아닌 선택한 파일의 합집합이다. `pnpm test`나 수동 Full checks가 모든 독립 검사까지 실행한다는 의미는 아니다. 새 회귀 테스트를 추가할 때 해당 CI 선택에 들어가는지 `--list`로 확인한다. 기존 QuickJS/SDK/CLI 검사는 수동 Full checks에는 있지만 자동 Quality에는 직접 연결되어 있지 않다. |

FNV 허용 목록에 없던 기존 7개 경로: `SourceStreamReader.tsx`, `SourceTextStreamReader.tsx`, `continuous-comic-window.ts`, `source-text-document.ts`, `source-work-reading-time.ts` (`src/features/external-sources/`), `local-document-series-import.ts`, `local-series-import.ts` (`src/features/import/`). 운영 코드 변경 없이 발견 사실만 남겼다.

## 최초 정리의 검증 결과와 한계

- `test:tooling`과 같은 Node 명령: 6개 파일, 18개 검사 통과.
- 변경한 Compose 검사 + 성능 관련 Vitest 3개 파일: 4개 파일, 12개 검사 통과.
- 변경 전후 Quality 발견 목록: 520개로 정확히 동일.
- 기본 Vitest 발견 목록: Node 실행기용 39개만 제외되고 실제 Vitest 파일은 동일.
- Full checks YAML을 구조적으로 비교: 실제 5개 작업과 47개 단계가 동일하며 삭제된 selector 테스트 명령만 제외.
- 변경 파일의 형식과 ESLint 검사 수행.

이번 작업에서 전체 965개 Vitest, 실제 브라우저 성능 측정, Docker E2E, Windows/Rust 빌드를 모두 실행하지는 않았다. 기존 FNV 검사 실패는 위 표에 별도 기록했으며 실패를 숨기기 위한 제외나 허용 목록 변경은 하지 않았다. 의존성 설치 시 `cpu-features`/`ssh2` 빌드 승인 상태 때문에 pnpm의 자동 재설치가 실패하여 로컬 검증에는 설치된 실행기를 직접 사용했다.
