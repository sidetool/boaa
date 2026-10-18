# 다중 계정 서버 독립 검토

검토일: 2026-10-18. 대상: `feat/admin-invited-accounts` 공유 작업 트리. 기능 파일은 수정하지 않았다. 아래 결과는 운영 데이터나 비공개 확장을 사용하지 않은 합성 PostgreSQL/Fastify 재현이다. 구현자가 검토 중 반영한 수정은 같은 재현으로 다시 확인했다.

## 판정

검토에서 수정 사항 6건을 확인했다. 데이터 격리 4건은 수정 후 독립 재현을 통과했다. 최초 검토에서 미해결이던 배포 epoch 정책과 로그아웃 쿠키 경쟁도 후속 구현으로 보완했다. 아래 본문은 발견 당시의 재현 기록이며, 이 보고서 자체는 전체 브라우저/PWA 승인이나 배포 승인을 의미하지 않는다.

| 번호 | 심각도 | 문제 | 재검증 상태 |
| --- | --- | --- | --- |
| S1 | P1 | 복원 사전 검사 후 생성된 다른 계정 글꼴을 덮어씀 | 수정 후 재현 통과 |
| S2 | P1 | 회원용 최종 책 ID 충돌 시 다른 계정 본문 교체 | 수정 후 재현 통과 |
| S3 | P1 | 다른 계정 책에 독서 세션 생성, 그 계정 백업에 혼입 | 수정 후 재현 통과 |
| S4 | P1 | 본문에만 책 ID를 넣은 sync 이벤트가 소유권 검사 우회 | 수정 후 재현 통과 |
| S5 | P1 | 비호환 스키마가 기존 epoch 및 rollback-safe 정책 유지 | epoch 2 및 오프라인 이전 절차 반영, 릴리스 검사 20개 통과 |
| S6 | P2 | 늦은 이전 계정 로그아웃 응답이 새 로그인 쿠키를 삭제함 | 폐기만 수행하도록 수정, 실제 Chromium 재현에서 B 세션 200 유지 |

후속 확인: `deploy/release-policy.json`의 schemaEpoch는 2이며 이전 배포와의 자동 업데이트를 허용하지 않는다. `deploy/release-management.md`는 별도 프로젝트/볼륨에 같은 시점의 백업을 복원하는 절차를 설명한다. logout/logout-all은 서버 세션만 폐기하고 응답으로 새 로그인 쿠키를 지우지 않는다. 조회 응답의 legacy cookie 재발급도 제거했으며 브라우저의 인증 변경은 origin 공통 Web Lock으로 직렬화한다. 실제 운영 이전 및 복원 리허설은 수행하지 않았다.

## S1 — 백업 글꼴 복원에 쓰기 시점 소유권 조건이 없음

위치: `apps/server/src/services/hosted-backup-service.ts`, `insertHostedBackupRow`, 글꼴 `ON CONFLICT (id) DO UPDATE`(검토 시 357–365행).

복원은 사전 검사에서 다른 사용자의 ID를 거부하지만 이 검사와 실제 INSERT 사이에는 파일 기록 및 다른 DB 작업이 있다. 글꼴 upsert는 기존 행의 `user_id`를 검사하지 않는다.

재현:

1. A가 `shared-font-id` 글꼴을 업로드하고 개인 백업을 만든 뒤 글꼴을 삭제한다.
2. A 복원이 사전 검사를 통과한 다음, 실제 글꼴 INSERT 직전에 B가 같은 ID로 정상 `PUT /api/fonts/shared-font-id` 요청을 완료한다.
3. A 복원이 성공한다. 행의 `user_id`는 B인데 이름은 A의 이름, 저장 키는 `a/backup-restores/...`로 바뀐다.
4. B의 `GET /api/fonts/shared-font-id/content`는 **200**이며 응답은 **A의 백업 바이트와 동일**, B가 업로드한 바이트와 다르다.

필수 수정: `user_fonts.user_id = excluded.user_id`를 실제 upsert에 넣고 영향 행 수가 1이 아니면 전체 복원을 실패시킨다. 사전 검사만 추가하거나 재실행하는 것으로는 이 경쟁을 막지 못한다. 경쟁 시 B의 메타데이터와 바이트가 그대로 남고 A 복원이 롤백되는 회귀 검증이 필요하다.

수정 후 독립 재검증: 같은 경쟁에서 복원은 `backup_restore_identity_conflict`로 중단된다. B의 이름 `FontB`와 저장 키 `b/fonts/...`가 유지되며 GET은 **200**, `equalsA=false`, `equalsB=true`다.

재현 파일: `/tmp/multi-account-backup-race.mts`. 실제 PG의 복원 연결을 감싸 INSERT 직전에 별도 정상 HTTP 업로드를 끼웠다. SQL 결과를 모킹하지 않았다. `A_FONT_PUT 200`, `CONCURRENT_B_FONT_PUT 200`, `RESTORE_RESULT restoredEntries:1`, `B_FONT_GET 200 equalsA true equalsB false`를 확인했다.

## S2 — 파생된 책 ID를 검사하지 않고 자식 본문을 교체함

위치: `apps/server/src/services/import-service.ts`, 회원용 `client_book_id` 파생, 책 활성화 INSERT 및 후속 `replaceParsedBookContent`; `services/import/stage-content.ts`의 자식 upsert.

최초 구현은 요청의 원래 `client_book_id`만 소유권 검사했다. 회원용 최종 ID를 만든 뒤 기존 타인 소유 행과 충돌하면 책 upsert가 0행이어도 `expectedBase`가 없을 때 계속 진행했다.

재현: A의 책 ID를 `persistentId128('hosted_book', ['b', 'same-client'])`로 만들고, B는 `client_book_id='same-client'`로 TXT를 가져온다. B 작업은 `done`이 되고 A의 책 소유자·제목은 남지만 기존 장/본문이 B의 내용으로 바뀌었다. 해시 충돌을 찾을 필요가 없는 명시적인 ID 충돌이다.

수정 후: 활성화 트랜잭션의 최종 ID 검사와 책 INSERT 영향 행 수 검사가 추가되었다. 같은 재현은 `import_target_not_found`, 작업 `failed`, 결과 책 ID `null`이며 A의 `Original A Chapter`가 보존되었다. 장·페이지·자산·문단 검색 upsert의 부모 조건 및 영향 행 수 검사도 확인했다.

## S3 — 독서 세션의 책과 사용자 관계를 검증하지 않음

위치: `apps/server/src/routes/books/personalization-routes.ts`, `POST /api/reading-sessions`; `services/hosted-backup-service.ts`, `snapshotHostedData`; migration 0060.

최초 구현은 `body.bookId`를 그대로 INSERT하고 사용자 FK와 책 FK를 각각만 만족시켰다. A 회원이 B의 책 ID를 보내면 **200**으로 `user_id=A, book_id=B` 행이 생성되었다. B의 개인 백업은 책 ID로만 자식을 선택해 A의 행을 포함했다. 이런 백업은 이후 교차 계정 복원 검사에도 걸린다.

수정 후: 소유한 책에서 `INSERT SELECT`, 없는 책/외부 책은 404, `(book_id,user_id)` 합성 FK, 백업의 사용자 열 필터를 확인했다. 같은 재현에서 **404**이며 B 백업의 독서 세션 배열은 비어 있다.

## S4 — sync의 최종 책 참조와 소유권 검사가 다름

위치: `apps/server/src/routes/sync/revision-conflict-policy.ts`, `hasExistingBookForEvent`; `push-route.ts`; `ai-tts-sync-persistence.ts`의 voice profile 교체.

최초 검사는 `event.novelId`가 없으면 통과했지만 실제 저장용 parser는 `payload.bookId`를 허용했다. A 관리자 주체로 유효한 v2 ID와 `type='voice_profiles_updated'`, `payload={bookId:'book_b',voiceProfiles:[]}`만 보내면 **accepted=1**이며 B 책의 profile이 삭제되었다. 회원 provider 차단은 의도한 V1 정책이지만 관리자 개인 데이터 API도 다른 계정을 수정해서는 안 된다.

수정 후: `syncEventBookBoundary`가 event와 payload/중첩 참조의 일치를 확인하고 최종 책 ID로 소유권을 검사한다. 같은 재현은 **accepted=0**, `invalid`이며 B profile 수는 1로 보존되었다. 서로 다른 event/payload 책 ID를 거부하는 검증도 구현자가 추가 중이다.

S2–S4 재현 파일: `/tmp/multi-account-server-review.mts`. 수정 전 실패와 수정 후 차단을 각각 실제 임시 PG에서 확인했다.

## S5 — 스키마 변경과 release 복귀 정책이 맞지 않음

위치: `deploy/release-policy.json:4`, migrations 0059/0060, `scripts/release/updater.mjs:234`의 `compatible`, `install.mjs`, `reconcile.mjs`, `deployment.mjs`의 `initialize`.

0059는 구버전이 읽는 `singleton_key`를 바꾸고 0060은 전역 raw hash 및 sync event ID 유일 제약을 제거한다. 기존 epoch 1 및 `rollbackSafe:true`로 이 버전을 발행하면 구버전 바이너리만 복귀시키는 경로가 같은 epoch로 취급된다. 회원 활성화 여부와 별개로 스키마 자체가 구버전 SQL과 비호환이다.

필수 조치: 첫 다중 계정 릴리스는 epoch 2 등 별도 호환 경계로 표시하고 정지·DB/볼륨 백업·오프라인 마이그레이션·일관된 배포 snapshot 갱신 절차를 제공한다. 현재 updater는 다른 epoch 자동 적용을 거부하므로 이를 우회하는 자동 migration 엔진을 이번 작업에 추가할 필요는 없다.

운영 절차의 구체적인 제약:

- `install.mjs`는 기존 `.boaa-release/installed.json`이 있으면 설치를 거부한다. 기존 설치를 그대로 업그레이드하는 명령이 아니다.
- `reconcile.mjs`는 새 manifest를 받지 않고 저장된 `current.json`의 compose를 다시 적용한다. 이전 snapshot을 남겨 두고 실행하면 이전 이미지를 적용한다.
- `DockerDeployment.initialize`는 `current.json`이 있으면 환경 변수보다 기존 snapshot을 우선한다. updater 환경의 epoch만 바꾸어서는 이전되지 않는다.
- 새 manifest의 digest/version, resolved config, compose, current snapshot의 epoch를 함께 맞추고 검증한 뒤 updater를 시작해야 한다. 복귀에는 동일 시점의 DB와 볼륨 snapshot이 필요하다.

## S6 — 늦은 로그아웃 응답이 새 계정 쿠키를 지움

위치: `apps/server/src/routes/auth.ts:162`의 logout handler, 특히 세션 폐기 이후의 `clearedSessionCookies` 응답.

현재 context 검사는 새 쿠키로 도착한 이전 탭 요청을 409로 막는다. 이미 A의 올바른 context로 접수한 요청의 응답 순서까지 막지는 못한다.

실제 Chromium의 같은 browser context 두 탭으로 재현했다. A의 logout은 DB에 해당하는 service 상태에서 세션을 폐기하고 응답 직전 대기한다. 다른 탭은 폐기된 A 쿠키로 B의 정상 login을 완료한다. 이때 쿠키는 `token-b`다. 이어 A logout 응답을 풀면 **200 + Max-Age=0**으로 B 쿠키가 사라지고 B의 `/api/auth/session`은 **401**이 된다. `replaceCurrentSession`이나 잘못된 Origin/context를 사용하지 않았다.

재현 파일: `/tmp/multi-account-cookie-response-race.mts`. 실제 Fastify auth route와 Chromium 쿠키 처리를 사용하며 service seam으로 폐기 후 응답 지연만 제어했다. 최종 출력은 `NEW_LOGIN 200 b`, `COOKIE_BEFORE_OLD_RESPONSE token-b`, `COOKIE_AFTER_OLD_RESPONSE []`, `B_SESSION_AFTER_STALE_LOGOUT 401`이다.

필요 조치: 새 쿠키에 영향을 줄 수 있는 인증 응답의 순서를 보장하거나, 폐기된 예전 쿠키를 무조건 만료시키지 않는 프로토콜을 검토한다. 다른 탭까지 포함한 쿠키 변경 동작 직렬화라면 로그인·로그아웃·비밀번호 변경과 지연된 상태 응답의 legacy cookie 이전도 함께 검토해야 한다. 단순한 응답 후 재확인, BroadcastChannel 알림, 요청 시작 시 context 비교만으로는 이미 적용된 Set-Cookie를 막지 못한다. 데이터 쓰기 격리와 별개의 재로그인 유발 결함이므로 P2로 분류했다.

## 검토 범위와 남은 검증

읽은 범위: auth hook/cookie/routes/service와 token transaction, 0059/0060, 요청 소유자 전달, import/sync/backup/독서 기록, owner runtime registry와 요청 abort 연결, 소스 코드 provisioning과 개인 vault 구성, global process budget, release 호환 검사.

합성 재현은 환경의 `*_TEST_DATABASE_URL` 및 `POSTGRES_TEST_URL`을 제거하고 새 임시 PG harness만 사용했다. 생성한 PG는 정리했다. 운영 서버/데이터/비밀 및 기존 `boaa-id-v2-eff22d5c` 컨테이너는 변경하지 않았다. 커밋·push·배포는 하지 않았다.

인증 token transaction과 credential provisioning 코드에서는 추가 중대 결함을 확인하지 못했다. owner registry의 abort 연결, APK supervisor의 kill 및 공유 budget 반환, browser state 저장 전 abort 검사를 확인했으나 모든 실제 worker 폐기나 스키마 downgrade/복원 리허설을 실행한 것은 아니다. `membersReady` 활성화는 별도의 실제 서버/브라우저 수락 검증 이후에 판단해야 한다.

구현 후속 기록: 기본 서버 설정에서 실제 전체 앱/임시 서버의 9개 계정 흐름을 통과한 뒤 초대 기능을 활성화했다. 브라우저 검증 한계와 한 차례 관측한 원인 미확정 취소 로그는 [최종 구현 기록](../plans/multi-account.md)에 남겼다. 운영 서버는 변경하지 않았다.
