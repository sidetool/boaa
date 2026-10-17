<p align="center">
  <img src="assets/branding/boaa-wordmark.png" alt="BOAA" width="320" />
</p>

<p align="center"><strong>소설과 만화를 위한 개인 서재</strong></p>

<p align="center">
  TXT · EPUB · PDF · 만화 압축 파일을 한곳에 모아 두고, 어느 기기에서든 읽던 곳부터 이어 읽으세요.
</p>

<p align="center">
  <a href="https://github.com/sidetool/boaa/actions/workflows/quality.yml"><img src="https://github.com/sidetool/boaa/actions/workflows/quality.yml/badge.svg" alt="Quality" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/status-beta-orange" alt="Beta" />
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#문서">문서</a> ·
  <a href="https://github.com/sidetool/boaa/issues">문제 제보</a>
</p>

---

## BOAA는

BOAA는 직접 가진 책을 보관하고 읽는 오픈소스 리더입니다. 서버 한 대에 설치해 두면 휴대폰·태블릿·PC
브라우저에서 같은 서재를 열고, 진행률·북마크·하이라이트가 기기 사이에 맞춰집니다.
서버 없이 쓰고 싶다면 Windows 앱이 PC 안에 서재를 만듭니다.

광고와 기본 콘텐츠 저장소는 없습니다. 무엇을 가져오고 어떤 소스를 연결할지는 사용자가 정합니다.

## 주요 기능

| 영역     | 할 수 있는 것                                                      |
| -------- | ------------------------------------------------------------------ |
| **서재** | 표지 보기, 책장, 검색, 연재 작품의 회차 관리, 읽던 위치 저장       |
| **읽기** | 스크롤·페이지·양면 보기, 글꼴과 테마, 자동 스크롤, 만화 우→좌 넘김 |
| **기록** | 북마크, 하이라이트, 메모, 본문 검색, 독서 통계                     |
| **듣기** | 시스템 TTS, 선택형 외부 TTS, AI 화자 구분                          |
| **확장** | 소스 확장 설치, 작품 검색과 회차 받기, 공식 사이트 작품 정보 보강  |
| **보관** | 원본 파일 받기, 전체 백업과 복원, 폴더 연결                        |

**지원 형식** — TXT, Markdown, EPUB, PDF, ZIP/CBZ, RAR/CBR, 7z/CB7. DRM이 걸린 파일은 열지 않습니다.

## 빠른 시작

### Docker Compose (권장)

Docker Engine, Compose v2, Node.js 22 이상이 필요합니다.

```bash
git clone https://github.com/sidetool/boaa.git
cd boaa
node scripts/init-env.mjs
docker compose up -d --build
```

브라우저에서 <http://127.0.0.1:8080>을 열고 관리자 계정을 만듭니다.

1. 서버 로그에서 일회용 **초기 설정 코드**를 확인합니다.
   ```bash
   docker compose logs api
   ```
2. 화면에 코드와 아이디·비밀번호를 입력하면 관리자 계정이 만들어집니다. 코드는 이때 한 번만 쓰이고 사라집니다.
3. 다른 기기에서는 아이디와 비밀번호로 로그인합니다.

`init-env`는 내부 비밀번호와 복구용 토큰을 무작위로 만들어 `.env`에 저장합니다. 이미 있는 값은 바꾸지 않으니,
`.env`는 서재 데이터와 함께 안전하게 보관하세요.

다른 기기에서 접속하려면 HTTPS 리버스 프록시를 앞에 두세요. Nginx Proxy Manager를 쓴다면
[`compose.npm.yaml`](compose.npm.yaml)을 함께 적용합니다. 외부 공개, 업데이트, 백업은
[Docker Compose 안내](docs/operations/docker-compose-guide-ko.md)에 정리되어 있습니다.

> [!WARNING]
> `docker compose down -v`는 서재가 저장된 볼륨까지 지웁니다. 업데이트할 때는 `-v` 없이 실행하세요.

### Windows

Windows 앱은 서버 없이 **이 PC의 서재**를 만들고, 이미 운영 중인 BOAA 서버에도 접속할 수 있습니다.
지금은 소스에서 빌드해 사용합니다 — [빌드 안내](docs/platforms/native-build-guide-ko.md).
설치 파일은 정식 릴리스와 함께 제공할 예정입니다.

## 문서

| 주제        | 문서                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 설치와 운영 | [Docker Compose 안내](docs/operations/docker-compose-guide-ko.md) · [배포 상세 (영문)](docs/operations/docker-compose-deployment.md) |
| 외부 접속   | [Nginx Proxy Manager · WireGuard](docs/operations/nginx-proxy-manager-wireguard.md)                                                  |
| 앱 빌드     | [Windows · Android 빌드](docs/platforms/native-build-guide-ko.md) · [데스크톱 구조](docs/platforms/desktop.md)                       |
| 확장 만들기 | [소스 확장 개발](docs/extensions/source-development.md) · [SDK 레퍼런스](docs/extensions/sdk-v1-reference.md)                        |
| 구조        | [문서 목차](docs/README.md)                                                                                                          |

## 개발

Node.js와 pnpm 버전은 [`package.json`](package.json)의 `engines`, `packageManager`를 따릅니다.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev          # 개발 서버
corepack pnpm typecheck    # 타입 검사
corepack pnpm lint         # 코드 검사
```

버그를 제보할 때는 BOAA 버전, 운영체제, 재현 순서, 오류 메시지를 함께 적어 주세요.
비밀번호·토큰·개인 서재 파일은 첨부하지 마세요.

## 알아 두기

- 한 사람(또는 믿을 수 있는 가족)이 쓰는 개인 서재입니다. 여러 사용자의 권한 분리는 아직 없습니다.
- 확장 소스와 외부 AI·TTS는 해당 서비스와 계정 설정에 따라 쓸 수 있는 범위가 달라집니다.
- Android 앱은 개발 중이며 공식 설치 파일은 아직 없습니다.
- 사용 전 [면책 안내](DISCLAIMER.md)를 확인해 주세요.

## 라이선스

[Apache License 2.0](LICENSE). 포함된 외부 구성 요소의 라이선스는 [Third-party notices](THIRD_PARTY_NOTICES.md)에 있습니다.
