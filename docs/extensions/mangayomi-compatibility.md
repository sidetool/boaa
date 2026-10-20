# Mangayomi JavaScript 지원 범위

이 문서는 사이트와 무관한 공통 호스트 계약을 설명합니다. [이용 안내 및 면책](../../DISCLAIMER.md)을 참고하세요.

기준: 2026-09-19 P0와 HTTP·SDK 후속 구현. 이 문서는 작업 트리의 구현 상태이며 해당 변경이 포함된 서버 버전부터 적용된다.
설치 가능한 확장과 실제 본문까지 취득 가능한 확장은 구분한다. 전체 Mangayomi 호환을 보장하지 않는다.

## 저장소 메타데이터와 표지

- 저장소의 `additionalParams` 문자열은 최대 16KiB까지 설치 기록과 `MProvider.source`에 보존한다.
  같은 JS 파일을 여러 소스가 공유해도 각 소스의 갤러리/분류 설정을 유지한다.
- `Document.body`, `head`, `documentElement`는 기존 DOM wrapper로 제공한다.
- 표지의 `getHeaders()`에는 이미지 CDN이 아닌 작품 URL을 전달한다. 소스가 반환한
  `imageHeaders`가 있으면 우선 사용하며 async `getHeaders()`도 기다린다. 헤더와 원격 URL은
  host에만 보관하고 클라이언트에는 작품 식별자와 인증된 이미지 응답만 전달한다.

## 실행 방식

Mangayomi JS 원본은 서버의 제한된 QuickJS realm에서 실행한다. Android WebView나 Flutter 앱을 실행하지 않는다.
사이트 JavaScript가 필요한 확장은 공통 Camoufox WebView 호스트를 사용할 수 있다. 일반 HTTP와 브라우저의
세션은 소스별로 분리되어 연결된다. 인증서 검증·네트워크 권한·취소·용량 제한은 그대로 적용된다.

현재 대상으로 삼는 형식은 JavaScript 만화(`itemType: 0`)와 소설(`itemType: 2`)이다.
Dart, 영상 추출, APK의 Android 객체는 이 지원표에 포함하지 않는다.

## 현재 API

| 기능        | 현재 동작                                                                                                                                   | 한계                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 목록        | `getPopular`, `getLatestUpdates`, `search`, `supportsLatest`, 필터 변환                                                                     | 소스가 각 메서드를 구현해야 한다.                                                     |
| 상세/회차   | `getDetail` 결과를 BOAA 작품·회차로 변환                                                                                                    | 회차를 별도 조회할 때 상세 함수가 다시 실행될 수 있다.                                |
| 이미지      | `getPageList`의 문자열 또는 `{url, headers}`와 `getHeaders`                                                                                 | 이미지 URL 발견과 실제 바이트 다운로드를 별도로 확인해야 한다.                        |
| 소설        | `getHtmlContent` 결과를 한 번 취득하고 안전한 TXT로 변환                                                                                    | 삽화·서식·EPUB 보존은 별도 기능이다.                                                  |
| 선택 기능   | `getSourcePreferences/getHeaders`의 정확한 `… not implemented` 신호는 기본값으로 처리                                                       | 다른 예외를 정상 결과로 바꾸지 않는다. 비동기 선택 메서드는 지원 계약 밖이다.         |
| 문자열      | 문자열 인스턴스의 `substringAfter/AfterLast/Before/BeforeLast/Between`                                                                      | 기존 `MProvider` 동명 helper도 유지한다.                                              |
| DOM         | CSS `select/selectFirst`, `attr/hasAttr`, `text/innerHtml/outerHtml`, class/tag 조회, children/siblings, `getHref/getSrc/getDataSrc/getImg` | XPath·전체 브라우저 DOM을 지원한다는 의미는 아니다.                                   |
| 빈 DOM 결과 | `selectFirst`는 빈 노드 wrapper를 반환하고 문자열 속성은 `''`, 목록은 `[]`                                                                  | `if (node)`로 존재를 판단하지 않는다. 필요한 속성이나 문자열을 검사한다.              |
| 텍스트      | DOM `text`의 원래 공백을 보존한다.                                                                                                          | 표시용 정리가 필요하면 원본 소스에서 `trim()` 등을 적용한다.                          |
| 설정        | 문자열·숫자·boolean 저장. `getString(key, defaultValue)`는 누락 시 기본값을 반환·저장                                                       | 문자열 복수 선택을 저장·복원한다. 항목 최대 128개이며 선언한 선택지만 저장할 수 있다. |
| HTTP        | GET/POST/PUT/DELETE/HEAD/PATCH, 응답 body/headers/statusCode/isRedirect와 요청 정보 일부                                                    | 아래 옵션·응답 범위를 참고한다. 전체 native HTTP client와 동일하지는 않다.            |
| 브라우저    | `evaluateJavascriptViaWebview`, 직접 `sendMessage`의 해당 메서드, `setResponse` callback                                                    | Android 객체·임의 native bridge와 동일하지 않다.                                      |
| 암호화      | 동기 `cryptoHandler`의 AES-CBC/PKCS7/base64 계약                                                                                            | Mangayomi profile 전용, 최대 입력 4 MiB. 다른 암호 helper를 포괄하지 않는다.          |
| 실행 수명   | 호출마다 새 realm과 인스턴스, 저장한 설정과 호스트 세션은 별도 보존                                                                         | 인스턴스 필드·전역 변수의 호출 간 보존을 기대할 수 없다.                              |

본문 정리는 확장의 `getHtmlContent()` 책임이다. 호스트가 `cleanHtmlContent()`를 자동으로 한 번 더 호출하지
않는다. 기존 자체 작성 Mangayomi JS가 호스트의 추가 정리에 의존했다면, 원본 함수에서 직접 정리한 결과를
반환하도록 맞춰야 한다. 자체 `.boaaext`의 `getContent()` 계약은 바뀌지 않는다.

DOM의 `getSrc/getHref` 등은 비교 기준 upstream의 outer HTML 기반 추출 의미를 따른다. 일반 웹 DOM의
`element.src/href`처럼 절대 URL 해석을 해주는 API가 아니다. EPUB helper와 동적 native handler는 지원하지 않는다.

### HTTP 옵션과 응답

`new Client({timeout, followRedirects, maxRedirects})`를 지원한다. `timeout`은 upstream과 같은 초 단위이며
기본 15초, 최대 90초다. DNS 대기부터 redirect·본문 수신까지 같은 요청 예산을 사용하고, 호출 전체의 실행 제한과
사용자 취소가 우선한다. 본문이 헤더 뒤에서 멈추는 경우도 취소한다. `followRedirects: false`는 3xx를 그대로
반환하며, `maxRedirects`는 0~4회 범위에서 적용한다. 더 큰 값은 호스트 한도 4회로 제한한다.

응답의 `request`에는 원래 요청 URL·메서드·확장이 지정한 헤더·본문 바이트 길이·redirect 정책을 제공한다.
vault에서 호스트가 추가한 쿠키·인증 헤더를 이 필드로 노출하지 않는다. `reasonPhrase`와 native 연결 상태 등은
아직 제공하지 않는다. `connectTimeout` 별도 제어·`noProxy`·`useDartHttpClient`는 적용하지 않으며
`verifyCertificates: false`로 TLS 검증을 해제할 수 없다. 이 제한은 설치 소스가 운영자의 네트워크 정책을
바꾸지 못하게 유지하는 의도적인 차이다.

## 재현 가능한 검사

```sh
corepack pnpm test:mangayomi-compatibility
corepack pnpm check:extension-mangayomi-app
```

단위 검사는 자체 작성한 [합성 소스 fixture](../../apps/server/src/extensions/mangayomi/fixtures/synthetic-sources.ts)와
결정적인 HTTP 응답만 사용한다. 사이트별 원본 확장, 도메인, 실제 작품·이미지는 공개 테스트에 포함하지 않는다.

- 문자열 구분자, 빈 DOM 노드, 기본 설정값과 선택 메서드의 미구현 신호.
- AES-CBC/PKCS7/base64 디코딩, 목록의 빈 다음 페이지, 페이지 정렬과 Referer.
- 소설 파일 검토·설치·재열기, POST 회차 조회, 본문 1회 취득과 중복 정리 방지.
- 다중 언어 소스 선택, 단일/복수 설정의 기본값·유효성 검사·저장·재열기.
- 상세 응답의 제목 누락 시 목록 제목 보존, 이미지 asset 전달과 디코딩.

브라우저 App 검사는 합성 이미지 소스의 설치, 설정 저장, 빈 검색과 정상 검색,
회차 가져오기, 직접 생성한 PNG 표시, 재열기 후 재다운로드 방지를 확인한다.
운영 계정·DB를 사용하거나 외부 소스에 요청하지 않는다. 실제 사이트의 현재 가용성이나
모든 호환 API 지원을 보증하는 검사는 아니다.
