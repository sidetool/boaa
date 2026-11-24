# 현재 아키텍처

코드 대조: 2026-10-25, `0550c99` 및 운영에 추가된 원격 파일 요청 취소 패치.
이 문서는 실행 경로의 지도다. 세부 계약은 아래 담당 문서와 해당 구현을 확인한다.

## 제품별 실행과 저장

| 실행 형태 | 시작점 | 주 저장소·인증 |
| --- | --- | --- |
| 서버 웹/PWA | `src/main.tsx` → `SelfHostAccountGate` → `src/reader-application.tsx`의 `AuthenticatedApplication` | 인증된 계정의 서버 repository, PostgreSQL·원본 객체 저장소. IndexedDB는 보조 로컬 상태에도 사용 |
| Windows 내장 서버 | 같은 시작점의 `EmbeddedServerGate` → remote reader runtime | 앱이 시작한 기존 self-host 서버의 DB·원본. Tauri가 서버 실행과 기기 기능 담당 |
| Windows의 기존 서버 연결 | `DesktopRemoteHome`, `src-tauri/src/desktop_remote_window.rs` | 선택한 서버의 웹 화면·로그인·서재 |
| 서버 없는 정적 웹 | `apps/web/src/main.tsx` → `createWebRuntime` → 공통 `App` | 로컬 IndexedDB. 선택적 Cloud Vault와 웹 인증 서비스는 별도 계약 |
| 로컬/native 실행 | `src/reader-application.tsx`의 `startLocalApp`, `src-tauri/` | 로컬 repository와 플랫폼 adapter. 서버 웹의 회원 기능과 동일시하지 않음 |

`src/App.tsx`와 `src/features/`는 제품 사이에 공유된다. `src/ui-next/`가 현재 주 화면을 구성한다.
정적 웹은 공통 코드를 조합하며, 공통 코드가 `apps/web`을 역참조하지 않는다.
데스크톱·Android의 빌드 및 지원 범위는 [데스크톱 구조](../platforms/desktop.md)와
[네이티브 빌드](../platforms/native-build-guide-ko.md), 정적 웹은 [별도 웹 구조](local-static-web.md)를 따른다.

앱 시작 시 서재 데이터와 기기 음성 목록을 병렬로 준비한다. 기기 음성 조회가 늦거나 실패해도 서재를 열 수 있다. 책장을 선택하면 제목의 권수와 읽기 상태별 권수는 그 책장에 담긴 작품을 센다. 다운로드한 소스 작품은 한 번만 세며, 휴지통은 서재 전체를 대상으로 한다.

통합 검색의 서재 결과는 30개씩 페이지를 넘겨 볼 수 있다. 작품 상세에서 뒤로 가면 해당 검색의 입력어, 서재 결과 페이지, 목록 위치와 선택한 작품의 포커스를 복원한다. 홈의 이어 읽기와 작품 줄도 돌아왔을 때 가로 위치를 복원한다. 소스 검색은 먼저 도착한 작품 줄 아래에 후속 결과를 추가한다. 동일한 소스 연결·검색어의 성공 결과는 현재 탐색 세션 안에서 1분 동안 재사용하며, 실패한 줄의 다시 시도는 소스에 새로 요청한다. 호스팅 계정에서 로그아웃하거나 로그인 세션이 교체되면 열려 있던 검색과 임시 입력·스크롤 상태를 폐기한다.

## 서버와 작업 처리

사용자 ZIP을 복원할 때 앱은 미리보기에서 교체하기로 한 작품 ID만 저장소로 전달한다. 로컬은 IndexedDB 쓰기 트랜잭션에서 충돌을 다시 확인하며, 서버는 업로드해 둔 ZIP을 재사용한다. 확인 뒤 새로 생긴 책은 기본 교체 대상에서 제외된다. 큰 선택 목록은 서버에 JSON 본문으로 전달하므로 웹과 API를 함께 업데이트한다.

```text
브라우저 / 데스크톱
  → 인증된 API (apps/server/src/server.ts)
    → routes / services → PostgreSQL + 객체 저장소
    → Redis / BullMQ → worker.ts → 가져오기 / AI·TTS / 번역
    → 계정별 확장 runtime → 공통 네트워크·자격 증명 경계
```

- `apps/server/src/index.ts`가 설정을 읽고 API를 시작한다. `server.ts`는 인증, route, 저장소 및 확장 runtime을 조합한다.
- `auth.ts`가 요청 주체와 세션 문맥을 검사한다. 서재와 소스 상태는 계정별이며 서버 관리·실행 코드 설치는 관리자 권한을 요구한다. [계정 운영](../operations/accounts.md)을 따른다.
- `worker.ts`는 가져오기·provider·번역 작업과 복구/유지 작업을 실행한다. API와 worker는 같은 릴리스로 배포한다.
- 저장소 형식은 `apps/server/src/db/migrations/` 및 `src/storage/`에서 확인한다. DB migration 파일을 과거 문서의 스키마 번호에 맞춰 되돌리지 않는다.
- 서버 배포 구성은 `compose*.yaml`, 관리형 릴리스는 `deploy/release-policy.json`과 [릴리스 관리](../../deploy/release-management.md)가 기준이다.

## 책임과 공통 코드

| 영역 | 구현 위치 | 담당 문서 |
| --- | --- | --- |
| repository와 데이터 수명 | `src/repositories/`, `src/storage/`, `apps/server/src/services/` | [데이터 모델과 저장](data-model-and-storage.md) |
| Reader·페이지/스크롤·위치 | `src/features/reader/`, `packages/reader-core/`, `packages/text-core/` | [Reader 경계](modular-reader-core.md) |
| 파서·가져오기·원본 보존 | `src/services/import/`, 공통 format 패키지, 서버 import service | [가져오기](import-parser.md), [고정 레이아웃](document-formats-and-fixed-layout-viewer.md) |
| 작품 소스·다운로드·서재 투영 | `src/external-sources/`, `src/features/external-sources/` | [외부 작품 소스](external-library-sources.md) |
| AI/TTS·작업·비밀키 | `src/providers/`, `src/features/tts/`, `apps/server/src/providers/`, `src-tauri/src/` | [provider 경계](provider-boundaries.md), [작업·캐시](ai-tts-provider-job-cache-security.md) |
| 번역 | `src/features/translation/`, `apps/server/src/translation/` | [작품 번역](../text-translation.md) |
| 설치형 확장·플러그인 | `src/extensions/`, `apps/server/src/extensions/`, `apps/server/src/plugins/`, 공통 확장 패키지 | [소스 SDK](../extensions/source-development.md), [플러그인](../extensions/platform-plugins.md) |

로컬/서버 adapter, 번들 신뢰 확장, 설치형 소스, 플랫폼 플러그인은 각각 소비자와 실행 경계가 있다.
이름이 비슷하다는 이유만으로 미사용 또는 중복이라고 판단하지 않는다. 구조 개선 후보와 검증 범위는
[유지보수 감사](../maintenance/2026-10-25-maintainability-audit.md)에 분리해 기록한다.
