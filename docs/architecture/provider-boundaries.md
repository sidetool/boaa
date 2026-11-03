# Provider Boundaries

## 일반 서버 TTS 재생·캐시 계약

2026-10-26 코드 대조. 아래 일반 낭독 계약은 뒤의 화자별 합성·native 경로와 구분한다.

- 묶음 크기는 200–2000자, 기본 700자이며 최대 16문단을 사용한다. 본문·회차·계정 검증을 거친 같은 합성 조건만 재사용한다.
- 일반 서버 합성 속도는 1배다. 재생 배속·음량 변경은 같은 오디오에 적용하며 다시 합성하지 않는다. 화면의 문단 위치는 길이 비율 추정이며 정확한 오디오 타임스탬프가 아니다.
- 읽기 세션의 메모리 캐시는 기본 8개/32MiB다. 같은 진행 중 요청은 공유하고 재생 취소는 대기자를 분리한다. 계정·runtime·본문 수명 종료 시 요청과 캐시를 정리한다.
- 재생기의 명시적 새로고침은 원래 묶음 시작에서 `regenerate: true`로 요청한다. 해당 항목의 브라우저·서버 메모리·영구 캐시를 교체하고 제공자 비용이 새로 발생할 수 있다. 늦은 이전 준비 결과는 새 음성을 덮지 않는다.
- 실패 후 재시작 위치는 추정 표시 문단이 아니라 실제 묶음 시작이다. 본문의 문단을 얻지 못하면 회차 완료로 건너뛰지 않는다.
- Gemini Vertex는 선택한 candidate의 오디오 part를 합치고 정상 완료·오디오 형식을 확인한다. 형식 검증과 정상 완료 표시는 원문을 의미적으로 모두 발화했다는 보장은 아니다.
- 불완전한 Gemini 응답은 출력 한도·콘텐츠 제한·음성 누락·형식 오류를 구분해 알린다. 일반 낭독과 화자별 백그라운드 생성 모두 공통 합성 경계에서 고정된 사유/완료 코드와 글자 수만 기록하며 원문·제공자 응답은 남기지 않는다. 저장 작업의 과거 오류에 붙던 청취 묶음 크기 변경 안내는 조회 시 제거한다. 청취 설정 변경은 저장된 생성 요청을 바꾸지 않으며, 불완전 응답의 자동 유료 재시도는 하지 않는다.

실행 코드는 `src/features/tts/usePlainTTS.ts`, `src/providers/plain-tts*.ts`,
`src/providers/browser-audio-session.ts`, `apps/server/src/routes/ai/plain-tts-routes.ts`와
`apps/server/src/providers/`에 있다. 회귀 검증은 해당 모듈의 행동 테스트를 따른다.

### 저장 음성의 일시 장애 재시도

- 저장용 일반·화자 음성 합성은 응답을 최대 180초 기다린다(실시간 낭독 45초 유지). 합성 adapter 호출 경계에서만 확인한 timeout, HTTP 408/500/502/503/504, 알려진 일시적 연결 오류를 재시도 대상으로 표시한다. 분석·새 목소리 제작, 명시적 취소, 인증·설정 오류, 콘텐츠 차단, 불완전한 음성, 파일/DB 저장 실패는 이 대상이 아니다.
- 일시 장애는 작업을 실패시키기 전에 15→30→60→120→240초를 기다려 최대 5회 추가 시도한다. `Retry-After`가 더 길면 해당 시간을 따른다. `audio_retry_attempts`와 `retry_at`을 저장해 서비스 재생성에도 대기/한도가 유지된다. 기존 429 대기 및 분석 재시도 한도와는 별도다. 429와 일시 장애가 동시에 발생한 묶음은 일시 장애 한도도 소모하며 긴 대기 값을 유지한다.
- 대기 후에는 요청 하나로 회복을 확인한다. 성공한 배치 뒤 한도를 초기화하고, 이미 저장한 파일은 재생성하지 않는다. 사용자 멈춤/종료와 영구 오류가 우선하며 한도 초과 시 만든 음성을 보존한 채 실패를 알린다. 재시도는 외부 API 요금이 다시 발생할 수 있어 무제한 반복하지 않는다. 수동 이어 만들기는 재시도 한도를 초기화한다.
- 화면은 기존 대기 상태와 서버 문구·다음 시각을 사용한다. 배경 합성의 시간 초과도 제공자·고정 오류 분류·입력 길이·소요 시간만 기록하고 본문/키/원본 오류는 로그에 남기지 않는다.

### 콘텐츠 차단 구간 건너뛰기

- 저장된 일반 음성·화자별 음성에 공통 적용한다. Gemini의 고정 정책 종료 코드(`SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`)와 OpenAI·호환/연결형·ElevenLabs API의 명시적 `content_policy_violation`/`content_filter` 오류 코드만 구간 차단으로 기록한다. 임의 오류 문구, 인증 거절, 429, 시간 초과, 출력 한도 및 잘린 파일은 대상이 아니다.
- 기본은 차단 시 중단이다. 해당 작업에서 사용자가 누락과 이후 생성 비용을 확인하고 `skip-blocked`를 선택하면 현재 차단 구간을 건너뛰고, 그 작업의 이후 정책 차단도 음성 없이 건너뛴다. 새 작업과 목소리 바꾸기로 만든 작업에는 선택을 물려주지 않는다. 일반 재시도는 알려진 차단 구간을 다시 과금 요청하지 않는다.
- migration 0070의 `blocked`/`skipped` 상태와 고정 `block_reason`으로 저장한다. 실제 음성 개수와 건너뛴 개수는 분리하며, `ready` 또는 `skipped`로 모든 구간의 처리가 끝나면 작업을 완료한다. 들을 수 있는 회차는 미처리 구간이 없고 실제 저장 음성이 하나 이상 있어야 한다. 화면에는 누락 개수·위치를 유지한다.
- 본문·분석·기존 음성 파일을 수정하지 않는다. 건너뛴 구간에는 가짜 무음 파일이나 대체 목소리를 만들지 않는다. 재생 목록과 미리 받기에서 제외하고 회차 시작 때 누락 안내를 보여 준다. 이전 재생 목록에서 뒤늦게 건너뛴 구간을 요청해도 서버의 명시적 `tts_audio_skipped` 응답만 생략으로 처리하며, 일반 파일 손상/404/410을 생략하지 않는다.

### 추가 TTS 서버

듣기 → TTS 엔진 연결 → **TTS 서버**에서 로컬 JSON 엔진과 OpenAI 호환 음성 API를 여러 개
등록한다. 기존 `local-endpoint`, `TTS_PLAIN_*`, 기본 목소리와 provider 설정은 교체하지 않는다.
새 연결은 일반 서버 목소리와 미리 생성하기에 참여하며 기존 화자별 provider 등록과는 별개다.

- `GET/POST /api/tts/connections`, `PUT/DELETE /:id`, `POST /probe` 및 `POST /:id/probe`는
  기존 provider와 같은 bootstrap 관리자 경계다. migration 0066의 `tts_connections`에 주소와 API 키를
  AES-GCM으로 암호화한다. 계정·연결 ID를 AAD로 사용하며 최대 16개를 트랜잭션으로 제한한다.
- 로컬 기본 주소에는 `/synthesize`, OpenAI 호환 기본 주소에는 `/audio/speech`를 붙인다.
  OpenAI 호환의 호스트만 입력하면 `/v1/audio/speech`다. 완성된 합성 주소도 받는다.
  키는 Bearer 헤더로 전송한다. 편집 시 키 생략은 유지, 빈 문자열은 삭제이며 origin 변경 시
  기존 키를 자동 전달하지 않는다. 브라우저 저장소에는 연결이나 키를 저장하지 않는다.
- 연결 확인은 같은 서버의 모델·목소리 목록 GET만 수행한다. 합성·과금 호출은 하지 않는다.
  `/models`, `/voices`를 지원하지 않는 서버는 모델·음성 ID를 직접 입력한다. 자동 입력 한도 탐지는 없다.
  각 요청은 등록한 호스트로 DNS를 검증·고정하고, 인프라 주소 및 리다이렉트를 허용하지 않는다.
  발견 응답은 256KiB, 합성 전송 응답은 32MiB로 제한한다.
- OpenAI 호환 요청은 `model/input/voice/response_format/speed`, 로컬 요청은 기존
  `modelId/text/voiceId/voiceProfile` 계약을 쓴다. 채팅 completion API는 TTS 연결이 아니다.
  기본 엔진 입력 제한은 1000자이며 긴 낭독 단위는 최대 8개 구간으로 순차 분할한다.
  분할 결과는 같은 형식의 PCM WAV만 합치며 본문 낭독 위치와 저장 작업은 하나의 원래 단위를 유지한다.
  고급 설정 범위는 1–20000자, 1–32구간이다. 한 요청은 하나의 텍스트를 보내므로 구간 수는 문장 수가 아니다.
- 연결 ID와 실제 주소·프로토콜·모델로 합성 모델을 식별한다. 이름·키·목록 변경이나 다른 서버 추가는
  기존 모델의 작업을 무효화하지 않는다. 실제 모델/주소 변경은 새 생성에서 차단하며 이미 만든 파일은 보존한다.
  각 전송 전후에 연결 존재·활성화·모델을 다시 확인한다. 삭제는 음성 파일이나 읽기 설정을 삭제하지 않는다.
- API와 worker는 같은 DB와 암호화 키를 읽는다. 등록 후 환경변수 변경이나 재시작은 필요하지 않다.
  GPU 모델 서버의 설치·시작은 그 서버 운영 범위다.

구현은 `providers/tts-connection*.ts`, `routes/ai/tts-connection-routes.ts`,
`src/services/remote/tts-connections-client.ts`, `UiNextTTSConnections.tsx`에 있다.
격리 PostgreSQL·네트워크 테스트와 `scripts/performance/tts-connections-ui-smoke.mjs`는
저장·권한·취소·모델 식별·형식 및 모바일 UI를 검증하며 실제 외부 엔진의 합성 품질을 보장하지 않는다.

### 저장형 오디오북

`audiobook-routes.ts`와 `services/audiobook-*.ts`는 일반 서버 음성을 사용자가 지정한 회차 범위만큼
만들어 보관한다. 화자 분석은 필요하지 않다. 원격 서버의 관리자 듣기 화면에서 **미리 생성하기**를
열어 현재 회차·범위·전체를 선택한다. 같은 시트 안의 하위 페이지이며 별도 시트를 중첩하지 않는다.
현재 일반 서버 목소리, 발음 규칙, 문장/문단/묶음과 각주 설정을 사용하며 기존 낭독 설정을 바꾸지 않는다.

- `POST /api/books/:bookId/audiobooks/estimate`는 소유한 본문에서 낭독 단위를 계산한다. 생성 호출은
  하지 않으며 회차·단위·문자 수와 선택한 엔진의 유료 여부를 반환한다. 금액을 추정하지 않는다.
- 같은 경로의 `POST /audiobooks`는 현재 계획의 fingerprint와 유료 엔진의 `confirmPaid`를 검증한다.
  중복 제출은 같은 작업을 반환한다. 새 목소리·규칙·본문 버전은 다른 계획이다.
- 작업은 PostgreSQL에, 음성은 `SERVER_DATA_DIR/saved-audiobooks`의 0600 파일에 저장한다.
  파일에는 오디오 해시를 기록하고 임시 파일을 원자적으로 교체한다. 임시 TTS 캐시의 TTL/LRU로 삭제하지 않는다.
- API 프로세스는 알려진 클라우드 TTS 연결에서 최대 2개 구간을 병렬 생성한다. 로컬·사용자 지정
  서버나 처리 능력을 모르는 연결은 1개씩 처리하고, 혼합 목소리 풀은 가장 낮은 한도를 따른다.
  성공한 차례 뒤에는 이벤트 루프에 양보하고 바로 다음 차례를 시작한다. 작업 없음·요청 제한·유지보수
  대기는 1초 간격으로 확인한다. PostgreSQL advisory lock은 진행 중인 모든 요청이 끝날 때까지 유지하며,
  관리형 업데이트의 활동 집계에도 포함한다. 유지보수 lease 중에는 새 단위를 시작하지 않는다.
- 중단은 이미 진행 중인 구간들이 끝난 뒤 적용한다. 앱을 닫아도 서버 작업은 계속한다. 서버 프로세스가
  사라진 뒤에는 진행 중이던 작업을 일시정지한다. 완료 여부를 모르는 유료 요청은 자동 재전송하지 않는다.
  명시적 `resume`은 완료한 파일을 재사용하고 미완료 단위만 재개한다. 429는 실패로 끝내지 않고
  `retry_at`과 누적 횟수를 DB에 저장해 대기열로 돌린다. 지수 대기는 10초부터 최대 5분이며,
  제공자의 더 긴 Retry-After도 최대 하루까지 지킨다. 대기 중에는 runner lock/DB 연결을 잡지 않는다.
  중단하면 자동 재시도도 멈추며, 성공한 단위 다음에는 대기를 초기화한다. 일부 조각을 이미 생성한
  연결형 TTS의 후속 429는 전체 재전송에 따른 중복 비용을 막기 위해 자동 재시도하지 않는다.
  병렬 요청 중 하나가 실패해도 나머지 결과를 보관한 뒤 멈춘다. 429 대기 후에는 먼저 1개로 재시도하고,
  성공하면 병렬 처리를 복구한다. 같은 차례의 시간 초과 등 불확실한 실패는 429보다 우선하여 중단한다.
  구간별 원문 위치·순서·캐시 키는 바꾸지 않으며 기존 녹음도 재분할하거나 다시 생성하지 않는다.
- `reader`는 보관된 생성 설정으로 현재 회차의 본문 위치와 낭독 구간을 재구성한다. 현재 배속·묶음 크기·
  발음 규칙이 달라도 녹음의 실제 구간을 사용한다. 본문 버전이 달라진 음성을 새 본문에 연결하지 않는다.
- `본문에서 듣기`는 기존 리더의 TTS 실행기로 들어간다. 본문 강조·스크롤·일시정지·수면 타이머·
  다음 회차 이동·서버 읽기 위치 저장을 그대로 사용한다. 별도의 오디오 플레이어는 없다.
  일반 서버 듣기도 같은 목소리로 미리 만든 회차가 있으면 해당 계획을 사용한다. 직접 고른 계획의
  범위를 벗어나면 다른 목소리로 전환하지 않고 멈춘다.
- 재생·선읽기는 먼저 읽기 전용 `audio` GET으로 저장 파일을 조회한다. 계획상 미완료인 구간에
  한해서 404 뒤 `resolve`로 생성한다. 저장 파일의 통신 실패·권한 오류·손상은 생성으로 대체하지 않는다.
  읽기 전용 조회는 일시 통신 실패/408/429/502/503/504에 최대 3회 재시도하며, 한 다운로드는 본문까지
  30초로 제한한다. 대용량 책 파일 전송의 기존 제한은 바꾸지 않는다.
- `resolve`는 완성된 파일을 바로 반환하며 엔진 연결이 필요 없다. 미완료 구간은 원래 작업의 모델·
  목소리·설정으로 생성하고 저장한다. 전경과 배경이 같은 구간을 요청하면 메모리의 진행 중 요청과
  PostgreSQL 구간별 lock으로 합쳐 생성 비용을 중복하지 않는다. 완료 수는 연속 접두부가 아니라
  실제 ready 행의 수다. 전경 오류 뒤 배경이 모호한 요청을 자동 재전송하지 않는다.
  미리 생성 경로는 한 단위 합성에 120초를 주고 일반 듣기/미리듣기는 45초를 유지한다.
  resolve 클라이언트는 서버 합성보다 긴 150초를 기다린다. 엔진이 기한 만료를 AbortError로 바꿔도
  원래 TimeoutError로 구분하며, 생성 시간 초과는 자동 재전송하지 않는다.
- 새 작업은 선택한 모델의 합성 설정만 고정한다. 전체 모델 목록·순서·기본값·설정 저장 시각이 바뀌어도
  같은 모델의 이어 만들기를 막지 않는다. 구형 계획은 일치하는 기존 음성 키 또는 변경되지 않은
  카탈로그로 모델을 확인한 뒤 이관한다. 실제 선택 모델 변경은 새 생성만 막고 완성된 음성은 보존한다.
  재생 중 명시적 다시 만들기는 해당 보관 구간을 교체한다. 일반 합성의 재생성은 기존 동작대로
  동일 키의 자동 캐시 연결만 해제한다.
- 보관 상한은 계정당 50개/20GiB다. 계획은 2,000회차/100,000단위/2천만 낭독 문자와 32MiB의
  원문 없는 계획 데이터로 제한한다. 한 회차 조회는 50,000문단/32MiB, 선택 원문 합계는 96MiB 이하다.
  상한이나 디스크 여유 공간 부족 시 완료한 녹음을 지우지 않고 중단한다.
  합성 전 계정별 트랜잭션 잠금으로 진행 중인 응답당 최대 16MiB를 예약해 병렬 요청의 용량 초과를 막는다.
- 삭제는 생성이 멈춘 뒤 가능하다. 삭제 진행 중 재시작과 영구 삭제된 작품의 고아 파일을 정리한다.
  복원하려면 PostgreSQL과 서버 데이터 볼륨을 함께 백업해야 한다.
- 화면은 생성 전 범위·목소리·낭독 글자와 구간 수를 표시하고, 유료 생성·재개는 명시적으로 확인한다.
  재생 속도·음량은 현재 듣기 설정을 따르고, 생성은 1배속을 사용한다. 목록을 나가도 본문 TTS는
  이어진다. 생성 작업 목록은 열린 동안 4초마다 갱신한다.

UI는 `UiNextAudiobookPanel.tsx`, 재생은 `App.tsx`의 기존 TTS 실행기와 `usePlainTTS.ts`에 연결된다.
공유 계약은 `src/providers/plain-audiobook.ts`, 생성 구간 연결은 `prepared-narration.ts`, 인증된
전송은 `src/services/remote/audiobook-client.ts`다. 여러 문단을 담은 음성의 내부 진행 위치는
여전히 낭독 글자 길이에 따른 추정이며, 문장별 타임스탬프나 강제 정렬을 추가한 것은 아니다.
서버의 실제 PostgreSQL/공유 합성 경로는 `audiobook-service.integration.test.ts`, 화면 상호작용은
UI 테스트와 `scripts/performance/audiobook-ui-smoke.mjs`에서 확인한다. 브라우저 스모크의 HTTP와
WAV는 중립 fixture이며 실제 제공자 생성·과금이나 운영 데이터 검증을 대신하지 않는다.

현재 범위는 관리자 소유 TXT/Markdown/EPUB와 등록된 API·local endpoint 엔진이다. 로컬 GPU 모델
설치, 단일 M4B/MP3 파일 내보내기, 브라우저 오프라인 다운로드, 화자별 생성 작업은 이 API의 범위가 아니다.
합성은 1배속이며 저장 음성의 재생 배속 변경은 합성을 다시 요청하지 않는다.

## AI·화자별 합성과 플랫폼 경계

### 기존 라벨 기반 낭독과 화자별 미리 생성의 구분

기존 `BOAA AI`의 작품 분석·라벨 교정은 `LabeledSegment`/`Character`를 만들고,
실시간 인물별 낭독은 `VoiceProfile`/`VoiceProductState`의 배정·승인·음성 풀을 사용한다.
이 경로의 주요 인물 수·샘플 승인·단역 대체 설정은 새 **화자별 미리 생성하기**의 설정이 아니다.
새 생성 경로는 별도 분석 캐시와 `speaker_voice_bindings`, 저장된 작업 계획을 사용한다.
기존 도구의 화면 노출을 줄여도 분석·배정·승인 저장 데이터나 실행 API를 삭제하지 않는다.

기존 발음 사전은 예외적으로 두 경로에서 계속 소비된다. `App`은 활성 literal 발음 규칙을
`SpokenTextRule`로 투영해 새 낭독 필터와 함께 합성에 전달한다. 필터 화면을 통합할 때도
이 규칙을 미리보기에 포함하고, 삭제는 새 필터 저장소가 아닌 기존 발음 사전으로 보낸다.
자동 이관·중복 저장으로 두 저장소의 규칙을 섞지 않는다.

청취 UI는 `화자·고급 설정` 진입을 없애고 읽기 미리보기를 **발음·문자 필터**로,
책 전체 건너뛰기 영향 확인을 **세부 청취 설정 → 건너뛸 내용**으로 모은다.
기존 발음 사전은 저장된 규칙이 있을 때만 필터 화면에서 별도로 관리한다.
기존 음성 초안·승인·음성 풀·캐시는 **실시간 인물별 낭독** 도구에 남긴다.

기본 읽기 도구에서는 내장 AI 탭을 숨긴다. 기존 방식을 사용 중이거나 분석 작업을 관리할 때,
또는 **세부 청취 설정 → AI 도구**로 직접 열었을 때는 접근할 수 있다.
`ReaderFeatureHost.hiddenTabIds`는 탭 표시만 제어하며 현재 열린 탭은 유지한다.
익스텐션의 켜짐/꺼짐 저장값·동기화·실행 계약은 바꾸지 않으며, 명시적으로 끈 익스텐션을
이 노출 정책으로 다시 켜지 않는다. 별도 설치 플러그인의 탭도 이 정책의 대상이 아니다.

S8 voice casting boundary - 2026-07-13: importance scoring, conservative trait resolution, pool allocation and
collision solving are deterministic provider-neutral code in `src/providers/voice-casting/`; they do not call an LLM
or TTS service. An optional future trait micro-pass receives only bounded ambiguous evidence through the existing LLM
provider interface. React calls the product controller/repository and existing sample/synthesis boundaries, never a
provider SDK or secret.

One book has one active casting provider/model context for playback. User pools for other providers may remain stored,
but projection selects assignments only for the requested provider/model and verifies the current VoiceProfile's actual
provider voice key. Accepted provenance, content revision and casting revision travel as provider-neutral binding data;
relation/importance internals do not enter the synthesis request. Local/Native and Hosted cache paths reject stale
workspaces. The Hosted guard allows the historical path only when a book has no casting row at all; once casting exists,
missing or stale character assignments fail closed until recompute.

Native compact speaker boundary - 2026-07-13: disconnected Tauri uses the same provider-neutral full-chapter
materializer, scene packet builder, compact request compiler and aggregate validator as Hosted. One schema-v3 logical
labeling job is materialized as a Rust-journaled packet batch; React never receives provider secrets or assembles the
external request. The journal persists packet request hashes, fences and safe result metadata, resumes only unfinished
units after restart, and returns one text-free logical checkpoint. TypeScript validates request/output/fingerprint
alignment before staging canonical labels, sequence decisions, risk routes, dependencies and provenance. Promotion
writes those rows atomically with generated segments. Rich v2 replay remains pinned to its own descriptor, and compact
speaker jobs cannot enter the durable boundary as embedded or single requests. Independent native escalation remains
an explicit pre-dispatch unsupported option rather than silently reusing the primary answer.

Accepted speaker provenance boundary - 2026-07-13: compact provider output is expanded and reconciled outside
provider-specific adapters. Automatic and reviewed promotion persist only text-free identity/source/temporal/sequence
provenance beside generated segments in the same transaction. Normal job progress exposes only count/fingerprint;
raw provenance drafts are confined to the internal staging artifact metadata and are not copied into settings, sync
events, logs or toasts. A provenance-free labeling replacement supersedes prior active sidecars in the same paragraph
scope instead of leaving stale identity attached to new segments. TTS may consume the accepted sidecar through a
provider-neutral playable-item projection. App/API query, voice allocation and TTS projection are now connected by the
S8 boundary above.

Speaker C3 compact boundary - 2026-07-13: provider adapters receive an immutable `SceneSpeakerPacketV3` projection,
not the full source, graph, or temporal store. Only sieve-unresolved spans are targets. The request compiles an
all-required `SpeakerWireV2` schema with exact target count and request-local ordinal bounds; a separate semantic
validator rejects stale fingerprints, ungrounded candidates and ungrounded new mentions. Dialogue sequence decoding
and canonical `LabeledSegment` expansion happen outside provider-specific code. Hosted workers and the Tauri durable
batch workflow both use this boundary; existing rich v2 replay remains active under its pinned profile.

Speaker S0 generation update - 2026-07-13: Hosted와 Tauri structured-JSON wrapper는
`src/providers/provider-generation-policy.ts`의 동일한 provider/model/task resolver를 사용한다. 설정에 없는
sampling 값은 전송하지 않고, Gemini 3.x bounded labeling에는 `thinkingLevel=minimal`, Gemini 2.5에는
`thinkingBudget=0`을 적용한다. Provider adapter는 완료/불완전 응답에서 원문을 폐기하고 policy/hash,
token/byte, partial hash, repetition과 bounded failure class만 `ProviderExecutionMetadata` allowlist로 보낸다.
요청별 output cap은 compact speaker request가 span inventory를 제공할 때 사용하며 기존 rich profile에는
사용자 명시 cap 외의 작은 cap을 억지로 적용하지 않는다.

Reader W4 playback controls - 2026-07-13: UI는 계속 provider interface만 호출한다. system `SpeakInput`은
rate/pitch/volume을 받고, Hosted/native synthesis는 catalog capability가 지원하는 rate/pitch만 render request와
cache fingerprint에 투영한다. playback-only volume과 sentence/paragraph/chapter pause는 audio cache identity에
들어가지 않는다. `BrowserAudioSession`과 Media Session adapter는 합성 provider와 분리되어 audio output과 OS
control만 소유한다.

- 2026-07-11 Character Graph v2 update: bundle adapters return provider-neutral observations with
  evidence anchors instead of overwriting canonical identity. Local/hosted persistence derives only
  exact typed-name review candidates; merge/split requires an explicit user command. Hosted/native
  labeling builds a chapter/scene-valid v2 graph slice before the provider adapter, so provider-specific
  code never owns graph selection, redirects, temporal validity, or identity mutation.
- 2026-07-11 capability update: provider adapters consume an immutable provider-neutral capability/task/
  admission snapshot. UI/catalog sees only safe limits, source/freshness and fingerprints. Result metadata
  may record normalized actual usage and estimate delta, but never provider options, prompts, raw bodies or
  secrets. Calibration applies only to an exact provider/requested+resolved model/task/corpus match.

Status: current
Last verified: 2026-07-10

## Current Implementation Note - 2026-07-06

- 2026-07-10 native durable-workflow update: `src-tauri/src/workflow/` accepts the existing provider-neutral structured JSON request DTO, persists immutable submit/job/checkpoint events to an fsynced local JSONL journal, rejects idempotency-key payload drift, validates bootstrap -> optional graph merge -> chapter labeling -> TTS-readiness transitions, requeues interrupted claims at startup, and fences late provider results after cancel/retry generations. `state.rs`, `journal.rs`, and `store.rs` separately own persisted models/view mapping, journal replay/transition validation, and command-facing orchestration; every workflow module stays below 500 lines. Public status responses omit prompts and provider-option bodies; checkpoint output is read separately, and provider secrets remain available only inside the existing secure-store bridge. This is the native execution/storage boundary; React-to-IndexedDB result promotion and dynamic Episode Context composition remain separate integration work.
- 2026-07-10 native TTS cache update: `native_tts_render_cached` derives a web-compatible SHA-256/persistent-ID cache key from content revision, provider, effective model, voice, exact-text hash, sanitized provider-options hash, format, speed, emotion, and tone. Secret-like options fail before cache lookup. Durable records contain hashes, audio, and non-secret render metadata, not source text, option bodies, request ids, or secure-store values. Existing React playback still calls the one-shot native synthesis command until a later UI adapter slice consumes this cache command.

- Hosted TTS cache identity now includes `TTSRenderSpec` and `renderSpecHash` in addition to provider/model/voice/options/text hashes.
- `TTSRenderSpec` is provider-neutral and records book/chapter/speaker/voice binding, segment anchors, input text hash, provider option hash, provider/model/version, format, speed, pitch, tone, emotion, and emotion policy.
- The browser may send anchors and hashes, but the server worker reconstructs raw synthesis text from stored paragraphs and segments before calling a TTS provider.
- AI/TTS metadata sync covers user-authored `voice_profiles_updated`/`user_correction_created` and generated `character_graph_updated`/`chapter_segments_updated`. Hosted audio-cache sync remains separate follow-up work.
- Hosted TTS playback/prefetch resolve, job polling, audio fetch, audio play orchestration, paragraph traversal, and system fallback callback wiring now run through injected runners; browser audio element/object URL lifecycle now lives in `BrowserAudioSession`, while `App.tsx` still owns React UI state.
- Hosted bundle-analysis graph merge now has a browser-side pre-merge review helper. The UI can exclude discovered character candidates and sends the reviewed `CharacterGraph` through the same hosted job boundary; it still does not call provider SDKs or assemble provider-specific LLM requests.
- AI/TTS smoke runners are dry-run by default. External smoke requests require the CLI `--live` flag; legacy environment toggles are ignored so accidental shell state cannot trigger a provider call.
- Hosted BYO provider secrets now live outside `provider_settings`: `/api/provider-secrets/*` can set/delete/test/status encrypted user secrets, `GET /api/provider-settings` returns `secretStatuses` only, and provider workers resolve `UI stored secret > env secret > missing` without returning secret plaintext to the browser.
- Hosted self-host provider settings now preserve user-selected LLM/TTS providers even when they are not in `AI_PROVIDER_ENABLED` or `TTS_PROVIDER_ENABLED`. Env provider lists seed defaults and smoke/dev setups, but actual hosted jobs check saved provider settings, implementation support, and `secretConfigured` from UI/env secret status.
- Tauri desktop mode now has a secure local LLM add-on path: provider settings stay as non-secret localStorage state, OpenAI/Gemini API/Claude API keys and Gemini Vertex credential paths stay in the OS credential store, and current-chapter labeling, label repair, bundle character analysis, and reviewed Character Graph merge cross a Tauri command that injects the secret and returns generated JSON text only. `src-tauri/Cargo.toml` explicitly enables the keyring native backends (`windows-native`, `apple-native`, and Linux persistent native/secret-service features) so desktop builds do not silently fall back to keyring's mock credential store.
- Tauri desktop mode now has a secure local cloud TTS path for `openai-tts` and `elevenlabs`: API keys stay in the OS credential store, React stores only non-secret provider settings and voice profiles, `desktop_tts_synthesize` performs provider calls in Rust, and returned audio bytes are played through `BrowserAudioSession`. The native cache command is durable and content-revision-aware, but current React playback does not invoke it or expose native whole-book warmup yet.
- Local connected mode now checks that the local book body has been attached to the self-host server before server provider labeling/repair/bundle/graph jobs or manual hosted TTS cache warmup/playback are started. If the server book/chapter is missing, the sync panel opens and the user is directed to run the server body attach action instead of receiving a late provider 404/job failure.
- Tauri mobile/APK now has a direct Android secure-store boundary for local API-key provider secrets. `src/platform/runtime.ts` still distinguishes `tauri-desktop` from `tauri-mobile`, but both Tauri shell kinds can select the native secure provider runtime when no server provider client exists. Desktop uses OS `keyring`; Android registers `ProviderSecretStorePlugin` and stores API keys with Android Keystore + AES-GCM before Rust provider commands read them at request time. Android native status reports `android_secure_store`, and the mobile readiness check verifies that the native plugin is not exposed through direct JS capabilities and that the Kotlin plugin package/Rust registration/sync target stay aligned with the Tauri app identifier. Native Gemini API / AI Studio sends the API key through the `x-goog-api-key` request header rather than the generated URL query. Android direct local mode filters out Gemini Vertex `credential_path` providers until a proper document-picker/content-URI credential import flow exists, and `desktop_ai_generate_json` rejects Android `gemini-vertex` execution at the command boundary; Vertex file credentials are desktop-local or connected/server-mode only in this slice. `pnpm check:mobile-readiness` now passes the direct Android secure-store adapter checks but still blocks APK completion when `src-tauri/gen/android` or SDK/NDK are missing.
- Gemini Vertex LLM live smoke has passed through the server provider boundary, through the direct Rust Vertex helper, through the desktop secure-store boundary where `provider_secret_set` stores the credential path before `desktop_ai_generate_json` reads it back for the live request, and through `pnpm check:desktop-vertex-contract -- --live`, which validates the desktop wrapper's strict TTS chapter-labeling prompt/schema, parser, and validator against a live Vertex response. Gemini Agent Platform remains a connected/server-mode provider until a matching secure-local adapter is added.
- Local endpoint TTS voice discovery uses the v1 `/voices` contract through the server adapter, and hosted TTS voice-profile controls can refresh discovered voices for per-character assignment.

## 원칙

AI/TTS 호출은 UI 컴포넌트에 직접 넣지 않는다. 모든 외부 또는 플랫폼별 기능은 provider interface 뒤로 숨긴다.

실제 외부 API 호출이 들어가는 단계에서는 이 문서와 함께 [AI/TTS Provider, Job, Cache, Security 설계](ai-tts-provider-job-cache-security.md)를 기준으로 삼는다.

## Provider Runtime

위치:

- `src/providers/provider-registry.ts`
- `src/providers/reader-provider-runtime.ts`
- `src/providers/provider-control-client.ts`
- `src/providers/provider-jobs.ts`
- `src/providers/provider-generation-policy.ts`
- `src/providers/speaker-attribution/output-budget.ts`
- `src/providers/speaker-attribution/repetition-evidence.ts`
- `src/providers/speaker-attribution/failure-classifier.ts`
- `src/providers/tts-cache.ts`
- `src/providers/browser-audio-session.ts`
- `src/providers/tts-playback.ts`
- `src/providers/tts-playback-session-runner.ts`
- `src/providers/hosted-tts-background-warmup-runner.ts`
- `src/providers/chapter-labeling-payload.ts`
- `src/providers/chapter-labeling-contract.ts`
- `src/providers/chapter-labeling-request-profile.ts`
- `src/providers/chapter-labeling-validator.ts`
- `src/providers/chapter-label-repair-request-profile.ts`
- `src/providers/character-graph-contract.ts`
- `src/providers/character-graph-request-profile.ts`
- `src/providers/character-graph-snapshot.ts`
- `src/providers/character-graph-review.ts`
- `src/providers/provider-settings-ui.ts`
- `src/providers/desktop-structured-json-provider.ts`
- `src/providers/desktop-tts-provider.ts`
- `src/services/remote/remote-api-client.ts`
- `src-tauri/src/lib.rs`
- `src-tauri/src/app.rs`
- `src-tauri/src/provider_secrets.rs`
- `src-tauri/src/provider_http.rs`
- `src-tauri/src/ai/command_contract.rs`
- `src-tauri/src/ai/bridge.rs`
- `src-tauri/src/ai/provider.rs`
- `src-tauri/src/tts/command_contract.rs`
- `src-tauri/src/tts/bridge.rs`
- `src-tauri/src/tts/provider.rs`
- `src-tauri/src/tts/local_endpoint_provider.rs`
- `apps/server/src/providers/server-ai-config.ts`
- `apps/server/src/providers/server-provider-settings.ts`
- `apps/server/src/providers/server-provider-secrets.ts`
- `apps/server/src/providers/provider-smoke.ts`
- `apps/server/src/providers/tts-provider-smoke.ts`
- `apps/server/src/providers/gemini-vertex-ai-provider.ts`
- `apps/server/src/providers/server-tts-provider-factory.ts`
- `apps/server/src/providers/openai-tts-provider.ts`
- `apps/server/src/providers/elevenlabs-tts-provider.ts`
- `apps/server/src/providers/gemini-tts-provider.ts`
- `apps/server/src/providers/gemini-vertex-tts-provider.ts`
- `apps/server/src/providers/google-cloud-tts-provider.ts`
- `apps/server/src/providers/local-endpoint-tts-provider.ts`

현재 구현:

- provider id 기반 `ProviderRegistry`.
- local mock AI/system TTS provider를 registry 뒤에서 생성하는 `createReaderProviderRuntime()`.
- provider capability, execution target, secret policy, job, budget estimate, TTS cache item 타입.
- TTS cache key helper.
- hosted AI/TTS data route and schema for characters, voice profiles, labeled segments, and user corrections.
- hosted sync event boundary for user-authored voice-profile collection replacement and manual correction upsert; malformed or stale voice-profile snapshots are rejected before they clear server state.
- hosted provider job enqueue/status/cancel routes and BullMQ worker for chapter labeling, chapter label repair, Character Graph merge, and TTS synthesis.
- hosted provider catalog route for enabled/implemented/secret-configured metadata without secret values.
- hosted provider secret route for set/delete/test/status. Status contains only provider id, scope, secret name, configured/source, fingerprint/last4, and timestamp when available; secret plaintext is never read back into the browser.
- hosted TTS provider catalog capabilities expose non-secret render option metadata and provider option metadata for `openai-tts`, `elevenlabs`, `gemini-tts`, `gemini-vertex-tts`, `google-cloud-tts`, and `local-endpoint`. The metadata marks per-character `voice_profile` options separately from provider default/request options, hosted voice-profile rows render and save those controls without duplicating the provider voice id field, and `local-endpoint` is flagged as allowing custom non-secret provider options for pluggable local engines.
- hosted provider catalog route also exposes non-secret chapter-labeling request profile metadata so UI can offer profile selection without knowing provider request payloads. The default is `chapter-labeling-v2-strict-tts`; explicit `chapter-labeling-v1` and `chapter-labeling-v1-strict-tts` remain available for compatibility. Repair defaults to `chapter-label-repair-v2-patch` while `chapter-label-repair-v1` remains readable for pinned jobs. Character Graph merge profile `character-graph-merge-v1` is used only by dedicated graph jobs.
- hosted provider settings route for per-user default provider, enabled-provider subset, model overrides, and non-secret provider options.
- hosted provider settings UI in the AI/TTS add-on panels. It edits provider id/model/request profile id through `RemoteApiClient`, renders catalog-backed non-secret provider option controls when metadata is available, keeps raw non-secret option JSON as an advanced fallback, and sends provider secrets only through the `ProviderControlClient` set/delete/test boundary.
- native provider settings UI in Tauri local mode. It uses the same `ProviderControlClient` surface, stores only non-secret defaults/model/profile/options in localStorage, reads key status from Tauri secure-store commands, can run a provider-settings sample structured JSON request, and can run current-chapter OpenAI/Gemini API/Gemini Vertex/Claude API labeling through `desktop_ai_generate_json`. Desktop secrets use OS `keyring`; Android API-key secrets use the registered Android Keystore plugin. Gemini Vertex uses a desktop-only `credential_path` secret; Rust resolves a JSON file path or single-JSON credential directory, mints the Google OAuth token locally, and does not return credential contents or access tokens to React. Android local direct mode omits Vertex `credential_path` providers until credential file import is implemented, and the native command rejects Android `gemini-vertex` execution if invoked directly. Native AI and TTS commands both reject secret-like provider options before provider calls. The same settings panel exposes `openai-tts` and `elevenlabs` for TTS synthesis; API keys are stored as `tts_synthesis/*/api_key`, voice discovery crosses Tauri, and playback calls `desktop_tts_synthesize` before system fallback.
- hosted AI analysis button in remote mode. It enqueues a provider job through the server, polls job status, and reloads saved segments/characters/voice profiles after success.
- hosted AI add-on graph review for completed bundle-analysis results. It compares discovered candidates to existing character names/aliases, flags duplicate and low-confidence candidates, lets the user exclude discovered candidates, removes relations that reference excluded candidates, and enqueues graph merge with the reviewed graph plus review metadata in `sourceContext`.
- server-only AI provider smoke runner for dry-run readiness checks and explicit one-call live labeling smoke; live mode requires `--live`.
- server-only TTS provider smoke runner for dry-run readiness checks and explicit one-call live synthesis smoke that returns audio metadata only.
- shared provider error classifier for AI/TTS smoke output and provider job failure rows. It records stable categories/error codes without preserving raw provider response bodies.
- hosted TTS cache resolve route that validates hashed TTS cache requests without accepting raw text. It creates `tts_synthesis` jobs only after a non-system TTS provider is enabled, implemented, and server-configured.
- hosted TTS synthesis worker path for `openai-tts`, `elevenlabs`, `gemini-tts`, `gemini-vertex-tts`, `google-cloud-tts`, and `local-endpoint`, including server-side segment text reconstruction, input hash verification, catalog-backed input character/segment budget checks, object storage write, and authenticated cached audio read route.
- browser audio session adapter for hosted cached-audio playback, object URL cleanup, pause/resume, and stop completion without importing React state into provider runners.
- injected TTS playback session runner that advances paragraphs/playable segments, chooses next hosted prefetch targets, tries hosted audio first, and wires system fallback callbacks without owning React state or browser audio elements.
- injected hosted TTS background warmup runner that loads chapters in cancellable batches, builds raw-text-free cache requests, and reuses the warmup queue without importing remote clients or provider adapters.
- provider-neutral chapter labeling payload builder, schema/parser, swappable request profile boundary, storage validator, bundle analysis request profile boundary, repair request profile boundary, Character Graph merge schema/parser/request profile boundary, and server-only LLM adapters for OpenAI, Gemini AI Studio, Gemini Vertex/Agent Platform, and Anthropic. The payload builder carries paragraph anchors, known characters, previous episode context, and user corrections without changing provider adapters. The bundle profile carries selected chapters, existing graph, previous bundle summary, and user corrections, then maps provider output to a discovered `CharacterGraph` candidate set without directly overwriting canonical graph tables. The validator blocks invalid source anchors, stale segment hashes, overlap, unsupported speaker ids, bad segment types, and confidence errors before generated labels are persisted. The strict TTS request profile reuses the same stored schema while tightening prompt rules around exact offsets, non-overlap, unknown speakers, and TTS-friendly emotions. The repair profile reuses the same response schema, adds existing labels and validator issues to the request, and is reachable through optional server provider `repairChapterLabels()` methods, hosted `chapter_label_repair` jobs, and opt-in labeling validation-failure auto repair. The Character Graph merge profile sends existing/discovered graph snapshots, source context, and user corrections, then validates returned character ids, relation endpoints, and confidence before mapping to an internal `CharacterGraph`.
- `VoiceProfile` local/hosted repository boundary and playback resolver for system/hosted/desktop-secure TTS character voice mapping.
- `desktop_tts_synthesize` accepts provider id, model id, synthesis text, voice id, speed/tone/emotion/format, and non-secret provider options. Rust reads the TTS API key or local endpoint URL from the platform secure store, rejects secret-like option keys/values, calls OpenAI Speech, ElevenLabs REST, or a user-managed local HTTP endpoint, and returns only content type, audio bytes, byte count, and request id metadata. `desktop_tts_list_voices` exposes OpenAI built-in voices, ElevenLabs `/v1/voices`, or local endpoint `/voices` without returning provider secrets.

현재 한계:

- OpenAI, Gemini AI Studio, Gemini Vertex/Agent Platform, and Anthropic server adapters exist. Actual external provider calls run only in the worker or provider smoke runner after the provider is explicitly enabled, configured with a model, and supplied with a server-side env secret or encrypted user secret. Gemini Vertex `gemini-3.1-flash-lite` has passed one live smoke through this boundary.
- Hosted provider settings UI is connected for LLM labeling and TTS synthesis defaults. Plain browser local mode still uses the local Mock/system TTS path. Tauri desktop local mode supports OpenAI/Gemini API/Gemini Vertex/Claude API provider-settings sample JSON requests, current-chapter labeling, label repair, bundle analysis, reviewed graph merge, and OpenAI/ElevenLabs/local-endpoint TTS synthesis through secure local commands and local validation/fallback before persistence or playback. Native AI/TTS/voice-discovery HTTP clients use bounded request timeouts so a provider endpoint cannot hold the desktop/mobile command open indefinitely. The TTS provider settings panel can run a native sample synthesis for the selected desktop/local TTS provider using draft non-secret options and the saved secure-store secret/endpoint. Tauri Android local mode uses the same command/UI boundary with Android Keystore-backed API-key and endpoint URL provider secrets, but APK build verification still requires generated `src-tauri/gen/android` plus SDK/NDK. Gemini Agent Platform, Gemini/Vertex/Google Cloud native TTS, React wiring for native durable workflow/cache/warmup, and arbitrary local model installation remain outside this slice.
- provider job 타입과 hosted table은 analysis queue/worker 및 TTS cache resolve/enqueue/cancel 경계와 연결됐다. 기본 provider는 `mock`이고 외부 API provider는 기본 비활성화 상태다. Analysis worker는 `paragraph_search`, `characters`, 직전 `chapter_contexts`, 적용 가능한 `user_corrections`를 request payload hint로 싣고, provider option/profile metadata와 validation summary를 job progress에 보존한다. Cancel route는 queued/running job만 DB에서 먼저 `cancelled`로 전환하고 가능한 BullMQ queued entry를 후속 best-effort로 제거한다. Worker는 `cancelled` job을 시작하지 않고 provider 호출 전후에 취소 상태를 확인하며, active provider call 동안 DB 취소 상태를 monitor해 provider `AbortSignal`을 abort한다. Fetch 기반 OpenAI/Anthropic/TTS adapters receive that signal, and current Gemini SDK calls receive it through `GenerateContentConfig.abortSignal`. Generated DB persistence transaction은 provider job row를 잠그고 취소 여부를 확인한 뒤 side effect를 쓴다. `character_bundle_analysis` route/worker는 선택 chapter ids와 source context로 idempotent job을 만들고, provider가 반환한 discovered graph와 bundle summary를 `analysis_runs.metadata`/job progress에 저장하되 canonical graph table은 graph merge 전까지 변경하지 않는다. Validation error가 있으면 generated `labeled_segments`를 저장하지 않고 job을 failed로 끝내지만, `autoRepairOnValidationFailure`가 명시된 경우에는 invalid result를 메모리 입력으로 repair provider에 한 번 넘긴 뒤 재검증된 결과만 저장한다. `chapter_label_repair` worker는 저장된 labels를 다시 검증하고, issue가 있으면 provider repair method를 호출한 뒤 재검증된 결과만 저장한다. `character_graph_merge` route/worker는 chapter 없이 book-level graph fingerprint, discovered graph hash, source context hash, correction hash, provider/model/profile/schema/options hash로 idempotent job을 만들고, validated merge result를 `characters`, `character_aliases`, `character_relations`, `analysis_runs`, `library_books.analysis_status`에 transaction으로 저장한다.
- OpenAI TTS, ElevenLabs, Gemini API TTS, Gemini Vertex TTS, Google Cloud TTS, and local endpoint TTS adapters are implemented but disabled unless server env explicitly enables/configures them. `pnpm server:tts-smoke` can check sanitized readiness by default and make one short synthesis request only with `-- --live`. Gemini Vertex TTS has passed one live smoke; Google Cloud TTS REST returned a safe `auth` category until API/IAM permissions are confirmed.

## AI Provider

위치: `src/providers/ai.ts`, `src/providers/desktop-structured-json-provider.ts`, `src-tauri/src/ai/command_contract.rs`, `src-tauri/src/ai/bridge.rs`, `src-tauri/src/ai/provider.rs`

현재 구현:

- `AIProvider` interface.
- `MockAIProvider`.
- `DesktopStructuredJsonAIProvider` for Tauri current-chapter labeling through injected or Tauri `desktop_ai_generate_json`.
- optional `repairChapterLabels()` provider boundary for validation repair jobs.
- optional `mergeCharacterGraph()` provider boundary for Character Graph merge experiments.
- Plain browser local mode sends no external network request and requires no LLM API key.
- Tauri desktop mode can call OpenAI/Gemini API/Gemini Vertex/Claude API for current-chapter labeling, label repair, bundle character analysis, and Character Graph merge. API keys and Vertex credential paths stay in the OS secure store and are never returned to JS. Tauri Android uses the same request command but resolves secrets through the Android Keystore plugin.

Mock provider behavior:

- paragraph text를 local heuristic으로 labeling한다.
- system-message-like paragraph는 `system_message`로 분류한다.
- fixed mock characters를 반환한다.
- `LabeledSegment`와 `Character`를 만들어 IndexedDB에 저장할 수 있다.
- existing/discovered graph를 alias 기준으로 병합하고, user-confirmed character metadata를 보존한다.

향후 구현:

```text
OpenAIProvider live smoke and production hardening
AnthropicProvider live smoke and production hardening
GeminiAIStudioProvider production hardening
GeminiVertexProvider production hardening
GeminiAgentPlatformProvider live smoke result capture and production hardening
LocalLLMProvider
ServerAIProvider
```

주의:

- browser client에 provider secret을 노출하지 않는다.
- 실제 LLM 호출은 server 또는 secure local adapter에서 처리한다.
- UI는 provider id/model id만 다루고 request 구현을 몰라야 한다.
- 모델명은 코드에 고정하지 않고 provider config로 주입한다.
- hosted provider settings는 secret 값을 저장하지 않고, encrypted provider secret store 또는 server env secret 상태만 실제 사용 가능 provider를 결정한다. UI 저장 secret이 있으면 env secret보다 우선한다.

## TTS Provider

위치:

- `src/providers/tts.ts`
- `src/providers/tts-playback.ts`

현재 구현:

- `TTSProvider` interface.
- `TTSSynthesisProvider` interface for future cacheable local/cloud synthesis providers.
- `SystemTTSProvider`.
- browser `speechSynthesis` 사용.
- `getStatus()`로 unsupported/no-voice/ready 상태를 반환한다.
- local voice list 조회.
- speak/pause/resume/stop 지원.
- 저장된 voice가 현재 환경에 없으면 한국어 voice, 그다음 기본 voice로 fallback한다.
- `VoiceProfile` 기반 내레이터/시스템/화자 미정/캐릭터별 시스템 음성 매핑.
- `buildPlayableTtsSegments()`가 labeled segment offset을 원문 조각으로 해석하고, 분석 라벨이 없으면 문단 전체를 내레이터로 fallback한다.
- hosted `POST /api/chapters/:chapterId/tts-cache/resolve`가 cache request contract와 catalog-backed TTS synthesis budget을 검증한다. non-system TTS provider가 enabled/implemented/secret-configured 상태가 된 뒤에만 cache miss에서 `tts_synthesis` job을 만든다.
- server worker can synthesize `openai-tts`, `elevenlabs`, `gemini-tts`, `gemini-vertex-tts`, `google-cloud-tts`, and `local-endpoint` jobs, reject stale secret-like voice/provider options before provider calls, reconstruct text from saved segment anchors, verify `inputTextHash`, re-check max input character/segment budget against reconstructed text, write audio to object storage, and expose cached audio through an authenticated hosted route.
- hosted reader playback can save selected-provider non-system voice ids and catalog-backed non-secret `voice_profile` options per role/character, build raw-text-free cache resolve requests from exact labeled segment anchors, poll cache-miss jobs, fetch cached audio blobs, and fall back to matching system TTS profiles when the segment cannot be safely cached.

현재 한계:

- system TTS 기반 캐릭터 voice profile은 동작하고, hosted `openai-tts`/`elevenlabs`/`gemini-tts`/`gemini-vertex-tts`/`google-cloud-tts`/`local-endpoint` synthesis cache playback은 labeled segment 단위로 연결됐다. Reader는 active source-range highlight, next-segment/next-paragraph hosted TTS prefetch, bounded current/nearby-chapter warmup, and whole-book/background chapter-batch warmup을 지원한다. Paragraph/playable traversal and system fallback callback wiring now run through `tts-playback-session-runner.ts`; the TTS provider smoke runner is implemented. Gemini Vertex TTS live smoke passed; non-Vertex/cloud provider live smokes remain pending.
- labeled segment 기반 다중 화자 playback queue는 paragraph 안에서 순차 재생하며, 현재 source range를 reader 본문에 표시한다. `tts-playback-session.ts`로 active range, prefetch target, voice profile composition, system fallback input 같은 순수 session helper는 분리됐다. `tts-playback-session-runner.ts`는 paragraph traversal, hosted-first handoff, next-paragraph prefetch selection, system fallback callback wiring을 injected function boundary로 분리한다. `hosted-tts-playback-runner.ts`는 hosted playback/prefetch의 resolve/poll/fetch/play loop를, `hosted-tts-warmup-runner.ts`는 hosted cache warmup의 resolve/poll/status summary loop를, `hosted-tts-background-warmup-runner.ts`는 whole-book/background chapter batch loop를 injected function boundary로 분리한다. `browser-audio-session.ts`는 browser audio element/object URL lifecycle과 pause/resume/stop을 adapter로 분리한다.
- 브라우저 오디오가 재생 중으로 표시되지만 15초간 위치가 진행되지 않으면, 같은 파일·위치에서
  `pause()` 후 `play()`로 복구한다. 소스를 다시 로드하거나 합성을 요청하지 않는다. 실제 pause 상태는
  지연된 background 진행 이벤트보다 우선하며, 복귀 시 바로 확인한다. 사용자의 일시정지는 존중하고,
  새 재생 시도 뒤 늦게 도착한 이전 시도의 거절은 무시한다. 복구는 최대 두 번으로 제한한다.
  이는 앱 측 복구 계약이며 Android PWA의 실제 잠금 화면 장시간 재생을 보장하는 검증은 아니다.
- 잠금 화면 재생 진단: `playback-diagnostics.ts`는 현재 페이지 메모리에 최근 256개 이벤트와
  화면 복귀 직전의 최대 256개 이벤트만 보관한다. visibility capture 단계에서 실제 미디어 상태를
  먼저 읽어 복구 코드의 영향을 구분한다. 문단·manifest·저장 음성 GET·버퍼·간격·회차 전환 대기와
  미디어 재생/종료/복구를 기록하며, 본문·음성·URL·계정/작품 ID·오류 원문은 넣지 않는다.
  별도 타이머·네트워크 전송·영구 저장은 없다. 듣기 → 세부 청취 설정 → 재생 진단 복사로 사용자가
  직접 공유하며 앱을 다시 열면 기록은 사라진다. 이 진단은 재생 방식을 변경하지 않는다.
  저장된 짧은 음성은 여전히 파일마다 JS 기반 전환을 거친다. 데스크톱의 lifecycle 시뮬레이션은
  Android 설치형 PWA의 실제 중단 원인을 재현한 검증이 아니다.
- 준비된 음성의 미리 읽기는 다음 한 파일에서 최대 6개 파일(본문 합계 1,400자 이내)로 확대했다.
  가까운 파일부터 순서대로 읽고, 긴 파일은 첫 다음 파일을 우선한다. 기존 8개/32MiB 메모리 캐시를
  공유하므로 재생 중 파일과 다음 회차 첫 파일의 공간도 남긴다. 추가 미리 읽기는 `ready` 파일만
  허용하며 미완성 구간에서 멈춘다. 바로 다음 구간의 기존 한 건 준비는 유지하되 그 너머의 합성을
  시작하지 않는다. 합성 요청 묶기·화자·재생 구간·간격·수면 타이머는 바꾸지 않는다.
  실제 App이 주입하는 오디오 세션에도 진단을 연결해 미디어 상태/재생 이벤트를 함께 기록한다.

- browser/WebView마다 voice availability가 다르다.
- 별도 OS 음성용 `DesktopSystemTTSProvider`/`AndroidTTSProvider`는 아직 없다. 다만 secure-local cloud/local-endpoint TTS adapter는 `desktop_tts_synthesize` 경계로 구현되어 있다.

향후 구현:

```text
BrowserSystemTTSProvider
DesktopSystemTTSProvider
AndroidTTSProvider
ServerTTSProvider
OpenAITTSProvider
ElevenLabsTTSProvider
GeminiTTSProvider
GoogleCloudTTSProvider
LocalEndpointTTSProvider
```

## Immutable Hosted Workflow Inputs

Compact speaker attribution uses the same boundary with a distinct pinned contract. The server materializes
`speaker_attribution_v3` packets from an accepted content revision, keeps full-chapter ordinal identity stable across
windows, and sends only bounded scene/burst targets through `AIProvider.attributeSpeakers()`. Hosted and desktop
structured-json adapters compile the same prompt, request-sized schema, generation policy and output budget. Internal
routing/escalation options are removed before external dispatch.

Provider output is validated and expanded to canonical labels before staging. Semantic escalation is a separate,
primary-answer-blind packet capped at 15%; disagreement returns to review. Browser UI never constructs this request.
Tauri persists the rich/compact labeling contract and fingerprint in its descriptor/journal, but compact execution is
disabled until a native scene-packet materializer and checkpoint aggregator exist.

Hosted book workflow jobs do not reconstruct provider input from mutable progress. Job creation stores an immutable `AnalysisInputRevision` containing source/content revision, Character Graph revision/snapshot, correction fingerprint/snapshot, request profile/prompt/schema, provider/model/non-secret option fingerprint, and window anchors. TTS cache-miss job creation and pinning are atomic and additionally store the voice profile snapshot and complete render spec.

Immediately before an external provider call, workers compare the logical job identity and active content/fence, source object/raw/normalized hashes, chapter/paragraph text hashes, graph revision, correction fingerprint, request profile/options, and TTS render/voice state. Workflow-linked jobs missing a pinned revision finish stale instead of falling back to mutable state. Pre-`0006` and direct one-off analysis jobs retain a compatibility path; converting those direct routes to mandatory revisions remains a separate hardening item.

AI results are written to immutable staging artifacts. Only a service-owned promotion transaction may write canonical graph/segments/context/run rows, and it does so after expected-revision checks while holding the book lock. TTS cache rows store content, graph, input revision, render, segment, voice, provider, model, and option provenance; replacement import deletes active cache rows after first quarantining their metadata.

## UI 규칙

UI가 해도 되는 것:

- provider 선택 UI 표시.
- provider default/model/non-secret option 저장 요청.
- hosted provider job enqueue/status 표시.
- provider에서 받은 status/result 표시.
- provider interface method 호출.
- unsupported/no-voice/saved-voice-missing 상태를 사용자에게 안내.

UI가 하면 안 되는 것:

- 외부 API endpoint 직접 호출.
- API key 저장/전송.
- provider별 request body 직접 조립.
- Tauri/Android native TTS를 직접 분기.

## Secret 규칙

- `VITE_*`, React state, IndexedDB, localStorage에는 provider secret을 저장하지 않는다.
- service account JSON이나 API key 파일은 커밋하지 않는다.
- `vertex env/`는 local credential input으로만 취급하고 `.gitignore`에 둔다.
- hosted mode의 provider secret은 encrypted `provider_secrets` row 또는 server env/mounted secret/cloud secret manager 중 하나로 들어온다. `provider_settings`, `voice_profiles.provider_options`, `provider_jobs.progress`, `analysis_runs.metadata`, `sync_events`, logs, toasts에는 secret 원문을 넣지 않는다.
- desktop secure local provider secret은 Tauri command가 OS credential store에 저장한다. JS는 set/delete/test/status만 호출하고 secret 원문을 다시 읽지 않는다.
- plain browser local web mode는 cloud provider key 저장/직접 호출을 지원하지 않는다. Hosted localhost/self-host 또는 desktop secure adapter를 사용한다.

### 낭독 설정 저장 경계

묶음 크기(`plainBatchCharacters`, 200–2000자 정수)는 전역 설정과 책별 덮어쓰기 모두
`/api/settings` 저장·재조회 경로에서 보존한다. 화면의 임시 상태나 JSON 직렬화만으로 저장을
검증하지 않고 서버 검증기·DB·동기화 이벤트와 재조회까지 검사한다. 서버 목소리 식별자는
제공자 접두사를 포함해 합성 요청과 같은 최대 512자를 허용하며 160자로 자르지 않는다.
책별 TTS 저장 항목과 기기/공유 설정 분류는 타입의 전체 키를 검사해 새 항목 누락을 막는다.
보기 설정은 기존 기기별 저장 범위를 유지하고 서버 설정 저장으로 덮어쓰지 않는다.

### 화자별 미리 생성하기 (선택 분석 서비스)

서버/PWA 전용 실험 기능이다. `apps/speaker-engine`은 preset3.5 참조의 현재 회차 화자 판정(A),
양옆 회차 문맥, 회차 순서에 따른 인물 연결과 compact lorebook(B)만 가져온 별도 무상태 서비스다.
연구 실행기와 고정 모델, 파일 재파싱은 가져오지 않는다. 원본·수정 경계는 해당 디렉터리 `NOTICE`에 있다.

BOAA는 암호화된 `speaker_engines` 연결을 통해 OpenAI 호환 chat completion, Gemini API 또는 Vertex AI 모델을
호출한다. 분석 서비스는 키를 받거나 외부 모델에 접속하지 않고 요청 구성/결과 검증만 담당한다.
모델 ID와 출력 한도, 선택적 추론 강도는 연결 설정이며, 모델 이름으로 분기하지 않는다.
출력 한도·한도 파라미터·추론 강도를 바꿔도 완료된 화자 분석·인물 연결·목소리 배정은 재사용한다. 연결의 암호화된 내부
`analysisSettings`는 기존 분석 식별값을 보존하는 기준값이며, 실제 요청에는 현재 출력 한도·추론 설정을
사용한다. 기준값이 없는 이전 연결은 기존 설정에서 시작하므로 업데이트만으로 분석 키가 바뀌지 않는다.
사용자가 보낸 내부 기준값은 무시한다. 모델·주소의 식별 규칙은 유지하며,
분석을 다시 하려면 기존 '초기화·삭제'에서 화자 분석 기록을 명시적으로 지운다.
서비스 토큰과 모델 키의 origin 변경은 각각 재입력/삭제를 요구한다. 모델/목소리 선택은
작품별 서버 `speaker_generation_preferences`에 저장하고, 목록에서 사라져도 다른 값으로 바꾸지 않는다.

Vertex AI는 화자 분석과 목소리 선정 연결 모두에서 서비스 계정 JSON 파일을 받는다. 프로젝트 ID는
파일에서 채우며 리전은 기본 `global`이고 직접 바꿀 수 있다. 모델 ID·출력 한도·선택적 추론 강도는
연결마다 따로 저장한다. JSON은 64KiB 이내의 Google RSA 서비스 계정 키만 허용하고 기존 연결
암호화에 포함한다. 조회 응답에는 등록 여부만 반환하며 별칭 수정·활성 전환·키 생략 저장은 기존
키를 유지한다. 다른 프로토콜로 저장하면 JSON은 제거한다. API/worker는 고정된 Google OAuth 주소에서
짧게 유효한 토큰을 얻고 만료 전에 갱신하며, 모델 요청 주소도 프로젝트·리전으로 구성한 Google
주소만 사용한다. 분석 서비스에는 JSON·액세스 토큰을 전달하지 않는다. ‘연결 확인’은 인증과 모델
목록 조회만 하고 모델을 생성 호출하지 않는다. 목록은 프로젝트/리전의 실행 권한을 보장하지 않으며,
목록에 없어도 모델 ID를 직접 입력할 수 있다. 실제 사용에는 해당 프로젝트의 Vertex AI 사용 설정과
서비스 계정 권한, 선택 모델/리전의 지원이 필요하다.

Gemini API와 Vertex 연결에는 기본 꺼짐인 ‘PDF로 압축해서 보내기’ 옵션이 있다. 분석 및 목소리
선정의 사용자 요청 내용을 1pt 네이티브 텍스트 PDF로 인코딩해 `inlineData`로 보내며, 시스템 지시와
결과 schema는 텍스트로 유지한다. 업로드된 Provider Manager 1.19.1의 텍스트 PDF 접근을 참고해
독립 구현했다. 이미지 PDF/OCR, 플러그인 실행기와 외부 자산은 가져오지 않았다. Type0/ToUnicode
매핑과 Flate 스트림을 사용하고 요약·본문 삭제는 하지 않는다. 원래 본문과 UTF-16 위치 검증은 그대로다.
PDF는 서버 메모리에서만 만들고 파일/제공자 Files API에 보관하지 않는다. 입력 50만 UTF-16 단위,
64페이지·4MiB PDF를 넘으면 보내기 전에 실패한다. 변환 중 취소도 모델 호출 전에 확인한다.

전송 표현만 바꾸므로 `inputFormat`은 의미상의 분석/선정 revision에 포함하지 않는다. 옵션을 바꿔도
기존 분석 체크포인트·인물 배정·준비 음성을 재사용하며, 아직 보내지 않은 요청에만 새 표현을 적용한다.
기존 연결에는 필드를 쓰지 않으며 OpenAI 호환에는 허용하지 않는다. PDF 오류나 미지원 응답에 대해
일반 텍스트로 자동 재청구하지 않고, 429는 기존 지속 재시도 경로를 따른다. 글자 수 확인은 원문 기준이다.
요청 크기 압축률과 입력 토큰/요금 절감률은 다르므로 고정 절감률을 표시하지 않는다. Google의
[PDF 문서 처리](https://ai.google.dev/gemini-api/docs/document-processing) 및
[Vertex 문서 처리](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/document-understanding)
지원은 선택 모델에 따라 달라지며, 조밀한 텍스트 PDF의 실모델 판정 품질과 과금 절감은 별도 검증 대상이다.
화면·저장·PDF 텍스트 추출·모의 전송 검증을 실제 모델 품질 검증으로 보고하지 않는다.

`0068_speaker_generation.sql`의 분석 체크포인트와 모델 응답은 계정·작품·본문 revision·분석 설정·
엔진 버전에 묶인다. 응답은 검증 전에 저장하므로 분석 서비스 연결 실패 후 이미 받은 응답을 재사용한다.
429는 기존 생성 큐의 지속되는 Retry-After/지수 대기로 이어진다. 결과가 불확실한 요청은 자동으로
재청구하지 않고 명시적으로 이어 만들기를 요구한다. 목소리 변경은 분석 캐시를 무효화하지 않는다.
분석 자체는 인물 연결을 위해 첫 회차부터 선택한 마지막 회차까지 진행하며 음성은 선택 범위만 만든다.
실험 범위는 500회차, 회차당 120,000자/10,000문단, 총 2천만 자다. 분석 기록은 계정당 512MiB,
개별 기록 16MiB 제한이며 가득 차면 기존 기록을 지우지 않고 중단한다. 개별 작업의 “음성만 삭제”는
음성 파일·작업만 삭제하고 마지막 작업을 지워도 화자 분석 기록을 보존한다. 기존 정식 라벨/Character Graph/사용자 교정 데이터에는 덮어쓰지 않는다.

작품의 “초기화·삭제”에서는 세 항목을 독립적으로 고른다. 처음에는 아무것도 선택하지 않는다.

- 만든 음성·생성 작업: 해당 작품의 `saved_audiobooks`와 파일(일반 미리 만들기 포함).
- 인물 목소리 배정·생성 설정: 모든 분석 키의 직접 지정 포함 배정과 작품 생성 선호값. 분석 모델 선택은 보존한다.
- 화자 분석 기록: 작품의 화자 찾기·인물 연결 캐시. 본문·연결·계정 목소리 보관함은 항상 유지한다.

서버 미리보기는 대상 수·용량·차단 이유와 fingerprint를 반환하고 실행 시 같은 스냅샷과 명시적 확인을 검증한다.
진행 중이거나 삭제 중인 작업이 있으면 실행하지 않는다. 분석이 덜 끝난 작업을 남기는 분석 삭제는 막고
음성·작업도 함께 선택하도록 안내한다. 완료 음성은 분석만 삭제해도 재생할 수 있다.
파일 삭제는 durable deleting 상태로 먼저 기록해 중단 후 기존 worker가 마무리한다.
초기화의 서버 전용 generationEpoch는 새 생성의 중복 판정에만 반영하고 분석 키에는 넣지 않는다.
따라서 설정만 초기화해도 이전 완료 작업을 돌려주지 않으며, 같은 본문·분석 모델의 완료 분석은 재사용한다.
이전 세대의 생성 계획은 저장 시 거절하고 다시 확인받는다. “AI가 골라 배정”의 기존 배정 유지 규칙은 그대로다.

음성 생성/저장/듣기는 기존 `AudiobookService`와 `PreparedNarration`을 쓴다. 회차 분석이 끝나면
원문 해시·UTF-16 범위가 검증된 화자 구간을 추가한다. 다음 회차 분석/배정을 기다리는 동안 이미
확정된 구간의 음성을 별도로 생성한다. 음성은 제공자의 기존 동시 처리 한도(1~2개)를 지키며,
새 목소리 제작이 남았거나 필요한 연기 태그가 없는 구간은 생성하지 않는다. 요청 묶기는 계속 선택 기능이다.
분석과 음성 중 한쪽에서 실패하면 새 요청을 중단하고 이미 보낸 양쪽 요청이 정리된 뒤 상태를 확정한다.
그동안 전체 runner 잠금을 유지하므로 다른 runner의 중복 실행을 막는다. 완료한 분석 응답과 음성은 보존한다.
분석 제공자의 HTTP 504와 BOAA 자체 10분 제한을 구분해 안내하며, 429 대기에는 실제 분석 단계 이름을 쓴다.
분석 엔진의 병렬 수와 TTS 동시 수는 별도 예산이다. DB 연결은 운영의 10개 풀에서 session fence와 쿼리 여유를 확보한다.
준비된 회차의 '본문에서 듣기'는 별도 플레이어 없이 기존 TTS 큐·본문 강조·회차 이동을 사용한다.
‘들을 수 있는 회차’는 해당 회차의 모든 저장 구간이 ready일 때만 포함한다. 일부 문장만 완성된 회차는 제외한다.
자동 연결은 같은 내레이터의 해당 회차 전체 음성이 준비된 작업을 우선하며, 사용자가 작업 ID를 직접 고르면 다른 작업으로 바꾸지 않는다.
목소리 제작·연기 분석이 덜 끝난 회차는 재생 시작 전에 425 준비 대기로 알린다. 오래된 재생 계획에서 개별 구간을 요청해도
같은 425를 반환하며, 이 대기 때문에 생성 작업을 failed로 바꾸거나 새 유료 요청을 보내지 않는다.
일반 서버 목소리로 듣기도 같은 내레이터 ID의 최신 준비 작업을 찾는다. 아직 화자 분석이 안 된
회차는 준비 중이라고 알리며 일반 목소리로 몰래 생성하지 않는다. 기존 실시간 화자 모드의
정식 라벨 저장소와는 별도이고, 준비 작업을 선택해서 듣는 동안에는 준비된 큐가 우선한다.
확실하지 않은 화자는 내레이터로 읽으며, 문장 누락 없이 모든 원문 구간을 유지한다.

준비 음성의 재생 시작은 실제 오디오 콜백으로 확인한다. 같은 세션에서도 이전 구간의 늦은 완료·
재개 응답은 다음 구간의 재생 상태를 바꾸지 않는다. 브라우저가 종료 이벤트를 누락하거나 재생을
멈추면 현재 시간·종료 상태를 확인하고, 15초간 진행이 없을 때 최대 두 번 같은 음성의 재생을
재개한다. 계속 정체되면 명시적인 실패로 끝낸다. 사용자가 일시정지한 음성은 자동 재개하지 않는다.
준비 완료 후 일시정지는 로딩과 구별하여 현재 음성 재생성 버튼을 사용할 수 있다.
위치 저장은 순서를 유지하며 최신 대기 위치만 남기는 별도 큐에서 처리하므로 저장 지연이 재생을
막지 않는다. 이미 생성된 음성 GET의 공유 대기는 45초까지 유지하고 실패한 대기는 다시 읽을 수
있다. 이 제한으로 유료 합성 POST를 다시 보내지 않는다. reader JSON은 본문까지 30초, resolve는
본문까지 150초로 제한한다. Android의 실제 백그라운드 정책은 모의 이벤트 검사와 구별해 검증한다.

실행: 기존 compose 명령에 `-f compose.speaker-engine.yaml`을 추가하고 해당 서비스만 시작한다.
`SPEAKER_ENGINE_TOKEN`은 24자 이상의 무작위 값으로 설정한다. 듣기 → 화자별 미리 생성하기 →
연결 관리에서 별도의 모델 API 주소/모델 ID/키를 입력한다. 기본 분석 서비스 주소
`http://speaker-engine:8095`는 API/worker에 전달된 배포 토큰으로 자동 인증하므로 서비스 토큰 칸을
비워 둔다. 다른 주소에는 배포 토큰을 보내지 않으며 별도의 서비스 토큰을 입력한다.
로컬 모델은 API 키 없이도 사용할 수 있다. 호스트 실행은
`node apps/speaker-engine/build.mjs` 후 `SPEAKER_ENGINE_TOKEN=… node apps/speaker-engine/dist/index.mjs`다.
서비스는 내부 포트만 열고 원문·모델 응답을 오류나 로그에 넣지 않는다. 기본 compose/TTS는 바꾸지 않는다.

검증은 원문 위치를 포함한 실제 코어 단계, 모의 모델 응답과 격리 PostgreSQL 작업 큐, UI 동작을
분리해 수행한다. 실제 모델별 화자 판정 품질은 별도의 사용자가 선택한 작품/모델 실험이 필요하다.

#### 목소리 보관함과 인물 자동 배정

화자별 작업 목록은 음성 구간 수가 아직 정해지지 않은 분석 단계에서 `0/0 구간`을 표시하지 않는다.
목록 API는 문맥용 앞 회차를 포함한 분석 대상 수, 현재 분석 회차와 제목, 계획 완료 여부와 지속된
`retry_at`을 반환한다. 화면은 회차 분석 진행과 이미 계획된 음성의 생성 진행을 구별하고, 429 대기에는
회전 표시 대신 자동 재시도 시각을 보여 준다. 진행 중인 모델 요청의 내부 진행률은 추정하지 않는다.
이 상태 조회와 표시 변경은 기존 분석 체크포인트·배정·생성 요청을 바꾸지 않는다.

분석 연결의 고급 설정은 전체 분석 모델 요청 수(1~~8, 기본 1)와 429 추가 재시도
횟수(0~~100, 미지정 시 계속 재시도)를 제공한다. 화자 찾기(A)는 정해진 회차 묶음 안에서 병렬로
실행한다. 현재 회차의 A가 끝나면 비워진 자리를 인물 연결(B)이 즉시 사용하며, 뒤 회차의 A가
끝나기를 기다리지 않는다. 새 A를 보충해 B의 자리를 차지하지 않으며, 전체 A+B 요청 수는 설정을
넘지 않는다. B의 이전 회차 ledger는 회차 순서대로만 갱신한다. 이전 회차 음성 합성 대기도 다음
인물 연결을 막지 않는다. 묶음 안의 모든 요청이 종료되고 응답이 저장된 뒤에만 작업 잠금을 해제한다. 성공한 형제 요청의 응답은 다른 요청의 실패·중지에도 권한/본문/연결 revision 확인 후 보존한다.
429 뒤 첫 재시도는 하나만 보내며 지수 대기와 Retry-After를 지킨다. 횟수를 소진하면 기록을 남기고
명시적 이어 만들기를 기다린다. 타임아웃·불명확한 실패는 자동 재시도 대상이 아니다.
화자 찾기·인물 연결의 모델 요청은 발송 시점부터 최대 10분을 기다린다. 분석 엔진의 프로토콜 호출
시간 제한과 분리하며, 중단 신호는 즉시 전달한다. 시간 초과는 해당 분석 단계의 오류로 표시한다.
이 실행 설정은 분석 의미 revision에서 제외하여 변경만으로 기존 분석·배정·음성을 폐기하지 않는다.
내부 엔진의 `attributionPreparation` 기능이 없는 연결은 동시 처리 수 1로 계속 사용할 수 있다.
직렬 A를 이미 시작한 회차는 그대로 이어 처리하며, 병렬 A 캐시는 같은 작품의 다른 음성 작업에서도 재사용한다.

`0069_voice_library.sql`은 계정의 목소리 보관함, 작품의 인물 배정, 제작 요청 체크포인트를 저장한다.
보관함의 ID·제공자 음성 ID·합성 모델은 별칭·음색·설명·언어·자동 배정 사용 여부와 분리한다.
표시 정보 수정은 합성 revision이나 이미 만든 음성을 무효화하지 않는다. 로컬/OpenAI 호환 TTS도
기존 목소리 목록에서 보관함에 추가할 수 있다. 목록에 없는 제공자 음성 ID를 임의로 합성하지 않는다.
미등록 목록과 설명 추가 화면에서도 저장하기 전에 목소리를 미리 들을 수 있다. 이때 기존
`/tts/plain/sample`을 사용하며, 저장된 보관함 목소리는 기존 보관함 샘플 경로를 유지한다.
이미 있는 목소리를 다시 추가해서 사용자의 설명을 덮어쓰지 않는다. 보관함에서 수정하거나,
아직 보관하지 않은 목소리의 ‘라벨 달기’를 사용한다. 음높이·질감·성별 느낌·나이 느낌 등의
선택 칩은 사람이 작성하는 음색 설명을 돕는 기능이며 합성 설정으로 자동 전송하지 않는다.

멈춤·실패·완료한 작업의 ‘목소리 바꾸기’는 그 작업에 저장된 화자·원문 해시·범위를 복사해
새 음성 작업을 만든다. 기존 목록에서 목소리만 바꾸면 분석(A/B)과 배정 AI 모델을 다시 호출하지 않는다.
기존 음성은 보존하며 작품 기본 배정 반영 여부는 사용자가 선택한다. 일부만 계획된 작업은 이미 계획된 회차·구간만 포함한다. 본문·소유권·원래 작업
상태를 저장 직전에 다시 확인하며 같은 요청의 지문은 같은 작업으로 합쳐진다. 새 작업 ID가 이전
브라우저 오디오와 구별되고, 변경하지 않은 단일 구간의 합성 캐시 키는 유지한다. 새로 묶은 구간은
원문 위치와 구성 구간을 포함한 별도 합성 키를 사용한다.
연기 지시는 선택용 보관함 설명과 별도이며 최대 2,000자다. Gemini/Vertex/Google Cloud와 지원되는
OpenAI 합성 어댑터의 capability가 있을 때만 입력하고 합성에 전달한다. 지원 여부를 알 수 없는
로컬·호환 연결에는 임의로 보내지 않는다. 기본 목소리는 계속 명시적으로 선택한다. 연기 지시는
목소리 복제 기능이 아니며, 변경 시 해당 구간의 합성 키가 바뀐다. 연출을 보존하거나 끄는 새 작업은 음성 합성 비용만 확인하며, 분석 연결이 사라져도 이미 계획된 구간을 다시 만들거나 이어 만들 수 있다. 빠진 연출을 분석하는 옵션은 별도의 분석 비용을 함께 확인한다.
Gemini 3.8 Flash/Flash-Lite TTS의 자연어 연기 지시는 본문과 분리한 `speech_metadata.style`로 전달한다.
성별·나이·고유 음색은 기존 목소리 선택이나 Voice design에서 정하고, 연기에는 짧은 감정·속도·말투를 적는다.
보관함의 인물 설명을 긴 합성 지시로 복사하거나, 본문 대사를 임의로 바꾸지 않는다.
전용 입력 도움은 해당 모델과 합성 지시 capability가 확인된 경우에만 표시한다.
[Gemini 공식 프롬프트 안내](https://ai.google.dev/gemini-api/docs/speech-generation#prompting-guide)를 따른다.

자동 연기는 지원 목소리를 고른 새 작업에서 기본으로 켜지며 사용자가 끄면 계정·작품 설정에
명시적 `false`를 저장한다. 이전 설정의 미지정 값은 지원 여부에 따른 기본값이고, 기존 생성 작업은
바꾸지 않는다. 확인된 Gemini/Vertex/Google Cloud 어댑터와 정확한 `gemini-3.8-flash-tts`,
`gemini-3.8-flash-lite-tts` 모델에만 `autoActingSupported`를 제공한다. 일반 지시를 지원하는 다른
TTS나 모델 ID만 같은 사용자 지정 연결에는 자동 연기를 켜지 않는다.

배정 AI 모델은 계속 쓸 음색·인물 설명과 선택적 Voice design을 담당한다. 화자 찾기(A)는
`performanceAnnotations`를 지원할 때 같은 응답에 구간별 감정·말투·속도·강도의 제한된 태그를
추가한다. 불확실한 발화와 내레이션은 중립적으로 처리한다. 인물 연결(B)의 순서·우선순위와
원문 위치는 유지하며, 태그를 켰다는 이유로 기존 A/B 분석 키를 바꾸지 않는다. 태그 없는 이전
분석을 재사용하면 B가 모두 완료된 뒤 같은 회차의 연출 정보만 함께 보충한다.
남은 대상이 120개 미만이면 한 요청, 120개 이상이면 100개씩 처리하고 남은 대상에 같은 기준을 적용한다.
연기 판단은 장면의 전후 발화와 서술을 함께 읽고, 속마음·다른 인물의 감정과 실제 발성을 구분한다.
감정만으로 울음·고함·느린 말하기를 추정하지 않으며 말투·속도는 명확한 근거가 있을 때만 바꾼다.
기본 강도는 subtle이다. 별도 모델 호출을 추가하지 않고 A와 보충 경로에서 같은 기준을 사용한다.

‘목소리 바꾸기’는 기존 태그 보존, 빠진 태그만 분석, 자동 연기 제거를 구분한다. 보충은
기존 구간의 화자·범위를 그대로 두며 A/B·배정 AI 모델을 호출하지 않는다. 분석 연결은
실제 빠진 태그가 있을 때만 필요하고, 고정한 연결 revision·본문·소유권을 응답 저장 시 재확인한다.
보충 요청에는 현재 회차 본문 전체를 문단 ID와 함께 한 번만 넣는다. 대상에는 확정 화자,
원문 문단·오프셋, 실제 읽을 텍스트를 보낸다. 대상마다 주변 문맥을 반복하지 않으며 다른 회차를 섞지 않는다.
분할 요청에서도 회차 전체 문맥은 유지한다. 요청 횟수는 줄일 수 있지만, 긴 회차에서 대상이 적으면
이전의 짧은 발췌 방식보다 입력 토큰이 늘 수 있다. 보충 응답 키에는 전체 문맥을 포함한다.
응답과 요청 중 상태는 작업의 `speaker_voice_decisions`에 보존한다. 429만 설정한 횟수로 자동
재시도하고 모호한 실패는 명시적 이어 만들기를 기다린다. 태그가 준비되기 전에는 합성하지 않는다.

수동 인물별 연기 지시는 생성 태그보다 우선한다. 태그는 합성 직전에 짧은 자연어로 변환하고
본문에 삽입하지 않는다. 캐시 키는 실제로 전달하는 지시를 기준으로 하므로 중립 태그나 수동
지시가 우선한 경우의 불필요한 재합성을 줄인다. 이 구조의 검증은 모의 모델 응답을 사용하며,
실제 모델이 감정을 얼마나 적절히 읽고 연기하는지는 별도의 청취 평가가 필요하다.
자동 연기 속도 지시는 slightly slower/faster로 제한하고, 감정·발성만 바꾸는 경우에는
normal conversational pace를 명시한다. 완전 중립은 계속 지시를 생략한다.
새 기준은 새로 분석하거나 합성할 때 적용하며, 저장된 태그와 완성 음성을 일괄 변경하지 않는다.

문장 묶기는 기본 OFF인 `batchAudio` 선택 기능이다. 새 생성 선호값이 없거나 요청 필드가 빠지면 묶지 않는다.
Gemini 3.8 Flash/Flash-Lite의 새 생성 계획과 ‘목소리 바꾸기’ 계획에서 사용자가 켰을 때 이어지는 동일 인물·목소리·모델·언어·연기 지시를
최대 700자/16개 원문 구간으로 묶는다. 화자, 모델, 수동 지시 또는 장면 연기가 달라지면 분리한다.
빠진 연기 태그를 분석할 인물 구간은 합치지 않으며, 내레이터의 빠진 태그는 신규 생성과 같은 중립값을 사용한다.
각 구성 구간의 문단 해시·위치·낭독 해시를 보존하고 합성/다시 만들기 때 모두 검증한다. 묶음 안의 문단 이동은
기존 글자 수 기반 추정 위치를 사용하며 제공자의 정확한 단어 타임스탬프가 아니다. 이미 저장되거나 진행 중인
작업의 구간 번호·파일을 재편하지 않는다. 기존 작업에서 ‘목소리 바꾸기’로 만드는 새 계획에도 켰을 때만 적용한다. 묶기 설정만 변경해도 새 작업을 만들 수 있고,
원본의 묶음 여부는 `SpeakerRevoiceSource.batched`로 알린다. 기존 묶음을 끄면 원래 개별 구간으로 풀어 새로 만든다.
요청 수 감소는 본문 합성에 적용하며 목소리 제작 API의 별도 한도까지 해소하지 않는다.
Google 429의 `Retry-After`와 제한된 크기의 `google.rpc.RetryInfo.retryDelay` 중 더 긴 대기시간을 지키고,
오류 원문/프로젝트 정보는 보관하지 않는다. 목소리 배정·목소리 제작·연기 분석 대기는 단계별 문구로 표시한다.
Vertex 오류가 `aiplatform.googleapis.com/voice_creations` 한도 0을 명시한 경우에는 자동 재시도를 멈추고
프로젝트 제작 한도/이용 권한 확인을 안내한다. 단순한 429만으로 한도가 0이라고 판단하지 않는다.

듣기 → 화자별 미리 생성하기에서 ‘목소리 보관함’과 ‘배정 AI 모델’을 관리한다.
분석용/선정용 연결은 같은 암호화된 연결 관리 화면을 사용하지만 선택과 revision은 독립적이다.
기본값은 별도 모델 비용 없는 결정적 배정이며, 선정 모델을 고르면 새 인물 최대 8명씩 원문 대사와
주변 문장, 사용자가 고른 목소리의 음색·설명을 보내 제한된 ID 목록에서 고르게 한다.
정체가 불확실한 인물은 내레이터, 엑스트라는 기존 목소리를 사용한다. 기본 후보는 내레이터와 같은
제공자의 활성 보관함 목소리를 우선하며 최대 32개다. 목소리가 하나뿐인 연결도 사용할 수 있다.
보관함 설명이 없을 때 Gemini 기본 목소리는 공식 목록의 음색 특성을 사용하며, 이름으로 성별이나
나이를 추정하지 않는다. 이 표시 메타데이터는 기존 합성 설정과 캐시 키를 바꾸지 않는다.

인물 배정은 계정·작품·분석 identity namespace에 귀속된다. 같은 분석을 재사용하는 다음 회차나
새 생성 작업에서는 선정 요청 없이 기존 배정을 쓴다. 분석 모델/본문 변경으로 identity namespace가
바뀌면 같은 인물 ID 문자열을 임의로 연결하지 않는다. 생성 작업을 멈추고 ‘작품 기본 목소리’를 열어
작업에서 확인한 합성 모델 안에서 수정할 수 있다. 수정은 다음에 계획할 회차와 새 작업부터 적용되며
이미 계획/생성된 구간은 바꾸지 않는다. 다른 합성 모델의 고정 배정을 새 작업에 몰래 가져오지 않는다.

신규 생성은 ‘순서대로 배정 / AI가 골라 배정 / 인물마다 새 목소리’를 구분한다. 새 목소리 제작은 실제로 선택한 내레이터의
TTS 모델이 정확히 `gemini-3.8-flash-tts`이고 같은 연결에 제작 기능이 있을 때만 노출한다.
Flash 연결이 등록되어 있기만 해서는 활성화하지 않는다. 제작 연결은 선택한 내레이터의 연결로
맞추며 Flash-Lite/다른 TTS에서는 새 제작 옵션을 숨긴다. 지원하지 않는 모델로 이전 제작 설정을
복원한 경우 시작을 막고 사용자가 방법을 바꾸게 한다. 서버도 새 제작 요청의 모델·연결 일치를 검증한다.

선정 모델은 대사와 인접 지문을 읽고 성별·대략적인 생애 단계·음색·평소 말투를 정한다.
지문, 대명사, 호칭과 인물 관계를 통한 문맥 추론을 허용하며, 판단 가능한 성별을 무조건 중립으로
처리하지 않는다. 이름/직업의 고정관념이나 말하는 사람이 부르는 상대의 호칭을 자기 성별 근거로
쓰지 않는다. 나이·성별을 모른다는 이유로 확인된 인물을 엑스트라로 낮추지 않는다. 장면 감정은 별도다.
표시 설명은 성별·대략적인 연령대·평소 목소리/말투 특성만 짧게 적도록 요청한다. 모르는 특성은 생략하고
‘성별/연령을 특정하지 않는다’는 해설, 현재 장면/대사 요약, 배정 이유를 쓰지 않는다. 제작 프롬프트도 같은
기본 특성을 짧게 사용한다. 이미 저장된 배정 설명과 유료 선정 응답은 재작성하지 않는다.
UI는 설명을 ‘인물 특징’으로 표시하고 긴 기존 설명은 접어 보여 주며 장면별 연기와 구분한다.
새 작업의 자동 제작은 주요·조연이 대상이며 작업당 1–8개 한도, 수동 고정/이미 제작한 작품 배정
재사용과 기존 자동 기본 음성 교체를 유지한다. 사용자가 음성 이름이나 라벨을 수동 작성할 필요는 없다.
묶음별 배정·모델을 저장하여 중단이나 8명 초과 인물에서도 완료한 배정을 반복하지 않는다.

‘목소리 바꾸기’는 인물별로 유지·다른 목소리 선택·새 제작을 명시한다.
기존 목소리를 고를 때 인물 행에서 짧은 예문을 미리 들을 수 있다. 재생 버튼을 눌렀을 때만 기존
`/tts/plain/sample` 경로를 호출하며 보관함 등록이나 작품 기본 배정을 쓰지 않는다. 같은 목소리와 모델의
샘플은 화면 세션에서 재사용한다. 다른 미리듣기·선택 변경·닫기는 이전 재생/대기를 중단하고 늦은 응답을 무시한다.
미리듣기 전 본문 낭독을 멈추며, 아직 제작하지 않은 새 목소리를 기존 목소리로 대신 미리 들려주지 않는다.
`designSpeakerIds`는 중복 없는 내레이터 외 인물 1–8명이고 제작 예산은 그 수로 고정한다.
지정한 인물은 기존 고정·기존 제작 음성·주요/조연/엑스트라 분류와 관계없이 새 제작이 필수다.
제작 실패나 잘못된 선정 응답은 오류로 멈추며 기존/후보 음성으로 조용히 대체하지 않는다.
목록에 없는 인물은 요청에 명시한 목소리를 사용한다. 대사만 있는 작업은 `narratorVoiceId`로
원래 내레이터 모델을 판정하고 존재하지 않는 내레이터 구간을 만들지 않는다. 명시한 새 제작 대상은 옛 음성이 삭제됐어도
내레이터 Flash 연결로 검증하고, 연기/말투 지시 지원 여부도 새 모델 기준으로 확인한다.
기존 클라이언트의 명시 목록 없는 자동 재제작 요청은 고정/수동 변경 인물 제외와 예산 fallback을 유지한다.

다시 만들기는 저장된 원문 구간만 사용하며 A/B를 재호출하지 않는다. 새 작업을 만들어 원래 오디오와
분석을 보존한다. `applyToBook`을 켜면 직접 바꾼 인물은 작업 생성 트랜잭션에서, 새 제작 인물은
제작 결과 채택 트랜잭션에서 작품의 기본 인물 배정을 갱신하고 고정한다. 내레이터 및 변경하지 않은
인물은 쓰지 않는다. 같은 분석 identity namespace의 향후 회차/새 작업에 적용하며 기존 계획 구간과
원본 작업을 덮어쓰지 않는다. 늦게 끝난 제작이 그 사이의 새로운 수동 배정을 덮어쓰지 않도록
배정 버전을 비교한다. 토글을 끄면 작품 기본 배정은 유지한다. 일부 제작만 끝난 뒤 실패할 경우
성공 확정된 인물의 배정만 반영될 수 있다. 선정/제작 비용과 정확한 대상 수는 시작 전 확인에 포함한다.

Gemini API는 Voices `POST /v1beta/voices`를 사용한다. Vertex는 global 위치의
`POST /v1beta1/projects/PROJECT/locations/global/voices`에 OAuth로 인증하고 `store:true`,
`VOICE_TYPE_PROMPTED`, 자연어 설명을 보내며 `voice.model`은 생략한다. 제공자가 반환한
`voice_…` ID를 보관함과 후속 합성에 사용한다. 24kHz mono PCM 샘플은 WAV로 변환한다.
참조 음성 복제나 임의 호환 서버의 제작 API를 가정하지 않는다.
[Vertex 공식 Voice design 계약](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/voice-design)을 따른다.

보관함은 256개·샘플 합계 64MiB, 개별 샘플 4MiB, 동시 제작 2건으로 제한한다. 제작 응답은 읽는 중
6MiB에서 차단한다. 목소리 제작/선정은 확인한 API 비용에 포함되고, 문맥만 분석하는 앞 회차에는
목소리를 만들지 않는다. 같은 제작 요청 ID는 저장 결과를 재사용한다. 429는 재시도 가능 상태로 남고
일반 생성 큐의 지속 대기를 따른다. 응답 여부가 불확실한 요청은 자동 재전송하지 않는다. 생성 작업의
명시적 ‘이어 만들기’에서만 재시도를 허용한다. 완성된 제작 결과가 일부만 있는 작업은 그 결과부터
재사용한다. 결과 저장 직전에 계정/작품/모델 권한을 다시 확인한다.

보관함의 샘플과 메타데이터는 인증된 계정 API로만 전달하고 공개 정적 경로에 쓰지 않는다.
보관함에서 제거해도 제공자의 원격 음성이나 기존 오디오는 삭제하지 않으며, 작품에서 사용하는
배정은 제거 전에 정리해야 한다. Google의 저장 음성은 제공자 quota/만료 정책의 영향을 받으므로
BOAA에 음성 ID가 남아 있다는 사실만으로 원격 영구 보관을 보장하지 않는다.
계약 참고: [Voice design](https://ai.google.dev/gemini-api/docs/voice-design),
[Voices API](https://ai.google.dev/api/voices).
