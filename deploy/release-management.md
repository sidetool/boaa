# Docker 서버 릴리즈와 선택 런타임

이 경로는 Docker 서버와 웹 UI용이다. 데스크톱 배포는 포함하지 않는다. 소스 개발용 `compose.yaml`은 계속 사용할 수 있지만 앱 내 서버 업데이트는 `compose.release.yaml`로 설치한 관리형 배포에서만 활성화된다.

## 설치

필요 조건: Linux Docker Engine/Compose v2, Node.js 22 이상, linux/amd64 또는 linux/arm64. 최초 공식 릴리즈를 만들기 전에는 아래 설치가 완료되지 않는다. 릴리즈 서명 키와 배포 준비 사항은 아래 발행 절차를 참고한다.

1. 공식 GitHub Release에서 `boaa-install.tar.gz`, `.sig`를 받고, 신뢰할 수 있는 별도 경로에서 공개 키를 확보한다. 아카이브 안의 키를 처음부터 신뢰하지 않는다. 저장소의 검토된 `scripts/release/verify-bundle.mjs`로 추출 전에 검증한다.
2. 새 설치 디렉터리에 압축을 풀고 다음 명령을 실행한다. 버전은 실제 발행된 태그로 대체한다.

```sh
node /trusted/verify-bundle.mjs boaa-install.tar.gz boaa-install.tar.gz.sig /trusted/boaa-release-public.pub
tar -xzf boaa-install.tar.gz -C /srv/boaa
cd /srv/boaa
node scripts/release/install.mjs --version vX.Y.Z --key /trusted/boaa-release-public.pub
```

설치기는 서명을 검증한 manifest의 digest로 모든 BOAA 이미지를 고정한다. `.env`가 없으면 무작위 비밀 값을 생성하고, 기존 `.env`는 보존한다. 기본 다운로드에는 API/작업자/웹/업데이터와 저장소 서비스만 포함된다. APK Java, Chromium, Python 메타데이터 실행기는 필요할 때 설정에서 별도로 설치한다.

기존 소스 설치를 이 명령으로 덮어쓰지 않는다. 같은 Compose project 이름, DB·객체 저장소·서버 데이터 볼륨, 암호화 키를 유지한 별도 전환 계획이 필요하다. 기존 설치의 설정·볼륨과 업데이터 기록이 맞지 않으면 관리 기능을 활성화하지 않는다. 자동 백업은 제공된 postgres 서비스와 `/data/server` 데이터 경로를 사용하는 구성만 지원한다. 외부 DB 또는 다른 데이터 경로는 자동 적용을 차단한다.

## 객체 저장소 이미지

새 설치는 공식 MinIO 소스 `RELEASE.2025-10-15T17-29-55Z`로 빌드한 `boaa-minio` 이미지를 고정 digest로 사용한다. 기존 공식 이미지 배포처가 닫혀 별도로 제공하며, 빌드 도구나 소스 묶음을 사용자 서버에 설치하지 않는다. 일반 BOAA 릴리즈에서는 이 이미지를 다시 빌드하지 않고, 앱 내 업데이트도 MinIO를 교체하지 않는다.

기존 MinIO 볼륨·S3 endpoint·접근 키 구성은 유지한다. 이미 운영 중인 MinIO를 바꾸는 작업은 자동으로 수행하지 않는다. 수동 전환은 쓰기 중단과 데이터 백업 후 진행한다. upstream 유지보수 종료 사실, 대응 소스와 재빌드 방법은 `deploy/minio/README.md`에 있다.

## 앱 내 동작

서버 설정에서 안정/베타 채널 확인, 릴리즈 노트 확인, 업데이트 및 선택 런타임 설치/비활성화를 실행한다. 확인은 다운로드나 자동 설치를 수행하지 않는다. 베타 채널에는 안정 버전도 포함되며, 채널 전환으로 낮은 버전이 설치되지는 않는다.

업데이트는 서명 검증 → 필요한 이미지 선다운로드 → 새 요청 제한 및 작업 대기열 비움 확인 → API/작업자 중지 → DB·설정 백업 → 실행 → health/readiness 확인 → 적용 기록 순서다. 15초 내 대기열이 비워지지 않으면 적용하지 않는다. 재시작 동안 웹 연결이 잠시 끊길 수 있다. 호환되는 이전 이미지 조합으로 복구하며, DB를 자동으로 과거 상태로 덮어쓰지 않는다. 스키마 epoch가 달라지거나 `rollbackSafe=false`인 릴리즈는 수동 마이그레이션 대상으로 차단한다.

업데이터는 자체 교체 없이 protocol 1 호환 릴리즈를 관리한다. 업데이터 프로토콜/실행기 자체 변경이 필요한 릴리즈는 별도의 관리자 전환이 필요하다. 앱 버튼이 Docker Engine이나 PostgreSQL/Redis/MinIO 자체를 업데이트하지는 않는다.

## 첫 다중 계정 전환: epoch 1 → 2 오프라인 이전

다중 계정 스키마는 `schemaEpoch: 2`다. 첫 적용 버전은 `0.1.1-beta.4`이며, 해당 버전의 검증·발행된 epoch 2 manifest와 설치 묶음을 사용한다. 아직 발행되지 않은 아티팩트로 아래 절차를 실행하지 않는다. beta.3에서의 전환은 아래 오프라인 이전이 필요하며 앱 내 자동 업데이트로 적용되지 않는다.

앱 내 업데이터는 서로 다른 epoch의 자동 적용을 차단한다. `rollbackSafe: true`도 epoch 경계를 넘는 이미지 단독 복귀를 허용하지 않는다. 기존 설치에서 `install.mjs`를 다시 실행하면 `.boaa-release/installed.json` 때문에 거부된다. `reconcile.mjs`는 새 manifest를 채택하는 도구가 아니라 `/state/current.json`에 기록된 기존 구성을 재적용한다. 환경 변수의 epoch만 바꾸거나 기록 파일을 손으로 수정하거나 지워서 이 제한을 우회하지 않는다.

지원되는 설치·복구 기능을 이용한 첫 전환은 **새 설치 디렉터리·새 Compose project·새 볼륨으로 전체 운영 백업을 복원하는 오프라인 이전**이다. 같은 DB를 구버전과 신버전이 동시에 사용하지 않는다.

1. 기존 설치의 현재 관리 구성을 기록하고 작업을 정상적으로 끝낸다. 모든 사용자 쓰기와 외부 ingress를 막고 대기열이 비었는지 확인한 다음 기존 API·worker·updater와 쓰기 가능한 선택 런타임을 정지한다. 관리형 배포는 현재 기록된 구성/컨테이너를 사용하며 초기 bootstrap Compose를 재적용하지 않는다. 백업 도중 새로운 작업이 들어오지 않게 정지 상태를 유지한다.
2. 같은 정지 시점의 **전체 운영 백업**을 만든다. PostgreSQL 전체 DB, MinIO/S3 원본·미디어 전체, 서버 데이터와 확장/소스 vault, 암호화 키, 선택 런타임 데이터, `.env`와 배포 설정, 설치 묶음 및 `.boaa-release`, 기존 updater 상태와 배포 snapshot을 함께 보관한다. DB dump의 복원 가능성과 각 파일/볼륨 사본을 확인한다. 앱의 개인 서재 내보내기 ZIP이나 업데이터의 DB·서버 데이터 백업만으로는 전체 복귀에 충분하지 않다. 운영 백업에는 모든 계정과 비밀 정보가 있으므로 운영자가 보호된 저장소에서 관리한다.
3. 검증한 epoch 2 설치 묶음을 **빈 새 디렉터리**에 푼다. 기존 `.env`의 `DEFAULT_USER_ID`, DB/객체 저장소 접근 정보, 암호화 관련 비밀과 필요한 설정은 보존하되 새 project 이름을 명시한다. 기존 외부 DB/버킷에 연결되는 주소는 반드시 격리된 새 복원 대상으로 바꾼다. 이전 `.boaa-release/installed.json`, bootstrap 파일이나 updater 상태를 새 설치에 복사하지 않는다. Compose가 실제로 해석한 DB·MinIO·server-data·runtime·updater 볼륨 이름과 bind mount 경로를 점검해 기존 프로젝트와 공유하지 않음을 확인한다. `COMPOSE_PROJECT_NAME`만 달라도 명시적 external volume, 동일 bind 경로, 외부 DB/버킷은 공유될 수 있다.
4. 외부 접근을 계속 닫은 상태에서 새 디렉터리에서 기존 `install.mjs --version <검증한-epoch2-태그> --key <신뢰한-공개키>`를 실행한다. 새 Compose project 이름은 이 명령과 이후 명령에 일관되게 지정한다. 설치기는 서비스를 시작하므로 곧바로 **새** API·worker·web·updater 및 데이터 쓰기가 가능한 선택 런타임을 정지한다. 이때 새 updater가 만든 epoch 2 상태는 보존한다. 아직 공개 요청을 받아서는 안 된다.
5. 새 DB에 만들어진 초기 데이터는 폐기하고 2번의 전체 DB를 복원한다. 새 객체 저장소와 서버/런타임 데이터 볼륨도 같은 백업 시점의 내용으로 복원하며 소유 UID·권한·암호화 키를 유지한다. 원래 `DEFAULT_USER_ID`와 bootstrap 소유자 ID가 일치해야 한다. **epoch 1 updater 상태는 새 설치에 복원하지 않는다.** 이전 상태는 구 설치로 전체 복귀할 때만 쓴다. PostgreSQL/객체 저장소의 복원 명령은 해당 DB 버전·저장 방식에 맞춰 운영자가 사전에 검증한 명령을 사용한다.
6. ingress와 updater를 닫아 둔 채 새 API를 시작해 순차 마이그레이션과 readiness를 확인한다. migration 실패 시 구버전 이미지를 새 DB에 연결하지 않는다. 관리자의 기존 로그인·서재·읽기 상태·소스 자격 증명과 새 계정 간 격리를 확인하고, worker와 필요한 선택 런타임을 시작해 작업 실행도 점검한다. 새 `/state/current.json`의 epoch 2와 새 컨테이너의 이미지·환경·마운트가 일치하는지 확인한 뒤에만 updater와 사용자 접근을 연다. `reconcile.mjs`가 필요한 경우에도 새 epoch 2 설치의 기록을 재적용하는 용도로만 사용한다.
7. 검증 전 복귀는 새 프로젝트를 정지하고, 손대지 않은 구 프로젝트/원래 백업과 epoch 1 이미지·설정·관리 상태를 함께 되살리는 방식으로 수행한다. 새 환경에서 쓰기를 받았다면 과거 스냅샷으로 복귀할 때 **그 이후 생성·수정된 계정과 모든 데이터는 사라진다.** 복귀 전에 새 상태도 별도로 보존하고 그 손실을 확인해야 한다. 신스키마 DB에 구 이미지 하나만 올리는 복귀는 지원하지 않는다. 실제 검증과 보존 기간이 끝나기 전에는 구 볼륨이나 백업을 삭제하지 않는다.

## 선택 구성요소

| 구성요소   | 설치 내용                                                 | 비활성화 시                                                |
| ---------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| APK        | JRE + 사이트 중립 APK 호스트 JAR, 원자적 `current` 포인터 | API 재시작, APK 실행 중단, APK 파일·설정·payload 볼륨 보존 |
| 브라우저   | 인증된 원격 Playwright/patchright + Chromium              | worker 중지, HTTP 확장은 계속 동작                         |
| 메타데이터 | 사이트 중립 Python ASGI 실행기                            | worker 중지, 제공자·캐시 데이터 보존                       |

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

## 관리자 계정 복구와 로그아웃 쿠키

로그아웃과 전체 로그아웃은 서버 세션을 폐기하고 응답에서 쿠키를 다시 쓰거나 지우지 않는다. 지연된 이전 탭의 응답이 새 로그인 쿠키를 지우는 경쟁을 막기 위한 동작이다. 폐기된 쿠키가 남아 있어도 상태 조회는 미인증으로 응답하고 정상 로그인으로 새 세션을 만들 수 있다. 기존 `moya_session` 쿠키도 계속 인증하지만 조회 응답에서는 canonical 쿠키로 재발급하지 않는다.

관리자 비밀번호 복구는 운영자의 배포 bearer 자격 증명으로 원래 관리자만 대상으로 한다. 계정 쿠키가 있는 요청은 유효하지 않은 쿠키라도 bearer로 대체 인증하지 않는다. 따라서 복구는 브라우저의 일반 계정 요청이 아니라 **Cookie 헤더를 보내지 않는 운영자 요청**으로 수행한다. 다음 값은 운영자가 자신의 환경에 설정하며 토큰 원문을 문서나 로그에 남기지 않는다.

```sh
curl -q --fail-with-body --request POST \
  --header "Authorization: Bearer ${READER_AUTH_TOKEN}" \
  --header 'Cookie:' \
  "${BOAA_API_ORIGIN}/api/auth/owner-recovery"
```

응답의 일회용 reset 토큰은 비밀 값이다. 운영자가 보호된 환경에서 복구 화면으로 전달하고 사용 후 폐기한다. 브라우저 도구로 별도 구현한다면 이 운영자 요청에 `credentials: 'omit'`를 명시해야 하며, 일반 웹 로그인 흐름에는 bearer 저장이나 전송을 추가하지 않는다.

## 로컬 배포 회귀 검증

`node scripts/release/docker-smoke.mjs`는 미리 빌드한 기본 서버와 선택 런타임 3종 이미지, PostgreSQL/Redis/MinIO/nginx 이미지로 격리된 테스트 프로젝트를 만든다. `apps/server/dist`를 먼저 최신 빌드해야 한다. 기본 이미지 태그는 `boaa-server-runtime-check:local` 및 `boaa-runtime-{apk,browser,metadata}:local-check`이며 `BOAA_SMOKE_*_IMAGE` 환경 변수로 변경할 수 있다.

실제 관리 API → 요청함 → 업데이터 → Docker 적용 경로에서 선택 기능 설치·중지, API IP 변경 후 웹 재연결, DB/서버 데이터 백업, 업데이트, 작업자 기동 실패 후 롤백, 데이터·프록시 설정·요청 결과 보존을 검사한다. 테스트용 릴리스 목록과 로컬 이미지를 사용하므로 GitHub 다운로드·서명 발행 검증을 대신하지 않는다. 테스트용 컨테이너·볼륨·네트워크·비밀 파일은 종료 시 정리하며 기존 설치를 사용하지 않는다.

## 릴리즈 발행 준비

저장소에는 비밀 서명 키를 넣지 않는다. 관리자가 Ed25519 키를 안전한 별도 장소에서 생성하고 공개 키만 `deploy/release-public.pub`에 커밋한다. 개인 키 PEM은 GitHub Actions secret `BOAA_RELEASE_PRIVATE_KEY`로 등록한다. 키 교체는 기존 설치의 신뢰 키 전환 계획과 함께 진행한다.

```sh
# 실제 개인 키 경로는 저장소 밖의 비공개 경로로 지정한다.
umask 077
openssl genpkey -algorithm ED25519 -out /secure/boaa-release-private.pem
openssl pkey -in /secure/boaa-release-private.pem -pubout -out deploy/release-public.pub
```

`package.json`과 `deploy/release-policy.json` 버전을 맞추고, 최소 지원 버전·스키마 epoch·복구 안전성을 검토한 뒤 버전 태그를 만든다. Server release workflow는 해당 태그를 검증하고 amd64/arm64에서 각 이미지를 빌드한 후 digest 목록과 설치 묶음을 서명하여 **초안 릴리즈**를 만든다. 이미지 공개 접근과 설치·업데이트 검증 후 관리자가 초안을 발행해야 앱에 나타난다. 같은 버전의 manifest를 교체하지 않는다.

기존 `third_party/license-release-policy.json`의 배포 차단 항목(바이너리 대응 소스/재링크 제공, container/Python 의존성 목록 등)이 해결되지 않으면 workflow의 `check:licenses:release`가 발행 준비를 차단한다. 소스 검사 통과만으로 바이너리 배포 준비가 끝났다고 간주하지 않는다. 서명 키 설정 및 실제 GitHub Release 발행은 코드 구현과 별도의 운영 단계다.

구현 참고: [Docker의 다중 아키텍처 CI 문서](https://docs.docker.com/build/ci/github-actions/multi-platform/), [GitHub artifact 다운로드](https://github.com/actions/download-artifact).
