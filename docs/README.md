# BOAA 문서

이 디렉터리는 제품 실행·빌드·유지보수 문서를 제공합니다. 현재 안내는 아래 색인을 따릅니다.

## 설치와 운영

- [콘텐츠·운영·외부 서비스 요금 및 면책 안내](../DISCLAIMER.md)
- [Ubuntu Docker Compose 설치·업데이트·백업](operations/docker-compose-guide-ko.md)
- [Docker Compose 구성 기술 문서](operations/docker-compose-deployment.md)
- [WireGuard + Nginx Proxy Manager + Suwayomi 배포](operations/nginx-proxy-manager-wireguard.md)
- [Hosted provider admission과 비용 경계](operations/hosted-provider-admission.md)
- [텍스트 소스 서버 설치·연결·회차 사용](operations/external-text-sources.md)

## 데스크톱과 Android

- [현재 데스크톱 구조·작업 범위](platforms/desktop.md) — 데스크톱 작업은 이 문서에서 시작합니다.
- [Windows·Android 네이티브 빌드 가이드](platforms/native-build-guide-ko.md)

## 아키텍처

- [현재 전체 구조](architecture/current-architecture.md)
- [Reader 기능 경계와 수명](architecture/modular-reader-core.md) — 공유 core, Reader/소스/가져오기 책임과 검증 방법.
- [데이터 모델과 저장소](architecture/data-model-and-storage.md)
- [가져오기와 parser](architecture/import-parser.md)
- [문서 형식과 고정 레이아웃 viewer](architecture/document-formats-and-fixed-layout-viewer.md)
- [책장 폴더 가져오기와 동기화](architecture/library-folder-import-and-sync.md)
- [Cloud Vault](architecture/cloud-vault-sync.md)
- [신뢰 익스텐션 v1 개발 가이드](architecture/trusted-extensions.md)
- [JS/TS 소스 확장 개발과 배포](extensions/source-development.md)
- [확장 패키지 형식](extensions/boaapatch-format.md)
- [Source SDK v1 빠른 참조](extensions/sdk-v1-reference.md)
- [Mangayomi JavaScript 지원 범위와 검사](extensions/mangayomi-compatibility.md)
- [외부 작품 소스와 Source Hub](architecture/external-library-sources.md)
- [AI/TTS provider 경계](architecture/provider-boundaries.md)
- [AI/TTS job·cache·보안](architecture/ai-tts-provider-job-cache-security.md)

구현 사실과 문서가 다르면 현재 소스와 테스트를 우선하고, 같은 변경에서 해당 공개 문서도 함께 고칩니다.

- [공개 확장 릴리스 절차](extensions/publishing.md): 독립 CLI·게시자 서명·저장소 목록 생성과 검증

## 공개 문서 작성 기준

운영 조사 결과는 구현 원인·수정·검증 한계를 중심으로 기록합니다. 개인 운영 환경의 콘텐츠 사이트명,
확장 저장소 주소, 작품 식별자와 비공개 로그 경로는 공개 문서에 옮기지 않습니다. 새 합성 테스트와 예제에는
가상 이름과 `example.com` 또는 `.invalid` 도메인을 사용합니다. 외부 코드의 저작권·라이선스·출처 표시는 유지하고,
실제 외부 소스를 검증한 기록을 합성 테스트 결과인 것처럼 바꾸지 않습니다.

## 릴리스

- [Windows 0.1.1-beta.1 안내](releases/0.1.1-beta.1.md)
