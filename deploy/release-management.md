# Docker 서버 릴리즈와 선택 런타임

이 경로는 Docker 서버와 웹 UI용이다. 데스크톱 배포는 포함하지 않는다. 소스 개발용 `compose.yaml`은 계속 사용할 수 있지만 앱 내 서버 업데이트는 `compose.release.yaml`로 설치한 관리형 배포에서만 활성화된다.

## 설치

필요 조건: Linux Docker Engine/Compose v2, Node.js 22 이상, linux/amd64 또는 linux/arm64. 최초 공식 릴리즈를 만들기 전에는 아래 설치가 완료되지 않는다. 릴리즈 서명 키와 배포 준비 사항은 아래 발행 절차를 참고한다.

1. 공식 GitHub Release에서 `boaa-install.tar.gz`, `.sig`를 받고, 신뢰할 수 있는 별도 경로에서 공개 키를 확보한다. 아카이브 안의 키를 처음부터 신뢰하지 않는다. 저장소의 검토된 `scripts/release/verify-bundle.mjs`로 추출 전에 검증한다.
2. 새 설치 디렉터리에 압축을 풀고 다음 명령을 실행한다. 버전은 실제 발행된 태그로 대체한다.

```sh
node /trusted/verify-bundle.mjs boaa-install.tar.gz boaa-install.tar.gz.sig /trusted/boaa-release-public.pem
tar -xzf boaa-install.tar.gz -C /srv/boaa
cd /srv/boaa
node scripts/release/install.mjs --version vX.Y.Z --key /trusted/boaa-release-public.pem
```

설치기는 서명을 검증한 manifest의 digest로 모든 BOAA 이미지를 고정한다. `.env`가 없으면 무작위 비밀 값을 생성하고, 기존 `.env`는 보존한다. 기본 다운로드에는 API/작업자/웹/업데이터와 저장소 서비스만 포함된다. APK Java, Chromium, Python 메타데이터 실행기는 필요할 때 설정에서 별도로 설치한다.

기존 소스 설치를 이 명령으로 덮어쓰지 않는다. 같은 Compose project 이름, DB·객체 저장소·서버 데이터 볼륨, 암호화 키를 유지한 별도 전환 계획이 필요하다. 기존 설치의 설정·볼륨과 업데이터 기록이 맞지 않으면 관리 기능을 활성화하지 않는다. 자동 백업은 제공된 postgres 서비스와 `/data/server` 데이터 경로를 사용하는 구성만 지원한다. 외부 DB 또는 다른 데이터 경로는 자동 적용을 차단한다.

## 앱 내 동작

서버 설정에서 안정/베타 채널 확인, 릴리즈 노트 확인, 업데이트 및 선택 런타임 설치/비활성화를 실행한다. 확인은 다운로드나 자동 설치를 수행하지 않는다. 베타 채널에는 안정 버전도 포함되며, 채널 전환으로 낮은 버전이 설치되지는 않는다.

업데이트는 서명 검증 → 필요한 이미지 선다운로드 → 새 요청 제한 및 작업 대기열 비움 확인 → API/작업자 중지 → DB·설정 백업 → 실행 → health/readiness 확인 → 적용 기록 순서다. 15초 내 대기열이 비워지지 않으면 적용하지 않는다. 재시작 동안 웹 연결이 잠시 끊길 수 있다. 호환되는 이전 이미지 조합으로 복구하며, DB를 자동으로 과거 상태로 덮어쓰지 않는다. 스키마 epoch가 달라지거나 `rollbackSafe=false`인 릴리즈는 수동 마이그레이션 대상으로 차단한다.

업데이터는 자체 교체 없이 protocol 1 호환 릴리즈를 관리한다. 업데이터 프로토콜/실행기 자체 변경이 필요한 릴리즈는 별도의 관리자 전환이 필요하다. 앱 버튼이 Docker Engine이나 PostgreSQL/Redis/MinIO 자체를 업데이트하지는 않는다.

## 선택 구성요소

| 구성요소 | 설치 내용 | 비활성화 시 |
| --- | --- | --- |
| APK | JRE + 사이트 중립 APK 호스트 JAR, 원자적 `current` 포인터 | API 재시작, APK 실행 중단, APK 파일·설정·payload 볼륨 보존 |
| 브라우저 | 인증된 원격 Playwright/patchright + Chromium | worker 중지, HTTP 확장은 계속 동작 |
| 메타데이터 | 사이트 중립 Python ASGI 실행기 | worker 중지, 제공자·캐시 데이터 보존 |

APK provider 컨테이너는 성공 후 `Exited (0)`인 것이 정상이다. 실행 중 앱 버전과 같은 릴리즈의 구성요소만 설치한다. 이미 설치했어도 꺼 둔 구성요소는 앱 업데이트 때 다시 받지 않으며, 다음 활성화 시 현재 앱 버전으로 맞춘다. 표시되는 다운로드 크기는 이미지 압축 layer 총량의 아키텍처별 최대치로, 이미 받은 layer 재사용에 따른 실제 전송량은 더 작을 수 있다.

선택 기능 설치·켜기·중지도 API와 작업자를 재시작한다. 적용하는 동안 다른 사용자의 요청도 잠시 제한되며 화면은 다시 연결한다. 중지해도 설치된 파일과 사용자 데이터는 보존한다.

메타데이터 실행기 설치와 실제 제공자 준비는 별개다. 제공자가 없으면 실행기는 정상 상태이지만 제공자 미설정으로 표시되고 수집 요청은 503이다. `BOAA_METADATA_PROVIDERS_DIR`를 Docker 빌드 컨텍스트 밖의 비공개 경로로 지정하여 읽기 전용 마운트한다. 공개 이미지와 설치 묶음에는 사이트별 코드·설정·식별자를 넣지 않는다. 이미 사용 중인 외부 브라우저/메타데이터 endpoint와 인증은 자동으로 바꾸지 않는다.

런타임 통신 토큰은 최초 bootstrap에서 32바이트 난수로 생성하고 UID 1000의 mode 0600 파일로 보관한다. API/browser/metadata만 읽기 전용 마운트하며 Compose 환경에 토큰 값을 넣지 않는다. 상세 worker 계약은 `services/runtime-components/README.md`를 참고한다.

## ByeDPI와 네트워크

API 이미지에 고정 버전 ByeDPI와 MIT 고지/소스 아카이브를 넣는다. 설정에서 활성화하면 상속 모드 소스의 공통 프록시로 `socks5://api:1080`이 적용된다. 직접 연결 또는 별도 프록시로 지정한 소스 설정은 유지된다. 프로세스 장애는 자동 재시작하며, 장애 중 상속 요청이 직접 연결로 새지 않도록 프록시 주소를 유지한다.

기본 연결 방식(`defaultMode`)과 저장된 프록시 주소(`defaultProxy`)는 별도로 보존한다. 직접 연결로 바꿔도 주소는 지워지지 않으며 실제 적용 값은 `effectiveProxy`다. 기존 클라이언트가 mode 없이 보내는 요청도 지원하고, 기존 vault 설정은 처음 읽을 때 호환 해석한다.

1080 포트는 호스트에 공개하지 않는다. 컨테이너 내부 다른 실행기가 접근할 수 있도록 bind는 `0.0.0.0`이다. Compose 네트워크에는 신뢰하는 서비스만 연결한다. Browser/metadata 요청도 같은 유효 프록시 경계를 사용한다. `deploy/byedpi-integration.md`에 바이너리 출처와 빌드 방법이 있다.

## 운영과 복구

업데이터만 Docker socket을 가진다. API에는 제한된 파일 요청함만 마운트되며 임의 명령·URL·Compose 변경을 요청할 수 없다. Docker socket을 가진 업데이터는 호스트 관리자 권한에 준하므로 관리자 기능을 공개 익명 접근으로 열지 않는다.

업데이터 상태 볼륨의 `/state/current.json`이 현재 배포의 원본이다. `/state/deployments/*/{config,compose}.json`에는 해석된 관리자 환경값이 있으므로 비공개로 취급한다. 앱 업데이트 후 최초 `compose.release.yaml`과 bootstrap override로 무조건 `up`하면 이전 이미지/옵션으로 돌아갈 수 있다. 서비스 재시작은 기존 컨테이너의 `docker restart`를 사용한다. 실제 이미지·환경·데이터 마운트가 저장된 구성과 달라지면 `deployment_drift`로 감지하여 앱 내 변경을 차단한다. 환경/마운트 변경은 업데이터를 중지하고 현재 구성과 함께 관리자가 반영해야 한다.

실수로 초기 Compose 구성을 재적용했거나 현재 관리 구성을 재생성해야 하면, 진행 중인 업데이트와 작업이 없는지 확인한 뒤 아래처럼 저장된 snapshot을 복원한다. 이 명령은 현재 환경값 변경을 채택하는 명령이 아니며, 기록된 환경·이미지·마운트로 맞춘다. 초기 설치 때와 같은 디렉터리와 Compose project 이름을 사용한다.

```sh
docker compose -f compose.release.yaml -f .boaa-release/bootstrap.json stop updater
docker compose -f compose.release.yaml -f .boaa-release/bootstrap.json run --rm --no-deps updater flock -n -F /state/updater.lock node scripts/release/reconcile.mjs
docker compose -f compose.release.yaml -f .boaa-release/bootstrap.json start updater
```

`/state/backups/<operation-id>/`에 DB dump, 서버 데이터(확장 vault 포함), 활성 메타데이터 데이터와 이전 배포 참조를 저장한다. 원본 미디어는 기존 MinIO 볼륨에 유지하며 이 백업은 전체 미디어 백업이 아니다. 백업은 자동 삭제하지 않으므로 용량과 보존 정책을 관리한다. 수동 복원은 API/작업자를 모두 중지한 상태에서 수행한다.

업데이터가 적용 중 종료되면 재시작 시 journal을 읽고 이전 조합 복구를 시도한다. 복구도 실패하면 `recovery-required`로 표시하고 API의 일반 요청을 차단한다. 비공개 `/state/journal.json`, Docker 서비스 상태와 백업을 확인하여 관리자 복구 후 진행한다. 상태 파일을 지워 정상으로 가장하거나 `docker compose down -v`로 데이터 볼륨을 지우지 않는다.

이미 검증하고 `current.json`에 반영한 배포는 재확인 후 성공으로 마무리한다. 배포 기록을 만들기 전에 중단된 요청은 중단 결과로 마무리하며 임시 유지보수 제한을 해제한다. 최근 32개 요청의 완료 결과는 ID별로 영속 보존하므로 이후 자동 확인이 실행돼도 이전 화면에서 결과를 확인할 수 있다. `recovery-required`는 업데이터 재시작만으로 해제하지 않으며 위의 관리자 복구 절차가 필요하다.

웹 프록시는 Docker DNS를 주기적으로 다시 조회한다. 추가 기능 변경으로 API 컨테이너 주소가 바뀌어도 웹 컨테이너를 다시 만들지 않고 연결을 복구한다.

## 로컬 배포 회귀 검증

`node scripts/release/docker-smoke.mjs`는 미리 빌드한 기본 서버와 선택 런타임 3종 이미지, PostgreSQL/Redis/MinIO/nginx 이미지로 격리된 테스트 프로젝트를 만든다. `apps/server/dist`를 먼저 최신 빌드해야 한다. 기본 이미지 태그는 `boaa-server-runtime-check:local` 및 `boaa-runtime-{apk,browser,metadata}:local-check`이며 `BOAA_SMOKE_*_IMAGE` 환경 변수로 변경할 수 있다.

실제 관리 API → 요청함 → 업데이터 → Docker 적용 경로에서 선택 기능 설치·중지, API IP 변경 후 웹 재연결, DB/서버 데이터 백업, 업데이트, 작업자 기동 실패 후 롤백, 데이터·프록시 설정·요청 결과 보존을 검사한다. 테스트용 릴리스 목록과 로컬 이미지를 사용하므로 GitHub 다운로드·서명 발행 검증을 대신하지 않는다. 테스트용 컨테이너·볼륨·네트워크·비밀 파일은 종료 시 정리하며 기존 설치를 사용하지 않는다.

## 릴리즈 발행 준비

저장소에는 비밀 서명 키를 넣지 않는다. 관리자가 Ed25519 키를 안전한 별도 장소에서 생성하고 공개 키만 `deploy/release-public.pem`에 커밋한다. 개인 키 PEM은 GitHub Actions secret `BOAA_RELEASE_PRIVATE_KEY`로 등록한다. 키 교체는 기존 설치의 신뢰 키 전환 계획과 함께 진행한다.

```sh
# 실제 개인 키 경로는 저장소 밖의 비공개 경로로 지정한다.
umask 077
openssl genpkey -algorithm ED25519 -out /secure/boaa-release-private.pem
openssl pkey -in /secure/boaa-release-private.pem -pubout -out deploy/release-public.pem
```

`package.json`과 `deploy/release-policy.json` 버전을 맞추고, 최소 지원 버전·스키마 epoch·복구 안전성을 검토한 뒤 버전 태그를 만든다. Server release workflow는 해당 태그를 검증하고 amd64/arm64에서 각 이미지를 빌드한 후 digest 목록과 설치 묶음을 서명하여 **초안 릴리즈**를 만든다. 이미지 공개 접근과 설치·업데이트 검증 후 관리자가 초안을 발행해야 앱에 나타난다. 같은 버전의 manifest를 교체하지 않는다.

기존 `third_party/license-release-policy.json`의 배포 차단 항목(바이너리 대응 소스/재링크 제공, container/Python 의존성 목록 등)이 해결되지 않으면 workflow의 `check:licenses:release`가 발행 준비를 차단한다. 소스 검사 통과만으로 바이너리 배포 준비가 끝났다고 간주하지 않는다. 서명 키 설정 및 실제 GitHub Release 발행은 코드 구현과 별도의 운영 단계다.

구현 참고: [Docker의 다중 아키텍처 CI 문서](https://docs.docker.com/build/ci/github-actions/multi-platform/), [GitHub artifact 다운로드](https://github.com/actions/download-artifact).
