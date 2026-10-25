# Tibo-bot

Tibo(`@thsottiaux`)의 X 게시글을 수집하고 Gemini 3.5 Flash-Lite로 분류하는 Cloudflare Workers 기반 Discord 봇입니다. 현재 구현은 **`/검증` 명령으로 수집·분석·D1·Queue 연결을 확인하는 프로토타입**입니다.

명령을 실행하면 설정한 서버·채널에서 비공개 지연 응답을 보내고, 공개 미러에서 게시글 또는 답글 표본 하나를 읽어 Gemini 분류 결과를 원래 응답에 표시합니다. 배포된 코드는 Cloudflare에서 실행하므로 맥북을 계속 켜둘 필요는 없습니다.

전체 게시글 이력 수집, 초기화 시각 예측, 주기적인 자동 알림은 향후 구현 범위입니다. 공개 미러의 가용성과 수집 누락 여부도 보장하지 않습니다.

## 구조

| 파일 | 책임 |
| --- | --- |
| `src/index.js` | HTTP 요청·Queue 진입점 |
| `src/discord.js` | 요청 서명·실행 대상 확인, 지연 응답과 작업 흐름 |
| `src/collector.js` | Nitter HTML에서 대상 작성자의 게시글 표본 추출 |
| `src/gemini.js` | Gemini 구조화 응답 요청과 결과 검증 |
| `scripts/register-command.mjs` | 지정한 앱·서버에 `/검증` 하나만 등록 |
| `test/` | 합성 HTML과 외부 API 응답으로 실행하는 테스트 |

수집 → Gemini 분석 → Discord 응답을 서로 다른 Queue 실행으로 처리합니다. 재전달된 결과는 원래 메시지를 PATCH해 후속 메시지가 중복으로 늘어나지 않도록 합니다. D1은 현재 연결 확인용 SELECT에 사용하며 제품 데이터 저장 스키마는 아직 없습니다.

## 준비

- Node.js 24 이상
- Cloudflare 계정과 Workers·D1·Queues 사용 가능 상태
- Gemini API 키: Google AI Studio에서 해당 프로젝트의 무료 등급과 한도를 확인하세요.
- Discord 애플리케이션과 봇을 설치할 서버의 관리 권한

무료 사용량과 제한은 계정·모델별로 달라질 수 있습니다. [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/), [Queues 요금](https://developers.cloudflare.com/queues/platform/pricing/), [Gemini 요금·한도](https://ai.google.dev/gemini-api/docs/rate-limits)를 확인하세요.

## 설치와 배포

### 1. 로컬 설정

```sh
git clone https://github.com/hyxx-su/Tibo-bot.git
cd Tibo-bot
npm ci
cp wrangler.example.jsonc wrangler.local.jsonc
cp .dev.vars.example .dev.vars
```

`wrangler.local.jsonc`와 `.dev.vars`는 Git에서 제외됩니다. 실제 ID나 비밀값은 예제 파일에 넣지 마세요.

### 2. Cloudflare 리소스

```sh
npx wrangler login
npx wrangler d1 create tibo-bot-db
npx wrangler queues create tibo-bot-jobs
```

생성 결과의 D1 데이터베이스 ID를 `wrangler.local.jsonc`에 넣습니다. Worker·D1·Queue 이름을 바꾸면 생산자와 소비자의 Queue 이름도 함께 맞춥니다. 현재 별도의 데이터베이스 마이그레이션은 필요하지 않습니다.

### 3. Discord와 Gemini 값

`wrangler.local.jsonc`의 다음 값을 자신의 앱·서버·채널 값으로 채웁니다.

- `DISCORD_PUBLIC_KEY`: 개발자 포털의 앱 퍼블릭 키
- `DISCORD_APPLICATION_ID`: 애플리케이션 ID
- `DISCORD_TEST_GUILD_ID`: 실행을 허용할 서버 ID
- `DISCORD_TEST_CHANNEL_ID`: 실행을 허용할 채팅 채널 ID

`.dev.vars`에는 로컬 개발용 Gemini 키와 명령 등록용 봇 토큰을 넣습니다. 배포된 Worker의 Gemini 키는 암호화 비밀변수로 등록합니다.

```sh
npx wrangler secret put GEMINI_API_KEY --config wrangler.local.jsonc
npm run deploy
```

봇 토큰은 명령 등록에만 사용하며 Worker에 저장할 필요가 없습니다. Discord의 지연 응답 수정에는 각 명령 요청이 제공하는 단기 interaction token을 사용합니다.

### 4. Discord 연결

개발자 포털의 Interactions Endpoint URL을 다음 형태로 설정하고 저장합니다.

```text
https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/discord
```

Discord의 실제 서명 확인 요청이 통과해야 저장됩니다. 서버 설치에는 `bot`, `applications.commands` 스코프와 채널 보기·메시지 보내기·링크 임베드·애플리케이션 명령어 사용 권한을 지정합니다.

### 5. 명령 등록

`.dev.vars`의 `DISCORD_BOT_TOKEN`을 채운 후 실행합니다.

```sh
npm run register:command -- --application-id YOUR_APP_ID --guild-id YOUR_GUILD_ID
```

도구는 토큰이 해당 앱 소속인지 먼저 확인합니다. 기존 명령 전체를 교체하지 않고 `/검증` 하나를 생성·갱신합니다. 자동화에서 토큰을 파일로 관리한다면 `DISCORD_BOT_TOKEN_FILE` 환경변수도 사용할 수 있습니다.

설정한 서버·채널에서 `/검증`을 실행해 실제 응답을 확인하세요. 명령 등록과 정상 응답은 각 배포 환경에서 직접 확인해야 합니다.

## 개발과 테스트

```sh
npm run dev
npm test
```

`npm test`는 예제 설정으로 배포 없는 빌드를 수행한 뒤 Miniflare/workerd에서 **30개 테스트**를 실행합니다. 실제 API 키나 계정 로그인은 필요하지 않으며 외부 서비스 응답은 테스트에서 대체합니다. HTML 표본은 직접 작성한 합성 데이터입니다.

수집원의 403·429·점검 페이지, 작성자 구분, 서명 위조·본문 변조, 대상 서버·채널 제한, 지연 응답, 단계별 Queue 처리, 동일 메시지 갱신, 만료와 재시도를 확인합니다.

## 현재 한계

- 공개 미러는 429, 인증 토큰 소진, HTML 변경 등으로 중단될 수 있습니다. 수집 실패를 초기화 부재로 해석하면 안 됩니다.
- 현재 수집 대상은 타임라인에서 대상 작성자의 첫 표본 하나이며 필수 필드를 검사합니다. 전체 이력과 무누락 여부는 검증하지 않습니다.
- Gemini 분류는 원문 해석을 돕는 결과이며, 다음 초기화 시각이나 실제 사용자 한도 초기화를 확정하지 않습니다.
- Queue는 재전달될 수 있어 같은 메시지 수정은 반복될 수 있습니다. Gemini 호출 비용까지 정확히 한 번으로 제한하는 처리는 아직 없습니다.
- 기본 설정의 Cron 목록은 비어 있습니다. 상시 자동 수집·알림은 실행하지 않습니다.

이관 전 검증 결과와 공개 버전의 검증 범위는 [검증 기록](docs/verification.md)에 정리했습니다. Discord 응답의 시간 제한은 [공식 문서](https://docs.discord.com/developers/interactions/receiving-and-responding)를 참고하세요.
