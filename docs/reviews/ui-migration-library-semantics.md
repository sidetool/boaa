# 서재·책장·최근 읽기 의미 검토

검토 기준: `ca5145ed4f2f4e69163c30b76fac52a62982327f` (`release/server-beta4`). 읽기 전용 코드 검토와 메모리 내 합성 데이터 재현으로 확인했다. 운영 DB·운영 화면·비공개 확장은 열거나 변경하지 않았다. 구현 변경은 없다.

## 기존 의도와 유지할 동작

- `최근 읽은 순`과 `최근 추가한 순`은 별도 명령이다. [정렬 명칭](../../src/ui-next/library/model.ts#L94), [독서 활동 저장소의 명시적 설명](../../src/storage/novel-reading-activity.ts#L6)은 메타데이터 변경 시각을 독서 증거로 사용하지 않도록 한다.
- 저장한 책과 스트리밍 작품은 하나의 정렬에 섞이고, 연결된 작품은 로컬/스트리밍 중 더 최근의 실제 방문을 사용한다. [정렬 계약](../../src/features/library/library-work-order.ts#L8), [기존 테스트](../../src/features/library/library-work-order.test.ts#L25).
- 단일 `책장 이동`은 기존 책장들에서 제거하고 목적 책장에 넣는다. 다중 선택의 `책장에 추가`는 기존 책장을 유지한다. 서로 다른 명령이므로 동작 차이는 의도에 맞다. [이동 구현](../../src/features/library/library-work-mutations.ts#L19), [다중 선택 명령](../../src/ui-next/library/actions.ts#L88). 이동은 목적 책장 추가를 먼저 수행하므로 제거 실패 시 책을 잃지 않는 것도 의도된 동작이다.
- 다운로드 후에도 이전 스트리밍 책장 배치를 보존하고 같은 책/책장 조합을 중복 집계하지 않는다. [병합 테스트](../../src/features/book-workspace/library-shelf-memberships.test.ts#L4).
- 읽기 위치 저장, 실제 독서 시간, 회차 방문은 독서 활동이다. [로컬 위치 저장](../../src/storage/reader-state-store.ts#L112), [스트리밍 방문 저장](../../src/features/external-sources/source-stream-library.ts#L181). 단순 작품 정보/책장 편집과 구분해야 한다. 회차를 열면 읽음으로 기록하는 현재 정책 자체는 이번 검토에서 결함으로 판정하지 않았다.
- 스트리밍만 있는 작품의 태그·즐겨찾기 일괄 변경은 명시적으로 비활성화되어 있다. 저장 방식별 기능 제한은 현재 계약이며, 버튼이 활성화된 척하는 결함은 발견하지 않았다. [명령 보호](../../src/ui-next/library/actions.ts#L100), [실행 보호](../../src/features/library/library-batch.ts#L27).

## LS-1 — P2: 메타데이터 수정이 최근 읽기 정렬을 바꾼다

**확실성: 합성 재현 확인. 사용자 제보와 일치하는 경로가 있으며, 모든 책장 이동에 발생하는 것은 아니다.**

원인은 실제 읽기 시각이 없으면 `updatedAt`으로 정렬하는 공통 정책이다.

- [통합 정렬](../../src/features/library/library-work-order.ts#L19): 22행은 로컬 책, 31행은 스트리밍 작품의 `updatedAt`을 대체값으로 사용한다.
- [기존 로컬 정렬](../../src/features/library/library-screen-model.ts#L61), [스트리밍 선행 정렬](../../src/features/book-workspace/workspace-screen-support.ts#L49)에도 같은 대체값이 있다.
- [소스 책장/제목 수정](../../src/features/external-sources/source-library-metadata.ts#L25)은 `updatedAt`을 현재 시각으로 바꾼다. [단일 책장 이동 연결](../../src/features/book-workspace/use-library-work-actions.tsx#L16)도 이 경로를 사용한다.
- 로컬 [메타데이터 수정](../../src/storage/library-management-store.ts#L76), [휴지통 복원](../../src/storage/library-catalog-store.ts#L113), [읽기 기록 초기화](../../src/storage/reader-state-store.ts#L162) 역시 `updatedAt`을 갱신한다.

재현: A는 9월 15일 읽었고 B는 9월 1일 추가한 미독 스트리밍 작품으로 둔다. `최근 읽은 순`은 A, B이다. B를 다른 책장으로 옮기면 읽은 기록은 그대로 없는데 B, A가 된다. 메모리 내 실제 `updateSourceLibraryMetadata` → `orderedLibraryWorks` 호출 결과:

```text
before: [recent-read, untouched-unread]
after:  [untouched-unread, recent-read]
hasReadAt: false
```

기대 동작: 분류·이름·태그·즐겨찾기·복원은 기존 독서 순서를 유지한다. 미독 작품을 정렬에 포함하는 정책은 유지하되, 읽기 증거가 없을 때는 변경되지 않는 추가 시각을 사용해야 한다. 현재 실제 동작: 편집한 미독 작품, 읽기 시각이 없는 과거 기록, 초기화한 작품이 새로 읽은 것처럼 승격된다. 실제 읽기 시각이 있으면 현재 코드도 그 값을 우선하므로 일반적인 편집은 순서를 바꾸지 않는다.

범위의 중요한 예외: 로컬 책의 순수 책장 멤버십 변경은 책의 `updatedAt`/`lastReadAt`을 쓰지 않는다. [IndexedDB 경로](../../src/storage/library-management-store.ts#L223), [서버 경로](../../apps/server/src/services/hosted-library-management-service.ts#L200). 따라서 원본 제보를 “책장 이동은 항상 읽기 시각을 덮어쓴다”라고 해석하면 잘못된 수정으로 이어진다. LS-3 때문에 실제 방문이 있어도 UI의 유효 읽기 시각이 사라지는 경우에는 이 문제가 더 넓게 드러날 수 있다.

최소 수정: 수정 시각의 저장은 유지하고, 세 정렬 경로의 활동 키를 공통화한다. 유효한 실제 방문/읽기 시각을 우선하고 없으면 `createdAt`/`addedAt`을 사용한다. “모든 미독을 마지막에 배치”는 별도 정책 변경이므로 이번 결함 수정에 임의로 포함하지 않는다.

회귀 검증: 로컬/스트리밍/연결된 작품 각각에서 읽음·미독·읽기 기록 초기화 상태를 만들고 책장 이동/추가/제외, 이름·태그·즐겨찾기 편집, 복원, 배경 소스 갱신 전후 정렬을 비교한다. 진짜 새 방문은 최상단으로 이동해야 하고 `최근 추가한 순`은 유지되어야 한다. 기존 [미독 대체값 테스트](../../src/features/library/library-work-order.test.ts#L43)는 추가 시각과 수정 시각을 분리하지 않아 이 오류를 잡지 못한다.

## LS-2 — P2: 소스 진행률 보정 후 완독 여부와 필터가 어긋난다

**확실성: 실제 projection 함수로 합성 재현 확인. 특히 `sourcePosition`이 있는 저장된 소스 텍스트 작품에서 명백하다.**

로컬 기준 필터/집계를 먼저 계산한 뒤, 소스 진행률이 들어오면 표시 객체의 `isFinished`만 바뀐다.

- [로컬 완독 판정](../../src/features/book-workspace/book-workspace-projection.ts#L29)은 저장된 책의 진행률을 사용한다.
- [필터/집계](../../src/features/library/library-screen-model.ts#L73), [집계 생성](../../src/features/library/library-screen-model.ts#L140)은 보정 전 값을 사용한다.
- [보정](../../src/features/library/library-source-progress.ts#L7)은 12행에서 `isFinished`를 바꾸지만 `readingStatusLabel`, 필터 결과, `filterCounts`를 재계산하지 않는다.
- [화면 연결](../../src/features/book-workspace/BookWorkspaceScreens.tsx#L188)은 이미 선택된 collection에 이 보정을 적용한다.

재현: 총 40회인 작품 중 1·2·6회를 저장하고 마지막 저장 회차까지 읽는다. 로컬 진행률은 100%지만 소스 위치는 6/40, 15%다. 완독 탭을 선택한다. 실제 결과:

```text
visibleInFinished: [downloaded]
filterCounts: { reading: 0, finished: 1 }
view: { isFinished: false, readingStatusLabel: 완독, bookProgress: 0.15 }
```

기대 동작: 새 UI가 보여 주는 작품 단위 완독 여부와 읽는 중/완독 탭, 개수, 홈 분류가 같은 판정을 사용한다. 현재 실제 동작: 완독 탭에 15%인 작품이 남고 읽는 중 탭에는 나타나지 않는다. 홈은 보정된 `isFinished`를 사용해 이어읽기 대상으로 취급할 수 있어 두 화면의 분류도 달라진다.

기존 의도와의 구분: [기존 보정 주석](../../src/features/library/library-source-progress.ts#L19)은 로컬 상태/필터 유지 정책을 명시한다. 그러나 현재 [소스 위치 테스트](../../src/features/external-sources/source-library-position.test.ts#L41)는 6/40인 책의 `isFinished === false`를 요구한다. 이 두 정책이 실제 코드 안에서 충돌한다. 모든 형식의 완료 정책을 임의로 바꾸기보다, 최소한 이미 `isFinished`를 바꾸는 소스 위치 경로에서 그 값으로 필터와 표시 상태를 다시 계산해야 한다.

최소 수정: 원본 Novel의 로컬 복원 상태는 유지하고, 유효한 작품 표시 상태를 계산한 뒤 필터/집계를 적용한다. `isUnread`, `isFinished`, 상태 문자열, CTA도 한 번에 같은 기준에서 파생한다.

회귀 검증: 저장된 마지막 회차가 소스의 마지막 회차가 아닌 경우와 같은 경우, 소스 위치 캐시가 없었다가 도착하는 경우를 각각 확인한다. 완독/읽는 중 탭의 포함 여부, 개수, 카드 퍼센트, 홈 이어읽기와 완독 행이 일치해야 한다.

## LS-3 — P2: 총 회차 수를 모르면 실제 읽기 이력이 서재에서 사라진다

**확실성: 메모리 내 progress·서재 필터·홈 continuity를 함께 호출해 재현 확인. 정상 복구 코드가 해당 입력을 만든다.**

- [방문 이력 복구](../../src/features/external-sources/recover-stream-library.ts#L75)는 캐시가 없을 때 최근 방문 회차 ID를 보존하지만 `availableReleaseCount: 0`인 서재 작품을 만든다.
- [진행률 projection](../../src/features/external-sources/source-work-progress.ts#L63)은 총 회차 수가 0이면 작품 전체를 건너뛴다. 유효한 `lastReadAt`도 결과에서 빠진다. 71행의 `knownReleaseIds`에만 묶인 방문 집계도 같은 종류의 이력 누락을 만들 수 있다.
- [서재 연결](../../src/features/book-workspace/BookWorkspaceScreens.tsx#L299)은 이 projection의 `lastReadAt`만 전달하고, [서재 상태 판정](../../src/features/book-workspace/workspace-screen-support.ts#L10)은 projection이 없으면 미독으로 본다.
- 반면 [홈 연결](../../src/ui-next/home/HomeWorkspace.tsx#L59)은 [방문 continuity](../../src/ui-next/home/source-continuity.ts#L20)를 대체값으로 사용하므로 실제 읽은 시각/회차를 유지한다.

재현: 회차 목록 캐시가 없는 복구된 스트리밍 작품에 최근 실제 방문 하나를 넣는다. 합성 결과는 `libraryProgressPresent: false`, 서재 읽는 중 필터 0개, 미독 필터 1개, 홈 `lastReadAt: 2026-09-15T00:00:00.000Z`다. 최근 정렬도 LS-1의 수정 시각 대체값으로 돌아가고, 메뉴는 [첫 화 보기](../../src/ui-next/library/actions.ts#L60)로 표시된다.

기대 동작: 총 회차 수가 없어 퍼센트를 계산하지 못해도, 이미 존재하는 실제 방문·이어읽기·최근 순서 정보는 보존한다. 같은 작품이 홈에서는 이어읽기인데 서재에서는 미독이 되면 안 된다.

최소 수정: 작품별 유효 방문 시각을 진행률의 분모/현재 카탈로그와 독립적으로 계산한다. 홈·서재·CTA·필터가 같은 읽기 이력을 사용하도록 연결하고, 실제 사용자 초기화 이후의 무효 이력은 계속 배제한다. 추가 네트워크 호출은 필요하지 않다.

회귀 검증: 총 회차 수 0, 부분 카탈로그에 마지막 방문 회차가 없는 경우, 오프라인/캐시 만료, 이력 초기화, 다른 계정의 동일 원격 ID를 포함한다. 미독 분류, 최근 순서, 이어읽기 라벨이 홈과 서재에서 일치해야 한다.

## LS-4 — P2: 책장 순서 교환의 첫 저장 실패 후 두 번째 저장이 계속된다

**확실성: 실제 관리 controller와 책장 editor hook에 오류를 주입해 재현 확인.**

- [순서 교환](../../src/features/library/use-shelf-editor-model.ts#L8)은 두 책장의 `sortOrder`를 순서대로 저장한다.
- [공통 실행 함수](../../src/features/library/useLibraryManagementController.ts#L204)는 실패를 알림으로 표시하고 정상적으로 resolve한다. [updateShelf](../../src/features/library/useLibraryManagementController.ts#L285)도 실패 결과를 호출자에게 전달하지 않는다.

재현: A의 순서 0, B의 순서 1에서 B를 위로 이동한다. B의 첫 업데이트에 충돌/네트워크 오류를 주입하고 A의 저장은 성공시킨다.

```text
calls: [[b, 0], [a, 1]]
stored order: [{ id: a, sortOrder: 1 }, { id: b, sortOrder: 1 }]
notifications: [danger, success]
```

기대 동작: 첫 저장 실패 시 교환을 중단하며 실패를 숨기지 않는다. 성공한 것처럼 두 번째 저장을 실행해서 동률 순서를 만들면 안 된다. 실제 동작: 저장된 두 순서가 같아지고, 후속 정렬은 이름 비교에 의존한다. 두 번째 성공 알림과 refresh가 첫 실패 표시를 덮을 수도 있다. 첫 저장이 성공하고 두 번째가 실패하는 경우도 비원자적 교환 때문에 동률을 만들 수 있다.

최소 수정: 실패를 반환값/예외로 전달해 첫 실패 후 후속 명령을 중단한다. 교환 전체는 로컬/서버 저장소의 원자적 재정렬 명령으로 처리하거나, 일부 성공 후 복구를 명시적으로 보장해야 한다. UI가 두 개의 독립적인 성공으로 해석하지 않도록 한 작업 결과로 보고한다.

회귀 검증: 첫 저장 실패, 둘째 저장 실패, 수정 revision 충돌을 주입하여 원래 순서 또는 완전한 새 순서만 남는지, 실패가 사용자에게 유지되는지 확인한다. [현재 테스트](../../src/features/library/use-shelf-editor-model.test.ts#L6)는 모두 성공하는 mock만 사용한다.

## LS-5 — P3: 서재 제목의 작품 수가 스트리밍 작품을 두 번 센다

**확실성: 호출 경로와 계산식을 직접 확인. 별도 브라우저 재현은 하지 않았다.**

[화면 controller](../../src/features/book-workspace/BookWorkspaceScreens.tsx#L205)는 `collection.totalBooks`에 활성 스트리밍 전용 작품 수를 이미 합산한다. [새 서재 화면](../../src/ui-next/library/UiNextLibraryScreen.tsx#L149)은 여기에 현재 보이는 스트리밍 작품 수를 다시 더하고 [제목 옆에 표시](../../src/ui-next/library/UiNextLibraryScreen.tsx#L242)한다.

재현: 활성 로컬 책 2권과 스트리밍 전용 작품 1개가 있으면 controller의 총계는 3이고, 새 화면 제목은 4가 된다. 해당 스트리밍 작품이 검색/필터로 숨겨지면 제목의 수가 3으로 달라진다.

기대 동작: 전체 서재 수는 작품별로 한 번만 집계한다. 최소 수정은 이미 합산된 `collection.totalBooks`를 사용하는 것이다. 책장 이름 옆에 그 책장 개수를 표시하려는 별도 UX 정책은 범위에 맞는 책장 집계를 사용하도록 구분해야 한다.

회귀 검증: 로컬만/스트리밍만/혼합/다운로드로 연결된 작품/휴지통을 포함하고, 검색·상태 필터 변화로 전체 개수가 임의로 달라지지 않는지 확인한다.

## 검증 결과와 한계

다음 기존 검사 7개 파일, 26개 테스트가 통과했다.

```text
node_modules/.bin/vitest run \
  src/features/library/library-work-order.test.ts \
  src/storage/library-management-store.test.ts \
  src/ui-next/home/local-reading-activity.test.ts \
  src/features/library/library-source-progress.test.ts \
  src/features/external-sources/source-library-position.test.ts \
  src/features/external-sources/source-work-progress.test.ts \
  src/features/library/use-shelf-editor-model.test.ts --maxWorkers=2
```

추가로 TSX eval에서 실제 함수·React hook을 사용한 합성 probe 네 건(LS-1~4)을 실행했다. 모든 probe는 메모리 상태만 사용했고 코드는 저장하지 않았다. 기존 검사가 통과해도 위의 음성 경로가 검증되었다는 뜻은 아니다. 서버 책장 membership 경로는 정적으로 확인했으며 실제 PostgreSQL 장애·다중 기기 동시 수정, 운영 브라우저 동작은 이번 검토에서 실행하지 않았다. 원본 제보의 개별 책에 실제 읽기 시각이 있었는지는 운영 데이터를 보지 않았으므로 확정하지 않았다.

## 수정 결과 — LS-1·LS-2·LS-3·LS-5 (2026-10-18)

- **LS-1 해결:** 통합/로컬/스트리밍 최근 정렬에 공통 활동 키를 적용했다. 실제 로컬 읽기·소스 방문 중 최신 시각을 사용하고, 이력이 없으면 `createdAt`/`addedAt`을 사용한다. 메타데이터 `updatedAt` 저장은 그대로이며 미독 작품의 추가 시각을 기존 독서와 섞는 정책도 유지한다.
- **LS-2 해결:** `sourcePosition` 경로의 완독·미독·상태 문자열·CTA를 같은 표시 상태로 계산하고, 전체 표시 카탈로그에서 필터·개수·최근 목록을 다시 만든다. 홈도 같은 `withSourceProgress`를 사용한다. 원본 Novel의 로컬 복원 위치는 변경하지 않는다. `sourcePosition` 없는 형식의 기존 완독 정책은 유지한다.
- **LS-3 해결:** 유효 방문 시각을 회차 분모/현재 목록과 독립적으로, connector/account/work 키별로 한 번 집계한다. 총 회차 0과 부분 목록에서도 방문 시각을 유지하고, 이후 미독 변경과 다른 계정·작품 이력은 배제한다. 알려지지 않은 회차를 읽음 개수로 추측하지 않으며 총계 0은 완독으로 판정하지 않는다. 로컬 책에 분모 없는 방문 정보만 있으면 기존 로컬 진행률 표시를 유지한다.
- **LS-5 해결:** 제목은 controller가 이미 합산한 `collection.totalBooks`만 표시한다. 표시 중인 스트리밍 작품 수를 다시 더하지 않는다.
- **LS-4 해결:** 아래 원자적 책장 순서 저장 수정 결과를 참조한다.

회귀 검증: 아래 8개 파일의 71개 테스트 통과. 원본 HEAD 구현 5개 파일을 별도 임시 복사본에 넣고 새 테스트를 실행했을 때 네 결함에 해당하는 7개 테스트가 실패했으며, 수정 구현에서는 통과했다. 임시 복사본은 삭제했다.

```text
node_modules/.bin/vitest run \
  src/features/library/library-work-order.test.ts \
  src/features/library/library-source-progress.test.ts \
  src/features/external-sources/source-work-progress.test.ts \
  src/features/book-workspace/BookWorkspaceScreens.source-progress.test.tsx \
  src/features/book-workspace/workspace-screen-support.test.ts \
  src/ui-next/library/UiNextLibraryScreen.test.tsx \
  src/features/external-sources/source-library-position.test.ts \
  src/ui-next/home/model.test.ts --maxWorkers=2
```

검증 범위는 메모리 fixture와 React 렌더링이다. 운영 데이터·브라우저·비공개 확장은 접근하지 않았으며, commit/push/deploy는 수행하지 않았다. 전체 통합 타입 검사는 병렬 수정이 합쳐진 시점에 다시 확인한다.

## 수정 결과 — LS-4 (2026-10-18)

책장 editor는 두 개의 `updateShelf` 대신 전체 ID·expectedRevision 목록을 한 번의 `reorderShelves`로 저장한다. 현재 전체 목록과 revision이 일치해야 하며 요청한 순서를 정수 `0..N-1`로 정규화하여 과거에 생긴 동률도 해결한다. 기존 `0..10000` 계약에 맞춰 최대 10001개를 허용한다. 순서가 바뀐 책장만 revision·updatedAt을 갱신하며 이름·색상·생성 시각은 보존한다.

IndexedDB는 책장과 sync outbox를 같은 readwrite transaction에 저장한다. PostgreSQL은 owner별 advisory transaction lock과 row lock 아래 목록을 검증하고, 모든 변경과 sync event를 한 transaction으로 commit한다. 생성·수정·삭제와 sync의 책장 쓰기도 같은 owner lock에 참여한다. 첫째·둘째 쓰기 실패는 순서·revision·event를 모두 rollback한다. UI는 전체 작업에 대해 성공 또는 실패 알림을 한 번만 표시하며 실패 뒤 후속 저장을 실행하지 않는다. 새 `PUT /api/shelves/order`를 지원하지 않는 서버는 업데이트 안내 오류를 반환하고 독립 저장으로 fallback하지 않는다. 스키마 변경은 없다.

검증:

- 로컬·editor·controller·remote compatibility·기존 metadata editor·sync reader 테스트 7개 파일 58개 통과. 실제 editor/controller 성공·실패 회귀 테스트를 원본 HEAD editor 임시 복사본에 적용하면 2개 모두 실패하며 수정본에서는 통과한다. 임시 파일은 삭제했다.
- 별도 생성·삭제하는 PostgreSQL harness에서 `apps/server/src/db/shelf-order.integration.test.ts` 3개 테스트 통과(27.59초, skip 없음). 실제 route/client/repository 연결, 동률 복구, revision·전체 목록 fence, 중복·크기 검증, 다른 owner 접근 거절, 동시 요청 한 건만 성공, 첫째·둘째 UPDATE 트리거 오류의 transaction rollback을 확인했다. 데이터베이스 URL 환경변수는 모두 해제했으며 운영 DB·컨테이너는 변경하지 않았다.
- 실패 시 IndexedDB의 sync outbox와 PostgreSQL의 sync_events가 원상태이고 metadata가 보존됨을 확인했다. 실제 다중 기기 sync 전달 자체는 이 검증 범위에 포함하지 않는다.

```text
node_modules/.bin/vitest run src/storage/shelf-order.test.ts src/storage/library-management-store.test.ts \
  src/features/library/use-shelf-editor-model.test.ts src/features/library/useLibraryManagementController.test.tsx \
  src/repositories/remote-shelf-order.test.ts src/ui-next/library/UiNextMetadataEditor.test.tsx \
  apps/server/src/routes/sync/sync-reader-events.test.ts --maxWorkers=2

env -u TEST_DATABASE_URL -u BOAA_TEST_DATABASE_URL -u MOYA_TEST_DATABASE_URL \
  -u NOVELDESK_TEST_DATABASE_URL -u MOA_TEST_DATABASE_URL -u POSTGRES_TEST_URL \
  node_modules/.bin/vitest run apps/server/src/db/shelf-order.integration.test.ts --maxWorkers=2
```
