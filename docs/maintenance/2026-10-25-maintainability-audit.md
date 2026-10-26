# BOAA 유지보수 검토 — 2026-10-25

## 검토 기준과 결론

사용자가 선택한 **현재 운영 배포 코드**를 기준으로 검토했다. 공개 `origin/main`과 운영 코드는 같지 않다.
운영 웹 배포 기록의 `0550c99`에 별도로 배포된 원격 파일 목록 취소 수정 5개 파일을 반영한
로컬 기준 커밋은 `9ee2947`이다. 이미지에 남은 beta.4 버전 표지만으로 소스를 판단하면 안 된다.
이 문서는 해당 시점의 감사 결과와 이후 적용 범위를 구분한다. 최초 제안 전체가 구현된 것으로 해석하지 않는다.
**현재 검증 결과는 아래 「운영 반영 전 실환경 검증」을 기준으로 한다.** 앞선 단계별 실패 기록은
진행 당시의 이력이며 현재 실패 목록이 아니다. 최종 원인 분석·코드 검토·수정은 주 에이전트가
직접 수행했고, 마지막 Sol 작업 범위는 지정 명령 실행과 원시 결과 보고로 제한했다.

**구현 전 회귀 검토 결과, 아래 제안을 그대로 한꺼번에 적용해도 안전하다고 판단할 수는 없다.**
저장본 재조회 제거, 같은 원본의 재해석, 해시 캐시, 복구 실행 순서에서 구체적인 회귀 조건을 확인해
제안을 수정했다. 각 항목의 변경 경계와 뒤의 구현 전 검증 기준을 함께 적용해야 한다.

부담의 원인은 단순한 파일 개수보다 **전체 목록을 다시 읽는 여러 소유자, 교체 후 남은 UI,
현재 구현과 어긋난 문서·검사**에 있다. 실제 중복 호출과 파일 버전 검증 누락도 확인했다.
최초 정리는 문서·테스트 실행 경로에 한정했고, 이후 사용자 승인으로 아래 적용 현황의 제품 코드를
리팩토링했다. 검토와 구현은 운영 기준을 복제한 작업 폴더에서 진행했고, 최종적으로 사용자 승인 후
`a371efe`의 웹·API·작업자를 운영에 반영했다. 아래 운영 반영 결과를 따른다. 외부 저장소에는
업로드하지 않았다. 아래 A1–A16의 근거·줄 번호는 최초 감사 시점의 기록이다.

검토 방법은 호출 경로 추적, TypeScript import 분석 후 전체 참조 재검색, 합성 객체 실행,
문서·CI·테스트 진입점 대조다. 운영 사용자 요청을 발생시키거나 전체 성능을 측정한 결과는 아니다.
`확정`은 코드 경로나 합성 실행으로 확인했다는 뜻이며 운영 장애 발생 여부를 뜻하지 않는다.

### 규모

정리 전 `9ee2947`의 Git 추적 파일 기준이다. 외부 라이선스·자산도 전체 파일 수에 포함된다.

| 항목                              |  측정값 | 해석                                                                  |
| --------------------------------- | ------: | --------------------------------------------------------------------- |
| 추적 파일                         |   4,824 | 이 수만으로 삭제 대상을 정할 수 없음                                  |
| Markdown                          |      90 | 현재 안내·과거 계획·라이선스 문서 혼재                                |
| `*.test.*`, `*.spec.*` 파일       |   1,009 | fixture 전체나 테스트 case 수가 아님                                  |
| 루트 package script               |     111 | 기능별 선택 실행과 전체 검증의 경계가 불명확                          |
| Quality CI가 선택하는 Vitest 파일 |     520 | 이미 합집합으로 중복 제거됨; 최초 문서·실행기 정리에서 동일 집합 보존 |
| `src/App.tsx`                     | 6,216줄 | import 169개, 상태·작업·화면 연결이 한 곳에 집중                      |
| `useExternalSourceController.ts`  | 4,410줄 | 목록·서재·구독·다운로드·복구를 함께 관리                              |
| `FixedDocumentScreen.tsx`         | 3,615줄 | 형식별 세션·화면·입력·읽기 진행을 함께 관리                           |

## 후속 리팩토링 적용 현황

검토 후 사용자 승인으로 `a8b6cd9`부터 구현했다. 아래는 유지보수 브랜치의 구현 상태이며 운영 배포 상태가 아니다.

| 항목       | 반영한 변경                                                                                                                | 보존한 경계                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A1         | 원본 ETag/If-Range 고정, body 수신 전 검증, export 버전 결합, 후속 PDF 오류 전달                                           | 다른 버전의 바이트를 혼합하지 않음; 검증 헤더가 없는 서버는 명시적 실패                  |
| A2         | 책장·소속 통합 조회와 오래된 응답 차단                                                                                     | 한 refresh의 HTTP 2회→1회; 로컬/이전 adapter, 계정별 수명 유지                           |
| A3         | 복구 pass의 서재 snapshot·회차 조회 공유, bootstrap 결과 재사용                                                            | 상태 변경 뒤 재조회, 큐 revision/CAS·휴지통·읽기 순서 유지                               |
| A4 — 일부  | 순수 조회와 반복 정합화 작업을 별도 모듈로 분리                                                                            | 기존 호출은 정합화를 계속 수행; 조회 때마다 생기는 쓰기 제거와 전용 조정자 도입은 미적용 |
| A5         | 탐색·홈의 소비자별 취소와 취소 가능한 대기열                                                                               | 다른 소비자 요청 보존, 실제 loader 종료까지 동시 실행 수 제한                            |
| A6         | 옛 UI 11개 삭제, 기존 5개 테스트를 현재 UI로 이전, 미참조 전용 CSS 정리                                                    | 공유 model/hook 보존; 실제 원본 다운로드 smoke도 현재 화면 사용                          |
| A7 — 일부  | 서재 조회/정합화 책임 분리와 PDF·만화 썸네일 component의 수명 분리                                                         | 대형 App/TTS·reader controller 전체 재구성은 후속 범위                                   |
| A8         | 페이지당 최대 512개 block INSERT를 1개로 묶음                                                                              | 기존 transaction·소유권·교체·rollback 유지; 동일 revision 저장 생략 없음                 |
| A9         | 책장 소유권 확인을 transaction당 1회로 줄임                                                                                | 항목별 savepoint·중복 입력 순서·부분 성공·no-op event 계약 유지                          |
| A10        | 미사용 탐색 설정 함수 3개와 전용 import 삭제                                                                               | 현행 설정 migration·계정 분리 유지                                                       |
| A11        | 사용자/멱등 키 잠금을 receipt 조회 전에 획득                                                                               | 같은 키 동시 요청은 같은 receipt, mutation/event는 한 번; 실패는 전체 rollback           |
| A12        | SHA256 표기 정규화와 같은 원본의 명시적 교체 선택                                                                          | 다른 인코딩/분할 재해석, 복사·건너뛰기 유지                                              |
| A13        | 서버 `done` 이후 최초 manifest 실패까지 저장/갱신 구분, 계정별 완료 기록과 조회 전용 재시도                                | 완전한 저장본 반환 유지; 완료 후 취소·재시작·시리즈 ID·다른 import 소비자의 복구 보호    |
| A14        | 선택적 본문 버전을 전달하고 위치 저장 transaction에서 확인                                                                 | 구 클라이언트 필드 누락 허용, 충돌 시 위치·읽음 상태·event 모두 무변경                   |
| A15 — 보류 | 현행 header timeout 정책 유지                                                                                              | 본문 제한은 제품 정책 변경이므로 이번 구조 정리에 포함하지 않음                          |
| A16        | 선택적 pageIndex를 서버에 전달                                                                                             | 구 서버 대응 필터·삭제용 map·전체 주석 list/최종 갱신 유지                               |
| EPUB·TXT   | 정확한 File/선택 수명에 묶인 준비 hash 재사용, 빈 서재 검사 생략, 서버 검증 TXT hash 재사용, EPUB 내부 중복 본문 hash 제거 | 실제 바이트 검증, 변경 가능한 공개 EPUB 입력의 재계산, 인코딩/분할/append/재개 경계 유지 |

격리 PostgreSQL에서 PDF 512블록의 block INSERT 1회와 책장 100항목 성공의 전체 SQL 506회를
측정했다. 기존 호출 구조의 512회와 604회에서 각각 줄어든다(같은 입력과 transaction/event 계약 기준).
기존 횟수는 이전 코드의 호출 구조로 산출했으며 운영 실행을 계측한 값이 아니다.
이는 운영 지연 개선율이 아니다. 실제 EPUB/TXT 전체 업로드 시간과 체감 개선율은 아직 측정하지 않았다.
탐색 공급자가 취소 신호를 무시하면 이미 실행 중인 요청이 끝날 때까지 다음 요청은 계속 기다린다.
이번 변경은 대기 중인 불필요한 작업을 제거하고, 취소를 지원하는 공급자에 취소를 전달한다.

### 1차 구현의 검증 결과

- Astra high 에이전트 3개가 가져오기, 서재/탐색, 리더/서버를 병렬 구현한 뒤 서로 다른 영역을
  교차 검토했다. 교차 검토에서 초기 서재 조회 실패 후 복구 누락, 오래된 복구 실행의 큐 정리,
  취소 직후 시리즈 저장 완료의 재시도 식별자 유실을 보완했다.
- Quality 합집합 532파일을 실행했다. 최초 실행은 528파일 통과, 4파일 실패이며
  개별 검사는 3,752개 통과·10개 실패·3개 건너뜀이다. 실행 중 다른 타입 검사·빌드도 겹쳤다.
- 실패 중 1개는 변경 전부터 있던 viewport 테스트의 `restorePage(49)`와
  `restorePage(49, undefined)` 비교 문제였다. 실제 49페이지 복원 요청을 검증하도록 고쳤고
  리더 코드는 바꾸지 않았다.
- 마지막 시리즈 가져오기 보완과 viewport 수정은 기본 시간 제한·단일 worker로 기존 4파일을
  다시 실행해 40개 전부 통과했다. 별도의 새 테스트 파일이나 전역 timeout 변경은 없었다.
- 나머지 9개는 수정하지 않은 확장 런타임의 시간 초과다. 기본 시간 제한을 유지한 단일 worker
  재실행에서 해당 3파일은 20개 통과·1개 시간 초과였다. 남은 `host.test.ts`를 단독 실행하면
  현재 코드와 변경 전 `a8b6cd9` 모두 9개 통과했다. 따라서 기존 코드의 확정 실패나
  **Quality 전체의 단일 실행 성공으로 보고하지 않는다.** 통합 실행의 시간 안정성은 남은 한계다.
- 실제 격리 PostgreSQL에서 읽기 상태 통합 7개와 bulk write 통합 3개를 통과했다.
  소유권, 같은 멱등 키의 동시 요청, 부분 성공, revision 충돌과 rollback을 확인했고 임시 DB는 제거했다.
- 현재 원본 파일 화면을 Chromium 320/390/1366px에서 확인했다. 다운로드 바이트·이름,
  목록 30→35개 추가, Escape 닫기와 콘솔 오류 없음을 검증했다.
- 웹·서버·scripts·EPUB/text-core 타입 검사, 웹 빌드와 서버 production build 검증을 통과했다.
  변경 파일 형식·ESLint, CSS·계약 경계·공개 소스 경계와 문서 상대 링크를 확인했다.

서버 없는 정적 웹의 실제 배포, Windows/Android/Rust 빌드, 전체 제품 브라우저 E2E와 운영 업로드
부하는 검증하지 않았다. 위 결과는 운영 배포 완료나 무회귀 보장이 아니다.

### 변경 단위와 반영 판단

- 1차 제품 변경은 `4e30f0c`~`03e2117`이다. 중복 조회·해시·SQL 비용 감소, 미사용 UI 제거,
  버전 검증과 저장 이후 갱신 실패 구분을 포함한다. 위 검증 범위 내에서 판단한다.
- `752f246`과 후속 host 테스트 정리는 테스트 실행 책임을 분리한다. 생산 런타임을 바꾸지 않는다.
- `0ad75c3`의 완료 복구는 서비스 오류 계약, 계정별 영속 기록, 취소·시리즈 UI를 함께 바꾸는
  **동작 변경**이다. 단순 코드 정리로 분류하지 않는다. 개선 방향은 유지하면서 구조 정리와
  별도 커밋으로 구분해 검증한다. 실제 서버/브라우저의 연결 중단·재시작·계정 전환은
  아래 후속 실환경 검증에서 확인했으며 자동 단위/통합 검사와 구별한다.
- 이 단계에서는 운영 배포나 외부 push를 하지 않았다. 후속 운영 반영 결과는 아래를 따른다.

### 완료 조회·재개 경계의 후속 보완

- 서비스 성공 결과의 `Novel` 계약은 유지하고, 서버 `done` 이후에는 canonical ID를 포함한
  별도 오류와 완료 기록으로 저장 성공을 보존한다. 재시도는 manifest 조회만 수행한다.
- 완료 기록은 서버/계정별로 보존하며 업로드의 7일 만료로 삭제하지 않는다. 계정 전환 뒤의
  오래된 retry/ack는 다른 계정에 접근하지 않는다. 이전 공용 키는 인증 확인 뒤 이관하고,
  과거 완료 callback은 같은 파일의 새 업로드 재개 기록을 지우지 못한다.
- 교차 검토에서는 새 복구 구현의 경계 오류도 발견했다. 이전 키의 재등장, 오래된 callback의
  새 업로드 기록 삭제, 취소와 metadata 실패가 겹칠 때 복구 동작이 사라지는 문제를 수정했다.
  이들은 기존 운영 장애로 분류하지 않는다. 별도 작업 폴더에서 회귀 사례를 추가해 확인했다.
- 일반 파일·시리즈 UI, 소스 다운로드, 폴더 동기화, 백업 복원, 서버 연결, 회차 삭제를 함께 검토했다.
  실제 ID/입력 hash와 pending 소스 연결을 보존하고, 불완전한 `Novel`을 만들어 전달하지 않는다.
  네 소비자의 같은 재조회/ack/원래 오류 보존 처리는 공통 함수로 합쳤고, 각 소비자의 검증과
  상태 저장·후속 정리는 호출부에 유지했다.
- Quality의 532파일 집합을 유지하면서 보조 프로세스를 반복 시작하는 8파일을 먼저 개별 실행한다.
  독립 입력 행렬은 개별 case로 분리했다. 제외·재시도·timeout 증가나 생산 runtime 변경은 없다.
  추적한 보조 프로세스 39개는 모두 종료됐고 최대 동시 실행은 1개였다. 같은 실행 안에서 첫 출력이
  약 0.11초에서 1.68초로 잠시 늘어났다. 외부 호스트 스케줄링 영향으로 추정하며 누수로 확정하지 않는다.

### 후속 보완의 통합 검증

- 당시 Quality 합집합 532파일 실행은 **530파일 통과·2파일 실패**로 종료됐다.
  개별 검사는 **3,808개 통과·2개 실패·3개 건너뜀**이다. 다른 빌드/타입 검사는 동시에 실행하지 않았다.
- 실패는 host의 JS 설치/검토/전송 계약 복합 검사와 대형 comic source 참조 검사 각각의
  5초 timeout이다. Assertion 불일치가 보고된 것은 아니다. 후자는 테스트와 해당 구현 모두
  운영 기준과 동일하다. Mangayomi 생산 실행 코드·extension-runtime 패키지·lockfile도 변경하지 않았다.
- host의 설치/검토 취소 상태 순서는 유지하면서 HTTP/native 어댑터 검증을 별도 case로 분리했다.
  보조 프로세스 총 호출 수와 모든 assertion은 유지했다. timeout을 올리거나 재시도/제외하지 않았다.
- 시간 초과 2건을 포함한 9파일을 각각 기본 시간 제한·단일 worker로 재검증해 **67개 전부 통과**했다.
  host 책임 분리 이후 runtime 8파일은 58개, 수정하지 않은 comic source는 9개다.
  이 재검증을 최초 합집합 실행의 성공으로 바꿔 보고하지 않는다. 통합 실행의 시간 안정성은 남은 한계다.
- 마지막 완료 재조회 공통화 후 해당 소비자 4파일·26개도 통과했다. 새로운 테스트 파일이나
  프로덕션 동작은 추가하지 않았고 기존 동작 검사를 재사용했다.
- 최종 제품 코드의 웹/서버 타입 검사, 변경 코드 lint/format, 웹 production build,
  도구·공개 경계 테스트 7개와 공개 소스·계약 경계 검사는 통과했다.

### 6.1 Sol high 독립 검증과 추가 수정

사용자 요청으로 6.1 Sol high 에이전트 두 개가 테스트 실행과 코드 검토를 분담했다.
테스트와 빌드/타입 검사는 동시에 실행하지 않았다. 조회·탐색 취소·리더 버전 검증·DB 잠금·EPUB
해시 재사용의 독립 코드 검토에서는 추가 회귀를 찾지 못했다. 이 결론은 전체 제품 무회귀 보장이 아니다.

- 새 완료 복구 처리에서 회귀 1건을 재현했다. 기존 문서 시리즈에 회차를 저장한 뒤 manifest와
  후속 조회가 모두 실패하면, 저장 전 `base.novel`이 `onCommitted`에 전달됐다. 저장본은 새 revision인데
  화면에 이전 revision을 게시하고 다운로드 큐를 완료 처리할 수 있었다. 기존 테스트는 첫 생성만 다뤘다.
- 완료 오류에서는 이전 `Novel`을 버리고 확정된 책 ID·저장 건수·복구 대기 연결을 유지하도록 수정했다.
  최신 metadata가 없는 상태에서 완료 callback을 실행하지 않는다. 기존 테스트 파일에 기존 작품의
  회차 추가·조회 실패·오래된 callback 차단·저장 건수·조회 복구 후 연결 정합화 사례를 추가했다.
  다른 검토 에이전트가 수정의 저장/복구 경계를 교차 검토했다.
- 최초 업로드·취소·계정·소비자 검사 **7파일 143개가 통과**했다. 수정 후 확장한 검사는
  **9파일 316개 중 315개 통과**였고, 새 테스트의 동일 ID checkpoint 필드 기대 1개가 틀렸다.
  실제 계약인 기존 `localBookId`와 pending 원본 hash를 검사하도록 테스트를 바로잡은 뒤
  coordinator **22개를 전부 통과**했다. 나머지 8파일은 수정된 제품 코드로 확장 검사에서 통과했다.
  이 결과를 전체 Quality의 단일 실행 성공으로 표현하지 않는다.
- 기존 시간 초과 두 항목을 기본 제한·단일 worker로 각각 실행했다. host는 **15개 통과**했고,
  comic source는 **8개 통과·1개 5초 시간 초과**였다. 실패한 대형 참조 검사의 실행 시간은 6.80초다.
  해당 테스트·직접 helper·fixed-document-core·hash 구현·lockfile은 운영 기준에서 변경되지 않았다.
  원인은 확정하지 않았으며, 통과할 때까지 재실행하거나 제한을 늘리지 않았다.
- 수정 후 웹 전체 타입 검사와 변경한 두 코드 파일의 ESLint·Prettier 및 `git diff --check`를 통과했다.
  추가 전체 Quality·운영 업로드 성능·브라우저/네이티브 E2E는 실행하지 않았고 운영 배포는 하지 않았다.

### 운영 반영 전 실환경 검증

운영/CI와 같은 Node 22.23.2로 검증했다. 웹·서버 타입 검사, hosted 웹 production build,
서버 bundle과 production build 검사를 통과했다. 기존 큰 chunk·브라우저 외부화 경고는 남아 있다.

- **실제 브라우저 13개 항목 통과:** 배포용 웹 산출물, 격리 PostgreSQL/Redis와 실제 API를 사용했다.
  UI에서 TXT·EPUB를 올려 본문을 읽고, 기존 2회차 작품에 2회차를 추가해 같은 ID의 4회차를 확인했다.
  job 완료 후 manifest에만 503을 주어 완료 기록과 조회 전용 복구를 확인했다. 새로고침·Chromium/API
  인스턴스 재시작·계정 전환 후 원래 계정에서 복구됐다. 최종 4작품/5revision/5job, 업로드 시작·청크·
  완료 각 5회로 중복 쓰기는 없었고 브라우저 미처리 오류도 0개였다. worker 함수 직접 호출 검사다.
- **배포용 프로세스 5개 항목 통과:** 격리 환경에서 `dist/index.js`, `dist/worker.js`를 Node 22
  프로세스로 실행했다. 실제 HTTP 업로드 queued → BullMQ worker 완료 → manifest/본문/readiness를
  확인했다. 두 프로세스 종료·재시작 후 같은 인증 session과 본문, 1작품/1revision/1job이 유지됐다.
- **깨끗한 설치와 SFTP 통과:** 미정 native build 정책으로 실패하던 frozen install을 재현했다.
  `cpu-features`, `ssh2`의 선택적 native build만 명시적으로 꺼 해결했다. 새 의존성의 실제 암호화
  SFTP도 통과했다. 자세한 설치 경계는 [검증 안내](testing.md)를 따른다.

**마지막 전체 Quality 대상 Vitest 실행은 532파일 모두 통과했다.** `fb3eda5`에서
3,812개 통과·기존 3개 건너뜀, 종료 코드 0이다. 런타임 8파일은 각각 1 worker,
나머지 524파일은 2 workers로 실행했으며 선택 집합·시간 제한·재시도 정책은 그대로다.
전체 실행에는 관측 reporter만 추가했고 실행 중 제품·테스트 코드는 수정하지 않았다.
이는 Quality의 선택 집합 결과이며 저장소의 모든 검사나 수동 Full checks 전체 성공을 뜻하지 않는다.

앞선 Node 22 실행은 526파일 통과/6파일 실패, 3,804개 통과/8개 실패/3개 건너뜀이었다.
실패 중 7개는 host(3개), comic source, plugin connections, development, store-kv의 시간 초과였고,
나머지 1개는 content-service 취소 후 close 호출 수 불일치였다. 마지막 실행에서 모두 통과했다.
원인은 다음처럼 구분한다.

- **실행 호스트의 CPU 클럭 저하를 직접 관측했다.** 마지막 실행 중 CPU 온도는 최대 95.375°C였고,
  이후 12개 논리 CPU가 모두 약 399MHz로 내려가는 구간이 반복됐다. 1초 간격 온도/주파수 표본
  633개 중 420개에서 모든 코어가 500MHz 미만이었다. 같은 1,086,050바이트 SHA-256 계산을
  초당 한 번 관측한 결과 CPU 시간 중앙값은 2GHz 초과 표본 54개에서 0.743ms,
  500MHz 미만 표본 238개에서 6.013ms였다. wall time도 0.750/6.173ms로 약 8배 차이였다.
  실제 계산 처리량 저하가 확인됐으며 단순 스케줄링 대기만으로 설명되는 현상이 아니다.
  host 대형 cache 검사도 저클럭 구간과 겹쳐 10.875초가 걸렸다(앞선 단독 실행 2.597초).
  이는 시간 초과 변동을 설명하는 강한 근거다. 다만 앞선 실패 실행에는 클럭 기록이 없으므로
  당시 7개 시간 초과 모두의 직접 원인을 입증한 것은 아니다. 발열·펌웨어·전원 제어 중 정확한
  저클럭 유발 원인도 미확정이다. CPU/전원/냉각 설정을 변경하지 않았다.
- **RAM 고갈이나 cgroup 제한 근거는 없었다.** 마지막 실행의 사용 가능 RAM은 5.32–6.35GiB,
  약 745초간 전체 호스트 swap-in/out은 505/706 pages였다. OOM은 0회, 실행 cgroup과 상위
  cgroup의 memory high/max/OOM 이벤트도 0이었다. CPU quota/throttling도 없었다.
  스왑 점유량만으로 RAM 부족을 원인으로 단정하지 않는다.
- **취소 검사는 기다리는 사건이 잘못돼 있었다.** 별도 합성 HTTP 실험에서 ID 응답 전 취소는
  close 0회, ID 수신을 증명하는 상태 GET 뒤 취소는 close 1회였다. 기존 검사는 POST 도착만
  기다리면서 ID 수신 후 정리를 기대했다. `fb3eda5`에서 상태 GET을 기다리도록 테스트만 고쳤고
  소유권·publisher·본문·close 횟수 assertion과 제한은 유지했다. ID 수신 전 취소에서 원격 작업
  생성 여부를 알 수 없어 직접 닫지 못하는 기존 한계는 남는다.

전체 실행 이후 직접 코드 검토에서 회차 삭제의 추가 회귀를 재현했다. 후속 조회의 `undefined`
(원격 404 포함)를 통신 실패와 합쳐 이전 import 결과로 대체하고 있었다. 또 로컬 import 결과는
저장 revision이 없는 파싱 metadata일 수 있었다. 실제 저장 pipeline을 사용하는 기존 테스트에
책 없음·조회 실패/저장 revision 있음·조회 실패/revision 없음의 3개 사례를 넣었고, 수정 전
첫 번째와 세 번째가 잘못 성공하는 것을 확인했다. 이제 조회가 예외로 실패하고 저장 revision이
있는 경우에만 fallback한다. 책 없음과 불완전한 metadata는 후속 정리·화면 완료 게시 전에 거절한다.
저장 작업을 다시 실행하지 않으며 이미 완료된 회차 삭제를 되돌리지 않는다.

이 마지막 제품 수정은 위 532파일 실행 **이후**에 적용했다. 수정 후 해당 파일의 **9개 테스트**,
웹 전체 타입 검사, 변경 파일 ESLint/Prettier와 `git diff --check`를 통과했다. 수정 후 전체 Quality를
다시 실행한 것으로 합산하지 않는다. 현재 확인된 제품 회귀는 수정했지만 운영 성능이나 무회귀를 보장하지 않는다.
특히 운영이 같은 저클럭 호스트를 사용한다면 이번 테스트 환경의 처리량 저하가 운영에도 영향을
줄 수 있다. 실제 EPUB/TXT 업로드의 전후 경과 시간은 측정하지 않아 체감 속도 개선율은 미확정이다.

전체 관측/재현 근거는 `/tmp/boaa-final-quality-observe/`의 `quality.log`, `events.jsonl`,
`resources.jsonl`, `thermal.jsonl`, `throughput.jsonl`, `summary.json`, `removal-before.log`,
`removal-after.log`, `typecheck-after.log`, `lint-after.log`에 있다.
이전 전체 실패 로그는 `/tmp/boaa-predeploy-quality-node22.log`, 같은 comic fixture의 Node 22/24
단독 비교(567/647ms)는 `/tmp/boaa-timing-diagnosis-mtu0917f/matched-summary.json`에 있다.
브라우저 근거는 `/tmp/boaa-preproduction-browser-hiuksu/evidence/`, 실제 프로세스 근거는
`/tmp/boaa-packaged-process-Ak4Y9y/evidence/`에 있다. 실험용 계정·DB·컨테이너·프로세스는 정리했고
임시 파일은 장기 보존을 보장하지 않는다. 이 사전 검증 단계에는 운영 배포를 포함하지 않았다.
외부 push와 Windows/Android 검증은 하지 않았다.

### 운영 반영 결과 — 2026-10-25

사용자의 배포 승인 후 **`a371efe`의 웹·API·작업자를 운영에 반영했다.** 기존 관리형 배포의
설정·볼륨·선택 런타임을 유지하고 현재 운영 이미지를 기반으로 새 빌드 산출물만 교체했다.
운영 리더 설정 보존(`0550c99`)과 원격 파일 취소(`9ee2947`) 패치가 포함된 것을 확인했다.
DB schema 64와 lockfile은 바뀌지 않았다. 서버 데이터와 DB를 백업하고 dump 읽기 검증을 마쳤다.
원본 객체는 기존 MinIO 볼륨에 유지하며 이 백업을 전체 미디어 사본으로 해석하지 않는다.

첫 시도는 기존 API의 `idle=false` 때문에 교체 전에 중단했다. 세 작업 큐가 모두 비고 실제
API 요청 연결도 없는 것을 확인했다. 두 번째 시도에서는 유지보수 lease로 새 요청을 막은 뒤
큐와 연결을 3회 연속 확인하고 API·작업자의 정상 종료 코드 0을 확인해 진행했다.
새 API 기동 후 `idle=true`로 돌아왔고 유지보수 lease는 해제됐다. 이 배포에서 기존 요청 계수
불일치의 코드 원인을 수정한 것은 아니며, 재발하면 관리 상태 추적을 별도로 조사한다.

- API·worker·web의 실행 이미지가 준비한 이미지와 일치하고 관리형 배포 기록과도 일치했다.
- DB·객체 저장소·worker readiness, 웹/API 건강 상태를 통과했고 시작 오류·재시작은 0회였다.
- 공개 HTTPS의 index와 JS/CSS 6개가 빌드 산출물과 일치하고 auth API 프록시도 정상 응답했다.
- 390/1280px 실제 브라우저에서 로그인 화면과 auth API 요청을 확인했고 page error는 0개였다.
- 교체 전후 사용자·책·장 건수와 DB schema가 같았다. 운영 데이터로 업로드·삭제 검사를 하지는 않았다.

배포 근거는 운영 설치의 `hotfixes/maintenance-audit-20261025/`에 보관한다. 관리 상태 볼륨의
`/state/backups/maintenance-audit-20261025-r2/`에 백업을, 같은 ID의 `operator-backups/`에
이전 설정·이미지와 검증 기록을 보존했다. 이전 이미지도 남겨 두었다. 외부 이미지 공개나 push는 하지 않았다.

운영 버전 기록도 후속 정합화했다. GitHub에 공개된 `v0.1.1-beta.6`의 실제 태그 커밋은
`37a3cd7`이며 현재 운영 코드 `a371efe`의 조상이다. 현재 운영은 **공식 beta6 기반 + 운영 테스트용
후속 수정**으로 구분한다. 공식 릴리즈·태그·첨부 이미지를 변경하거나 새 릴리즈를 발행하지 않았다.
수동 배포들이 유지하던 beta4 관리 기록을 beta6로 맞춰 `current.json`, 관리 상태/API,
웹·API·worker·updater의 환경 변수와 앱 이미지 버전 label이 일치한다. 이미지 파일시스템 계층과
배포 프로그램 파일은 동일하며 schema·데이터 건수도 유지됐다. 선택 런타임의 실제 버전은 바꾸지 않고,
동일한 앱/런타임 조합에 대한 로컬 이미지 등록만 수정된 앱 버전에 연결했다.
근거는 운영 설치 `hotfixes/version-reconcile-20261025/verification.json`에 있다.
Docker project/설치 경로의 `boaa-beta4`는 볼륨을 연결하는 기존 식별자이므로 그대로 유지한다.

## 최초 감사에서 발견한 항목

P1은 데이터 일관성·사용자 동작에 직접 영향이 있는 항목, P2는 반복 비용·유지보수 부담이다.
파일·읽기 상태 버전 검증을 먼저 보고, 가져오기 판단 오류와 작은 중복 요청 제거,
서재 로드 소유권 정리 순서로 진행하는 것이 적절하다.

### A1. P1 — 원본 Range 읽기가 처음 연 파일 버전을 고정하지 않음 · 확정

- 근거: `src/repositories/remote-book-asset-repository.ts:94`의 검사는 상태·범위·길이만 확인한다.
  `openSource:154`는 최초 `contentHash`를 보관하지만 `readRange:166`에서 비교하지 않는다.
  `src/services/remote/remote-api-client.ts:634`도 `Range`만 보내고 `If-Range`를 보내지 않는다.
- 실제 사용: `src/features/fixed-document/use-pdf-document-session.ts:53`에서 PDF range transport로 전달된다.
  서버 `apps/server/src/routes/books/catalog-routes.ts:260`에는 이미 ETag/If-Range 처리가 있다.
- 영향: 읽는 동안 같은 책의 원본이 같은 크기의 다른 파일로 교체되면, 기존 PDF 세션에 새 파일의
  바이트가 정상 응답처럼 들어올 수 있다. 크기가 다르면 기존 길이 검사가 잡지만 같은 크기는 통과한다.
- 재현: 합성 metadata의 `old-hash`와 응답 ETag의 `new-hash`, 같은 길이의 `NEW!`를 제공하면
  이전 hash를 가진 handle이 새 바이트를 반환한다. 실제 운영 파일 교체는 수행하지 않았다.
- 개선: 최초 hash를 서버의 따옴표 포함 ETag 형식으로 변환해 If-Range를 보내고 응답도 검증한다.
  불일치 시 서버는 200 전체 파일을 반환하므로 **body를 전부 읽기 전에** 상태·버전을 확인하고 취소해야 한다.
  `pdf-range-transport.ts:34`는 후속 오류를 잡아 abort만 하므로 실패·재열기 UI 전달도 함께 구현한다.
  `exportSource:149`의 metadata/body 병렬 읽기도 같은 버전 결합 규칙으로 검토한다.
- 완료 기준: 정상 부분 읽기는 유지하고, 같은 크기 교체·다른 크기 교체·읽기 중 취소에서
  서로 다른 버전의 바이트를 성공으로 반환하지 않는 저장소/세션 동작 테스트.

### A2. P2 — 책장과 소속 목록이 동일 API를 각각 호출 · 확정·합성 재현

- 근거: `src/features/library/useLibraryManagementController.ts:186`에서 `listShelves()`와
  `listShelfMemberships()`를 병렬 호출한다. `src/repositories/remote-library-catalog-repository.ts:66`과
  `:70`은 둘 다 `client.listShelves()`를 호출한다. 서버 응답에는 이미 두 데이터가 함께 있다.
- 영향: 새로고침 한 번에 동일 GET 2회. 데이터 변경 사이에 두 응답이 만들어지면 스냅샷도 어긋날 수 있다.
- 재현: 실제 repository에 합성 client를 넣고 두 메서드를 Promise.all로 호출하면 client 호출 수가 2다.
- 개선: 우선 두 목록을 함께 반환하는 호출 하나로 묶는다. Promise를 공유한다면 계정별로 분리하고
  mutation 뒤 refresh가 변경 전의 진행 중 요청에 합류하지 않게 한다. 서버의 `listHostedShelves:92`는
  여전히 독립 DB 조회 2개를 수행하므로 HTTP 1회만으로 DB snapshot 원자성까지 보장하지는 않는다.
- 완료 기준: 한 refresh에 HTTP 1회, 변경 뒤 최신 데이터 반환, 실패 뒤 재시도 및 계정 분리 유지.

### A3. P2 — 복구 큐마다 전체 서재를 다시 조회 · 확정

- 근거: `use-source-download-recovery.ts:104`의 `refreshRecovery(true)`가 큐마다
  `reconcileDownloadQueue:54`를 실행하고, 각각 `loadSourceLibrary`를 호출한다.
  동시에 `useExternalSourceController.ts:466`도 최초 서재를 읽는다.
  `source-library-snapshot.ts:65` → App의 repository 연결 →
  `src/services/remote/remote-book-transport.ts:28`은 페이지가 끝날 때까지 전체 책 목록을 읽는다.
- 영향: 처리할 복구 큐 Q개이면 이 두 경로에서만 전체 목록 순회 Q+1회가 가능하다.
  이 횟수는 다른 bootstrap 요청을 제외한 호출 구조이며 운영 트래픽 측정값이 아니다.
- 개선: 한 복구 실행의 서재 snapshot과 작품별 chapter 조회를 공유한다. 가져오기/삭제로 상태가 바뀐
  뒤에는 새 snapshot을 사용해야 하며 서로 다른 계정이나 세대 사이에 전역 공유하면 안 된다.
  reading-history 대기 → links → 휴지통 포함 catalog 순서를 유지한다. 큐 제거 시 항목별
  `remoteRevision` 비교도 유지해 다른 탭이 추가한 회차나 새 revision을 지우지 않는다.
- 완료 기준: 여러 복구 큐와 페이지가 많은 서재에서도 전체 catalog 순회는 복구 실행당 1회,
  누락·휴지통·새로 가져온 회차에 대한 복구 판단은 유지.

### A4. P2 — `loadSourceLibrary`가 조회와 복구 쓰기를 동시에 소유 · 확정된 구조 문제

- 근거: `src/features/external-sources/source-library-snapshot.ts:61`은 읽기 외에도
  pending link 정합화, association purge 완료, 방문/stream library 복구, metadata 복구를 수행한다.
  controller의 세대 검사 `:471`은 결과 반영만 막고 이미 시작한 이 작업들은 취소하지 않는다.
- 영향: 단순 목록 재조회가 비싼 복구까지 반복한다. 서로 겹친 refresh의 쓰기 순서와 비용을
  파악하기 어렵다. 이 검토로 실제 데이터 손실을 입증한 것은 아니다.
- 개선: 계정별 복구 조정자와 읽기 snapshot을 분리하되 **초기 1회 복구로 축소하지 않는다**.
  가져오기 완료·중단 후 복원·다른 탭 purge·미완료 방문 journal을 다시 처리할 조건이 필요하다.
  links 우선 순서, pending link의 operation-ID 비교, purge receipt의 범위·시점, 방문 replay를 유지한다.
  catalog 조회 실패를 빈 목록으로 취급하거나 이미 확정된 삭제의 잔여 정리를 일괄 취소하면 안 된다.
- 완료 기준: 동시에 두 refresh, 다운로드 완료 중 refresh, 계정 전환을 검증하고 복구 쓰기는
  멱등적이며 최신 계정/세대에만 반영된다. 단순 조회 테스트는 복구 전체를 mock하지 않아도 된다.

### A5. P2 — 이전 탐색 요청이 새 검색 앞에서 계속 실행 · 확정된 대기 경로

- 근거: `src/features/discovery/useDiscoveryPages.ts:85`의 cleanup은 `active=false`만 설정한다.
  `discovery-session.ts:154`의 list에는 소비자 취소 signal이 없고 세션 수명/30초 timeout만 있다.
  `:195`는 같은 소스의 요청을 순서대로 실행한다.
- 영향: 느린 검색 A 다음 검색 B로 바꿔도 A가 끝나야 B가 시작될 수 있다. timeout은 실행 시점에
  만들어지므로 큐 대기 시간까지 30초 이내라고 보장하지 않는다. 같은 key의 공유는 이미 존재한다.
- 개선: 소비자가 사라진 요청은 큐에서 제거하고, 실행 중 작업은 남은 소비자 수를 고려해 취소한다.
  공유 요청 전체를 한 화면의 cleanup으로 취소하면 다른 홈/탐색 소비자를 깨뜨릴 수 있다.
  공급자가 abort를 무시할 수 있으므로 실제 작업 종료 전 동시 실행 슬롯을 반환하지 않는다.
  이전 작업의 finally가 같은 key의 새 작업을 지우지 않도록 entry identity를 확인한다.
- 완료 기준: 느린 A→B 검색 전환, 큐 대기 중 취소, 두 소비자가 같은 key를 공유하는 경우를 확인한다.

### A6. P2 — 새 UI 전환 후 예전 화면 11개가 남음 · 런타임 미참조 확인

TypeScript import 분석과 문자열/동적 참조 재검색에서 아래 11개 UI 파일(합계 2,077줄)은
현재 앱 화면 진입점에서 연결되지 않았다. 테스트와 수동 smoke의 참조는 별도로 남아 있으므로
단순 `import 없음`만으로 일괄 삭제하면 검증까지 없애게 된다.

| 예전 파일 (`src/features/` 아래)              | 실제 UI (`src/ui-next/` 아래)                  |
| --------------------------------------------- | ---------------------------------------------- |
| `backup/BackupPanel.tsx`                      | `library-tools/UiNextBackupSheet.tsx`          |
| `chapter-structure/ChapterStructurePanel.tsx` | `chapter-structure/UiNextChapterStructure.tsx` |
| `discovery/DiscoveryEditor.tsx`               | `discovery/DiscoveryEditSheet.tsx`             |
| `discovery/SaveDiscoveryList.tsx`             | `discovery/SaveListSheet.tsx`                  |
| `discovery/SourceQuickJump.tsx`               | `discovery/SourceJumpSheet.tsx`                |
| `external-sources/SourceWorkManagement.tsx`   | `source/SourceWorkTools.tsx`                   |
| `import/ImportDialog.tsx`                     | `import/UiNextImportSheet.tsx`                 |
| `library-folders/LibraryFolderPanel.tsx`      | `library-tools/UiNextFolderSheet.tsx`          |
| `library/LibraryManagementPanel.tsx`          | `LibraryManagementPanel.tsx`                   |
| `library/LibraryWorkDialog.tsx`               | `library-tools/UiNextLibraryWorkSheet.tsx`     |
| `library/OriginalFilesDialog.tsx`             | `library-tools/UiNextOriginalFilesSheet.tsx`   |

근거 진입점: `App.tsx:328`, `features/import/ImportFeatureHost.tsx:6`,
`features/library/LibrarySourceFilesHost.tsx:3`, `features/book-workspace/BookWorkspaceScreens.tsx`,
`features/book-workspace/use-library-work-actions.tsx`, `ui-next/discovery/UiNextDiscoveryScreen.tsx`.

5개 옛 UI에는 직접 테스트가 남아 있고 `scripts/performance/original-files-smoke.mjs`도 옛 dialog를
직접 렌더한다. 예전 화면의 테스트 통과가 현행 화면의 검증으로 오인될 수 있다.
이번에는 감사 대상으로 기록했다. 다음 정리에서는 고유한 동작 검증을 현행 UI/공유 model로 옮긴 뒤
옛 화면·대응 테스트·전용 CSS를 함께 제거한다. 공유 controller/model은 실제로 재사용하므로 보존한다.

worker/guest entry, HTML 진입점, `?url` 자산, 테스트 fixture는 import 분석의 미참조 결과만으로
죽은 코드로 분류하지 않았다. `legacy` 이름의 마이그레이션·ID·저장 데이터 호환 코드도 삭제 대상이 아니다.

### A7. P2 — 큰 controller에 수명과 실패 처리가 집중 · 구조 개선 대상

`App.tsx`는 bootstrap, 설정, 동기화, AI/TTS, reader 연결을 함께 소유한다.
`useExternalSourceController`는 소스 목록과 서재/다운로드/복구를 묶고,
`FixedDocumentScreen`은 PDF/만화의 읽기·입력·표시를 함께 관리한다.
파일 크기만으로 느리다고 단정할 수는 없지만, 변경마다 관련 없는 동작과 mock을 동시에 건드리는 원인이 된다.

줄 수를 맞추는 추출보다 **설정/계정 수명, TTS 실행 수명, 소스 catalog snapshot, 다운로드 작업,
PDF 세션, 만화 viewport**처럼 상태와 취소 책임을 같이 옮긴다. 이미 존재하는 hook/model을 먼저
연결하고 비슷한 facade/controller를 새로 겹쳐 만들지 않는다. 한 기능의 테스트가 거대한 App mock
없이 실행되고 기존 계정 전환·읽기 위치·취소 테스트가 유지되는 것을 완료 기준으로 삼는다.
현재 소스 화면을 닫아도 다운로드는 계속된다(`useExternalSourceController.ts:769`). 작업을 화면 전용
hook으로 옮겨 닫을 때 다운로드까지 취소하면 회귀다. runtime 생성 횟수·객체 identity와 PDF 저장 후
주석 재배치·pending 정리처럼 commit 이후에도 끝내야 하는 작업의 수명을 보존한다.

### A8. P2 — PDF 텍스트 저장이 블록마다 직렬 INSERT · 확정

- 근거: `apps/server/src/routes/books/document-text-routes.ts:202`가 각 block에 `await db.query`를 실행한다.
  같은 파일의 입력 한도는 페이지당 512블록이므로 한 HTTP 요청에 최대 512개의 순차 INSERT가 추가된다.
  `:198`은 동일 revision을 다시 저장할 때도 기존 block을 삭제한다.
- 사용처: `src/App.tsx:4970`의 서버 PDF TTS와 `src/features/tts/fixed-document-tts-download.ts:133`.
- 개선: 첫 변경은 기존 트랜잭션 안의 block INSERT만 batch로 바꾼다. 소유권·순서·다른 책의
  revision ID 충돌 거부·기존 ready revision을 stale로 바꾸는 순서를 보존한다.
  동일 내용 재저장 생략은 별도 변경이다. revision ID/pageHash가 같아도 OCR block·좌표·quality가
  달라질 수 있고 stale revision 재활성화도 필요하므로 **ID/hash만 보고 저장을 생략하지 않는다**.
- 완료 기준: 512블록도 제한된 SQL 수로 저장하며 실패 시 전체 rollback한다. 멱등 생략까지 한다면
  정규화된 전체 payload와 활성 상태를 비교한다. 기존 route 테스트는 parser 검사여서 DB 원자성의
  증거가 아니다. 실제 DB 왕복 지연이나 운영 병목 비율은 측정하지 않았다.

### A9. P2 — 일괄 책장 작업의 공통 확인을 항목마다 반복 · 확정된 최적화 대상

- 근거: `apps/server/src/services/hosted-library-management-service.ts:475`에서 각 책마다 savepoint,
  `applyBookBatchCommand:331`의 책 조회, `setMembership:265`의 책장/책 소유권 재조회,
  쓰기와 sync event, savepoint 해제를 반복한다.
- 개선: 같은 책장의 소유권을 한 번 확인하고 대상 책 조회/잠금을 묶는다. 쓰기/event의 일괄 처리는
  **일부 항목만 revision 충돌로 실패하는 receipt 계약**을 유지할 수 있는 범위에서 적용한다.
  첫 변경은 공통 확인 축소에 한정하고 항목별 savepoint를 유지한다. 입력은 중복 bookId를 허용하므로
  임의 dedup으로 결과 개수·순서·두 번째 항목의 revision 충돌을 바꾸지 않는다. no-op event도 만들지 않는다.
- 완료 기준: 1개/100개 처리에서 쿼리 수와 원자성·부분 실패 의미를 함께 비교한다.
  단일 HTTP batch라는 이유만으로 DB 처리까지 일괄화돼 있다고 판단하지 않는다.

### A10. P3 — 사용처 없는 이전 탐색 설정 helper · 확정된 제거 후보

`src/features/discovery/discovery-config.ts:24`의 `readStoredConfig`, `:31`의 `readConfig`,
`:34`의 `writeConfig`는 내부 호출 외 사용처가 없다. 실제 저장 경로는
`discovery-settings-store.ts:12`, `:118`이다. 세 함수와 전용 import만 제거할 수 있으며,
같은 파일의 `configKey`, `newTab`, 정렬·고정 helper는 사용 중이므로 파일 전체를 삭제하면 안 된다.
제거 시 DiscoverySettingsStore 검증과 타입 검사를 완료 기준으로 삼는다.

### A11. P2 후보 — 동일 batch 멱등 키의 동시 요청 · DB 재현 필요

`hosted-library-management-service.ts:460`은 receipt를 일반 SELECT하고 작업을 실행한 뒤
`:497`에서 receipt를 INSERT한다. `db/migrations/0019_library_management.sql:72`에는 사용자/키
unique 제약이 있으나 최초 조회를 동시에 통과한 요청을 직렬화하거나 충돌 뒤 기존 receipt를
재조회하는 경로는 없다. 두 번째 요청이 정상 replay 대신 unique 오류로 끝날 가능성이 있다.
트랜잭션 rollback이 있으므로 중복 데이터 적용이나 데이터 손실이 확인됐다는 뜻은 아니다.

격리된 DB에서 같은 키 요청 2개가 같은 receipt로 성공하고 변경은 한 번만 적용되는지 먼저 검증한다.
실패가 재현되면 사용자/멱등 키별 잠금 또는 충돌 후 replay 처리를 추가한다.
잠금은 receipt 조회·작업 **전**에 획득하거나, 충돌한 트랜잭션 전체를 rollback한 뒤 receipt를 읽어야 한다.
마지막 INSERT에 `ON CONFLICT DO NOTHING`만 붙이면 이미 실행한 두 번째 mutation까지 commit할 수 있다.
같은 키·다른 payload도 원래 receipt를 반환하는 현재 계약과 계정별 키 분리를 유지한다.

## 추가 검토 — 업로드와 남은 동작 문제

추가 요청에 따라 `e3877f6`에서 검토를 이어갔다. 실행 중인 웹/API/worker 이미지 ID가 최초 검토 때와
동일함을 읽기 전용으로 재확인했다. 아래 A12–A16과 EPUB/TXT 성능 검토는 당시의 추가 발견이다. 당시에는 문서만 갱신했으며,
후속 구현 여부는 앞의 적용 현황을 기준으로 구분한다.

### A12. P2 — 현재 형식의 원본 해시를 중복 검사에서 인식하지 못함 · 합성 재현

- `src/features/import/import-duplicate-inspection.ts:30`은 접두사 없는 SHA256 hex를 계산하고
  `:33`에서 `novel.rawTextHash`와 그대로 비교한다. 현재 TXT parser는
  `packages/text-core/parser.ts:231`에서 `sha256:` 표기로 정규화한다. EPUB의 `index.ts:992`와
  `src/services/remote/remote-book-snapshot.ts:146`도 현재 원본 해시를 사용한다.
- 실제 TXT parser로 만든 책에 동일한 바이트의 파일을 다시 검사한 결과, 같은 이름이면
  `same_source/open_existing` 대신 **`same_name/new`**, 다른 이름이면 **충돌 0건**이었다.
  불필요한 재업로드/재처리를 유도하며 이름이 바뀐 복사본을 같은 원본으로 안내하지 못한다.
- 기존 `import-duplicate-inspection.test.ts` 2개는 통과한다. 하지만 첫 테스트는 저장소의 현재 표기
  대신 검사기와 같은 bare hash로 가짜 책을 만들어 이 연계 오류를 놓친다.
- 개선: 기존 공통 hash 정규화 함수를 사용해 현행 tagged hash와 이전 bare SHA256을 비교한다.
  오래된 FNV 해시를 SHA256으로 오인해 변환하면 안 된다. 파일 크기 제한 32MiB도 별도 정책이다.
  **동일 원본을 다른 설정으로 다시 해석하는 경로도 보장해야 한다.** 현재 `UiNextImportSheet.tsx:386`의
  same_source는 열기/건너뛰기/복사만 제공한다. 비교만 고치면 기존 same_name의 교체 선택지가 사라진다.
  실제 TXT parser에 같은 바이트를 single/mixed로 넣으면 원본 hash는 같고 장은 각각 1개/2개였다.
- 완료 기준: 실제 parser 결과를 사용해 동일 이름·변경 이름·다른 내용·이전 SHA256 표기를 검증한다.
  같은 파일의 인코딩·화 분리 변경 후 교체, 복사·건너뛰기·append 동작도 유지한다.
  새 테스트 파일을 여러 개 만드는 대신 기존 중복 검사 테스트의 입력과 사례를 보강하면 된다.

### A13. P2 — 저장 성공 뒤 재조회 실패를 가져오기 실패로 집계 · 합성 재현

- `src/features/import/import-controller.ts:144`에서 import promise가 성공한 다음,
  `:145`의 `getNovel`을 다시 기다린다. 이 조회가 실패하면 `:159`의 파일 실패 경로로 들어가며
  이미 완료된 저장과 조회 실패를 구분하지 않는다.
- 실제 `runImportBatch`에 저장 성공과 일시적인 조회 오류를 제공하면
  **저장 성공=true, completed=0, failed=1**로 끝나고 committed callback도 호출되지 않는다.
  사용자에게 재가져오기를 유도할 수 있다. 실제 저장 내용이 사라진다는 뜻은 아니다.
- 서버 경로는 `server-upload-import-service.ts:439`에서 이미 manifest를 받아 result를 만들고,
  이후 `remote-reader-repository.ts:171`이 같은 manifest를 다시 받는다. 순차 호출이므로
  `remote-book-transport.ts:14`의 진행 중 요청 공유도 이 두 요청을 합치지 못한다.
- 개선: 저장 성공 집계와 후속 조회·callback 실패를 분리하되 **공통 getNovel은 유지한다**.
  브라우저 pipeline은 `parsed.novel`을 반환하지만 `content-revision-store.ts:216`의 저장 단계는 별도
  객체에 활성 revision·사용자 메타데이터·읽기 상태를 반영한다. 모든 adapter의 결과를 저장본으로
  취급하는 앞선 제안은 철회한다. 조회 실패는 미갱신 상태와 재조회로 안내하고 parser 결과를
  완전한 저장본으로 대신 사용하지 않는다. 취소·계정 전환 뒤 늦은 완료도 화면에 되살리지 않는다.
  append 전 조회(`import-controller.ts:132`)는 최신 base revision 확보용이므로 제거 대상이 아니다.
- 회귀 반례: 실제 parser → `saveParsedNovelImport` → fake IndexedDB 교체에서 반환 객체에는
  사용자 제목·즐겨찾기·누적 읽기 시간·활성 revision이 없거나 초기값이었고 저장본에는 모두 반영됐다.
  재조회 제거는 DB 내용을 지우지는 않지만 반환값과 화면 상태를 틀리게 한다.
- 완료 기준: 저장 후 조회 오류에서도 완료 1건을 유지하고 재업로드 대신 조회 재시도를 제공한다.
  callback 실패를 완료/실패에 중복 집계하지 않는다. 서버의 첫 완료 manifest 조회도 실패할 수 있으므로
  batch 수정만으로 모든 완료 후 실패가 해결되지는 않는다. 명시적인 commit 근거 없이 네트워크 오류를
  성공으로 바꾸지 않는다. 서버 중복 manifest 축소는 저장본 반환 계약·공통 mapper 정리 후 별도 적용한다.

### A14. P1 — 서버 읽기 위치 저장에서 본문 버전 확인 정보가 사라짐 · 전송 누락 재현

- `src/features/reader/use-reader-progress.ts:87`은 `expectedContentRevisionId`를 전달하지만,
  `remote-reader-repository.ts:237`과 `remote-api-client.ts:1012`는 이 필드를 요청에서 누락한다.
  `apps/server/src/routes/books/reader-state-routes.ts:42`는 소유권·장·문단의 존재를 검사하지만
  활성 본문 revision은 비교하지 않는다. 로컬 `reader-state-store.ts:104`는 이 비교를 수행한다.
- 실제 repository와 API client에 이전 버전을 넣고 합성 fetch의 JSON을 확인했을 때 필드가 없었다.
  본문 변경 뒤에도 장/문단 ID가 유효하게 남으면 이전 화면의 늦은 저장이 새 상태에 적용될 수 있다.
  운영 데이터 덮어쓰기 자체를 재현한 결과는 아니다.
- 개선: 계약·요청·서버 검증까지 버전을 전달하고 저장 트랜잭션에서 활성 revision을 비교한다.
  필드 없음/현재 버전/불일치를 구분한다. 필수화하면 구 클라이언트가 실패하고, 구 서버는 새 필드를
  무시할 수 있다. 충돌은 전용 오류로 전달하며 최신 revision을 끼워 자동 재시도하지 않는다.
  기존 timestamp·keepalive·reset tombstone·잠금·섹션 읽음 상태 갱신 순서를 유지한다.
- 완료 기준: 장 ID가 같아도 이전 revision의 위치와 섹션 읽음 상태는 모두 변경되지 않아야 한다.
  현재 revision 저장과 기존 클라이언트의 호환 정책도 함께 검증한다.

### A15. P2 후보 — JSON 본문 수신 제한 정책 보강 · 현행 정책 확인

- `src/services/remote/remote-api-client.ts:494`는 응답 헤더를 받으면 타이머를 지우고,
  그 뒤 `:528`의 `response.json()`을 기다린다. 호출자 취소 연결은 유지되지만 별도 취소가 없으면
  본문이 끝나지 않을 때 이 제한 시간으로는 요청을 종료하지 못한다.
- 즉시 헤더를 주고 끝나지 않는 JSON stream을 제공한 합성 실행에서 제한 시간 15ms가 지나도
  65ms 뒤 요청이 미완료였다. 직접 abort해야 끝났다.
- `src/App.tsx:2092`의 bootstrap도 여러 JSON 조회를 Promise.all로 기다리므로 초기 로딩 지연으로
  이어질 수 있다. 일반 업로드 상태 조회에는 별도의 응답 제한도 있으므로 모든 요청이 같은 것은 아니다.
- 현행 `remote-book-resource-cancellation.test.ts:43`은 JSON에서도 header timeout을 body deadline으로
  바꾸지 않는다고 명시한다. 따라서 단순 타이머 누락 버그가 아니라 **기존 정책 변경 후보**다.
- 개선: 필요한 JSON 요청에 별도의 본문 제한과 총 요청 예산을 정의한다. 공통 타이머 해제만 옮기지
  않는다. 큰 Blob·백업·진행 중 응답에는 기존 계약을 유지하거나 별도 전송 정책을 마련한다.
  서버 저장 후 body가 멈추면 결과는 불확실하므로 timeout을 일반 통신 오류로 바꿔 mutation을
  무조건 재전송하지 않는다. 호출자/계정 취소·401 처리와 최종 listener 정리도 유지한다.
- 완료 기준: 헤더 뒤 중단된 JSON은 기한 안에 실패하며, 정상 응답·계정/호출자 취소·진행 중인
  큰 파일 전송은 각 계약에 맞게 유지된다.

### A16. P2 — PDF 페이지 텍스트 확인마다 책 전체 주석 조회 · 합성 재현

- `src/repositories/remote-document-annotation-repository.ts:16`의 `listPage`는 전체 `list`를
  받아 브라우저에서 필터링한다. 서버 `routes/books/document-annotation-routes.ts:33`도 페이지
  조건 없이 책 전체 주석을 반환한다.
- 실제 경로는 `FixedDocumentScreen.tsx:1006` → `use-pdf-text-session.ts:116` →
  `text/pdf-text-publication.ts:17`이며, 이미 추출한 페이지 텍스트를 확인할 때도 실행된다.
  재배치할 주석이 있으면 `pdf-text-publication.ts:23`에서 전체 목록을 추가로 조회한다.
- 합성 client로 0·1페이지를 읽으면 동일한 책 전체 주석 URL을 두 번 호출한다.
  N페이지와 M개 주석에 대해 전송·파싱량이 N×M으로 증가하는 구조다. 실제 지연은 측정하지 않았다.
- 개선: `listPage`에만 선택적 페이지 조건을 전달하고 전체 `list`는 유지한다. 구 서버가 query를
  무시해도 계약을 지키도록 클라이언트 필터와 삭제에 필요한 annotation→book map 등록을 보존한다.
  `pdf-text-publication.ts:23`의 재배치 후 전체 조회는 `setDocumentAnnotations`로 화면 목록을
  대체하므로 페이지 조회로 바꾸면 다른 페이지 주석이 사라진다. 이 조회와 snapshot 캐시는 별도 작업이다.
- 완료 기준: 페이지에는 해당 페이지 주석만 반환하고 전체 주석 패널 및 편집/재배치를 유지한다.

## EPUB·TXT 업로드 속도: 가벼운 검토

**개선 여지는 있다. 우선 중복 해시와 조회를 줄이는 작은 수정부터 할 만하다.** 다만 운영 업로드의
지배적인 병목이나 개선 비율을 측정하지 않았으므로 큰 체감 개선을 약속할 근거는 없다.

여기서 사용자의 로컬 파일을 운영 BOAA로 올리는 경로는
**공통 파일 선택/중복·회차 검사 → 청크 업로드 → complete 검증 → queue/worker 조립·파싱 →
원본·본문 저장 → 완료 조회**다. 서버 없는 정적 웹은 같은 파일 선택 뒤 BrowserImportService와
IndexedDB를 사용한다. 아래에서 두 저장 경로를 구분한다.

### 먼저 시도할 작은 변경

| 후보                           | 적용 경로·근거                                                                                                                                                       | 기대 효과와 주의점                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 준비 단계 SHA256 재사용        | 공통 선택 화면 `import-duplicate-inspection.ts:30`, `useImportController.ts:535`; 서버 `server-upload-import-service.ts:335`는 이미 `expectedSourceContentHash` 지원 | 32MiB 이하에서 계산한 해시가 일반 입력에 전달되지 않아 재계산한다. 정확한 File 객체와 준비 세대에만 묶는다. 파일명·크기·수정시간 key는 다른 바이트를 구분하지 못하며, 잘못 재사용하면 이전 완료 job에 합류해 새 파일 검증까지 생략될 수 있다. |
| 빈 서재의 중복용 해시 생략     | 공통 `inspectImportDuplicates`는 novels가 비어도 전체 파일을 읽음                                                                                                    | 8MiB 합성 File+빈 서재에서 중복 검사 전체 읽기 1회와 이후 업로드 hash의 8MiB 읽기를 확인했다. 중복 검사가 불필요하면 업로드 준비 시 한 번만 계산하면 된다.                                                                                    |
| TXT worker의 원본 재해시 제거  | 서버 `import-service.ts:583` → `packages/text-core/parser.ts:163`; 조립 단계에 이미 검증한 `upload.contentHash` 존재                                                 | 서버가 실제 바이트에서 계산한 hash만 기존 decode 함수와 `parseDecodedNovelTextForImport`에 전달한다. 클라이언트 주장이나 공통 parser의 검증 생략은 대상이 아니다. 합성 20MiB 해시 4회는 Node24에서 102–131ms였으며 전체 업로드 시간이 아니다. |
| EPUB 정규화 본문 해시 재사용   | 공유 `packages/epub-core/index.ts:821`, `:879`에서 같은 sections를 결합·해시                                                                                         | 이미지 복구 이후 내부 parse→materialize 연속 호출에 한정한다. 공개 EpubDocument는 호출자가 수정할 수 있어 객체에 붙인 과거 hash를 무조건 신뢰하면 안 된다. 원본 hash와 본문 hash도 합치지 않는다. 실제 절약 시간은 미측정.                    |
| 완료 직후 manifest 재조회 축소 | 서버 업로드 `awaitImport`와 batch의 `getNovel` 두 경로                                                                                                               | A13의 집계 수정과 분리한다. 현재 공통 결과는 완전한 저장본이 아니므로 재조회를 유지한다. 서버 반환 계약·mapper를 맞춘 뒤 원격 경로만 줄이는 후보이며 즉시 적용할 단순 삭제가 아니다.                                                          |

브라우저의 준비 단계 SHA256은 async 함수 안에서도 실제 계산은 JavaScript로 동기 실행된다.
단순히 동시에 여러 파일을 검사하도록 바꾸기보다 결과 재사용과 불필요한 계산 생략이 먼저다.
해시 재사용 시 재선택·새 File·ZIP 생성·회차 병합 결과에 이전 원본 hash를 넘기지 않는다.
업로드 session의 encoding/split/clientBookId/mode/base/expectedBase 구분과 서버 무결성 검증을 유지한다.

### 파일 특성에 따라 효과가 있을 후보

- **청크 수가 많은 업로드:** `apps/server/src/routes/uploads.ts:374`가 청크 저장 뒤
  `uploadProgress`로 세션·전체 청크·job을 다시 조회한다. 정상 경로는 BEGIN/COMMIT 포함
  9 SQL 왕복이며 세션 잠금 동안 파일 쓰기와 조회를 수행한다. 이미 읽은 세션 재사용과 필요한
  응답 위주 조회로 줄일 수 있다. 네트워크 전송까지 모두 직렬이라는 뜻은 아니다.
  같은 index 재전송은 이전 크기를 제외해 계산해야 하며 missing-index 재개와 동시 complete를 유지한다.
  기존 응답을 단순 ACK로 바꾸거나 업로드 바이트를 누적 증가만 시키면 안 된다.
- **이미지가 많은 EPUB, 서버 저장:** `import-service.ts:1041`의 `book_assets` upsert는 asset마다
  하나씩 실행한다. 개수·파라미터 크기 제한을 둔 묶음으로 바꾸되 책/소유자 일치와 성공 행 수 검사는
  유지한다. 텍스트 위주 EPUB이나 TXT에는 영향이 작다.
  같은 asset ID가 batch 안에 중복되면 순차 upsert와 달리 SQL 오류가 날 수 있어 입력 정책도 필요하다.
- **이미지가 많은 EPUB, 서버 없는 로컬 저장:** `src/storage/db.ts:1795`는 stream asset마다
  `stageEmbeddedBookAssets(...,[asset])`를 호출해 IndexedDB transaction을 만든다.
  `book-asset-store.ts:130`이 이미 배열 입력을 지원하므로 개수·누적 바이트 제한을 둔 작은 batch가
  가능하다. 이 변경은 운영 서버 업로드의 PostgreSQL 저장 속도에는 적용되지 않는다.
  ZIP 해제는 열린 IDB transaction 밖에서 수행하고 성공한 batch만 cleanup 대상에 기록한다.
  마지막 작은 batch·중간 취소·사용자 표지 보존을 검증해야 한다.
- **여러 회차 TXT/EPUB 선택:** `useImportController.ts:355`의 선택 전 검사가 main thread에서
  파일별 원본 hash와 `inspectDocumentSeriesSource`를 수행한다.
  `local-document-series-import.ts:186`에서 읽고 나서 `document-series-core/index.ts:337`에서
  다시 읽으며, EPUB은 이미지 해제와 전체 문단 생성 후 목차 요약만 남긴다. 설정 변경 때 재실행하고
  cleanup은 세대만 변경해 이전 계산 자체는 계속된다. 기존 parser의 요약 모드/결과 재사용과 취소를
  붙이는 것이 후보지만 단순 해시 전달보다 범위가 크다. 일반 단일 파일과 500MiB 초과 파일은
  이 경로를 우회하므로 모든 단일 업로드가 두 번 파싱된다고 보면 안 된다.

### 이번 검토에서 성급하게 바꾸지 않을 부분

- 이미 청크 업로드는 2MiB 단위·기본 동시 4개다. 서버 EPUB asset 저장도 4개/16MiB 제한으로
  병렬화돼 있다. 서버 문단 25페이지·검색 인덱스 최대 3,000행·장 100개 단위 저장도 이미 있다.
- 서버 EPUB은 `onAsset`을 전달하므로 이미지 추출 뒤 두 번째 ZIP 읽기 경로를 실행하지 않는다.
  로컬 EPUB의 두 번 읽는 경로는 메모리를 제한하기 위한 것으로, 이를 통째로 없애려면 별도 설계가 필요하다.
- 진행률 DB 갱신은 650ms로 제한한다. 완료 polling은 처음 1초 동안 100ms, 이후 700ms이고
  느린 요청의 왕복 시간을 차감한다. 더 자주 polling하는 것을 첫 속도 개선책으로 삼지 않는다.
- `/complete`의 전체 chunk hash 검증(`uploads.ts:525`) 뒤 worker가 같은 chunk를 다시 읽어
  조립·검증(`upload-file.ts:50`)한다. 안전하게 조립 파일을 인계하면 읽기 1회를 줄일 수 있으나
  재시도·취소·파일 수명 처리가 필요하다. 검증을 삭제하는 작은 수정으로 취급하지 않는다.
- worker 기본 동시성을 높이면 여러 파일의 대기는 줄일 수 있어도 파일 하나가 빨라지는 것은 아니다.

기존 `import_job_profile`로 단계별 확인을 시작할 수 있다. 단, worker 실행 전 complete hash와
queue 대기는 집계 밖이고 EPUB `parse_archive`에는 asset 저장도 포함된다. 실제 병목을 측정할 때
**선택 준비 / 전송 / complete / queue / 파싱·저장 / 완료 후 화면 갱신**을 구분해야 한다.

### 추가 감사 당시의 검증 범위

A12/A13/A14/A15/A16은 실제 함수·클래스와 합성 입력/응답으로 확인했다. A14는 버전 필드 전송
누락까지, DB 쓰기 영향은 코드 추적까지다. 기존 중복 검사 2개는 통과하지만 현행 parser와의
연계 오류를 놓치는 이유를 확인했다. 측정용 파일은 합성 메모리 데이터이며 사용자 자료나 운영
DB를 사용하지 않았다. 새 테스트 파일은 추가하지 않았고 실제 브라우저/IndexedDB·업로드 부하
측정이나 개선 구현은 수행하지 않았다.

## 구현 전 회귀 검토 — 제안의 적용 조건

후속 요청에 따라 `34b667f`의 제안을 다시 검토했다. **안전 범위를 좁힐 수는 있지만 구현 없이
무회귀를 확정할 수는 없다.** 위 A1–A16과 업로드 표의 제안은 이번 재검토 결과를 반영한 내용이다.
공통 재조회 삭제와 본문까지 공통 timeout을 일괄 적용하는 제안은 철회했고, 초기 1회 복구 및 revision ID만으로
저장 생략도 허용하지 않는다. 제품 코드·기존 테스트·운영 환경은 이번 재검토에서 변경하지 않았다.

### 변경 범위와 필요한 행동 검증

| 범위          | 먼저 적용할 수 있는 단위                                         | 구현 후 반드시 확인할 동작                                                                                                                          |
| ------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2·A10        | 책장 통합 조회, 미사용 함수 3개 제거를 각각 분리                 | 로컬/원격 adapter, 변경 직후 refresh, 조회 실패 시 선택 유지, 계정 전환, 이전 설정 migration                                                        |
| A12·A13       | 중복 판정과 재해석 선택 보존, 저장/후속 조회 실패 분리           | 같은 원본의 다른 encoding/split, 사용자 메타데이터·읽기 상태 보존, append의 최신 revision, 조회/callback 실패, 취소 후 늦은 완료                    |
| A16           | 선택적 pageIndex만 추가; 전체 list 유지                          | 0·빈 페이지, 구 서버의 query 무시, 조회 후 삭제, 다른 페이지 주석 유지, 재배치 후 최신 상태                                                         |
| A1·A14        | 원본 읽기와 위치 저장을 각각 클라이언트/서버 경계에서 수정       | quoted ETag, 200 body 조기 취소, 최초/후속 range 실패 UI, 버전 필드 누락 정책, 구 버전 조합, append/reset 경쟁, 충돌 시 위치·읽음 상태·event 무변경 |
| A3·A4         | 한 복구 pass의 snapshot 공유 후 복구 책임 분리                   | links 우선·휴지통 포함 조회, 동시 큐 추가, 새 revision 보존, 가져오기 완료 후 재복구, purge/방문 journal 재실행, 실패를 빈 목록으로 오인하지 않음   |
| A5·A7         | 소비자 취소와 작업 수명을 보존하며 하나씩 분리                   | 공유 소비자 중 한 명만 취소, abort 무시 공급자, 화면 닫아도 다운로드 유지, runtime 중복 생성 방지, commit 이후 주석 정리 완료                       |
| A6            | 고유 검증을 현행 UI로 옮긴 뒤 옛 component만 제거                | 큰 원본 다운로드·닫은 뒤 늦은 응답·재시도·진행 단계, 실제 화면 연결; 공유 model/hook/CSS 유지                                                       |
| A8·A9·A11     | block INSERT batch, 공통 소유권 확인, 멱등 키 직렬화를 별도 변경 | 임시 DB에서 rollback·다른 책 충돌·변경된 동일 revision 저장·항목별 부분 성공·중복 입력 순서·동일 키 동시 2요청의 변경/event 1회                     |
| A15           | JSON 본문 제한을 별도 정책으로 정의                              | 느리지만 진행 중인 응답, 큰 Blob, 멈춘 401/503 body, 저장 성공 뒤 응답 중단, 총 재시도 예산, 호출자/계정 취소                                       |
| TXT·EPUB 속도 | File 수명에 묶인 준비 hash 및 서버 검증 TXT hash부터 각각 적용   | 동일 파일 메타데이터·다른 바이트, 재선택/재개, 파싱·장·본문 identity 동등성, 취소·교체·원본 보존; 실제 단계별 시간 비교                             |

작은 후보도 관련 동작 검증 전에는 안전 판정이 아니다. 공통 parser·저장소 변경은 운영 서버뿐 아니라
정적 웹/IndexedDB와 내장 서버 소비자도 확인한다. 새 테스트 파일을 항목마다 늘리지 않고 기존 동작
테스트에 빠진 반례를 추가한다. SQL 저장·동시성 변경은 문자열 assertion이나 mock 통과만으로 끝내지 않는다.

### 이번에 확인한 근거와 한계

- **구체적인 반례:** 실제 TXT parser에서 같은 바이트·다른 분할 설정이 같은 원본 hash와 다른 장 수를
  만든다. 실제 parser/저장 함수와 fake IndexedDB에서는 파싱 반환 객체와 보존된 저장본이 다르다.
  브라우저 pipeline이 이 parser 객체를 반환한다는 점은 코드로 확인했다. 실제 브라우저 E2E는 아니다.
- **기존 테스트 12파일·81개 통과:** 가져오기 controller·중복 검사·준비 경쟁·로컬 EPUB 4파일/14개,
  원격 데이터 안전·리소스 취소·위치 저장·주석 저장소·PDF document/text session·서버 주석 route·
  서버 보안 8파일/67개다. 설치된 Vitest를 직접 실행했고 테스트나 fixture를 수정하지 않았다.
- 이 통과는 현재 계약과 비교할 기준이다. **미구현 개선안이 테스트를 통과했다는 뜻이 아니다.**
  PostgreSQL 동시성·실제 브라우저/네이티브·구 버전 조합·운영 업로드 속도는 아직 검증하지 않았다.
  따라서 개선율과 배포 후 무회귀를 보장하지 않으며, 위 범위별 변경 뒤 해당 검증으로 판단한다.

## 최초 문서·테스트 정리

실제 변경 내역과 실행 방법은 [문서 정책](documentation-policy.md), [검증 안내](testing.md)에 있다.

- 완료된 계획/과거 검토 13개(1,565줄)를 활성 문서 트리에서 제거했다. 복구는 Git 이력을 사용한다.
  계정 운영에 필요한 현재 계약은 단일 문서로 통합하고, 단일 계정/미배포로 잘못 설명한 안내를 고쳤다.
- 현재 구조·문서 색인·루트 AGENTS에서 작업 시작점과 소스 우선순위를 정했다.
  라이선스·현재 운영 문서와 버전별 릴리스 기록은 보존한다.
- Vitest와 Node test 실행 경로를 분리했다. 이 단계에서는 Quality CI의 520개 선택 집합을 유지했다.
- 수동 Full checks에 남아 항상 전체 실행으로 귀결되던 PR 변경분 판별기와 조건을 제거한다.
  실제 browser/서버/배포/native 검증 job은 유지한다.
- 현행 UI 대신 옛 ImportDialog를 요구하던 reader 경로 검사를 수정하고,
  이미 전체 typecheck한 뒤 build가 같은 typecheck를 반복하던 부분을 줄인다.

### 최초 문서·테스트 정리의 검증 결과

- 도구 검사 18개와 변경 관련 Vitest 12개 통과.
- 웹 TypeScript 검사(`tsc --noEmit`) 통과.
- 변경된 실행 코드의 ESLint·Prettier 검사 및 `git diff --check` 통과.
- Quality의 선택 파일 집합 520개가 이전과 동일함을 비교했고,
  수동 Full checks의 실질 5개 job/47개 step을 유지했다.
- A1/A2/A5는 합성 client/registry로 각각 버전 불일치 허용, 호출 수 2회, 이전 검색 대기를 확인했다.
  전체 965개 Vitest 파일을 실행해 모두 통과했다고 주장하지 않는다.

## 기존 검증의 실패와 한계

- `src/test/legacy-hash-import-guard.test.ts`는 이번 변경 전부터 실패한다.
  허용 목록에 없는 7개 source/import 경로가 추가됐고 기존 `event-contract-translation`의 직접 import는
  사라졌다. 기존 ID 호환성을 확인하지 않고 허용 목록을 넓히거나 테스트를 삭제하지 않았다.
  실제 FNV 용도를 분류한 뒤 신규 ID 생성과 기존 데이터 호환 경계를 정해야 한다.
- 최초 pnpm install은 `cpu-features`, `ssh2`의 미정 build 정책 때문에 종료 코드 1을 반환했다.
  후속 운영 검증에서 Node 22.23.2/pnpm 11.7.0의 격리된 clean offline frozen install로 동일 오류를
  재현했다. 선택적 네이티브 가속 두 항목만 `allowBuilds: false`로 명시하자 다른 깨끗한 환경의
  설치가 성공했다(413개 cache 재사용, 다운로드 0, lockfile 불변). 새 의존성에서 native binding이
  없는 실제 암호화 SFTP 검사도 통과했다. 이 설치 차단은 해결했으며 전체 script 실행 허용은 하지 않았다.
- 전체 browser/Docker/native/실제 소스 요청 테스트나 운영 부하 측정은 하지 않았다.
  테스트 개수가 많다는 이유로 저장·계정 경계·취소·복구 검증을 없애지 않았다.

## 남은 작업

- A4는 조회/정합화 모듈만 분리했다. 기존 refresh의 정합화 쓰기와 재실행 조건은 유지하며, 이를 계정별 전용 조정자로 옮기는 작업은 남아 있다.
- A7의 App/TTS·PDF/만화 controller 전체 책임 분리는 별도 변경으로 진행한다. 이번에 분리한 조회/정합화와 썸네일 수명을 기반으로 하고 줄 수만 줄이기 위한 계층을 만들지 않는다. 완료 복구 계약을 추가하면서 가져오기 controller와 서버 import service도 커졌다. 이들의 책임 분리는 남은 구조 개선 항목이며, 이번 정확성 보완을 코드 크기 개선으로 계산하지 않는다.
- A15의 JSON 본문 제한은 정상 장시간 응답·저장 성공 후 응답 중단·재시도 예산을 정의한 뒤 검토한다. 현행 timeout 정책을 실패한 테스트에 맞춰 임의 변경하지 않는다.
- A13은 서버 `done` 관측 이후를 구분한다. 서버 완료 여부를 관측하기 전에 응답이 끊긴 경우의 불확실성은 기존 업로드/job 재개로 확인한다. localStorage를 사용할 수 없는 환경은 완료 정보의 앱 재시작 복구를 보장하지 않는다.
- EPUB asset DB/IndexedDB batch, 청크 상태 조회 축소, 다중 회차 준비의 요약/취소, complete와 worker 조립 인계는 미적용이다. 실제 단계별 지연과 메모리를 측정해 비용이 큰 경로부터 적용한다.
- 기존 FNV 사용 경계는 남은 문제다. 이 리팩토링의 통과를 위해 검사나 허용 목록을 완화하지 않는다. 의존성 build-script의 미정 정책으로 인한 설치 차단은 위 실환경 검증에서 해결했다.
- 이후 배포에서도 운영 변경과의 차이를 다시 확인한다. 이번 운영 코드 기준은 위의 `a371efe`이며, 작업 폴더의 후속 문서 커밋이나 새 구현이 자동 배포되는 것은 아니다.

### 후속 TTS·배포 요청 집계 수정 — 2026-10-26

운영 웹은 `2c928cb`, API·worker는 이를 포함한 `4585fbd`로 반영했다. 버전 표시는
공식 GitHub beta6 기반의 로컬 운영 패치로 유지했고 릴리스·태그·외부 이미지를 발행하지 않았다.

- Gemini REST와 local endpoint의 HTTP 상태 전달을 복구해 429 대기·재시도가 동작하도록 했다.
  실제 재생이 진행 중 prefetch를 이어받을 때도 동일한 재시도 정책을 적용한다.
  재생 취소는 후속 재시도를 막으며, 이미 시작된 공유 요청을 중복 생성하지 않는다.
- Gemini PCM 샘플 정렬 검사와 고정된 실패 사유 기록을 추가했다. 제공자 응답 본문·오디오·
  원문은 로그에 기록하지 않는다. 실제 Gemini 유료 생성 요청은 검증 중 호출하지 않았다.
- 반복되던 유지보수 `idle=false`를 재현했다. 앞선 비동기 인증 hook이 대기하는 사이 연결이
  닫히면, 관리 hook이 뒤늦게 요청을 집계하고 이미 지나간 close 이벤트를 기다리게 됐다.
  수정 후 이미 끊긴 요청은 집계·후속 handler 실행에서 제외하고, 살아 있는 요청은 완료까지
  busy로 유지한다. 실제 HTTP 연결을 사용한 회귀 검증을 추가했다.
- TTS 관련 9개 파일 96개 검사, 관리·계정 정책 관련 2개 파일 8개 검사 통과.
  웹·서버 타입 검사, 변경 코드 lint/format, 서버 production build 검사, hosted 웹 빌드와
  브라우저 시작 검사를 통과했다. 전체 Quality를 다시 실행한 결과는 아니다.
- 첫 TTS 배포는 관리 상태 때문에 교체 전 취소했다. 유지보수 lease 아래 세 작업 큐와 실제
  API 연결 부재를 연속 확인한 후 정상 종료·백업·교체했다. 이후 요청 집계 수정의 추가
  배포는 일반 acquireLease 절차로 진행했다. 두 배포 모두 DB/schema 및 사용자·책·장 건수가
  동일했고 backup dump를 읽기 검증했다. 기존 MinIO 원본 객체 볼륨은 유지했다.
- 최종 API/worker/web 이미지·코드 해시와 공개 HTTPS 산출물이 일치했다. `/health`, `/ready`
  200, 관리 상태 complete/busy=false, 유지보수 lease 해제 및 idle=true를 확인했다.
  TTS 웹 배포 후 390/1280px 로그인 화면·auth API 검증에서 브라우저 오류는 없었다.
- Supertonic 연결·목소리 목록은 정상 응답했다. 첫 짧은 합성은 45초를 넘겼으나, 같은 문장을
  다시 요청했을 때 1.33초에 정상 WAV가 생성됐다. 당시 CPU 전 코어 약 399MHz와 이후
  1.8~3.2GHz를 관측했다. CPU 저속 동작의 하드웨어 원인을 해결했다고 주장하지 않는다.
  런타임의 1,000자 입력 상한도 남아 있다.

배포·검증 근거는 운영 설치의 `hotfixes/tts-reliability-20261026/`와
`hotfixes/maintenance-request-accounting-20261026/`에 보관한다. 복구 자료는 관리 상태 볼륨의
각 `operator-backups/` 및 `backups/tts-reliability-20261026-r2/`,
`backups/maintenance-request-accounting-20261026/`에 있다.

### 낭독 미리 생성하기 운영 반영 — 2026-10-26

API·worker·웹을 `c0bac3d`로 함께 반영했다. 듣기 화면의 **미리 생성하기**에서 회차 범위의
음성을 서버에 보관하고, 일반 듣기에서 같은 본문·목소리의 음성을 재사용한다. 계약과 상한은
[provider 경계](../architecture/provider-boundaries.md)의 저장형 오디오북 절을 따른다.

- 관련 검사 117개가 단계별로 통과했다. 최종 수정 모듈과 의존 경계의 타입 검사, lint,
  서버 production bundle 검사와 웹 빌드를 통과했다. 최종 전체 TypeScript/Quality 재실행은 아니다.
- 실제 패널과 모의 서버·WAV를 사용해 320/390/1280px 배치, 생성 확인·중단·재개 및 저장된
  두 음성의 순서 재생·위치 저장을 확인했다. 실제 유료 API 생성이나 대량 생성 부하는 검증하지 않았다.
- 일반 유지보수 lease로 진행 중 요청이 끝나기를 기다린 후 API·worker를 정상 종료했다.
  PostgreSQL dump와 서버 파일을 백업하고 dump 읽기 검사를 거친 뒤 migration 65를 적용했다.
  기존 사용자·책·장 건수와 계정·보기/낭독·provider·플러그인 설정 지문은 반영 전후 동일했다.
- 교체 후 세 서비스의 이미지·코드와 HTTPS 웹 산출물을 확인했다. 실제 소유 책의 생성 목록 GET,
  익명 접근 거부, 저장 음성 조회 경로를 확인했으며 합성 호출이나 임시 세션 생성은 없었다.
  관리 상태는 complete/busy=false이며 유지보수 lease는 해제됐다.

운영 근거는 설치 폴더의 `hotfixes/narration-preparation-20261026/`, 복구 자료는 관리 상태
볼륨의 같은 이름 `backups/`와 `operator-backups/`에 보관한다. 스키마가 64에서 65로 바뀌므로
이전 이미지만 재시작하는 롤백은 불가능하다. 적용 스크립트는 새 테이블이 비어 있고 migration
체크섬이 일치할 때만 65를 되돌린다. 녹음이 생긴 이후에는 DB와 음성 파일을 함께 보존하는
별도 복구가 필요하며, 녹음을 지워 자동 롤백하지 않는다.

### 미리 만든 음성의 본문 TTS 연결 수정 — 2026-10-26

API·worker·웹을 `b28e7f4`로 반영했다. 이전 별도 저장 음성 플레이어를 제거하고 **본문에서 듣기**를
기존 리더 TTS 실행기에 연결했다. 기록 당시의 낭독 구간과 본문 위치를 사용하므로 현재 묶음 크기나
배속이 달라도 완성된 음성을 다시 합성하지 않는다. 미완료 구간은 같은 작업에서 준비하고, 전경과
배경의 같은 구간 요청은 합친다. 기존 강조·스크롤·일시정지·수면 타이머·다음 회차 경로를 사용한다.

- 전체 모델 목록 대신 선택 모델의 합성 설정을 고정한다. 다른 엔진이나 설정 저장 시각 변경으로
  이어 만들기가 막히지 않는다. 실제 선택 모델 변경은 새 생성만 거부하고 기존 음성은 보존한다.
- 관련 회귀 89개와 패널 61개가 통과했다. 변경 모듈 및 의존 경계의 웹·서버 타입 검사, lint/format,
  의존 순환 검사, 서버 bundle과 hosted 웹 빌드가 통과했다. 전체 Quality 재실행은 아니다.
- Chromium에서 실제 패널·기존 TTS controller·queue·음성 hook·HTTP client·WAV 디코딩을 사용했다.
  320/390/1280px 생성 흐름과, 두 회차 네 구간의 순서·본문 위치·모델 연결 없음·현재 설정 불일치
  재사용을 확인했다. 계정 API는 fixture이며 완전한 운영 App/휴대폰 재생 검증을 대신하지 않는다.
- 일반 유지보수 lease·정상 종료·새 DB/파일 백업·dump 읽기 검사 후 교체했다. 스키마는 65로 유지했고
  반영 전후 계정·보기/낭독·provider·플러그인·연결 및 녹음/구간 행 지문이 동일했다.
- 운영의 기존 일시정지 작업에서 완성된 58개 구간과 세 회차의 리더 계획을 확인하고 실제 저장 음성을
  조회했다. 현재 카탈로그와 구형 계획의 revision/목소리가 일치함을 확인한 뒤 선택 모델 식별자만
  추가했다. 기존 설정 필드·상태·진행 수·시각은 그대로였고 생성을 재개하지 않았다.
- 공개 HTTPS 산출물과 세 서비스 이미지·코드·health를 확인했다. 관리 상태 complete/busy=false,
  lease 해제 상태다. 운영 검증의 새 합성 호출·유료 API 생성·임시 로그인 세션은 없었다.

여러 문단을 담은 음성 내부의 진행 표시는 여전히 글자 길이에 따른 추정이다. 타임스탬프나 음성-원문
강제 정렬을 구현하지 않았으며 이번 수정으로 문장 단위 시간 오차까지 해결했다고 보지 않는다.
운영 근거와 복구 자료는 `hotfixes/prepared-reader-20261026/` 및 관리 상태 볼륨의 같은 이름
`operator-backups/`, `backups/`에 있다. 다른 작업자의 TTS 환경 변경은 이 배포 전에 이미 원복됐고,
이번 배포에서 TTS 주소·모델 환경변수나 사용자 provider/reader 설정을 과거 DB로 복원하지 않았다.

### 로컬·OpenAI 호환 TTS 서버 연결 관리 — 2026-10-26

API·worker·웹을 `7bba0ef`로 운영 반영했다. 듣기 → TTS 엔진 연결의 **TTS 서버**에서
로컬 JSON TTS 서버 또는 OpenAI 호환 음성 API를 추가·확인·수정·켜고 끄기·삭제할 수 있다.
기존 제공자나 기본 목소리를 교체하지 않으며 연결별 설정은 서버 DB에 암호화해 저장한다.
모델/목소리 목록을 제공하지 않는 서버는 ID를 직접 입력한다. 연결 확인은 메타데이터 조회이고
합성 요청은 보내지 않는다. 서버 자체 실행과 실제 API 호환성은 별도 전제다.

- Opus medium이 기존 듣기 화면 스타일로 UI를 구현했다. 새 중첩 시트나 애니메이션은 추가하지 않았다.
- 관련 백엔드 83개, UI 58개 테스트 및 마지막 입력 계약 8개 재검사가 통과했다. 변경 모듈과
  의존 경계의 웹·서버 타입 검사, lint/format, 순환 검사, 서버 bundle·hosted 웹 빌드를 완료했다.
  전체 저장소 Quality 재실행은 아니다.
- Chromium에서 실제 컴포넌트·시트·HTTP 클라이언트와 모의 계정 API를 사용해 320/390/1280px
  등록/수정·키 보존·비활성·삭제·실패 안내를 확인했다. 최초 fixture에서 빠진 실제 공용 base CSS를
  포함한 뒤 각 입력칸의 너비까지 측정했고 최종 여섯 화면을 검토했다. 전체 운영 App·안드로이드
  실기기나 실제 외부 TTS 합성을 검증한 것으로 보지 않는다.
- 유지보수 lease, API/worker 정상 종료, DB·파일 백업과 dump 읽기 검사 후 스키마 65→66을 적용했다.
  새 테이블만 추가했고 계정·읽기/낭독·provider·플러그인·기존 연결·녹음 및 구간 행 지문이 동일했다.
  API/worker/web의 기존 환경변수 전체 지문도 동일하다. TTS 주소·모델·허용 호스트를 바꾸거나
  과거 DB를 복원하지 않았다.
- 운영 연결 목록 API의 관리자 조회·익명 차단·no-store 응답, 기존 목소리 목록을 확인했다.
  기존 일시정지 작업의 완성된 58개 구간·세 회차의 리더 계획 및 실제 저장 음성 조회가 통과했다.
  새 연결 등록·실제 합성·유료 호출·임시 로그인 세션 생성 없이 기존 작업 상태와 설정을 보존했다.
- 공개 HTTPS 웹 산출물, 세 서비스 이미지/코드/health, 재시작 0회, 관리 complete/busy=false 및
  lease 해제를 확인했다. 운영 근거·복구 자료는 `hotfixes/tts-connections-20261026/`와 관리 상태
  볼륨의 같은 이름 `operator-backups/`, `backups/`에 있다.

일반 서버 낭독과 미리 생성하기에 연결한다. 화자별 전용 제공자 설정까지 확장한 것은 아니다.
모델 변경은 URL·프로토콜·선택 모델 기준으로 판단하고, 이름·API 키·목소리 목록·요청 분할 한도의
변경만으로 기존 생성 작업의 모델이 바뀐 것으로 처리하지 않는다.

### 묶음 크기 저장 누락과 목소리 식별자 보존 — 2026-10-26

운영 `7bba0ef`에서 묶음 크기를 바꾸어도 재진입하면 되돌아가는 원인을 확인하고 API·worker·웹에
`6b807dc`를 반영했다. `plainBatchCharacters`가 서버 검증기와 책별 덮어쓰기 허용 목록에서 빠져
성공 응답에도 저장되지 않았다. 당시 운영 계정 행에도 해당 값이 없었다. 화면/JSON만 확인하던
이전 묶음 크기 테스트는 이 경계를 검증하지 못했다. 새 재현 12건이 수정 전 실패했다.

- 전역·책별 묶음 크기 200–2000자 정수를 저장한다. 잘못된 값은 400으로 거부하고 기존 DB를 보존한다.
- 추가 서버의 접두사를 포함한 목소리 ID를 160자로 자르던 경로를 합성 계약과 같은 512자로 맞췄다.
- 책별 TTS 허용 목록과 기기/공유 설정 분류에 전체 타입 키 검사를 넣었다. 모든 TTS 필드의 실제
  서버 검증 후 재조회, 책별 전환, 기기 보기 설정·설정 로딩/저장 경쟁·계정 전환을 함께 점검했다.
- 설정 관련 38개 파일 181건 범위를 실행했다. 179건 통과 후 기존 160자 제한을 기대하던 2건을
  새 512자 계약에 맞춰 해당 파일 24건 재실행으로 통과했다. 격리 PostgreSQL 검사에서는 실제
  PUT→서버 재생성→GET, 다른 설정 수정, sync event, 실패 요청 시 데이터 보존을 확인했다.
  React/IndexedDB 보존 테스트도 실제 서버 검증기를 사용하도록 바꿨다. 테스트 DB는 종료했다.
- 변경 모듈·의존 경계의 웹/서버 타입 검사, lint/format, 서버 bundle·hosted 웹 빌드가 통과했다.
  UI 배치나 애니메이션을 변경하지 않았고 별도 브라우저/휴대폰 검사는 반복하지 않았다.
- 정상 유지보수 lease·종료·DB/파일 백업 후 적용했다. 스키마 66을 유지하며 배포 전후 읽기 설정,
  provider, 추가 TTS 연결, 계정·플러그인, 기존 녹음/구간 지문과 서비스 환경변수가 동일했다.
  공개 HTTPS 산출물, 정상 health/재시작 0회, complete/busy=false/lease 해제를 확인했다.
  기존 작업의 준비된 18개 구간과 한 회차 리더 계획·저장 음성 조회도 성공했다. 신규 합성은 없었다.

이미 저장 과정에서 버려진 묶음 크기는 복원할 근거가 없으므로 임의로 지정하지 않았다. 새 화면을
불러온 뒤 한 번 다시 선택해야 한다. 운영 근거는 `hotfixes/settings-persistence-20261026/`와
관리 상태 볼륨의 같은 이름 `operator-backups/`, `backups/`에 보존했다.
