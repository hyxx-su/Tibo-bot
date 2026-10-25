# Tibo-bot

Tibo(`@thsottiaux`)의 새 X 게시글·답글을 Discord로 보내는 Cloudflare Workers 봇입니다. **1분마다 자동 확인하며 맥북을 켜둘 필요가 없습니다.** 미러의 갱신 지연이 있으므로 X 게시 후 1분 이내 도착을 보장하는 것은 아닙니다.

## 동작

1. 처음에는 현재 최신 글을 기준점으로 저장합니다. 과거 글을 한꺼번에 보내지 않습니다.
2. 이후 발견한 일반 게시글·답글은 **X 원문 링크만** 보냅니다. 본문 없이 이미지·GIF·동영상만 첨부한 답글도 포함합니다. 초기화 후보는 먼저 분석하며, 링크 미리보기는 허용하고 멘션은 끕니다.
3. `reset`, `resets`, `resetting`, `초기화`가 있거나, 같은 스레드의 앞선 본문에 해당 표현이 있는 답글은 함께 Gemini 3.5 Flash-Lite로 분석합니다. 같은 작성자의 인용 글도 분석하며, 인용 ID에 연결된 저장 문맥을 함께 읽습니다.
4. 초기화로 판단된 글은 **제목·한국시간·설명·원문 링크를 한 메시지로** 보냅니다. 링크만 따로 먼저 보내지 않습니다. 예정·진행 중·전체 반영 완료·단순 언급을 구분합니다. “Rest and reset” 단독은 휴식 표현일 수 있지만, 같은 작성자가 같은 스레드에 초기화 기한을 덧붙인 경우 문맥을 함께 읽습니다.
5. 원문에 근거가 있는 시각은 **한국시간(KST)** 으로 표시합니다. 날짜·시간대가 불명확하면 확정할 수 없다고 표시합니다.

게시 시각이 `2026-10-25 12:00 UTC`이고 원문이 `tomorrow at 9am PT`라면 한국시간은 **2026-10-27 01:00**입니다. `in 2 hours`는 해당 게시 시각 기준으로 계산합니다. `By midnight PST`는 그 표현을 게시한 당시 PST 날짜의 다음 자정을 기한으로 계산합니다. 예를 들어 10월 25일 03:40 UTC의 해당 답글은 **10월 25일 17:00 KST까지**입니다. 원문의 PST는 UTC−8로 유지하며 PT(서머타임 적용 지역 시각)로 임의 교체하지 않습니다. 서머타임은 지역 시간대를 통해 반영하며, 전환 시점의 중복·존재하지 않는 시각은 확정하지 않습니다.

`GATEWAY_ENABLED="true"`이면 Cloudflare Durable Object 한 개가 Discord Gateway 연결을 유지하여 멤버 목록에 **온라인**으로 표시합니다. 맥북을 켜둘 필요가 없습니다. 연결이 끊기면 기존 Cron이 재접속을 시도하며, 알림 수집·발송은 별도 경로로 계속 실행됩니다.

## 초기화 알림 예시

```md
**:warning: 초기화 예상 시간 감지**
# 10월 25일 17:00
-# 한국시간(KST) · 추정

게시글과 연결된 스레드의 내용을 분석한 결과, PST 기준 다음 자정까지 초기화될 가능성이 있습니다.

https://x.com/thsottiaux/status/POST_ID
```

이미지·GIF의 시각적 내용은 분석하지 않습니다. 첨부만 있는 글도 원문 링크를 보내며, 실제 미리보기 생성 여부는 Discord와 X의 응답에 따라 달라질 수 있습니다.

예정 시각을 계산할 수 없으면 `초기화 시각 미정`으로 표시합니다. 진행 공지에는 공지 게시 시각을 표시하며, 완료 공지는 다음 형식으로 보냅니다.

```md
# 초기화 완료
-# 기존 예상 · 10월 25일 17:00 (KST)

Tibo가 사용량 초기화의 전체 반영이 완료되었다고 안내했습니다. 기존 예상 시각보다 앞서 완료된 것으로 보입니다.

https://x.com/thsottiaux/status/POST_ID
```

기존 예상은 직접 인용한 글에 저장된 `scheduled` 분석 시각만 사용합니다. 마지막 비교 문장은 완료 공지 게시 시각이 해당 예상 시각보다 빠를 때만 붙입니다. 예상 시각과 같거나 늦은 경우, 게시 시각을 해석할 수 없는 경우에는 붙이지 않습니다. 기존 예상을 찾지 못하면 `기존 예상 시각 미확인`으로 표시합니다. 공지 게시 시각으로 개별 계정의 정확한 초기화 순간을 확정하지 않습니다.

예고를 인용한 `It is all propagated`와 같은 후속 글은 Gemini가 새 글 자체의 근거로 완료 여부를 판별합니다. `still propagating` 등 진행 중인 안내는 완료 메시지로 보내지 않습니다. 인용 글이 다른 작성자의 것이거나 무관한 배포·질문·부정이면 이전 초기화 예고로 연결하지 않습니다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `/상태` | 마지막 수집 성공 시각, 기준점, 대기·완료·실패 건수를 비공개로 표시 |
| `/검증` | 서버 관리 권한 필요. 표본 1개 수집 → Gemini → D1·Queue → 비공개 응답 확인. 전체 합계로 분당 1회·UTC 하루 20회 |

명령은 설정한 테스트 서버·채널에서만 실행됩니다. `/상태`는 본인에게만 온라인 연결과 수집 상태를 표시합니다. 자동 알림은 `DISCORD_NOTIFY_CHANNEL_ID`로 지정한 채널로 전송합니다.

## 구조

| 파일 | 책임 |
| --- | --- |
| `src/index.js` | HTTP·Cron·Queue 진입점 |
| `src/discord.js` | Ed25519 서명 확인과 명령 응답 |
| `src/collector.js` | 대상 작성자 게시글·답글·자기 인용과 다음 페이지 추출 |
| `src/command-guard.js` | 검증 명령 재사용·호출량 제한 |
| `src/input.js` | 외부 응답 바이트 제한과 AI 요약 서식 보호 |
| `src/gateway.js` | 온라인 상태, Heartbeat 확인, 세션 재개·재접속 제한 |
| `src/watcher.js` | 예약 수집, 링크 발송, 분석·공지 진행 |
| `src/watch-store.js` | 기준점·처리 이력, 작업 점유·재시도, 일일 분석 상한, 인용된 예고 문맥 조회 |
| `src/reset-analysis.js` | 초기화 분류, 원문 근거 확인, 공지 구성 |
| `src/reset-time.js` | 원문 시간 표현 해석과 KST 변환 |
| `src/gemini.js` | `/검증`용 표본 분류 |
| `migrations/0001_watch.sql` | 자동 알림 저장 구조 |

수집, 분류, 발송은 Queue 단계로 처리합니다. 일반 글은 즉시 링크만 보내고 초기화 후보는 분석 결과에 따라 통합 알림 또는 링크 중 하나만 보냅니다. 분석이 최대 재시도 후 실패하면 링크만 전송합니다. D1의 미완료 작업은 다음 수집 주기에 재개합니다.

## 설치와 배포

Node.js 24 이상, Cloudflare 계정, Gemini API 키, Discord 앱과 서버 관리 권한이 필요합니다.

```sh
git clone https://github.com/hyxx-su/Tibo-bot.git
cd Tibo-bot
npm ci
cp wrangler.example.jsonc wrangler.local.jsonc
cp .dev.vars.example .dev.vars
npx wrangler login
npx wrangler d1 create tibo-bot-db
npx wrangler queues create tibo-bot-jobs
```

`wrangler.local.jsonc`에 자신의 Worker·D1·Queue 이름과 D1 ID를 넣습니다. Queue 생산자와 소비자 이름은 같아야 합니다. 실제 설정과 `.dev.vars`는 Git에서 제외됩니다.

| 변수 | 값 |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | 앱 퍼블릭 키 |
| `DISCORD_APPLICATION_ID` | 앱 ID |
| `DISCORD_TEST_GUILD_ID` | 명령 실행 서버 ID |
| `DISCORD_TEST_CHANNEL_ID` | 명령 실행 채널 ID |
| `DISCORD_NOTIFY_CHANNEL_ID` | 새 글·초기화 공지 채널 ID |
| `NITTER_BASE_URL` | 공개 미러 HTTPS 주소 |
| `WATCH_ENABLED` | 준비 후 문자열 `"true"`로 설정. 기본 `"false"` |
| `RESET_ANALYSIS_DAILY_LIMIT` | 자동 분석 시도 일일 상한. 기본 100, 최대 100 |

비밀값은 `.dev.vars`에 로컬 개발용으로 저장하고 배포 환경에는 암호화 비밀변수로 등록합니다. **자동 발신에 봇 토큰이 필요합니다.**

```sh
npx wrangler secret put GEMINI_API_KEY --config wrangler.local.jsonc
npx wrangler secret put DISCORD_BOT_TOKEN --config wrangler.local.jsonc
npx wrangler d1 migrations apply tibo-bot-db --remote --config wrangler.local.jsonc
```

CLI에 D1 관리 권한이 없으면 해당 데이터베이스 Console에서 `migrations/0001_watch.sql`, `0002_thread_context.sql`을 순서대로 실행할 수 있습니다. 두 번째 파일은 열을 추가하므로 최초 한 번만 적용합니다. 기존 기준점·글 이력은 유지합니다.

Discord 앱을 `bot`, `applications.commands` 스코프와 채널 보기·메시지 보내기·링크 임베드·애플리케이션 명령어 사용 권한으로 설치합니다. `WATCH_ENABLED`를 `"true"`로 바꾼 뒤 배포합니다.

```sh
npm run deploy
npm run register:command -- --application-id YOUR_APP_ID --guild-id YOUR_GUILD_ID
```

명령 등록에는 `.dev.vars`의 봇 토큰을 사용합니다. 자동화에서는 `DISCORD_BOT_TOKEN_FILE`로 보호된 파일을 지정하고 `node scripts/register-command.mjs ...`를 실행할 수도 있습니다. 기존 명령 전체를 교체하지 않고 `/검증`과 `/상태`를 각각 생성·갱신합니다.

Discord 개발자 포털의 Interactions Endpoint URL을 아래 형태로 설정합니다. 실제 서명 확인 요청이 통과해야 저장됩니다.

```text
https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/discord
```

Cron은 `* * * * *`로 매분 실행됩니다. [예약 변경 전파에는 최대 15분이 걸릴 수 있습니다.](https://developers.cloudflare.com/workers/configuration/cron-triggers/) `/상태`에서 기준점과 마지막 수집 성공 시각을 확인하세요. 첫 기준점 저장 전에는 감시가 시작된 것으로 간주하지 않습니다.

## 운영과 제한

- **중지·재개:** `WATCH_ENABLED`를 `"false"`로 바꾸고 재배포합니다. 예약 자체도 없애려면 `triggers.crons`를 `[]`로 바꿉니다. 재개할 때는 기존 D1 이력을 유지합니다.
- **수집 범위:** 새 게시글·답글 대상이며 재게시, 다른 작성자의 문맥, 최초 기준점 이전 이력은 제외합니다. 최대 3페이지까지 따라갑니다. 기준점 이후에 작성됐지만 미러에 늦게 노출된 글도 조회 페이지 안에 있으면 발견합니다.
- **무료 미러:** 차단·429·HTML 변경·갱신 지연·오래된 캐시가 생길 수 있습니다. 다음 주기에 다시 시도하지만 전체 글 무누락은 보장하지 않습니다. 마지막 성공 시각은 미러 응답을 받은 시각이며 X 최신성 보증이 아닙니다.
- **중복 방지:** 글 ID, 처리 단계, 작업 점유와 Discord nonce를 사용합니다. 발송 성공 직후 저장에 실패하고 장시간 후 재시도하는 경우까지 정확히 한 번 전송을 보장하지 않습니다. [Discord nonce 중복 검사는 최근 몇 분 범위입니다.](https://docs.discord.com/developers/resources/message#create-message)
- **실패 처리:** 발송·분석은 최대 6회, 간격을 늘려 재시도합니다. 인증·권한 오류는 즉시 실패로 남깁니다. `/상태`에 실패 건수가 있으면 토큰·권한·서비스 상태를 확인하고 해당 작업을 재개해야 합니다.
- **AI와 시간:** 분류 오류 가능성이 있습니다. 현재 글과 미러에 표시된 동일 스레드의 앞선 동일 작성자 글 최대 5개를 함께 읽습니다. 다른 작성자나 단순히 인접한 글은 합치지 않습니다. 문맥에도 키워드가 없는 암시적 공지는 분석하지 않습니다. ISO 날짜·시간대, 명시된 날짜/오늘/내일과 UTC·KST·PT·ET·PST·PDT·EST·EDT, 분·시간 후, `by/before/at midnight 시간대` 표현을 지원합니다. `by/before`는 정확한 실행 시각이 아니라 “까지”라는 기한으로 표시합니다. 주중 이름·시간 범위 등 미지원 표현이나 날짜·시간대 누락은 확정하지 않습니다. 원문에 없는 다음 초기화 시각은 예측하지 않습니다.
- **분석 상한:** 자동 분석 시도는 UTC 날짜 기준 최대 100회입니다. 상한 도달 시 초기화 후보의 분석과 메시지 전송을 다음 날로 미룹니다. 일반 글 링크는 계속 전송합니다. `/검증` 호출은 별도이며 실제 잔여 무료량을 조회하는 기능은 아닙니다.
- **무료 사용량:** 매분 수집 Queue만 정상 처리해도 하루 약 4,320회 연산을 사용하며 새 글·분석·발송·재시도는 추가됩니다. [Queues](https://developers.cloudflare.com/queues/platform/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/limits/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Gemini](https://ai.google.dev/gemini-api/docs/rate-limits)의 한도를 계정에서 확인하세요. 유료 요금제로 자동 전환하도록 설정하지 않습니다.

## 관리자 단건 재검증

감시 기준점 이전의 특정 글을 검증할 때는 Cloudflare Queues 관리 화면 또는 인증된 API로 `{"kind":"watch-replay","postId":"실제_글_ID"}` JSON을 보낼 수 있습니다. 현재 미러 첫 페이지에서 해당 글을 다시 읽으며, 지정하지 않은 과거 글은 발송하지 않습니다. 이미 완료된 이력은 덮어쓰지 않습니다. 이 작업은 공개 HTTP 요청이나 일반 Discord 명령으로 노출되지 않습니다.

## 개발과 검증

```sh
npx wrangler d1 migrations apply tibo-bot-db --local --config wrangler.local.jsonc
npm run dev
npm test
```

`npm test`는 배포 없는 빌드 후 72개 테스트를 실행합니다. 실제 계정·키·게시글을 사용하지 않으며 외부 API는 합성 응답으로 대체합니다. 기준점, 링크 단독 발송, 시간 변환과 DST, 중복 작업, 429 재시도, 장애 중 작업 복구, 분석 상한, 여러 페이지 수집, Discord 서명을 검증합니다.

실제 서비스 실행 기록과 한계는 [검증 기록](docs/verification.md)에 정리합니다.


## 온라인 표시 설정

배포 설정의 `durable_objects`와 SQLite 마이그레이션 이력을 유지하고 `GATEWAY_ENABLED`를 `"true"`로 설정합니다. 기존 `DISCORD_BOT_TOKEN`을 사용하며 추가 privileged intent는 필요하지 않습니다. 배포 후 다음 Cron 실행에서 연결을 시작합니다. 공개 `/health`는 최소 서비스 상태만 반환하며 내부 객체를 호출하지 않습니다. 실제 온라인 연결 상태는 Discord의 비공개 `/상태`로 확인합니다.

연결 객체 이름은 고정되어 한 개만 사용합니다. Heartbeat ACK 누락, 연결 종료, Discord의 재접속 요청을 처리합니다. 살아 있는 세션은 재개하고, 새 인증은 재시작을 포함해 최소 2분 간격으로 제한합니다. 토큰의 SHA-256 해시로 교체를 구분하여 새 토큰에는 이전 인증 오류의 한 시간 대기를 적용하지 않습니다. 동일 토큰으로 재배포할 때는 대기가 유지됩니다. Gateway 저장소에는 토큰 원문을 저장하지 않습니다. 복구 대기는 최대 15분이며 치명적인 인증·설정 오류는 한 시간 동안 재시도를 제한합니다. `GATEWAY_ENABLED="false"`로 재배포하면 다음 Cron에서 연결을 종료합니다. 배포 설정에서 Durable Object 마이그레이션 이력을 임의로 삭제하지 마세요.

[Cloudflare 공식 요금표](https://developers.cloudflare.com/durable-objects/platform/pricing/) 기준 Workers Free의 Durable Objects 실행 시간은 하루 13,000 GB-s입니다. 외부 WebSocket은 hibernation 대상이 아니므로 연결 중 실행 시간을 소비합니다. 객체 하나의 24시간 연결은 대략 11,000 GB-s로 무료 한도 안에 들어가는 계산이지만 계정의 다른 Durable Objects 사용량도 합산됩니다. 무료 한도 초과 시 해당 작업은 오류로 중단되며, 장애나 배포 중 일시적인 오프라인 표시는 발생할 수 있습니다.


## 보안 운영

- Discord 요청은 Ed25519 서명과 ±5분 유효 시간을 확인합니다. `/검증`은 서버 관리·관리자 권한을 확인하고, 별도 SQLite Durable Object가 중복 요청과 호출 상한을 저장합니다. 호출 제한 저장소 오류 시 새 분석을 실행하지 않습니다.
- `/검증`의 일일 제한은 UTC 자정, 한국시간 오전 9시에 초기화합니다. 자동 게시글 분석의 기존 하루 100회 제한과 별개입니다.
- 수집원은 현재 확인한 `https://x.noodl3.net`만 허용합니다. 다른 미러를 쓰려면 수집기의 허용 목록도 검토해야 합니다. 외부 HTTP 리다이렉트는 자동 추적하지 않습니다.
- Discord 입력은 64 KiB, 미러 HTML은 2 MiB, Gemini 응답은 64 KiB로 제한합니다. AI 요약의 외부 링크를 제거하고 Discord 서식을 이스케이프하며, 멘션은 비활성화합니다.
- `sharp`와 `undici`의 보안 패치는 `overrides`로 고정합니다. 개발 도구에 필요한 패치이며 Worker 런타임에 해당 Node 패키지를 포함하는 것은 아닙니다. 의존성 변경 후 `npm test`와 `npm audit`를 실행합니다.
- 키·봇 토큰·개인별 배포 설정은 Git에 넣지 않습니다. 채팅이나 로그에 노출된 자격 증명은 발급처에서 폐기·재발급하고 Cloudflare secret도 교체해야 합니다.

자세한 점검 범위와 한계는 [보안 점검 기록](docs/security-review.md)을 확인하세요.
