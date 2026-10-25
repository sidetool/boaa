# 문서 관리와 2026-10-25 정리 내역

기준은 운영 배포와 일치시킨 `0550c99` 및 원격 파일 요청 취소 추가 패치다. 정리는 별도 유지보수 브랜치의
변경이며 운영 배포·공개 업로드를 수행하지 않았다. [전체 감사](2026-10-25-maintainability-audit.md)와
[검증 가이드](testing.md)를 함께 본다.

## 읽는 순서와 수명

1. 작업 대상의 버전·배포 패치를 먼저 확인한다. 현행 동작의 근거는 그 소스의 진입점·공유 계약·설정·migration이다.
2. [AGENTS.md](../../AGENTS.md), [문서 색인](../README.md), [현재 아키텍처](../architecture/current-architecture.md)에서 담당 문서로 이동한다. 다른 제품의 저장·인증 설명을 섞지 않는다.
3. 관련 행동 테스트는 계약을 확인하는 증거다. 오래된 파일명·소스 문자열 기대가 실제 제품 요구사항을 대신하지 않는다.
4. 릴리스 문서는 해당 버전의 이력이다. 날짜가 있는 감사의 관측·제안은 그 기준본에 한정되며 현재 버그나 구현 완료 상태로 자동 해석하지 않는다.

현행 사용법·API·운영 계약은 담당 문서 하나에서 고친다. 완료된 작업의 계획서·중간 검토·개별 실행 로그는
계속 덧붙이지 않는다. 필요한 계약과 아직 해결하지 않은 사항만 담당 문서에 남긴 뒤 중복 문서는 제거한다.
현재 파일에서 제거한 tracked 기록은 Git 이력으로 확인할 수 있으므로 `archive/`에 복제하지 않는다.
삭제 전 tracked 여부와 참조를 확인하고, 삭제 후 상대 링크를 확인한다. 외부 저작권·라이선스·출처는 유지한다.

## 삭제·통합 결과

**추적된 계획 5개와 검토 스냅샷 8개, 총 13개/1,565줄을 삭제했다.** 이름이 오래됐다는 이유가 아니라
구현 전 상태·미배포 선언·수정 전 결함·임시 로그/검증 수가 현재 코드 설명과 섞여 있었기 때문이다.

| 삭제 대상 | 대체·보존 위치 |
| --- | --- |
| `docs/plans/multi-account.md`, `multi-account-client.md`, `multi-account-identity.md`, `multi-account-isolation.md` | 구현된 계정 사용·권한·세션·이전 계약을 [계정 운영](../operations/accounts.md) 하나로 통합 |
| `docs/plans/text-translation.md` | [작품 번역](../text-translation.md)에 현재 범위와 후속 미지원 기능이 이미 있음 |
| `docs/reviews/multi-account-server.md` | 계정 운영 문서, 현재 소유권/인증 회귀, [릴리스 이전 절차](../../deploy/release-management.md) |
| `docs/reviews/text-translation-robustness.md` | 작품 번역 문서에 원문·캐시·취소 계약과 미검증 범위 통합 |
| `docs/reviews/tts-batch-completeness.md` | [provider 경계](../architecture/provider-boundaries.md)에 일반 낭독·캐시·명시적 재생성 계약 통합 |
| `docs/reviews/ui-migration-audit.md`, `ui-migration-final-verification.md`, `ui-migration-library-semantics.md`, `ui-migration-work-lifecycle.md`, `ui-migration-async-performance.md` | 수정 완료 스냅샷 제거. 현행 작품 수명/정렬/캐시 구현과 행동 회귀를 근거로 사용 |

추가 정리:

- README와 배포 가이드 2개의 단일 계정 설명을 현재 초대 방식으로 수정했다.
- 두 배포 가이드의 8월 특정 패치 배포 절차를 현행 릴리스 호환성 안내로 교체했다.
- 현재 아키텍처의 옛 IndexedDB/Tauri 중심 설명을 실제 제품별 시작점·저장소 지도로 교체했다.
- 문서 색인에 계정·번역·원격 파일·정적 웹·유지보수 문서를 연결하고 삭제 문서 참조를 제거했다.
- 릴리스 기록 2개는 버전별 호환성과 검증 이력이므로 보존하고 과거 기록임을 표시했다.
- 플랫폼/공통 아키텍처, 운영·SDK 문서, 법적 고지와 라이선스는 보존했다. 짧은 작업 시작 안내를 루트에 추가했다.

## 삭제하면서 보존한 미확정 관측

아래는 2026-10-18/19 검토의 관측이며 이번 문서 정리에서 재현하거나 해결했다고 주장하지 않는다.

- 계정 전환 검토에서 탭 초기화와 세션 폐기를 겹친 한 실행에 원인 미확정 AbortError가 있었다. 후속 실행은 통과했지만 재현 시 스택과 계정 수명을 확인해야 한다.
- 번역 브라우저 검사에서 한 차례 회차 끝 이동 후 행 겹침이 관측됐고 원인이 확정되지 않았다. 문서 삭제는 해당 관측의 해결 판정이 아니다.
- 실제 유료 provider 품질/과금, 실물 모바일의 백그라운드 복원, 실제 APK/JVM 다중 계정 동작, 운영 백업 이전은 과거 합성 검증의 통과 수만으로 보장하지 않는다.

## 남긴 문서의 확인 범위

세부 아키텍처에는 아직 최초 설계 날짜와 점진적 구현 설명이 남아 있다. 이번에는 서버/정적 웹/native에서
쓰이는 경계까지 일괄 삭제하지 않았다. 특히 `provider-boundaries.md`, `ai-tts-provider-job-cache-security.md`,
`data-model-and-storage.md`의 모든 세부 문장과 Windows/Android 배포물의 현재 공개 여부는 전수 재검증하지 않았다.
관련 기능을 수정할 때 실행 경로와 대조해 담당 문서를 정리한다.
과거 작업 로그의 미확정 관측을 현재 재현된 결함으로 승격하거나, 테스트를 지웠다는 이유로 해결 처리하지 않는다.
