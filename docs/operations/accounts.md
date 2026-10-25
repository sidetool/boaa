# 서버 계정과 초대

코드 대조: 2026-10-25, `0550c99`. 서버 웹/PWA는 관리자가 가족·지인의 계정을 만들고 초대하는 방식을 지원한다.
공개 회원가입과 탭별 동시 계정 선택은 제공하지 않는다. 데스크톱·정적 웹의 로컬 서재와는 별도 계약이다.

## 사용과 권한

1. 새 서버는 로그의 초기 설정 코드로 첫 관리자를 만든다. 기존 소유자는 같은 사용자 ID와 서재를 유지한다.
2. 관리자는 설정의 계정 화면에서 회원을 만들고 일회용 초대 링크를 전달한다. 초대받은 사람은 자기 비밀번호를 설정한 뒤 로그인한다.
3. 관리자는 회원 이용 중지/재활성화, 초대 재발급, 비밀번호 재설정 링크 발급과 세션 해제를 할 수 있다. 회원 비밀번호를 조회하거나 관리자 권한으로 다른 회원의 서재를 여는 기능은 없다.
4. 같은 서버 origin과 브라우저 프로필은 쿠키 계정 하나를 공유한다. 계정 전환은 같은 쿠키 저장소를 사용하는 다른 탭/PWA에도 영향을 준다. 별도 브라우저 프로필은 별도 계정을 사용할 수 있다.

| 구분 | 현재 경계 |
| --- | --- |
| 서재·읽기 상태·책장·소스 로그인·브라우저 캐시 | 계정별 분리 |
| 확장 코드 설치·업데이트·제거, 서버 업데이트·공통 실행기 | 관리자 전용 |
| 허용된 소스의 자기 설정·로그인·활성 여부 | 회원별 관리 |
| 서버 AI·TTS·작품 번역, 공유 로그인 수집기, WebDAV/SFTP 연결 | 관리자 전용. 회원의 기기 시스템 음성은 사용 가능 |
| 백업 | 본인 서재 내보내기. 복원은 관리자 전용이며 다른 계정 ID를 덮어쓰지 않음 |

서버 운영자가 DB·파일에 접근할 수 없게 만드는 종단 간 암호화 서비스는 아니다. 이 구분은 앱/API와 실행 상태의 소유권 경계다.

## 구현 계약

- 요청의 `{ userId, role, authMethod }`는 서버 인증이 정한다. `DEFAULT_USER_ID`는 기존 관리자·이전 호환용이며 일반 요청의 소유자 대체값으로 쓰지 않는다.
- 쿠키 기반 보호 API는 `X-BOAA-Session-Context`를 검사한다. 쿠키 계정과 다르면 `409 session_context_mismatch`로 거부한다. 이전 요청을 새 계정으로 자동 재시도하지 않는다.
- 로그아웃은 서버 세션을 폐기한다. 늦은 이전 로그아웃 응답이 새 로그인 쿠키를 지우지 않도록 한다. 브라우저 runtime·저장소와 비동기 응답도 계정 수명을 따른다.
- 초대/재설정 토큰은 해시로 저장하고 만료·재발급·일회 사용을 검사한다. 초대 수락 자체가 자동 로그인은 아니다.
- `READER_AUTH_TOKEN`은 기존 관리자용 복구/자동화 자격 증명이다. 일반 웹 계정의 개인 토큰이나 회원 로그인 대체값이 아니다.
- 기존 계정 구분 없는 브라우저 저장소를 첫 회원에게 자동 이전하지 않는다. 서버 설정을 가져오며 기기 전용 연결·폴더 권한은 다시 연결해야 할 수 있다.
- API와 작업자는 접수한 계정의 소유권을 유지한다. 로그아웃만으로 이미 접수된 다운로드/가져오기 작업의 소유자가 바뀌지 않는다.

확인할 코드:

- `apps/server/src/auth.ts`, `routes/auth.ts`, `routes/admin-accounts.ts`, `services/self-host-auth-service.ts`
- `apps/server/src/services/owner-context.ts`, `extensions/owner-runtime-registry.ts`
- `src/features/auth/`, `src/storage/account-storage.ts`, `src/ui-next/settings/pages/AccountPage.tsx`
- `apps/server/src/db/migrations/0059_admin_invited_accounts.sql`

## 이전과 검증

다중 계정 이전은 schema epoch 1 → 2의 호환 경계를 넘는다. 구버전 이미지로 교체하는 것만으로 복귀할 수 없다.
[릴리스 관리의 오프라인 이전 절차](../../deploy/release-management.md)를 따라 같은 시점의 DB·파일·암호화 키를 보존한다.
현재 버전·최소 업데이트 버전·epoch는 `deploy/release-policy.json`을 확인한다.

변경 시 인증/권한, 교차 계정 데이터 충돌, 늦은 응답과 브라우저 계정 전환을 검증한다.
관련 검사는 `apps/server/src/auth.test.ts`, `apps/server/src/db/*account*.test.ts`,
`src/features/auth/` 및 `scripts/smoke-multi-account-browser.mjs`에 있다. 실행 범위는 [검증 가이드](../maintenance/testing.md)를 따른다.
과거 특정 실행의 통과 수는 현재 배포·실기기·다중 worker의 검증을 대신하지 않는다.
