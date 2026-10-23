# JS 플러그인 개발

BOAA 플러그인은 홈 추천 목록, 리더 기능, 명령, 자체 설정 화면을 추가합니다. 설치 파일은 `.js` 또는 `.boaaext`이고, 설정의 **플러그인 → 파일로 설치**에서 검사한 뒤 활성화합니다. 사용자가 패키지 세대를 선택할 필요는 없습니다. 아래 `packageVersion: 3`, `apiVersion: 2`는 현재 개발 계약입니다. 이전 형식은 호스트가 호환 여부를 판단합니다.

현재 실행 환경은 **로그인한 self-host 브라우저**입니다. 데스크톱·Android 네이티브와 정적 웹의 지원을 뜻하지 않습니다. 설치 코드, 승인 권한, 플러그인 설정과 저장 자료는 서버의 계정별 저장소가 기준이며 브라우저 IndexedDB에 설치하지 않습니다. 실행 세션은 메모리에 있으며, 홈 목록과 선택적 조회 캐시·표지는 별도 서버 캐시에 보관합니다. 다른 계정과 공유되지 않습니다. 서버에 파일이 보관되는 것과 서버에서 플러그인이 상시 실행되는 것은 다릅니다. 앱을 닫으면 실행도 끝납니다.

같은 계정으로 다른 브라우저나 기기에서 접속하면 서버의 설치와 설정을 불러옵니다. 이후 변경은 약 5초 간격으로 반영하며, 저장 성공은 서버 반영이 끝난 뒤에만 반환합니다. 서버에 연결되지 않으면 로컬에 저장된 것처럼 처리하지 않습니다. 동시 변경이 충돌하면 최신 상태를 다시 읽으며 기존 요청을 자동으로 덮어쓰거나 재실행하지 않습니다.

이전에 현재 계정으로 브라우저에 설치한 V3 플러그인은 처음 접속할 때 검증하여 서버로 옮깁니다. 서버에 같은 플러그인 기록이 있으면 서버의 상태를 유지하며, 서버에서 삭제한 플러그인을 이전 브라우저 자료로 복구하지 않습니다. 이전 IndexedDB와 프로필 정보는 읽기만 하고 삭제하지 않습니다. 코드 검사나 이전이 실패한 자료도 원래 브라우저에 남습니다. 큰 이전 버전 패키지는 요청 크기 제한 때문에 기존 브라우저에만 남을 수 있습니다. 이전 연결의 API 키와 승인은 자동 이전하지 않으므로 외부 연결은 다시 승인해야 합니다.

## 만들기와 검사

일반 서버 배포에서는 별도 `JS_PLUGIN_ORIGIN` 설정 없이 로그인한 HTTPS 호스트에서 사용할 수 있습니다. 이 환경변수는 특정 origin에만 고정하려는 운영자의 선택 사항입니다. 개발용 HTTP는 loopback에서만 허용됩니다. 서버 production bundle 및 `server dev/start` 스크립트는 iframe·Worker 실행 자산을 함께 준비합니다.

애플리케이션 저장소에서 다음 명령을 실행합니다. 실제 사이트용 플러그인의 프로젝트·패키지·조사 자료는 애플리케이션 저장소와 Docker 빌드 컨텍스트 밖의 비공개 디렉터리에 둡니다. 아래는 네트워크를 사용하지 않는 합성 예제입니다.

```sh
pnpm plugin:platform init /path/to/private-plugins/example-feed --id org.example.feed --name '추천 목록'
pnpm plugin:platform check-js /path/to/private-plugins/example-feed/dist/controller.js
pnpm plugin:platform pack /path/to/private-plugins/example-feed --out /path/to/private-plugins/example-feed.boaaext
pnpm plugin:platform check /path/to/private-plugins/example-feed.boaaext
```

`init`은 새 폴더에 `manifest.json`, `dist/controller.js`, `LICENSE`를 만듭니다. 기존 폴더를 덮어쓰지 않습니다. 생성한 `controller.js` 자체를 설치하거나 패키지로 묶을 수 있습니다. `.js` 첫 주석의 선언과 패키지의 `manifest.json`을 함께 수정해야 두 설치 방법의 권한과 이름이 일치합니다. 패키징은 이미 빌드된 파일만 읽으며 프로젝트 스크립트나 플러그인 코드를 실행하지 않습니다. 서명이 필요하면 기존 `pack --key <publisher.pem>`을 사용할 수 있습니다.

TypeScript 선언은 다음 경로에서 가져옵니다. 이것은 런타임 라이브러리 import가 아닙니다. `BoaaPlugin`은 호스트가 제공하는 전역입니다.

```ts
import type { PlatformControllerApi } from '@boaa/extension-contracts/platform-sdk';
declare const BoaaPlugin: PlatformControllerApi;
```

소스가 TypeScript라면 먼저 독립 JS 파일로 빌드합니다. 실행 중 npm 모듈, Node API, 임의 `fetch`, 부모 앱 DOM에 접근할 수 없습니다. 컨트롤러 코드는 QuickJS에서 실행하고, UI 역할은 별도 iframe 안에서 실행합니다.

## 홈 목록 → 제목 검색

최소 manifest는 다음과 같습니다.

```json
{
  "packageFormat": "boaa.extension.package",
  "packageVersion": 3,
  "apiVersion": 2,
  "extension": { "id": "org.example.feed", "name": "추천 목록", "version": "0.1.0" },
  "license": "UNLICENSED",
  "entries": { "controller": { "path": "dist/controller.js", "permissions": ["home.feed"] } },
  "activation": ["onHome"],
  "features": { "required": ["home.feed"], "optional": [] },
  "contributes": {
    "commands": [],
    "views": [],
    "decorations": [],
    "homeSections": [{ "id": "popular", "title": "오늘의 인기 작품" }]
  },
  "requestedAccess": { "storageKiB": 0, "contentScopes": [] }
}
```

컨트롤러에서 같은 섹션 ID를 등록합니다.

```js
BoaaPlugin.register({
  apiVersion: 2,
  activate(ctx) {
    ctx.home.register('popular', async (signal) => {
      signal.throwIfAborted();
      return {
        items: [{ id: 'sample', title: '예제 작품', author: '예제 작가', rank: 1 }],
        ttlSeconds: 1800,
      };
    });
  },
});
```

활성화된 섹션은 홈에 추가되고 홈 편집에서 순서·표시 여부를 바꿀 수 있습니다. 껐다 켜거나 파일을 교체해도 사용자가 숨긴 행을 강제로 다시 표시하지 않습니다. 해당 플러그인이 없는 환경에서는 그 행의 배치를 보존합니다. 카드 클릭은 호스트의 통합 검색을 열어 자동 제출합니다. 검색어는 `searchQuery`가 있으면 그 값, 없으면 `title`입니다. 검색 대상은 기존 서재 및 연결된 검색 가능 소스입니다. 플러그인이 검색 엔진을 별도로 구현할 필요는 없습니다.

| 필드                    | 의미와 제한                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `items`                 | 최대 50개, 응답 전체 JSON 최대 48 KiB                              |
| `id`, `title`           | 필수. 응답 안에서 ID 중복 불가, 각각 최대 128자·256자              |
| `author`, `searchQuery` | 선택, 최대 256자                                                   |
| `rank`                  | 선택, 실제 순위 정수 1–100000. 배열 위치로 순위를 다시 매기지 않음 |
| `coverUrl`              | 선택, HTTPS 이미지 URL. 아래 승인된 GET 연결과 일치해야 함         |
| `asOf`                  | 선택, ISO 날짜·시간. 순위를 집계한 시점을 표시                     |
| `ttlSeconds`            | 60–86400, 기본 1800. 만료 뒤 홈/앱 복귀 또는 표시 중 갱신          |

플러그인은 최대 8개 홈 섹션을 선언할 수 있습니다. BOAA가 카드를 그리고 표지를 지연 로드합니다. 표지는 서버의 승인된 연결을 통해 이미지로 검증한 뒤 표시하므로 브라우저에 외부 URL을 직접 삽입하지 않습니다. 갱신 실패 시 기존 목록과 실패 안내·재시도 버튼을 함께 표시합니다. 비활성화·교체 중 늦게 도착한 응답은 반영하지 않습니다. 홈 화면을 닫으면 행의 자동 갱신 타이머도 해제됩니다.

홈 섹션에 `view`를 지정하면 행의 **전체 보기**가 `contributes.views`에 선언한 플러그인 화면을 엽니다. 선언하지 않은 view ID는 설치 검증에서 거부합니다.

자체 UI에서 제목 검색을 열려면 UI 역할에 `app.search` 권한과 필수 feature를 선언하고 클릭 핸들러에서 `await ctx.app.search(title)`을 호출합니다. 최대 256자의 검색어만 허용하며, SDK의 사용자 활성화 확인과 호스트의 프레임 포커스·세션 확인·초당 1회 제한을 적용합니다. 검색을 열면 플러그인 화면이 닫힙니다. 임의 URL이나 앱 라우트는 지정할 수 없습니다.

## HTTP 연결

HTTP가 필요한 역할은 `http.request` 권한과 필수 feature를 선언하고, `contributes.connections`에 연결 ID를 넣습니다. `connections` 기본값을 함께 제공하면 설치 시 공개 연결 주소와 허용 메서드를 확인할 수 있습니다. 키나 토큰을 manifest에 넣지 않습니다.

```json
{
  "contributes": { "connections": ["catalog"] },
  "connections": [
    { "id": "catalog", "title": "작품 목록", "endpoint": "https://example.invalid/api/", "methods": ["GET"] }
  ]
}
```

위 코드는 manifest 전체가 아닌 추가 필드 예시입니다. 기본 endpoint는 쿼리·인증 정보 없이 `/`로 끝나는 HTTPS 주소여야 합니다. 요청의 `path`는 승인한 디렉터리를 벗어나지 않는 상대 경로입니다. 기본값이 없는 연결은 사용자가 설정에서 구성합니다. 인증이 필요한 연결의 비밀 값은 호스트가 관리하고 플러그인 응답에 돌려주지 않습니다.

```js
const result = await ctx.http.request(
  {
    slot: 'catalog',
    path: 'ranking',
    method: 'GET',
    response: 'json',
  },
  signal,
);
if (!result.ok) throw new Error(result.code);
if (result.status < 200 || result.status >= 300) throw new Error('ranking_failed');
// result.body를 검증하고 HomeFeed 형태로 변환합니다.
```

`response`는 `text` 또는 `json`입니다. HTTP 상태 코드는 전송 성공 결과에서도 직접 확인합니다. `response: "json"`인데 오류 상태의 본문이 HTML이거나 비어 있으면 `body: null`과 원래 상태를 반환합니다. 정상 상태의 잘못된 JSON과 크기 제한 초과는 전송 실패로 처리합니다. 취소 결과의 `outcome: 'unknown'`은 요청이 서버에 도착했을 가능성이 있으므로 변경 요청을 무조건 반복하지 않습니다. 표지를 내려받으려면 표지 URL의 origin과 경로도 승인된 **GET** 연결 범위에 포함되어야 합니다. 별도 이미지 호스트라면 별도 연결을 선언합니다. 연결 승인이 임의 서버나 내부 주소 접근 권한을 부여하지는 않습니다.

HTTP와 표지 요청은 서버에 저장된 소스 기본 연결 방식(직접 연결 또는 운영자 프록시)을 따릅니다. 플러그인은 프록시를 선택하거나 주소를 받지 않습니다. 프록시를 사용해도 목적지 DNS/IP 검증, TLS 호스트 검증 및 승인한 경로 범위를 유지하며 프록시 실패 시 직접 연결로 전환하지 않습니다.

기본 HTTP 응답 본문은 24 KiB, 요청 본문은 32 KiB로 제한됩니다. 서버는 기본 `User-Agent: BOAA/1.0`으로 요청합니다. 표지는 별도 경로로 최대 512 KiB의 PNG·JPEG·WebP를 받습니다. 리다이렉트와 압축 응답은 따르지 않습니다.

고정 크기의 큰 JSON 목록에는 `http.json-pick` feature를 선언하고 `response: 'json'` 요청에 `pick`을 지정할 수 있습니다. 예를 들어 `pick: [['items', '*', 'id'], ['items', '*', 'title'], ['total']]`은 각 항목의 ID·제목과 전체 개수만 전달합니다. 서버는 성공 응답 원본을 최대 512 KiB까지 읽고, 추출 결과를 24 KiB 이하로 제한합니다. 추출이 없는 요청과 오류 상태 응답에는 기존 24 KiB 제한을 적용합니다. 원본 전체는 게스트 VM에 전달하지 않습니다.

경로는 최대 48개, 각 경로는 최대 8단계입니다. `*`는 배열의 모든 항목 또는 객체의 모든 값을 선택합니다. 배열 순서와 길이를 유지하며 숫자로 배열 위치를 선택하거나 필터·정렬·코드를 실행하지 않습니다. 없는 객체 필드는 생략하고 `null`은 보존합니다. 배열당 최대 256개, 유지하는 값은 총 8192개까지이며 부모 필드를 통째로 선택해도 같은 제한을 적용합니다. 위험한 객체 키는 거부합니다.

승인된 서비스가 Origin 헤더를 요구하면 `http.origin` feature와 연결의 `origin` 헤더 허용이 모두 필요합니다. 값은 승인한 요청 대상의 정확한 origin으로만 지정할 수 있습니다. 임의 origin, 경로를 붙인 주소, `null`은 허용하지 않습니다. 필수 feature로 선언한 패키지의 기본 연결을 설치할 때 이 헤더 허용도 함께 승인합니다. 두 feature 모두 역할별 HTTP 권한·연결 승인·변경 확인을 대체하지 않습니다.

## 자체 화면의 이미지

UI 역할의 `http.request` 권한과 `ui.images` 필수 feature를 선언하면 승인된 GET 연결에서 표지를 표시할 수 있습니다. 이미지 주소 전체 대신 연결 ID와 상대 경로를 전달합니다. 쿼리는 허용하지만 승인한 디렉터리를 벗어날 수 없습니다.

```js
const cover = await ctx.images.load({ slot: 'covers', path: 'book.webp' }, signal);
imageElement.src = cover.url;
// 화면 밖으로 나가거나 상세 화면을 닫을 때 반환합니다.
cover.dispose();
```

서버가 공개 PNG·JPEG·WebP를 최대 512 KiB까지 받아 정적 WebP로 변환합니다. 입력은 최대 800만 픽셀, 한 변 8192px이며 애니메이션은 거부합니다. 출력은 최대 320×480px이고 작은 원본은 확대하지 않습니다. 인증 헤더·쿠키는 보내지 않으며 기존 목적지 검증과 기본 프록시를 따릅니다. 서버의 이미지 변환은 동시에 2개, 대기는 최대 8개입니다.

반환한 `blob:` URL은 격리 프레임 안에서 만들며 직접 외부 이미지를 읽도록 CSP를 넓히지 않습니다. `dispose()`는 여러 번 호출해도 안전합니다. 같은 이미지의 동시 요청은 공유하지만 각 소비자는 독립적인 사용권을 받습니다. 한 소비자의 취소는 다른 소비자의 이미지를 해제하지 않습니다. 취소 신호는 완료 후에도 해당 사용권을 반환하며, 프레임 종료 시 모든 URL을 해제합니다.

프레임별 캐시는 최대 24개, 인코딩된 자료 4 MiB, 표시 픽셀의 RGBA 추정치 12 MiB입니다. 동시 이미지 요청은 2개, 대기 포함 서로 다른 요청은 32개, 소비자는 64개까지 허용합니다. 사용 중인 이미지로 한도가 차면 `IMAGE_LIMIT` 오류가 나므로 가까운 항목만 요청하고 화면 밖 항목은 반환합니다. 캐시 재사용도 서버의 현재 연결·설치·권한을 확인합니다. 5분이 지난 자료는 다시 받으며, 같은 연결에서 기존 사용권이 살아 있다면 표시 중인 URL을 유지하고 교체를 미룹니다. 연결 revision 변경이나 승인 철회가 확인되면 기존 URL도 무효화합니다.

이미지 전용 RPC 응답에만 base64와 봉투를 포함한 704 KiB 한도를 적용합니다. 일반 UI RPC의 64 KiB 및 컨트롤러 HTTP 본문의 24 KiB 한도는 유지합니다. 이미지 바이트는 컨트롤러 VM을 거치지 않습니다. 이미지 호출도 UI의 전체 4개 대기 제한을 공유하며 SDK가 제어 요청을 위한 자리를 남겨 둡니다.

## 저장 자료와 설정

`storage.own` 권한·feature와 `requestedAccess.storageKiB`를 선언하면 설치별 JSON 저장소를 사용할 수 있습니다. `get`, `set`, `remove`, `list`가 있고 설정 스키마와 별개입니다. 키는 최대 128자, 값은 최대 48 KiB, 설치당 최대 128개 키이며 선언한 용량 안에서 사용합니다. 캐시가 필요하지 않다면 이 권한을 요청할 필요가 없습니다.

```js
const previous = await ctx.storage.get('ranking-cache');
await ctx.storage.set('ranking-cache', { items: [], fetchedAt: Date.now() }, previous.found ? previous.revision : null);
```

없는 키는 `expectedRevision: null`로 만들고 기존 키를 수정·삭제할 때는 읽은 revision을 전달합니다. 키 revision이 다르면 `STORAGE_CONFLICT`, 다른 기기의 서버 변경과 충돌하면 `STATE_CONFLICT`가 발생하므로 다시 읽고 처리합니다. `list({prefix, cursor, limit})`는 키와 revision 목록을 반환합니다. 기본 limit은 32, 최대 128이며 응답 크기에 따라 더 적은 항목과 `nextCursor`를 반환할 수 있습니다. 값 하나는 최대 48 KiB, 플러그인당 키는 최대 128개이고 총용량은 manifest의 `storageKiB`를 따릅니다. 이 저장소는 계정 서버에 보관되며 플러그인 제거 시 함께 삭제됩니다.

사용자 설정은 `settings.own` 권한과 `settings.schema` feature로 별도 선언합니다. 컨트롤러 등록 객체의 `settings: {version, fields}`에 boolean, number, string, color, enum, list, group 스키마를 넣으면 호스트 설정 화면이 만들어집니다. `ctx.settings.get()` 및 revision을 넣는 `set()`으로 읽고 수정합니다. 컨트롤러는 `settings.changed` 이벤트, UI는 `settings.subscribe()`로 변경을 받습니다. 컨트롤러에는 UI 전용 `settings.register/subscribe`가 없습니다.

## 기능 범위와 수명

| 기능           | 공개 API와 범위                                                                          |
| -------------- | ---------------------------------------------------------------------------------------- |
| 홈 목록        | `ctx.home.register`; 호스트 카드 및 제목 검색                                            |
| 명령           | `ctx.commands.register`; 선언한 명령 ID, 설정 화면 및 승인된 리더 입력에서 실행          |
| 자체 화면      | `entries.ui`, `contributes.views`; 설정 화면 또는 홈에서 여는 격리된 UI, `ctx.view.root` |
| UI ↔ 컨트롤러  | UI의 `ctx.controller.call`, 컨트롤러의 `ctx.handlers.register`                           |
| 리더 상태·본문 | `ctx.reader.state/content`; 열린 책에 한정, 본문 권한 필요                               |
| 본문 서식      | `ctx.decorations.register/invalidate`; TXT·EPUB의 범위·색상 장식, 원본 본문 변경 아님    |
| 메모·북마크    | `ctx.reader.annotations`; 현재 책의 권한과 호스트가 발급한 handle 필요                   |
| 자동 스크롤    | `ctx.reader.auto`; 사용자가 승인한 실제 입력의 interaction/lease 동안만 제어             |
| 계산 작업      | `entries.task`, `ctx.tasks.run`; 별도 VM의 순수 계산, 네트워크·UI·저장소 없음            |
| 이벤트         | `app.ready`, 리더 진입·이탈·상태 변경, 설정 변경, view 열기·닫기                         |

`ctx.controller.call`과 UI의 HTTP 요청은 최대 25초까지 기다린 뒤 취소합니다. 컨트롤러의 기존 30초 실행 감시와 메모리·CPU 제한은 유지됩니다.

`onHome`은 홈 피드를 요청할 때, `onCommand`는 명령을 실행할 때, `onView`는 자체 UI를 열 때 활성화합니다. `onReader`와 `onAppSession`은 해당 앱 수명에 연결됩니다. `activate()`에서 핸들러를 등록하고 실제 작업은 핸들러 안에서 수행합니다. 홈·명령용 유휴 컨트롤러는 해제될 수 있으므로 메모리 전역 값의 영속성을 가정하지 않습니다. 필요한 지속 상태는 `storage.own`에 저장합니다. 제공되는 `signal`로 취소를 확인하고 HTTP에 전달합니다.

임의 앱 메뉴·라우트·DOM 변경, 전체 서재 데이터 접근, 파일 시스템·셸 실행, 앱이 닫힌 뒤 예약 수집은 이 API에 없습니다. 소스의 탐색·본문 가져오기는 별도의 [소스 확장 계약](source-development.md)입니다. 홈 순위 목록만 제공한다면 읽기·다운로드 소스 전체를 구현할 필요가 없습니다.

개발 검사는 `check`/`check-js`로 선언과 파일을 검사하는 단계이며 사이트 동작 검증을 대신하지 않습니다. 호스트 테스트의 네트워크 자료는 합성 fixture를 사용합니다. 실제 사이트별 코드·식별자·진단 자료는 비공개 프로젝트에 보관합니다.

호스트 통합 검증은 `pnpm check:plugin-platform:browser`로 실행합니다. 임시 PostgreSQL과 실제 Chromium에서 합성 플러그인 설치, iframe·Worker 실행, 홈 카드 검색, 별도 브라우저 간 설정·저장 자료 공유, 계정 분리와 비활성화를 확인합니다.

## 전용 저장소와 조회 캐시

설정·최근 검색 등 보존할 자료는 기존 `ctx.storage`를 사용합니다. 다시 가져올 수 있는 목록은 `cache.own` 기능을 선언하고, 해당 controller/ui 역할에 이미 승인된 `storage.own` 권한으로 `ctx.cache`를 사용합니다. 캐시 정리는 영구 저장소의 용량·자료에 영향을 주지 않습니다.

- `await ctx.cache.get(key)`: `{ found: false }` 또는 `{ found: true, value, savedAt, freshUntil, expiresAt }`. 시간은 서버가 정한 Unix 밀리초입니다. `freshUntil`이 지났어도 `expiresAt` 전이면 이전 목록을 표시할 수 있습니다.
- `await ctx.cache.set(key, value, { ttlSeconds: 300, staleSeconds: 86400 })`: 기본 5분 동안 신선한 결과, 이후 최대 하루 동안 갱신 대기용 결과로 보관합니다. TTL은 60–86400초, 추가 보관 기간은 0–604800초입니다.
- `await ctx.cache.remove(key)`: 해당 조회 캐시만 삭제합니다.

JSON 캐시는 설치별 **256KiB·64개**, 항목별 **키 UTF-8 바이트 + 직렬화한 값 48KiB** 이내입니다. 홈 스냅샷도 같은 예산을 사용합니다. 계정 전체는 8MiB이며, 한도를 넘으면 저장 시각이 오래된 캐시부터 정리합니다. 캐시 누락·저장 실패는 정상 조회를 막아서는 안 됩니다. 키에는 검색 방식·정규화한 검색어·필터·정렬·페이지 등 결과를 바꾸는 모든 입력을 포함합니다.

표지는 호스트가 별도로 보관합니다. 원본 홈 표지와 UI 축소본은 서로 다른 항목이며, 서버에서 1시간 동안 재사용합니다. 설치별 8MiB·128개, 계정 전체 64MiB의 별도 예산을 사용합니다. JSON/Base64 표현과 키의 실제 바이트를 계산합니다. 브라우저 Blob URL은 공유하거나 서버에 저장하지 않습니다.

캐시는 계정·서재·설치 세대·패키지와 승인된 외부 연결의 revision에 묶입니다. 업데이트·비활성화·삭제 시 이전 설치 캐시를 제거하고, 권한·연결이 달라지면 이전 캐시를 반환하지 않습니다. 서버 캐시 API는 로그인한 동일 출처 호스트만 호출할 수 있고 공개 이미지 경로를 만들지 않습니다.

화면에서는 캐시 결과를 먼저 표시하고 만료된 경우 별도의 **await 가능한** 새 조회로 갱신합니다. 같은 검색의 갱신 중에는 기존 행을 비우지 않고, 실패해도 유지합니다. 새 첫 페이지가 도착하면 예전 다음 페이지를 교체하고 페이지 캐시에 목록 세대 식별자를 넣어 섞이지 않게 합니다. QuickJS 핸들러가 반환한 뒤 분리된 비동기 작업을 실행하면 RPC 수명이 끝나므로, stale 결과를 반환한 컨트롤러 안에서 백그라운드 갱신을 시작하지 않습니다.
