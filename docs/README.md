# BOAA 문서

이 디렉터리는 제품 실행·빌드·유지보수 문서를 제공합니다. 작업은 [AGENTS.md](../AGENTS.md)와
[현재 아키텍처](architecture/current-architecture.md)에서 시작합니다. 실제 동작은 대상 배포의 소스·설정·계약을 기준으로 확인하고,
관련 행동 테스트로 검증합니다. 오래된 계획·검토 결과나 다른 제품의 안내를 현행 요구사항으로 적용하지 않습니다.

## 설치와 운영

- [콘텐츠·운영·외부 서비스 요금 및 면책 안내](../DISCLAIMER.md)
- [Ubuntu Docker Compose 설치·업데이트·백업](operations/docker-compose-guide-ko.md)
- [Docker Compose 구성 기술 문서](operations/docker-compose-deployment.md)
- [WireGuard + Nginx Proxy Manager + Suwayomi 배포](operations/nginx-proxy-manager-wireguard.md)
- [Hosted provider admission과 비용 경계](operations/hosted-provider-admission.md)
- [텍스트 소스 서버 설치·연결·회차 사용](operations/external-text-sources.md)
- [서버 계정·초대·권한](operations/accounts.md)
- [WebDAV·SFTP 파일 소스](remote-file-sources.md)
- [작품 번역](text-translation.md)
- [서버 릴리스·업데이트·복구](../deploy/release-management.md)

## 데스크톱과 Android

- [현재 데스크톱 구조·작업 범위](platforms/desktop.md) — 데스크톱 작업은 이 문서에서 시작합니다.
- [Windows·Android 네이티브 빌드 가이드](platforms/native-build-guide-ko.md)
- [서버 없는 정적 웹 구조](architecture/local-static-web.md) · [운영 안내](../apps/web/README.md)

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
- [JS 플러그인 개발: 홈 목록·리더·설정·HTTP](extensions/platform-plugins.md)
- [확장 패키지 형식](extensions/boaapatch-format.md)
- [Source SDK v1 빠른 참조](extensions/sdk-v1-reference.md)
- [Mangayomi JavaScript 지원 범위와 검사](extensions/mangayomi-compatibility.md)
- [확장 릴리스 절차](extensions/publishing.md): CLI·게시자 서명·저장소 목록 계약
- [외부 작품 소스와 Source Hub](architecture/external-library-sources.md)
- [AI/TTS provider 경계](architecture/provider-boundaries.md)
- [AI/TTS job·cache·보안](architecture/ai-tts-provider-job-cache-security.md)

## 유지보수

- [2026-10-25 유지보수 감사](maintenance/2026-10-25-maintainability-audit.md): 운영 기준 구조·동작 문제, EPUB/TXT 속도 개선 후보와 구현 전 회귀 검증 조건
- [검증 가이드](maintenance/testing.md): 변경 범위에 맞는 테스트 실행과 유지 기준
- [문서 관리 기준과 정리 내역](maintenance/documentation-policy.md): 문서 우선순위, 삭제·통합 범위와 남은 확인 사항

감사 문서는 해당 기준본의 기록입니다. 실제 수정 여부는 후속 변경과 현재 코드에서 확인합니다.

## 공개 문서 작성 기준

운영 조사 결과는 구현 원인·수정·검증 한계를 중심으로 기록합니다. 개인 운영 환경의 콘텐츠 사이트명,
확장 저장소 주소, 작품 식별자와 비공개 로그 경로는 공개 문서에 옮기지 않습니다. 새 합성 테스트와 예제에는
가상 이름과 `example.com` 또는 `.invalid` 도메인을 사용합니다. 외부 코드의 저작권·라이선스·출처 표시는 유지하고,
실제 외부 소스를 검증한 기록을 합성 테스트 결과인 것처럼 바꾸지 않습니다.

## 과거 릴리스 기록

아래 문서는 해당 버전의 변경·호환성·검증 기록입니다. 현재 배포 상태나 최신 구현의 안내로 사용하지 않습니다.

- [Windows 0.1.1-beta.1](releases/0.1.1-beta.1.md)
- [서버·웹 0.1.1-beta.4](releases/0.1.1-beta.4.md)
