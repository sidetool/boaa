# Reader 기능 경계와 수명

2026-10-13 리팩토링에서 도입한 경계다. 기존 repository/API/저장 형식은 유지한다.

## 공유 규칙

`packages/reader-core`는 화면·브라우저·서버 런타임에 의존하지 않는다. 공개 subpath는
`settings`, `defaults`, `settings-scope`, `query-contract`, `search-policy`, `discovery-settings`, `sync-contract`다.
외부 참조는 contracts와 extension-contracts의 순수 타입으로 제한한다.
기존 `src/repositories`, `src/reader`, `src/integration-settings` 경로는 호환 re-export다.
서버에서 이 frontend 경로를 다시 참조하면 `check:contract-boundaries`가 실패한다.

새 공유 규칙을 추가할 때는 양쪽 사용처를 먼저 확인하고 package exports, 서버 build alias,
dependency-cycle graph, boundary 검사와 해당 테스트를 함께 갱신한다.
sync negotiation/validation은 `reader-core/sync-contract`를 사용한다. `src/sync/contract`는 frontend 호환 re-export이며 서버가 이를 다시 참조하면 boundary 검사에 실패한다.
서버의 나머지 frontend 역참조까지 모두 제거한 상태는 아니다.

## Reader와 음성 편집

- `src/app/composition/ReaderFeatureHost.tsx`가 Reader 하위의 플러그인 snapshot을 구독한다.
  플러그인 패널 갱신이 App 전체 구독 갱신을 유발하지 않도록 이 경계를 유지한다.
- `use-plugin-annotation-refresh`는 책·content revision·repository별 scope에 최신 요청만 반영한다.
  읽기 화면을 떠난 뒤 완료된 목록 조회가 다른 책의 주석을 덮어쓰면 안 된다.
- `useVoiceProfileEditor`는 App session 동안 낙관적 저장과 CAS queue를 유지한다.
  TTS 패널을 닫아도 저장은 지속한다. 이미 요청한 원래 책의 쓰기는 유지하되,
  교체된 scope에 rollback·재조회·알림을 반영하지 않는다.
- `ReaderDecorationStore`의 정적 입력 배열/Set은 immutable snapshot이다.
  수정할 때 새 참조를 전달한다. 재생 range만 바뀌면 이전·현재 문단만 갱신하고,
  정적 annotation이 바뀌면 index를 다시 만든다. plugin layer와 구독 snapshot API는 유지한다.

## 서재 표시와 원본 파일 명령

`buildLibraryCatalogProjection`은 책별 표시 값, 최근 읽은 책, ID lookup과 필터별 개수를 만든다.
`selectLibraryCollection`은 그 snapshot에 검색·필터·정렬을 적용한다.
`useBookWorkspaceProjection`은 novels 배열이 그대로면 기본 projection을 재사용한다.
책 metadata·읽기 기록·휴지통 변경은 새 novels 배열로 전달해야 한다. 입력을 제자리 수정하지 않는다.
`buildLibraryCollectionModel`과 기존 workspace projection 함수는 호환 진입점으로 유지한다.

`LibrarySourceFilesController`는 원본 export·재선택·재구성과 원본 목록 dialog 상태를 맡는다.
`LibrarySourceFilesHost`만 dialog snapshot을 구독하므로 dialog 변경을 App state에 올리지 않는다.

- runtime·계정·settings scope·repository·document IO 교체와 effect cleanup은 이전 명령을 무효화한다.
- 책을 옮겨도 수락한 export는 저장을 완료할 수 있다. 계정/저장소가 바뀌면 이전 명령이 새 저장 dialog나 알림을 열지 않는다.
- 이미 시작한 source 쓰기는 캡처한 repository에서 완료한다. 같은 session에서는 서재를 갱신하지만,
  작업 중 탐색이 바뀌었다면 이전 책을 다시 열지 않는다. A→B→A 이동도 별도 탐색으로 취급한다.
- 브라우저 direct original download와 native document IO 경로, portable source의 lazy import,
  repository의 원본 보강·재구성 저장 계약은 유지한다.

클래식 가상 목록 전용 브라우저 성능 검사는 ui-next 전환 때 폐기했다. 현재 서재의 검색·정렬·필터·선택 계약은
`src/ui-next/library/UiNextLibraryScreen.test.tsx`, 공용 projection은
`src/features/book-workspace/book-workspace-projection.test.ts`에서 확인한다.
이 계약 테스트의 통과는 합성 1천/1만 권의 성능이나 앱 전체 INP 측정 결과가 아니다.

## TTS 준비와 오프라인 다운로드

`useTTSWarmupController`가 텍스트 음성 준비의 시작·중복 실행 차단·취소를 소유한다.
`native-tts-download`와 `hosted-tts-download`는 provider별 실행을,
`hosted-tts-download-queue`는 오디오 저장과 ready item 기록 순서를 담당한다.
`tts-warmup-execution`은 공통 작업 기록과 진행 observer를 제공한다.

- App session에 hook을 둔다. 패널을 닫아도 준비 작업이 끊기면 안 된다.
- 책·chapter·revision·계정·runtime/provider가 교체되면 이전 token과 scope를 무효화한다.
  오래된 finally가 새 작업을 해제하거나 이전 응답이 현재 화면을 갱신하면 안 된다.
- preflight 전에 warmup token을 생성하므로 준비 검사 중 취소도 반영한다.
  취소는 클라이언트 요청·polling·로컬 작업 기록의 수명이다. 서버 합성 job 취소 API를 추가한 것은 아니다.
- `useOfflineTTSDownloads`가 복구 promise, 저장소 보호 요청, 이전 음성 정리와 최신 snapshot을 소유한다.
  계정/runtime별 복구 owner와 책/revision별 조회 scope를 구별한다.
- `useFixedDocumentTTSPreparation`은 고정 문서 음성 준비를 같은 App session 원칙으로 소유한다.
  본문 조회 전에 synthetic document chapter의 실행 token을 확보한다.
  `fixed-document-tts-download`는 최대 50페이지의 revision/block snapshot·OCR 품질 필터와
  기존 native runner/hosted queue 연결을 담당한다. 취소 후 현재 owner의 다운로드 현황은 재조회한다.
- CAS·재시도·다운로드 정책과 저장 schema는 유지한다.

## AI workflow 연결

`useBookAIWorkflowController`가 기존 start/retry/cancel/restore/monitor 실행을 계속 소유한다.
`useBookAIWorkflowSession`은 실행 전 provider sync·본문 연결과 실행 후 artifact 재조회·채택을 조정한다.
App은 provider 선택과 UI 조립을 맡고, 결과 조회·채택 코드를 다시 추가하지 않는다.

- 책/revision·계정·runtime의 session owner가 바뀌면 별도 실행 lane을 사용한다.
  이전 callback·restore 결과·finally가 새 lane의 진행 상태를 바꾸면 안 된다.
- 아직 workflow ID가 없는 preflight 중에도 취소할 수 있다. 취소 뒤 attach/start를 실행하지 않는다.
- artifact 조회는 가장 최근 요청만 반영한다. 조회 중 chapter가 바뀌면 이전 chapter의 segments를 채택하지 않는다.
- 영속 workflow ID key와 managed/trusted runner 계약은 유지한다.
  전체 AI 설정·리뷰 UI·sync 구현을 새 controller 하나로 모으지 않는다.

## PDF와 고정 문서 탐색

- `use-pdf-document-session`이 source, range transport, PDF loading task와 page cache를 소유한다.
  열기 도중 취소도 task를 destroy하며 초기 range read와 unmount가 겹쳐도 source는 한 번만 닫는다.
  책·원본 revision·asset repository 교체 시 이전 document/page를 노출하지 않는다.
- range 크기 64KiB, auto fetch/stream 비활성화, wanted page와 현재 ±3페이지 보존,
  20개를 넘으면 비보존 page를 정리하는 기존 정책을 유지한다. 이는 절대 20개 상한은 아니다.
- `use-fixed-document-navigation`이 초기 위치·직접 진입·chapter prepend anchor·듣기 위치 추적을 맡는다.
  관측한 스크롤 위치와 명령으로 이동한 위치를 구분해 scroll feedback을 막는다.
- `PdfPageView`는 canvas/text/annotation 렌더링과 render task 정리를 소유한다.
  archive decode/URL 수명은 기존 archive loader에 둔다.
- `use-pdf-text-session`은 native text 추출·전체 indexing·페이지별 text snapshot을 소유한다.
  추출을 공유하는 표시 페이지와 bulk indexing은 각각 기다리는 작업의 취소를 판단한다.
  bulk 취소가 현재 페이지의 공유 추출 결과까지 없애면 안 된다.
- `use-pdf-ocr-controller`는 OCR worker·언어 모델 cache·범위 작업을 소유한다.
  `text/pdf-text-publication`은 ready revision 저장→주석 remap→pending 정리→active blocks 조회 순서를 보존한다.
  이미 commit한 revision의 후처리는 캡처한 저장소에서 마무리하고, 화면 반영은 현재 owner만 한다.
- `use-pdf-text-search`와 `use-pdf-reading-order`는 검색 및 읽기 순서 편집을 맡는다.
  제외/순서 override는 검색·복사·TTS의 공통 저장 형식을 사용한다.
- `use-pdf-task-owner`는 고유 owner와 effect epoch로 책 A→B→A, repository/resource 교체,
  StrictMode 재실행을 구분한다. 문자열 book key 비교만으로 이전 작업을 다시 유효하게 만들지 않는다.

실제 빌드와 PDF worker를 사용하는 회귀 검사는
`node scripts/performance/pdf-session-smoke.mjs --dist apps/web/dist`다.
합성 PDF와 새 브라우저에서 검색·읽기 순서 제외/초기화·페이지 이동·닫은 뒤 재진입·reload 후 저장 위치를 확인한다.

## 초기 번들 경계

`document-series-core`는 EPUB 입력을 처리하는 기존 async 경로 안에서만 `epub-core`를 import한다.
TXT 경로와 일반 앱 시작에 EPUB/XML 파서를 포함하지 않는다. 최초 EPUB 처리의 import 실패는
호출자에게 전달하며 기존 오류 처리를 사용한다. cloud import/export와 여러 EPUB 병합의 결과는 유지한다.
PDF는 원래 지연 로딩되던 기능으로, 이번 경계 분리를 신규 PDF 라이브러리 용량 절감으로 계산하지 않는다.

ZIP을 필요로 하는 가져오기 명령은 `features/import/local-import-lazy`의 기존 async 경계에서 로드한다.
Cloud Vault의 만화 전송, 플러그인 ZIP 읽기/쓰기, 외부 소스의 원본 확인·회차 삭제도 해당 분기에서만 로드한다.
`@boaa/document-series-core/local-archive-series`는 parser를 끌어오지 않는 metadata 상수/guard subpath다.
main export의 기존 API는 유지하며 server bundle alias와 cycle graph에도 새 subpath를 등록한다.

chunk import 뒤 취소 여부를 다시 확인하고, 오류를 기존 호출자에게 전달한다.
`node scripts/performance/import-first-use-smoke.mjs --dist apps/web/dist`는 각각 새 프로필에서
TXT/EPUB/CBZ 최초 가져오기와 실제 본문·페이지 표시를 검증한다.
standalone artifact 검사로 lazy chunk의 offline manifest 포함 여부도 확인한다.

## 외부 소스

공개 타입은 `external-source-controller-contract.ts`에 있다. 기존 controller 경로도 type export를 유지한다.

- `use-source-catalog-query`는 목록·상세·필터·loading 상태와 catalog 요청 owner를 소유한다.
  `source-catalog-query`는 cache-first/SWR, 페이지 병합, 오류 fallback, 구독 조정을 담당한다.
  registry·storage·설정 scope·extension revision 교체와 effect epoch가 owner를 무효화한다.
  hostContext는 매 렌더에서 만들어질 수 있으므로 객체 참조 자체로 owner를 교체하지 않는다.
  현재 account/connection generation을 다시 확인하고, 이전 응답·finally·알림이 새 요청에 반영되지 않게 한다.
  연결·선택·삭제·기록 초기화가 소유한 busy 중 후속 조회는 `command-refresh`로 구분한다.
  일반 탐색은 계속 차단하며 내부 명령도 raw setter나 현재 요청 abort 전에 owner를 검사한다.
  catalog 취소는 download/stream/recovery queue의 수명을 종료하지 않는다.
- `source-library-snapshot`은 links를 먼저 읽고 importer 완료와 novel metadata를 조정한다.
- `use-source-library-links`와 `source-serial-item`은 links의 서재 표시를 담당한다.
- `use-source-download-recovery`는 queue ID, 복구 상태, 저장 의도, checkpoint와 재개를 소유한다.
- `use-source-subscription-refresh`는 검사 session, AbortController, 회전 offset, 페이지 예산과
  foreground 실행을 소유한다. `cancel()`은 자신의 session만 종료해야 한다.
  이전 session의 finally가 새 session의 checking 상태를 해제하면 안 된다.
- `use-source-stream-session`은 streaming snapshot, 이어읽기 탐색과 취소, saved-first port를 소유한다.
  `use-source-command-scope`의 owner/effect epoch와 현재 연결의 account/generation을 검사한다.
  `source-owned-stream-port`는 늦은 결과를 차단하고 교체된 owner에 도착한 image session을 닫는다.
  saved-first 오프라인 경로와 같은 연결의 회차 이동 시 port 재사용을 유지한다.
- `use-source-automatic-download`는 자동 다음 회차의 metadata/cache 준비와 queue 접수만 소유한다.
  준비 중에는 owner·연결·취소를 검사하고 접수 후 다운로드는 기존 durable queue 수명을 따른다.
  화면에서 다음 회차로 이동한 것만으로 접수된 작업을 취소하면 안 된다.
  오류 callback은 요청 시작 시 캡처하며 이전 owner의 정책 변경 callback도 차단한다.

connection generation 또는 account가 바뀌면 이전 비동기 결과를 버린다.
controller를 새 기능의 상태·타입·queue 코드를 다시 모으는 위치로 사용하지 않는다.

## 서버 가져오기와 transport

`services/import-service.ts`는 coordinator와 공개 façade다. `services/import/`의 source reader,
page/rekey, batch persistence, execution lifecycle 모듈은 개별 책임을 맡는다.
chapter/page 쓰기, revision 활성화, sync 기록은 **동일한 PoolClient와 단일 transaction**을 유지한다.
단계별 helper 안에서 commit하지 않는다. claim fencing과 heartbeat cleanup은 execution 모듈이 맡는다.

`RemoteBackupTransport`는 백업 API 6개를 소유하고 `RemoteApiClient`는 delegate를 유지한다.
진행 조회 실패로 mutation POST를 재전송하지 않는다. transport 분리는 서버의 백업 ZIP 형식을 바꾸지 않는다.
`RemoteImportTransport`는 upload/chunk/complete/import 작업, `RemoteProviderTransport`는 provider 설정·secret·voices·job·TTS cache JSON endpoint를 맡는다.
공통 request callback으로 auth·오류·signal·timeout 정책을 유지하며, 오디오 binary 요청은 기존 client에 둔다.
provider 계약과 row mapping은 별도 모듈이다. 하위 transport가 façade를 다시 import하지 않는다.
mutation 401을 자동 재전송하거나 expectedBase/expectedRevision·hash 필드를 생략하면 안 된다.

## 플러그인

`platform-call-policy.ts`는 method/role/permission의 정적 표다. `plugin-store`가 session fence와
DB의 현재 grant를 검증하고, task 존재·settings 등록 주체·visible content 권한을 추가 확인한다.
정적 표로 DB 권한 검사를 대체하지 않는다. 알 수 없는 method와 prototype key는 거절한다.

`PlatformSettingsStore`는 설정 검증·CAS·취소 transaction을, `PlatformMarkerStore`는 runtime marker와 종료 영수증 정리를 담당한다.
`PlatformPluginStore`는 공개 façade와 session/epoch를 소유하며 현재 authority를 하위 store에 전달한다.
설정 쓰기의 authorize·read·write는 동일 transaction에 남긴다. 이미 폐기된 scope의 종료 처리가 새 scope를 정리하면 안 된다.

`PluginService`는 session fence·config revision·registration version이 같을 때 decoration plan을 재사용한다.
재사용 전에 DB 권한·설정을 확인하며 실행/commit 시 검증도 유지한다. actions는 실행 시 캡처한다.
controller polling 500ms와 서버 scope 확인 5000ms는 바꾸지 않는다. 이 최적화는 객체 생성 감소이며 DB 조회 감소가 아니다.

서버 `plugins/plugin-scope.ts`는 인증된 cookie의 account/library scope를 결정한다.
runtime route와 connection route가 이 모듈을 공유하며 서로를 역참조하지 않는다.

## 검증과 측정

```sh
pnpm typecheck
pnpm check:contract-boundaries
pnpm check:cycles
node scripts/ci/quality-tests.mjs
pnpm check:bundle-inventory
pnpm exec vite build
pnpm diagnose:web-bundle --dist dist --json /tmp/boaa-bundle.json
```

bundle 측정은 Vite manifest의 entry와 재귀적인 static imports, CSS를 중복 없이 합산한다.
lazy chunks와 asset은 별도로 기록한다. manifest가 없으면 실패한다.
여러 entry가 있으면 entry들의 합집합이므로 제품·빌드별로 비교한다.
기본 예산은 기존 advisory이며 `--strict`를 지정하면 초과 시 실패한다.
압축 byte는 전송 시간·브라우저 메모리·사용자 지연을 뜻하지 않는다.

decoration 합성 시험:

```sh
pnpm exec vitest run src/features/reader/reader-decoration-store.benchmark.test.ts --maxWorkers=1
```

15,000개 주석, warmup 10회와 측정 30회다. 시간의 절대값은 CI 합격 조건으로 사용하지 않고
snapshot 동일성·이전/현재 문단 알림·annotation 교체·plugin paint 회귀를 검사한다.
