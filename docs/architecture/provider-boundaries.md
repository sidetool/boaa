# Provider Boundaries

## 일반 서버 TTS 재생·캐시 계약

2026-10-26 코드 대조. 아래 일반 낭독 계약은 뒤의 화자별 합성·native 경로와 구분한다.

- 묶음 크기는 200–2000자, 기본 700자이며 최대 16문단을 사용한다. 본문·회차·계정 검증을 거친 같은 합성 조건만 재사용한다.
- 일반 서버 합성 속도는 1배다. 재생 배속·음량 변경은 같은 오디오에 적용하며 다시 합성하지 않는다. 화면의 문단 위치는 길이 비율 추정이며 정확한 오디오 타임스탬프가 아니다.
- 읽기 세션의 메모리 캐시는 기본 8개/32MiB다. 같은 진행 중 요청은 공유하고 재생 취소는 대기자를 분리한다. 계정·runtime·본문 수명 종료 시 요청과 캐시를 정리한다.
- 재생기의 명시적 새로고침은 원래 묶음 시작에서 `regenerate: true`로 요청한다. 해당 항목의 브라우저·서버 메모리·영구 캐시를 교체하고 제공자 비용이 새로 발생할 수 있다. 늦은 이전 준비 결과는 새 음성을 덮지 않는다.
- 실패 후 재시작 위치는 추정 표시 문단이 아니라 실제 묶음 시작이다. 본문의 문단을 얻지 못하면 회차 완료로 건너뛰지 않는다.
- Gemini Vertex는 선택한 candidate의 오디오 part를 합치고 정상 완료·오디오 형식을 확인한다. 형식 검증과 정상 완료 표시는 원문을 의미적으로 모두 발화했다는 보장은 아니다.

실행 코드는 `src/features/tts/usePlainTTS.ts`, `src/providers/plain-tts*.ts`,
`src/providers/browser-audio-session.ts`, `apps/server/src/routes/ai/plain-tts-routes.ts`와
`apps/server/src/providers/`에 있다. 회귀 검증은 해당 모듈의 행동 테스트를 따른다.

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
- API 프로세스가 하나씩 생성한다. PostgreSQL advisory lock으로 다중 프로세스의 중복 실행을 막고,
  관리형 업데이트의 활동 집계에도 포함한다. 유지보수 lease 중에는 새 단위를 시작하지 않는다.
- 중단은 진행 중인 한 단위가 끝난 뒤 적용한다. 앱을 닫아도 서버 작업은 계속한다. 서버 프로세스가
  사라진 뒤에는 진행 중이던 작업을 일시정지한다. 완료 여부를 모르는 유료 요청은 자동 재전송하지 않는다.
  명시적 `resume`은 완료한 파일을 재사용하고 미완료 단위만 재개한다. 429는 실패로 끝내지 않고
  `retry_at`과 누적 횟수를 DB에 저장해 대기열로 돌린다. 지수 대기는 10초부터 최대 5분이며,
  제공자의 더 긴 Retry-After도 최대 하루까지 지킨다. 대기 중에는 runner lock/DB 연결을 잡지 않는다.
  중단하면 자동 재시도도 멈추며, 성공한 단위 다음에는 대기를 초기화한다. 일부 조각을 이미 생성한
  연결형 TTS의 후속 429는 전체 재전송에 따른 중복 비용을 막기 위해 자동 재시도하지 않는다.
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
