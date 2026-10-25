# BOAA 유지보수 검토 — 2026-10-25

## 검토 기준과 결론

사용자가 선택한 **현재 운영 배포 코드**를 기준으로 검토했다. 공개 `origin/main`과 운영 코드는 같지 않다.
운영 웹 배포 기록의 `0550c99`에 별도로 배포된 원격 파일 목록 취소 수정 5개 파일을 반영한
로컬 기준 커밋은 `9ee2947`이다. 이미지에 남은 beta.4 버전 표지만으로 소스를 판단하면 안 된다.
이 문서는 해당 시점의 감사 결과이며 미래 구현의 계약이나 완료 선언이 아니다.

부담의 원인은 단순한 파일 개수보다 **전체 목록을 다시 읽는 여러 소유자, 교체 후 남은 UI,
현재 구현과 어긋난 문서·검사**에 있다. 실제 중복 호출과 파일 버전 검증 누락도 확인했다.
이번 변경은 문서·테스트 실행 경로 정리에 한정한다. 아래 제품 코드 개선은 미적용 상태이며,
운영 서비스·데이터·설정을 변경하거나 외부 저장소에 업로드하지 않았다.

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
| Quality CI가 선택하는 Vitest 파일 | 520 | 이미 합집합으로 중복 제거됨; 이번에도 동일 집합 보존 |
| `src/App.tsx` | 6,216줄 | import 169개, 상태·작업·화면 연결이 한 곳에 집중 |
| `useExternalSourceController.ts` | 4,410줄 | 목록·서재·구독·다운로드·복구를 함께 관리 |
| `FixedDocumentScreen.tsx` | 3,615줄 | 형식별 세션·화면·입력·읽기 진행을 함께 관리 |

## 우선 개선할 항목

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
- 개선: 최초 hash로 If-Range를 보내고 응답 ETag/원본 hash도 검증한다. 불일치는 세션을 폐기하고
  재열기를 유도한다. `exportSource:149`의 metadata/body 병렬 읽기도 같은 버전 결합 규칙으로 검토한다.
- 완료 기준: 정상 부분 읽기는 유지하고, 같은 크기 교체·다른 크기 교체·읽기 중 취소에서
  서로 다른 버전의 바이트를 성공으로 반환하지 않는 저장소/세션 동작 테스트.

### A2. P2 — 책장과 소속 목록이 동일 API를 각각 호출 · 확정·합성 재현

- 근거: `src/features/library/useLibraryManagementController.ts:186`에서 `listShelves()`와
  `listShelfMemberships()`를 병렬 호출한다. `src/repositories/remote-library-catalog-repository.ts:66`과
  `:70`은 둘 다 `client.listShelves()`를 호출한다. 서버 응답에는 이미 두 데이터가 함께 있다.
- 영향: 새로고침 한 번에 동일 GET 2회. 데이터 변경 사이에 두 응답이 만들어지면 스냅샷도 어긋날 수 있다.
- 재현: 실제 repository에 합성 client를 넣고 두 메서드를 Promise.all로 호출하면 client 호출 수가 2다.
- 개선: catalog snapshot 메서드 하나로 묶거나, 같은 계정/요청의 진행 중 Promise만 공유한다.
  무기한 캐시를 추가하면 생성·이동·삭제 뒤 오래된 목록이 보일 수 있으므로 피한다.
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
- 완료 기준: 여러 복구 큐와 페이지가 많은 서재에서도 전체 catalog 순회는 복구 실행당 1회,
  누락·휴지통·새로 가져온 회차에 대한 복구 판단은 유지.

### A4. P2 — `loadSourceLibrary`가 조회와 복구 쓰기를 동시에 소유 · 확정된 구조 문제

- 근거: `src/features/external-sources/source-library-snapshot.ts:61`은 읽기 외에도
  pending link 정합화, association purge 완료, 방문/stream library 복구, metadata 복구를 수행한다.
  controller의 세대 검사 `:471`은 결과 반영만 막고 이미 시작한 이 작업들은 취소하지 않는다.
- 영향: 단순 목록 재조회가 비싼 복구까지 반복한다. 서로 겹친 refresh의 쓰기 순서와 비용을
  파악하기 어렵다. 이 검토로 실제 데이터 손실을 입증한 것은 아니다.
- 개선: 계정별 초기 복구와 읽기 snapshot을 분리하고, mutation 뒤 무효화 범위를 명시한다.
  links를 catalog보다 먼저 읽어 신규 연결을 잘못 지우지 않도록 한 기존 순서 보장은 유지한다.
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

### A8. P2 — PDF 텍스트 저장이 블록마다 직렬 INSERT · 확정

- 근거: `apps/server/src/routes/books/document-text-routes.ts:202`가 각 block에 `await db.query`를 실행한다.
  같은 파일의 입력 한도는 페이지당 512블록이므로 한 HTTP 요청에 최대 512개의 순차 INSERT가 추가된다.
  `:198`은 동일 revision을 다시 저장할 때도 기존 block을 삭제한다.
- 사용처: `src/App.tsx:4970`의 서버 PDF TTS와 `src/features/tts/fixed-document-tts-download.ts:133`.
- 개선: 페이지 안의 block을 bulk INSERT하고 동일 내용 재저장은 멱등 처리한다.
  소유권·순서·트랜잭션 원자성을 유지해야 한다. 페이지 사이 무제한 병렬화는 먼저 할 일이 아니다.
- 완료 기준: 512블록도 고정된 수의 SQL로 저장하고 동일 내용 재요청이 전체 삭제/삽입을 반복하지 않는다.
  실제 DB 왕복 지연이나 운영 병목 비율은 측정하지 않았다.

### A9. P2 — 일괄 책장 작업의 공통 확인을 항목마다 반복 · 확정된 최적화 대상

- 근거: `apps/server/src/services/hosted-library-management-service.ts:475`에서 각 책마다 savepoint,
  `applyBookBatchCommand:331`의 책 조회, `setMembership:265`의 책장/책 소유권 재조회,
  쓰기와 sync event, savepoint 해제를 반복한다.
- 개선: 같은 책장의 소유권을 한 번 확인하고 대상 책 조회/잠금을 묶는다. 쓰기/event의 일괄 처리는
  **일부 항목만 revision 충돌로 실패하는 receipt 계약**을 유지할 수 있는 범위에서 적용한다.
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

## 추가 검토 — 업로드와 남은 동작 문제

추가 요청에 따라 `e3877f6`에서 검토를 이어갔다. 실행 중인 웹/API/worker 이미지 ID가 최초 검토 때와
동일함을 읽기 전용으로 재확인했다. 아래 A12–A16과 EPUB/TXT 성능 검토는 **추가 발견이며 미수정**이다.
기존 문서를 갱신했고 제품 코드·테스트·운영 설정은 바꾸지 않았다.

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
- 완료 기준: 실제 parser 결과를 사용해 동일 이름·변경 이름·다른 내용·이전 SHA256 표기를 검증한다.
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
- 개선: 저장 성공을 먼저 확정하고 응답으로 받은 novel을 사용한다. 필요한 목록 재조회 실패는
  저장 실패와 구분해 경고/재조회로 처리한다. 이미 controller `useImportController.ts:724`에는
  목록 갱신 실패를 경고하는 처리가 있어 그 계약과 맞출 수 있다.
- 완료 기준: 저장 후 조회 오류에서도 완료 1건을 유지하고 재업로드 대신 조회 재시도를 제공한다.
  모든 adapter의 결과 완전성을 확인한 뒤 서버의 중복 manifest 요청을 줄인다.

### A14. P1 — 서버 읽기 위치 저장에서 본문 버전 확인 정보가 사라짐 · 전송 누락 재현

- `src/features/reader/use-reader-progress.ts:87`은 `expectedContentRevisionId`를 전달하지만,
  `remote-reader-repository.ts:237`과 `remote-api-client.ts:1012`는 이 필드를 요청에서 누락한다.
  `apps/server/src/routes/books/reader-state-routes.ts:42`는 소유권·장·문단의 존재를 검사하지만
  활성 본문 revision은 비교하지 않는다. 로컬 `reader-state-store.ts:104`는 이 비교를 수행한다.
- 실제 repository와 API client에 이전 버전을 넣고 합성 fetch의 JSON을 확인했을 때 필드가 없었다.
  본문 변경 뒤에도 장/문단 ID가 유효하게 남으면 이전 화면의 늦은 저장이 새 상태에 적용될 수 있다.
  운영 데이터 덮어쓰기 자체를 재현한 결과는 아니다.
- 개선: 계약·요청·서버 검증까지 버전을 전달하고 저장 트랜잭션에서 활성 revision을 비교한다.
- 완료 기준: 장 ID가 같아도 이전 revision의 위치와 섹션 읽음 상태는 모두 변경되지 않아야 한다.
  현재 revision 저장과 기존 클라이언트의 호환 정책도 함께 검증한다.

### A15. P2 — JSON 응답 본문 수신에는 요청 제한 시간이 적용되지 않음 · 합성 재현

- `src/services/remote/remote-api-client.ts:494`는 응답 헤더를 받으면 타이머를 지우고,
  그 뒤 `:528`의 `response.json()`을 기다린다. 호출자 취소 연결은 유지되지만 별도 취소가 없으면
  본문이 끝나지 않을 때 이 제한 시간으로는 요청을 종료하지 못한다.
- 즉시 헤더를 주고 끝나지 않는 JSON stream을 제공한 합성 실행에서 제한 시간 15ms가 지나도
  65ms 뒤 요청이 미완료였다. 직접 abort해야 끝났다.
- `src/App.tsx:2092`의 bootstrap도 여러 JSON 조회를 Promise.all로 기다리므로 초기 로딩 지연으로
  이어질 수 있다. 일반 업로드 상태 조회에는 별도의 응답 제한도 있으므로 모든 요청이 같은 것은 아니다.
- 개선: JSON은 본문 소비까지 제한을 적용한다. 큰 Blob에는 별도의 전체 시간 또는 무진행 제한을 둔다.
  모든 파일을 기존 JSON용 시간으로 일괄 중단하면 정상 다운로드를 깨뜨릴 수 있다.
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
- 개선: 페이지 조건을 서버 API에 전달한다. 색인 실행당 snapshot 공유도 가능하지만 주석 편집과
  재배치 뒤 무효화 규칙이 필요하다.
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
| 준비 단계 SHA256 재사용 | 공통 선택 화면 `import-duplicate-inspection.ts:30`, `useImportController.ts:535`; 서버 `server-upload-import-service.ts:335`는 이미 `expectedSourceContentHash` 지원 | 32MiB 이하에서 계산한 해시가 충돌 없는 파일은 버려지고 일반 new/replace/copy 입력에도 전달되지 않아 재계산한다. File 객체와 준비 세대에 묶어 표기를 정규화해 재사용한다. 서버의 무결성 검증은 유지한다. |
| 빈 서재의 중복용 해시 생략 | 공통 `inspectImportDuplicates`는 novels가 비어도 전체 파일을 읽음 | 8MiB 합성 File+빈 서재에서 중복 검사 전체 읽기 1회와 이후 업로드 hash의 8MiB 읽기를 확인했다. 중복 검사가 불필요하면 업로드 준비 시 한 번만 계산하면 된다. |
| TXT worker의 원본 재해시 제거 | 서버 `import-service.ts:583` → `packages/text-core/parser.ts:163`; 조립 단계에 이미 검증한 `upload.contentHash` 존재 | 기존 decode 함수와 `parseDecodedNovelTextForImport`에 검증된 hash를 전달할 수 있다. 이 머신 Node24의 합성 20MiB 해시 4회는 102–131ms였다. 네트워크·파싱·DB 시간을 포함한 수치가 아니다. |
| EPUB 정규화 본문 해시 재사용 | 공유 `packages/epub-core/index.ts:821`, `:879`에서 같은 sections를 결합·해시 | 파싱 결과 내부에서 재사용하거나 callback이 필요하지 않을 때 첫 계산을 생략한다. 원본 hash와 본문 hash는 다른 목적이므로 합치면 안 된다. 실제 EPUB에서 절약 시간은 미측정. |
| 완료 직후 manifest 재조회 축소 | 서버 업로드 `awaitImport`와 batch의 `getNovel` 두 경로 | A13을 고치면서 authoritative 결과를 재사용할 수 있다. 왕복이 느릴 때 유리하며 실패 집계도 함께 바로잡는다. 다른 adapter가 반환하는 결과 계약은 먼저 확인한다. |

브라우저의 준비 단계 SHA256은 async 함수 안에서도 실제 계산은 JavaScript로 동기 실행된다.
단순히 동시에 여러 파일을 검사하도록 바꾸기보다 결과 재사용과 불필요한 계산 생략이 먼저다.

### 파일 특성에 따라 효과가 있을 후보

- **청크 수가 많은 업로드:** `apps/server/src/routes/uploads.ts:374`가 청크 저장 뒤
  `uploadProgress`로 세션·전체 청크·job을 다시 조회한다. 정상 경로는 BEGIN/COMMIT 포함
  9 SQL 왕복이며 세션 잠금 동안 파일 쓰기와 조회를 수행한다. 이미 읽은 세션 재사용과 필요한
  응답 위주 조회로 줄일 수 있다. 네트워크 전송까지 모두 직렬이라는 뜻은 아니다.
- **이미지가 많은 EPUB, 서버 저장:** `import-service.ts:1041`의 `book_assets` upsert는 asset마다
  하나씩 실행한다. 개수·파라미터 크기 제한을 둔 묶음으로 바꾸되 책/소유자 일치와 성공 행 수 검사는
  유지한다. 텍스트 위주 EPUB이나 TXT에는 영향이 작다.
- **이미지가 많은 EPUB, 서버 없는 로컬 저장:** `src/storage/db.ts:1795`는 stream asset마다
  `stageEmbeddedBookAssets(...,[asset])`를 호출해 IndexedDB transaction을 만든다.
  `book-asset-store.ts:130`이 이미 배열 입력을 지원하므로 개수·누적 바이트 제한을 둔 작은 batch가
  가능하다. 이 변경은 운영 서버 업로드의 PostgreSQL 저장 속도에는 적용되지 않는다.
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

### 추가 검토의 검증 범위

A12/A13/A14/A15/A16은 실제 함수·클래스와 합성 입력/응답으로 확인했다. A14는 버전 필드 전송
누락까지, DB 쓰기 영향은 코드 추적까지다. 기존 중복 검사 2개는 통과하지만 현행 parser와의
연계 오류를 놓치는 이유를 확인했다. 측정용 파일은 합성 메모리 데이터이며 사용자 자료나 운영
DB를 사용하지 않았다. 새 테스트 파일은 추가하지 않았고 실제 브라우저/IndexedDB·업로드 부하
측정이나 개선 구현은 수행하지 않았다.

## 문서·테스트 정리

실제 변경 내역과 실행 방법은 [문서 정책](documentation-policy.md), [검증 안내](testing.md)에 있다.

- 완료된 계획/과거 검토 13개(1,565줄)를 활성 문서 트리에서 제거했다. 복구는 Git 이력을 사용한다.
  계정 운영에 필요한 현재 계약은 단일 문서로 통합하고, 단일 계정/미배포로 잘못 설명한 안내를 고쳤다.
- 현재 구조·문서 색인·루트 AGENTS에서 작업 시작점과 소스 우선순위를 정했다.
  라이선스·현재 운영 문서와 버전별 릴리스 기록은 보존한다.
- Vitest와 Node test 실행 경로를 분리한다. Quality CI의 520개 선택 집합은 유지한다.
- 수동 Full checks에 남아 항상 전체 실행으로 귀결되던 PR 변경분 판별기와 조건을 제거한다.
  실제 browser/서버/배포/native 검증 job은 유지한다.
- 현행 UI 대신 옛 ImportDialog를 요구하던 reader 경로 검사를 수정하고,
  이미 전체 typecheck한 뒤 build가 같은 typecheck를 반복하던 부분을 줄인다.

### 이번 변경의 검증 결과

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

## 다음 작업 단위

1. **파일·읽기 상태 일관성:** A1의 원본 교체/부분 읽기와 A14의 revision 검증을 각각 독립 변경으로 처리한다.
2. **가져오기와 작은 중복 제거:** A12/A13의 잘못된 중복·실패 판단부터 바로잡고, A2의 책장 요청을 줄인다.
   업로드 속도는 준비 해시 전달·TXT 검증 해시 재사용부터 별도로 확인한다.
3. **서재 로드 통합:** A3/A4를 함께 정리한다. 읽기 snapshot의 범위와 복구 쓰기의 소유권을 먼저 정의한다.
4. **취소 체계:** A5의 소비자별 취소를 기존 공유 캐시/큐 계약에 통합한다.
5. **UI 잔재 제거:** A6의 고유 검증을 현행 UI로 옮기고 옛 파일을 제거한다.
6. **큰 controller 축소:** 위 책임이 정리된 뒤 A7을 기능별로 진행한다. 줄 수만 목표로 잡지 않는다.
7. **서버 일괄 처리:** A8/A9의 SQL 횟수를 계측하고 A11의 동시 재시도를 격리된 DB에서 검증한다.
   A10은 탐색 UI 잔재 정리와 함께 작은 독립 변경으로 처리한다.
8. **응답과 페이지별 조회:** A15의 JSON 본문 제한과 A16의 페이지 주석 조회를 각각 분리해 수정한다.

각 작업은 재현 조건·변경 범위·선택 검증·남은 한계를 같은 변경에 기록하고 완료된 항목의 상태를 갱신한다.
