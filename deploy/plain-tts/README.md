# Basic Korean narration

The optional `compose.plain-tts.yaml` service runs Supertonic 3 on CPU. It provides
ten Korean voices independently of character analysis, voice approval and AI jobs.
In the reader select **TTS → 기본 목소리 → 서버 음성**, choose a voice and preview it.
Selection is saved as the default, or as a book override when explicitly enabled.
External providers share their connection settings with ordinary listening; character analysis and cast approval are not prerequisites.

```sh
docker compose -f compose.yaml -f compose.plain-tts.yaml up -d --build plain-tts api
```

Initial startup downloads the pinned 401 MB model bundle into `plain-tts-models`.
Later starts verify the stored files and load without another download. Model
weights are not included in the application image or exposed as static files.
The inference port is internal only. The service uses four CPU threads and has a
1.5 GiB memory limit. The API and model revisions must match.

`model-manifest.json` is the supported bundle registry: source revision, required
files, sizes and SHA-256. `install.py --directory /models --archive /uploads/model.zip`
also installs an uploaded/local ZIP without network access. The ZIP must contain
exactly these paths at its root. It rejects extra/duplicate files, symlinks,
incorrect sizes and hashes; installation becomes visible only after validation.
Mount the uploaded ZIP read-only when invoking the installer in the container.
This initial release supports this pinned Supertonic 3 bundle, not arbitrary
ONNX/PTH models or Samsung Android voice packages. A browser model-upload UI is
not included; the default model does not require the user to obtain files.

The API validates ownership, current content revision, paragraph hash and the
shared spoken-text projection before synthesis. A second source check prevents
returning audio after a concurrent edit or deletion. Short chunks are synthesized
directly; two upcoming chunks are prefetched. The server keeps a bounded 64 MiB
memory cache and merges duplicate requests. API restart drops audio caches; model
files persist. This basic server mode requires a connection; offline downloads
and whole-book preparation currently belong to the existing cast pipeline.
Device narration remains usable independently of server availability. A failed
server voice stops with an error rather than silently changing the voice.

Runtime source: `helper.py` is unchanged from
[`supertone-oss-archive/supertonic` at `1e9799e964ea4c0dad7cde993b65c3c813a7b373`](https://github.com/supertone-oss-archive/supertonic/tree/1e9799e964ea4c0dad7cde993b65c3c813a7b373/py),
under `LICENSE.upstream`. The model bundle retains its own LICENSE. The upstream
repository is archived; source and model revisions are deliberately pinned.

## External engines in ordinary listening

Open **듣기 → TTS 엔진 연결**, save the key/endpoint and model, enable the provider,
then return and select its voice. All ten Supertonic voices remain available. Gemini's featured voices and
OpenAI built-in voices are listed; a custom voice ID can also be supplied in the provider `voice` option.
ElevenLabs lists account voices. Gemini API defaults to `gemini-3.8-flash-lite-tts`; explicitly saved older
models are preserved. Its 3.8 adapter separates delivery metadata from the verbatim text and handles WAV/PCM.
Gemini Vertex also defaults to `gemini-3.8-flash-lite-tts`; Google Cloud Text-to-Speech keeps its existing default. No analysis jobs or speaker separation are started.

Use either optional Compose overlay, not both. `compose.local-tts.yaml` now uses this same lightweight runtime
and preserves the old `local-tts-models` volume. Remove old Melo model/voice overrides when migrating.

For another internal engine, use `local-endpoint` and allow only its hostname with `LOCAL_TTS_ALLOWED_HOSTS`.
BOAA endpoints accept `{modelId,text,voiceId,speed,format,...}` at `/synthesize` and return audio bytes
or `{audioBase64,contentType}`. `/voices` returns `{voices:[{id,label,lang}]}`.
An endpoint whose path ends in `/audio/speech` automatically receives the OpenAI-compatible
`{model,input,voice,speed,response_format}` payload. Discovery tries sibling `/audio/voices`, then `/voices`;
string arrays and `{voices:[...]}` are accepted. A configured `voice` is used when discovery returns 404/405.
Other network failures remain errors. Endpoints still pass through the existing hostname/DNS/redirect policy.
For an authenticated OpenAI-compatible service use the OpenAI provider with its API key, base URL and custom voice option.

API keys remain on the server. Paid engines are identified before preview/playback. The default engine being
unavailable never silently selects another engine. The bounded cache reduces identical repeat calls but is not
persistent; replay after restart may incur charges. The two-chunk lookahead can generate a little audio beyond
where playback stops. Multi-account v1 retains administrator-only server providers; members use device voices.

## Google Cloud service-account JSON (hosted TTS)

In **듣기 → TTS 엔진 연결**, choose **Gemini Vertex TTS** (Google's current documentation
calls the platform Gemini Enterprise Agent Platform) or **Google Cloud TTS**, and upload a
Google-generated service-account JSON key. This upload option is for hosted TTS; desktop
and labeling-provider credential configuration are unchanged.

The target project needs billing, its relevant API enabled, and the service account's permission
to invoke the chosen model. For Gemini 3.8 Flash-Lite speech, use the Vertex entry with
`gemini-3.8-flash-lite-tts` and location `global`. The separate Google Cloud TTS entry uses
Cloud Text-to-Speech's `text:synthesize` API and its supported model identifiers.
Project ID defaults to the uploaded JSON's `project_id`; a provider `project` option can override it.
Select/enable the engine and save its model/options, then choose its voice in ordinary listening.
Speaker separation and analysis jobs are not required. Preview and playback may incur Google charges.

Keys are encrypted in the server provider-secret store and never returned to the browser.
The upload accepts only `type: service_account`, a valid RSA private key, and Google OAuth endpoints,
up to 64 KiB. External-account/executable ADC JSON is not an upload format.
The uploaded key takes precedence over an older credential path/token/environment setting for that
engine; deleting it restores the old authentication configuration, if any. Key rotation consists of
uploading the new key, testing playback, then revoking the old key in Google Cloud.
The settings check confirms storage/configuration only; it does not prove API/IAM access.
Existing mounted credential files continue to work and are passed per client, without changing
process-wide authentication. JSON uploads do not require a schema migration or an extra runtime.

References: [Gemini TTS](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/overview),
[Cloud TTS authentication](https://docs.cloud.google.com/text-to-speech/docs/authentication).


### 연속 듣기 합성 단위와 요청 제한

기본은 문장 단위입니다. 듣기 → 세부 청취 설정 → 읽는 방식 → 합성 단위에서 문단 또는 묶음을 선택할 수 있습니다. 묶음은 같은 회차에서 순서대로 이어지는 짧은 문단을 최대 700 Unicode code points/16문단까지 함께 합성합니다. 긴 첫 문단은 기존 문단 분할을 사용합니다. 화 끝 각주처럼 원문 순서가 바뀌는 경계는 넘지 않습니다. 묶음 내부의 정확한 음성 타임스탬프가 없으므로 위치 표시·재시작은 묶음 시작 문단 기준이고, 내부 문장·문단 쉬는 간격은 적용하지 않습니다.

다음 음성 미리받기는 하나로 제한합니다. 공급자 429는 API 인스턴스의 엔진별 cooldown으로 공유하고 10/20/40초 간격으로 늦춥니다. 현재 재생 요청은 서버가 알려 준 대기 시간 후 최대 3회 재시도하며 중지 시 예약도 취소합니다. 시간 초과 등 합성 성공 여부가 모호한 오류는 과금 중복을 피하려 자동 재시도하지 않습니다. 엔진 자동 전환은 하지 않습니다. 이 처리는 공급자 할당량이나 공급자 장애 자체를 없애지는 않습니다.

생성 음성은 SERVER_DATA_DIR/plain-tts-audio 아래 비공개 파일(0600)로 재사용합니다. 원문·계정·본문 버전·엔진 설정/비밀키 revision·목소리·속도에 묶인 해시 키를 사용하고, 캐시를 반환하기 전 원문 소유권/버전을 재확인합니다. 기본 상한은 256MiB/128개이며 7일 동안 쓰이지 않은 항목은 읽기/쓰기 시 정리합니다. 파일 캐시 실패는 낭독을 막지 않습니다. 캐시는 다시 만들 수 있는 데이터이며 서버 데이터 백업에는 포함될 수 있습니다.

### 낭독 문자 필터

듣기 → 발음·문자 필터에서 단어를 그대로 교체하거나 정규식 교체를 추가할 수 있습니다. 재생 중에는 발음 고치기로 들어갈 수 있습니다. 원문은 변경하지 않으며 현재 작품 또는 모든 작품에 적용합니다. 규칙은 위에서 아래 순서대로 적용합니다. 빈 교체 문자열은 해당 내용을 읽지 않게 합니다.

규칙은 이 브라우저의 IndexedDB에 저장되며 기기 간 동기화는 하지 않습니다. 계정 기능을 사용하는 빌드는 계정별 DB를 사용합니다. 저장하면 이전 규칙으로 준비한 재생을 중단하므로 다시 재생하세요.

`.ttsfilter`는 UTF-8의 `정규식#->#교체 문자열` 형식입니다. 줄 양쪽의 공백과 빈 교체값은 유지됩니다. 가져오기 전에 검토하며 오류 행을 제외하려면 명시적으로 선택해야 합니다. 파일은 64KiB, 작품에 적용되는 규칙은 최대 100개, 패턴과 교체 문자열은 각각 256자까지입니다.

정규식은 RE2JS 2.8.8을 사용하며 전방 탐색과 패턴 안의 역참조는 지원하지 않습니다. 교체값에서는 `$1`~`$99`, `$&`, `$$`를 지원합니다. 문단별로 실행하며 원문 위치 매핑을 유지합니다. 복잡한 패턴을 네이티브 RegExp로 우회 실행하지 않습니다. 지나치게 긴 문단·팽창하는 교체 결과는 오류로 중단하며 몰래 잘라 읽지 않습니다. 서버는 저장된 원문과 같은 규칙으로 낭독 텍스트·해시를 다시 검증합니다.
