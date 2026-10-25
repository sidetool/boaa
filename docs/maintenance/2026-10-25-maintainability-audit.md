# BOAA 유지보수 검토 — 2026-10-25

## 검토 기준과 결론

사용자가 선택한 **현재 운영 배포 코드**를 기준으로 검토했다. 공개 `origin/main`과 운영 코드는 같지 않다.
운영 웹 배포 기록의 `0550c99`에 별도로 배포된 원격 파일 목록 취소 수정 5개 파일을 반영한
로컬 기준 커밋은 `9ee2947`이다. 이미지에 남은 beta.4 버전 표지만으로 소스를 판단하면 안 된다.
이 문서는 해당 시점의 감사 결과와 이후 적용 범위를 구분한다. 최초 제안 전체가 구현된 것으로 해석하지 않는다.

**구현 전 회귀 검토 결과, 아래 제안을 그대로 한꺼번에 적용해도 안전하다고 판단할 수는 없다.**
저장본 재조회 제거, 같은 원본의 재해석, 해시 캐시, 복구 실행 순서에서 구체적인 회귀 조건을 확인해
제안을 수정했다. 각 항목의 변경 경계와 뒤의 구현 전 검증 기준을 함께 적용해야 한다.

부담의 원인은 단순한 파일 개수보다 **전체 목록을 다시 읽는 여러 소유자, 교체 후 남은 UI,
현재 구현과 어긋난 문서·검사**에 있다. 실제 중복 호출과 파일 버전 검증 누락도 확인했다.
최초 정리는 문서·테스트 실행 경로에 한정했고, 이후 사용자 승인으로 아래 적용 현황의 제품 코드를
리팩토링했다. 모든 변경은 운영 기준을 복제한 유지보수 작업 폴더에만 있다. 운영 배포·데이터 변경이나
외부 저장소 업로드는 하지 않았다. 아래 A1–A16의 근거·줄 번호는 최초 감사 시점의 기록이다.

검토 방법은 호출 경로 추적, TypeScript import 분석 후 전체 참조 재검색, 합성 객체 실행,
문서·CI·테스트 진입점 대조다. 운영 사용자 요청을 발생시키거나 전체 성능을 측정한 결과는 아니다.
`확정`은 코드 경로나 합성 실행으로 확인했다는 뜻이며 운영 장애 발생 여부를 뜻하지 않는다.

### 규모

정리 전 `9ee2947`의 Git 추적 파일 기준이다. 외부 라이선스·자산도 전체 파일 수에 포함된다.

| 항목 | 측정값 | 해석 |
| --- | ---: | --- |
| 추적 파일 | 4,824 | 이 수만으로 삭제 대상을 정할 수 없음 |
| Markdown | 90 | 현재 안내·과거 계획·라이선스 문서 혼재 |
| `*.test.*`, `*.spec.*` 파일 | 1,009 | fixture 전체나 테스트 case 수가 아님 |
| 루트 package script | 111 | 기능별 선택 실행과 전체 검증의 경계가 불명확 |
| Quality CI가 선택하는 Vitest 파일 | 520 | 이미 합집합으로 중복 제거됨; 최초 문서·실행기 정리에서 동일 집합 보존 |
| `src/App.tsx` | 6,216줄 | import 169개, 상태·작업·화면 연결이 한 곳에 집중 |
| `useExternalSourceController.ts` | 4,410줄 | 목록·서재·구독·다운로드·복구를 함께 관리 |
| `FixedDocumentScreen.tsx` | 3,615줄 | 형식별 세션·화면·입력·읽기 진행을 함께 관리 |

## 후속 리팩토링 적용 현황

검토 후 사용자 승인으로 `a8b6cd9`부터 구현했다. 아래는 유지보수 브랜치의 구현 상태이며 운영 배포 상태가 아니다.

| 항목 | 반영한 변경 | 보존한 경계 |
| --- | --- | --- |
| A1 | 원본 ETag/If-Range 고정, body 수신 전 검증, export 버전 결합, 후속 PDF 오류 전달 | 다른 버전의 바이트를 혼합하지 않음; 검증 헤더가 없는 서버는 명시적 실패 |
| A2 | 책장·소속 통합 조회와 오래된 응답 차단 | 한 refresh의 HTTP 2회→1회; 로컬/이전 adapter, 계정별 수명 유지 |
| A3 | 복구 pass의 서재 snapshot·회차 조회 공유, bootstrap 결과 재사용 | 상태 변경 뒤 재조회, 큐 revision/CAS·휴지통·읽기 순서 유지 |
| A4 — 일부 | 순수 조회와 반복 정합화 작업을 별도 모듈로 분리 | 기존 호출은 정합화를 계속 수행; 조회 때마다 생기는 쓰기 제거와 전용 조정자 도입은 미적용 |
| A5 | 탐색·홈의 소비자별 취소와 취소 가능한 대기열 | 다른 소비자 요청 보존, 실제 loader 종료까지 동시 실행 수 제한 |
| A6 | 옛 UI 11개 삭제, 기존 5개 테스트를 현재 UI로 이전, 미참조 전용 CSS 정리 | 공유 model/hook 보존; 실제 원본 다운로드 smoke도 현재 화면 사용 |
| A7 — 일부 | 서재 조회/정합화 책임 분리와 PDF·만화 썸네일 component의 수명 분리 | 대형 App/TTS·reader controller 전체 재구성은 후속 범위 |
| A8 | 페이지당 최대 512개 block INSERT를 1개로 묶음 | 기존 transaction·소유권·교체·rollback 유지; 동일 revision 저장 생략 없음 |
| A9 | 책장 소유권 확인을 transaction당 1회로 줄임 | 항목별 savepoint·중복 입력 순서·부분 성공·no-op event 계약 유지 |
| A10 | 미사용 탐색 설정 함수 3개와 전용 import 삭제 | 현행 설정 migration·계정 분리 유지 |
| A11 | 사용자/멱등 키 잠금을 receipt 조회 전에 획득 | 같은 키 동시 요청은 같은 receipt, mutation/event는 한 번; 실패는 전체 rollback |
| A12 | SHA256 표기 정규화와 같은 원본의 명시적 교체 선택 | 다른 인코딩/분할 재해석, 복사·건너뛰기 유지 |
| A13 | 서버 `done` 이후 최초 manifest 실패까지 저장/갱신 구분, 계정별 완료 기록과 조회 전용 재시도 | 완전한 저장본 반환 유지; 완료 후 취소·재시작·시리즈 ID·다른 import 소비자의 복구 보호 |
| A14 | 선택적 본문 버전을 전달하고 위치 저장 transaction에서 확인 | 구 클라이언트 필드 누락 허용, 충돌 시 위치·읽음 상태·event 모두 무변경 |
| A15 — 보류 | 현행 header timeout 정책 유지 | 본문 제한은 제품 정책 변경이므로 이번 구조 정리에 포함하지 않음 |
| A16 | 선택적 pageIndex를 서버에 전달 | 구 서버 대응 필터·삭제용 map·전체 주석 list/최종 갱신 유지 |
| EPUB·TXT | 정확한 File/선택 수명에 묶인 준비 hash 재사용, 빈 서재 검사 생략, 서버 검증 TXT hash 재사용, EPUB 내부 중복 본문 hash 제거 | 실제 바이트 검증, 변경 가능한 공개 EPUB 입력의 재계산, 인코딩/분할/append/재개 경계 유지 |

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
  별도 커밋으로 구분해 검증한다. 실제 서버/브라우저의 연결 중단·재시작·계정 전환 전체 흐름은
  자동 단위/통합 검사와 구별해 아직 확인하지 않은 범위로 남긴다.
- 어느 변경도 운영에 배포하거나 외부 저장소에 push하지 않았다.

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

- 최종 Quality 합집합 532파일 실행은 **530파일 통과·2파일 실패**로 종료됐다.
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

| 예전 파일 (`src/features/` 아래) | 실제 UI (`src/ui-next/` 아래) |
| --- | --- |
| `backup/BackupPanel.tsx` | `library-tools/UiNextBackupSheet.tsx` |
| `chapter-structure/ChapterStructurePanel.tsx` | `chapter-structure/UiNextChapterStructure.tsx` |
| `discovery/DiscoveryEditor.tsx` | `discovery/DiscoveryEditSheet.tsx` |
| `discovery/SaveDiscoveryList.tsx` | `discovery/SaveListSheet.tsx` |
| `discovery/SourceQuickJump.tsx` | `discovery/SourceJumpSheet.tsx` |
| `external-sources/SourceWorkManagement.tsx` | `source/SourceWorkTools.tsx` |
| `import/ImportDialog.tsx` | `import/UiNextImportSheet.tsx` |
| `library-folders/LibraryFolderPanel.tsx` | `library-tools/UiNextFolderSheet.tsx` |
| `library/LibraryManagementPanel.tsx` | `LibraryManagementPanel.tsx` |
| `library/LibraryWorkDialog.tsx` | `library-tools/UiNextLibraryWorkSheet.tsx` |
| `library/OriginalFilesDialog.tsx` | `library-tools/UiNextOriginalFilesSheet.tsx` |

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

| 후보 | 적용 경로·근거 | 기대 효과와 주의점 |
| --- | --- | --- |
| 준비 단계 SHA256 재사용 | 공통 선택 화면 `import-duplicate-inspection.ts:30`, `useImportController.ts:535`; 서버 `server-upload-import-service.ts:335`는 이미 `expectedSourceContentHash` 지원 | 32MiB 이하에서 계산한 해시가 일반 입력에 전달되지 않아 재계산한다. 정확한 File 객체와 준비 세대에만 묶는다. 파일명·크기·수정시간 key는 다른 바이트를 구분하지 못하며, 잘못 재사용하면 이전 완료 job에 합류해 새 파일 검증까지 생략될 수 있다. |
| 빈 서재의 중복용 해시 생략 | 공통 `inspectImportDuplicates`는 novels가 비어도 전체 파일을 읽음 | 8MiB 합성 File+빈 서재에서 중복 검사 전체 읽기 1회와 이후 업로드 hash의 8MiB 읽기를 확인했다. 중복 검사가 불필요하면 업로드 준비 시 한 번만 계산하면 된다. |
| TXT worker의 원본 재해시 제거 | 서버 `import-service.ts:583` → `packages/text-core/parser.ts:163`; 조립 단계에 이미 검증한 `upload.contentHash` 존재 | 서버가 실제 바이트에서 계산한 hash만 기존 decode 함수와 `parseDecodedNovelTextForImport`에 전달한다. 클라이언트 주장이나 공통 parser의 검증 생략은 대상이 아니다. 합성 20MiB 해시 4회는 Node24에서 102–131ms였으며 전체 업로드 시간이 아니다. |
| EPUB 정규화 본문 해시 재사용 | 공유 `packages/epub-core/index.ts:821`, `:879`에서 같은 sections를 결합·해시 | 이미지 복구 이후 내부 parse→materialize 연속 호출에 한정한다. 공개 EpubDocument는 호출자가 수정할 수 있어 객체에 붙인 과거 hash를 무조건 신뢰하면 안 된다. 원본 hash와 본문 hash도 합치지 않는다. 실제 절약 시간은 미측정. |
| 완료 직후 manifest 재조회 축소 | 서버 업로드 `awaitImport`와 batch의 `getNovel` 두 경로 | A13의 집계 수정과 분리한다. 현재 공통 결과는 완전한 저장본이 아니므로 재조회를 유지한다. 서버 반환 계약·mapper를 맞춘 뒤 원격 경로만 줄이는 후보이며 즉시 적용할 단순 삭제가 아니다. |

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

| 범위 | 먼저 적용할 수 있는 단위 | 구현 후 반드시 확인할 동작 |
| --- | --- | --- |
| A2·A10 | 책장 통합 조회, 미사용 함수 3개 제거를 각각 분리 | 로컬/원격 adapter, 변경 직후 refresh, 조회 실패 시 선택 유지, 계정 전환, 이전 설정 migration |
| A12·A13 | 중복 판정과 재해석 선택 보존, 저장/후속 조회 실패 분리 | 같은 원본의 다른 encoding/split, 사용자 메타데이터·읽기 상태 보존, append의 최신 revision, 조회/callback 실패, 취소 후 늦은 완료 |
| A16 | 선택적 pageIndex만 추가; 전체 list 유지 | 0·빈 페이지, 구 서버의 query 무시, 조회 후 삭제, 다른 페이지 주석 유지, 재배치 후 최신 상태 |
| A1·A14 | 원본 읽기와 위치 저장을 각각 클라이언트/서버 경계에서 수정 | quoted ETag, 200 body 조기 취소, 최초/후속 range 실패 UI, 버전 필드 누락 정책, 구 버전 조합, append/reset 경쟁, 충돌 시 위치·읽음 상태·event 무변경 |
| A3·A4 | 한 복구 pass의 snapshot 공유 후 복구 책임 분리 | links 우선·휴지통 포함 조회, 동시 큐 추가, 새 revision 보존, 가져오기 완료 후 재복구, purge/방문 journal 재실행, 실패를 빈 목록으로 오인하지 않음 |
| A5·A7 | 소비자 취소와 작업 수명을 보존하며 하나씩 분리 | 공유 소비자 중 한 명만 취소, abort 무시 공급자, 화면 닫아도 다운로드 유지, runtime 중복 생성 방지, commit 이후 주석 정리 완료 |
| A6 | 고유 검증을 현행 UI로 옮긴 뒤 옛 component만 제거 | 큰 원본 다운로드·닫은 뒤 늦은 응답·재시도·진행 단계, 실제 화면 연결; 공유 model/hook/CSS 유지 |
| A8·A9·A11 | block INSERT batch, 공통 소유권 확인, 멱등 키 직렬화를 별도 변경 | 임시 DB에서 rollback·다른 책 충돌·변경된 동일 revision 저장·항목별 부분 성공·중복 입력 순서·동일 키 동시 2요청의 변경/event 1회 |
| A15 | JSON 본문 제한을 별도 정책으로 정의 | 느리지만 진행 중인 응답, 큰 Blob, 멈춘 401/503 body, 저장 성공 뒤 응답 중단, 총 재시도 예산, 호출자/계정 취소 |
| TXT·EPUB 속도 | File 수명에 묶인 준비 hash 및 서버 검증 TXT hash부터 각각 적용 | 동일 파일 메타데이터·다른 바이트, 재선택/재개, 파싱·장·본문 identity 동등성, 취소·교체·원본 보존; 실제 단계별 시간 비교 |

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

## 남겨 둔 실패와 검증 한계

- `src/test/legacy-hash-import-guard.test.ts`는 이번 변경 전부터 실패한다.
  허용 목록에 없는 7개 source/import 경로가 추가됐고 기존 `event-contract-translation`의 직접 import는
  사라졌다. 기존 ID 호환성을 확인하지 않고 허용 목록을 넓히거나 테스트를 삭제하지 않았다.
  실제 FNV 용도를 분류한 뒤 신규 ID 생성과 기존 데이터 호환 경계를 정해야 한다.
- 오프라인 의존성 연결은 완료했지만 pnpm install은 `cpu-features`, `ssh2`의 미지정 build-script
  정책 때문에 종료 코드 1을 반환했다. 허용 정책은 임의로 변경하지 않았다. 검증은 설치된 실행 파일을
  직접 사용했으며, 프로젝트의 reproducible install 설정은 별도 정리가 필요하다.
- 전체 browser/Docker/native/실제 소스 요청 테스트나 운영 부하 측정은 하지 않았다.
  테스트 개수가 많다는 이유로 저장·계정 경계·취소·복구 검증을 없애지 않았다.

## 남은 작업

- A4는 조회/정합화 모듈만 분리했다. 기존 refresh의 정합화 쓰기와 재실행 조건은 유지하며, 이를 계정별 전용 조정자로 옮기는 작업은 남아 있다.
- A7의 App/TTS·PDF/만화 controller 전체 책임 분리는 별도 변경으로 진행한다. 이번에 분리한 조회/정합화와 썸네일 수명을 기반으로 하고 줄 수만 줄이기 위한 계층을 만들지 않는다. 완료 복구 계약을 추가하면서 가져오기 controller와 서버 import service도 커졌다. 이들의 책임 분리는 남은 구조 개선 항목이며, 이번 정확성 보완을 코드 크기 개선으로 계산하지 않는다.
- A15의 JSON 본문 제한은 정상 장시간 응답·저장 성공 후 응답 중단·재시도 예산을 정의한 뒤 검토한다. 현행 timeout 정책을 실패한 테스트에 맞춰 임의 변경하지 않는다.
- A13은 서버 `done` 관측 이후를 구분한다. 서버 완료 여부를 관측하기 전에 응답이 끊긴 경우의 불확실성은 기존 업로드/job 재개로 확인한다. localStorage를 사용할 수 없는 환경은 완료 정보의 앱 재시작 복구를 보장하지 않는다.
- EPUB asset DB/IndexedDB batch, 청크 상태 조회 축소, 다중 회차 준비의 요약/취소, complete와 worker 조립 인계는 미적용이다. 실제 단계별 지연과 메모리를 측정해 비용이 큰 경로부터 적용한다.
- 기존 FNV 사용 경계와 의존성 build-script 정책은 기존 문제로 남아 있다. 이 리팩토링의 통과를 위해 검사나 허용 정책을 완화하지 않는다.
- 배포할 때는 운영 이후 변경과의 차이를 다시 확인한다. 이 작업 폴더의 완료 상태를 운영 반영으로 해석하지 않는다.
