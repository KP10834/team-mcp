# slack-mcp

> Slack 메시지 발송, 채널/스레드 조회, 메시지 검색

---

## 설정

```json
"slack-mcp": {
  "env": {
    "SLACK_BOT_TOKEN": "xoxb-...",
    "SLACK_USER_TOKEN": "xoxp-...",
    "SLACK_DEFAULT_CHANNEL": "#alerts"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SLACK_BOT_TOKEN` | | Bot Token (xoxb-). `postMessage` / `history` / `replies` 용. **권장** |
| `SLACK_USER_TOKEN` | | User Token (xoxp-). `search` 도구에 필수, 나머지는 fallback |
| `SLACK_DEFAULT_CHANNEL` | | `slack_post_message`에서 channel 생략 시 사용할 기본 채널 |

> BOT 또는 USER 중 **하나는 필수**. 둘 다 없으면 서버가 시작되지 않는다.

### Slack App 권한 (Scopes)

Bot Token에 부여:
- `chat:write` — 메시지 발송
- `channels:history`, `groups:history` — 공개/비공개 채널 메시지 조회
- `channels:read`, `groups:read` — 채널명 → ID 자동 변환

User Token에 부여 (검색용):
- `search:read`

봇이 메시지를 읽으려면 해당 채널에 **봇을 초대**해야 한다 (`/invite @botname`).

---

## 도구 (4개)

### `slack_post_message`

채널/DM/스레드에 메시지 발송.

```
"#alerts 채널에 '배포 완료' 보내줘"
"방금 그 스레드(ts: 1700000000.123)에 답글로 '확인했습니다' 달아줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `channel` | string | | `SLACK_DEFAULT_CHANNEL` | 채널 ID(`C…`) 또는 이름(`#general`) |
| `text` | string | O | | 메시지 본문 (mrkdwn 지원) |
| `thread_ts` | string | | | 답글로 달 스레드의 ts |
| `reply_broadcast` | boolean | | `false` | 스레드 답글을 채널에도 broadcast |

**출력 예시:**

```
## 메시지 발송 완료
- channel: `C0123456789`
- ts: `1700000123.456789`
```

---

### `slack_history`

채널의 최근 메시지 조회.

```
"#alerts 최근 메시지 20개 보여줘"
"#deploy 채널 어제 메시지 확인해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `channel` | string | O | | 채널 ID(`C…`) 또는 이름(`#general`) |
| `limit` | number | | `20` | 조회 건수 (최대 200) |
| `oldest` | string | | | 이 ts 이후 메시지만 |
| `latest` | string | | | 이 ts 이전 메시지만 |

**출력 예시:**

```
## #alerts 최근 메시지 (3개)

- **2025-05-17 09:21:33** `U0ABCDEF` [2 replies]
  배포 완료: v1.4.2
  _ts: 1747469293.123456_

- **2025-05-17 09:15:01** `B0BOTID01`
  CI 통과: PR #142
  _ts: 1747468901.000100_
```

---

### `slack_replies`

특정 스레드의 답글 조회.

```
"#alerts에서 ts 1700000000.123 스레드 답글 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `channel` | string | O | | 채널 ID 또는 이름 |
| `thread_ts` | string | O | | 부모 메시지 ts |
| `limit` | number | | `50` | 조회 건수 (최대 200) |

**출력 예시:**

```
## #alerts 스레드

### 부모
- **2025-05-17 09:21:33** `U0ABCDEF` [2 replies]
  배포 완료: v1.4.2

### 답글 (2개)
- **2025-05-17 09:22:10** `U0ZZZZZZ`
  확인했습니다
```

---

### `slack_search`

키워드로 메시지 검색. **User Token 필수.**

```
"slack에서 'OutOfGas' 검색해줘"
"in:#alerts before:2025-05-17 ERROR 검색"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `query` | string | O | | Slack 검색 문법 지원 (`in:#ch`, `from:@user`, `before:YYYY-MM-DD` 등) |
| `count` | number | | `20` | 결과 건수 (최대 100) |
| `sort` | enum | | `timestamp` | `score`(관련도) / `timestamp`(시간순) |

**출력 예시:**

```
## 검색 결과 (3/12건)
_query: `OutOfGas in:#alerts`_

- **2025-05-17 14:02:11** `U0ABCDEF` in #alerts
  withdraw 트랜잭션 실패: OutOfGas (txHash: 0xabc…)
  https://your-workspace.slack.com/archives/C0.../p1747497731000100
```

---

## 알림(이벤트) 수신은?

MCP는 **stdio 기반 요청/응답 프로토콜**이라 Slack 이벤트를 실시간 push로 받지는 못한다. 대신:

1. **폴링 방식** — `slack_history`로 알림 채널을 주기적으로 조회 (`"#alerts 최근 30분 메시지 보여줘"`).
2. **Slack Events API** (별도 구현 필요) — HTTPS endpoint가 필요해서 MCP 범위 밖. n8n / 별도 워커로 받아서 DB나 채널에 적재 후 MCP로 조회.

운영 알림 채널을 `SLACK_DEFAULT_CHANNEL`로 두고 `slack_history`로 확인하는 게 가장 단순한 패턴.
