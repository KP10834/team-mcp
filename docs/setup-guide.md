# @stableteam/team-mcp 설정 가이드

팀 공유 MCP 서버를 Claude Code에 연동하는 가이드.

---

## 1. 설치

```bash
npm i -g @stableteam/team-mcp
```

설치 확인:

```bash
team-mcp
# Usage: team-mcp <server>
# Available: evm, kafka, redis, slack, grafana, kibana, dooray, github-wiki, workflow, rca
```

Node 20+ 필수.

---

## 2. MCP 등록

`~/.claude/.mcp.json`에 사용할 서버를 등록한다. 아래 템플릿에서 필요한 서버만 복사해서 `<placeholder>`를 실제 값으로 교체.

### 전체 템플릿

```json
{
  "mcpServers": {
    "evm-mcp": {
      "command": "team-mcp",
      "args": ["evm"],
      "env": {
        "EVM_RPC_URL": "http://<rpc-host>:8545",
        "RPC_TIMEOUT_MS": "10000"
      }
    },
    "kafka-mcp": {
      "command": "team-mcp",
      "args": ["kafka"],
      "env": {
        "KAFKA_BROKERS": "<broker-host>:9092"
      }
    },
    "redis-mcp": {
      "command": "team-mcp",
      "args": ["redis"],
      "env": {
        "REDIS_HOST": "<redis-host>",
        "REDIS_PORT": "6379",
        "REDIS_DB": "0",
        "REDIS_KEY_PREFIX": ""
      }
    },
    "slack-mcp": {
      "command": "team-mcp",
      "args": ["slack"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_USER_TOKEN": "xoxp-...",
        "SLACK_DEFAULT_CHANNEL": "#alerts"
      }
    },
    "kibana-mcp": {
      "command": "team-mcp",
      "args": ["kibana"],
      "env": {
        "KIBANA_URL": "http://<kibana-host>:5601",
        "KIBANA_API_KEY": "<base64-encoded-api-key>",
        "KIBANA_COOKIE": "sid=<session-cookie>"
      }
    },
    "grafana-mcp": {
      "command": "team-mcp",
      "args": ["grafana"],
      "env": {
        "GRAFANA_URL": "https://<grafana-host>",
        "GRAFANA_SA_TOKEN": "glsa_...",
        "GRAFANA_PROM_DATASOURCE_UID": "",
        "GRAFANA_LOKI_DATASOURCE_UID": ""
      }
    },
    "dooray-mcp": {
      "command": "team-mcp",
      "args": ["dooray"],
      "env": {
        "DOORAY_TOKEN": "<dooray-api-token>",
        "DOORAY_DEFAULT_PROJECT_ID": "",
        "DOORAY_DEFAULT_CHANNEL_ID": ""
      }
    },
    "github-wiki-mcp": {
      "command": "team-mcp",
      "args": ["github-wiki"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "WIKI_REPOS": "{\"my-project\":\"org/repo\"}"
      }
    },
    "workflow-mcp": {
      "command": "team-mcp",
      "args": ["workflow"],
      "env": {
        "PROJECT_DIR": "",
        "GITHUB_REPO": ""
      }
    },
    "rca-mcp": {
      "command": "team-mcp",
      "args": ["rca"],
      "env": {
        "KIBANA_URL": "http://<kibana-host>:5601",
        "KIBANA_API_KEY": "<base64-encoded-api-key>",
        "KIBANA_COOKIE": "",
        "RPC_TIMEOUT_MS": "10000"
      }
    }
  }
}
```

등록 후 **Claude Code를 재시작**하면 반영된다.

---

## 3. 서버별 설정 상세

### EVM (evm-mcp)

블록체인 RPC 호출. 잔액, 트랜잭션, nonce, 블록 조회.

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `EVM_RPC_URL` | | `http://localhost:8545` | RPC 엔드포인트 |
| `RPC_TIMEOUT_MS` | | `10000` | 타임아웃 (ms) |

각 도구에서 `rpc_url` 파라미터로 호출 시 오버라이드 가능.

**도구:** `evm_balance` `evm_token_balance` `evm_tx` `evm_nonce` `evm_block` `evm_chain_info`

**사용 예:**
```
"0x1234... 잔액 확인해줘"
"이 트랜잭션 상태 확인: 0xabcd..."
"연결된 체인 정보 보여줘"
```

---

### Kafka (kafka-mcp)

Kafka 토픽 관리, 메시지 발행/소비.

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `KAFKA_BROKERS` | | `localhost:9092` | 브로커 주소 (쉼표 구분) |

**도구:** `kafka_list_topics` `kafka_publish` `kafka_consume` `kafka_offsets`

**사용 예:**
```
"카프카 토픽 목록 보여줘"
"payments.completed 최근 메시지 3개 읽어줘"
"orders.created에 테스트 메시지 보내줘"
```

---

### Redis (redis-mcp)

Redis 키 조회/삭제, 락 관리, 서버 모니터링.

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `REDIS_HOST` | | `localhost` | 호스트 |
| `REDIS_PORT` | | `6379` | 포트 |
| `REDIS_DB` | | `0` | DB 인덱스 |
| `REDIS_PASSWORD` | | | 비밀번호 |
| `REDIS_KEY_PREFIX` | | _(empty)_ | 키 프리픽스 (자동 적용) |

**도구:** `redis_keys` `redis_get` `redis_del` `redis_ttl` `redis_locks` `redis_info`

**사용 예:**
```
"redis에 account 관련 키 있어?"
"현재 활성 락 보여줘"
"redis 서버 상태 보여줘"
```

---

### Slack (slack-mcp)

Slack 메시지 발송, 채널/스레드 조회, 검색.

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `SLACK_BOT_TOKEN` | △ | | Bot Token (`xoxb-`). post/history/replies 용 |
| `SLACK_USER_TOKEN` | △ | | User Token (`xoxp-`). search 필수 |
| `SLACK_DEFAULT_CHANNEL` | | | 기본 채널 |

> △ BOT 또는 USER 중 하나 이상 필수.

**Bot Token 필요 스코프:** `chat:write`, `channels:history`, `groups:history`, `channels:read`, `groups:read`
**User Token 필요 스코프:** `search:read`

**도구:** `slack_post_message` `slack_history` `slack_replies` `slack_search`

**사용 예:**
```
"#alerts 최근 메시지 20개 보여줘"
"slack에서 'OutOfGas' 검색해줘"
"#deploy 채널에 '배포 완료' 보내줘"
```

---

### Kibana (kibana-mcp)

Kibana Console Proxy를 통한 ES 검색. ES 9200 포트 차단 환경에서도 동작.

#### 설치

```bash
# 1. 패키지 설치 (최초 1회)
npm i -g @stableteam/team-mcp

# 2. MCP 서버 등록
team-mcp setup kibana
# → ~/.claude/.mcp.json 에 kibana-mcp 등록됨
# → KIBANA_URL, KIBANA_COOKIE 등 placeholder를 실제 값으로 교체

# 3. Claude Code 재시작
```

또는 `~/.claude/.mcp.json`을 직접 편집해도 된다 (아래 설정 예시 참고).

#### 환경변수

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `KIBANA_URL` | O | | Kibana 베이스 URL |
| `KIBANA_API_KEY` | △ | | API Key (base64 인코딩된 `id:api_key`) |
| `KIBANA_COOKIE` | △ | | 세션 쿠키 (`sid=...`) |

> △ API_KEY 또는 COOKIE 중 하나 필수. 둘 다 없으면 서버가 시작되지 않는다.

#### 인증 방법

**방법 1: Session Cookie (가장 간단)**

SSO/Okta 환경이거나 API Key 발급 권한이 없을 때 사용.

1. 브라우저에서 Kibana에 로그인
2. **F12** (DevTools) → **Application** 탭 → 좌측 **Cookies** → Kibana 도메인 선택
3. `sid` 쿠키의 **Value** 전체를 복사
4. `~/.claude/.mcp.json`에 설정:
   ```json
   "KIBANA_COOKIE": "sid=<복사한 값>"
   ```

> 쿠키는 보통 8시간~며칠 후 만료된다. 만료되면 위 과정 반복.
> Claude Code에서 `Kibana 401` 에러가 나면 쿠키 갱신이 필요하다는 뜻.

**방법 2: API Key (장기 사용)**

Kibana Stack Management에서 발급 가능할 때 사용. 만료 없이 쓸 수 있어서 편함.

1. Kibana → **Stack Management** → **API keys** → **Create API key**
2. Name: `claude-mcp` (아무거나)
3. Role 설정: 기본(현재 유저 권한 상속) 또는 커스텀
4. 생성 후 표시되는 **Base64 encoded** 값을 복사
5. `~/.claude/.mcp.json`에 설정:
   ```json
   "KIBANA_API_KEY": "<base64 값>"
   ```

> API Key가 설정되면 Cookie보다 우선 사용된다.

#### mcp.json 설정 예시

```json
"kibana-mcp": {
  "command": "team-mcp",
  "args": ["kibana"],
  "env": {
    "KIBANA_URL": "http://<kibana-host>:5601",
    "KIBANA_COOKIE": "sid=<session-cookie>"
  }
}
```

#### 도구 (5개)

| 도구 | 설명 | 사용 예 |
|------|------|---------|
| `kibana_es_search` | ES 로그 검색 (서비스/레벨/시간 필터) | "최근 1시간 ERROR 로그 50건" |
| `kibana_es_request` | ES 임의 요청 (모든 method/path) | "_cluster/health 확인해줘" |
| `kibana_saved_objects` | 대시보드/시각화/검색 조회 | "대시보드 목록 보여줘" |
| `kibana_alerts` | Alerting 룰 조회 | "알림 룰 상태 보여줘" |
| `kibana_data_views` | Data View (인덱스 패턴) 목록 | "인덱스 패턴 뭐 있어?" |

#### 사용 예시

```
"오늘 ERROR 로그 보여줘"
"최근 30분 withdraw 관련 로그"
"service가 adapter인 로그만 50건"
"_cluster/health 확인해줘"
"logs-* 인덱스에서 'timeout' 검색해줘"
"대시보드 목록 보여줘"
"알림 룰 상태 확인해줘"
```

#### `kibana_es_search` 파라미터 상세

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| `index` | string | `logs-*` | 인덱스 패턴 |
| `query` | string | | lucene/키워드 쿼리 |
| `service` | string | | service 필드 필터 |
| `level` | enum | | `error` / `warn` / `info` / `debug` / `fatal` |
| `minutes` | number | | 최근 N분 |
| `size` | number | `20` | 조회 건수 (최대 100) |

#### 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `Kibana 401` | 쿠키 만료 또는 API Key 무효 | 쿠키 재발급 또는 API Key 재생성 |
| `Kibana 403` | 권한 부족 | API Key의 role에 인덱스 읽기 권한 추가 |
| `서버 시작 안 됨` | `KIBANA_URL` 미설정 | env 확인 |
| `검색 결과 0건` | 인덱스 패턴 불일치 | `kibana_data_views`로 사용 가능한 패턴 확인 후 `index` 파라미터 지정 |

---

### Grafana (grafana-mcp)

Grafana Datasource Proxy를 통한 Prometheus/Loki 조회. 백엔드 포트 차단 환경에서도 동작.

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `GRAFANA_URL` | O | | Grafana 베이스 URL |
| `GRAFANA_SA_TOKEN` | O | | Service Account Token (`glsa_...`) |
| `GRAFANA_PROM_DATASOURCE_UID` | | | Prometheus UID |
| `GRAFANA_LOKI_DATASOURCE_UID` | | | Loki UID |

**SA Token 발급:** Grafana UI → Administration → Service accounts → Add service account → Add token. Role은 `Viewer` (조회) 또는 `Editor` (annotation 포함).

**데이터소스 UID 확인:** 처음 한 번 `grafana_datasources` 호출 → UID 확인 → env에 저장.

**도구:** `grafana_metrics` `grafana_logs` `grafana_alerts` `grafana_dashboards` `grafana_annotate` `grafana_datasources`

**사용 예:**
```
"최근 30분 adapter 에러율 보여줘"
"지금 firing 알림 뭐 있어?"
"'v1.4.2 deploy' 마커 찍어줘"
```

---

### Dooray (dooray-mcp)

NHN Dooray Project(업무) + Messenger 연동.

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `DOORAY_TOKEN` | O | | API 인증 토큰 |
| `DOORAY_API_URL` | | `https://api.dooray.com` | 사내 호스팅이면 변경 |
| `DOORAY_DEFAULT_PROJECT_ID` | | | 기본 프로젝트 ID |
| `DOORAY_DEFAULT_CHANNEL_ID` | | | 기본 메신저 채널 ID |

**토큰 발급:** 두레이 → 프로필 → My Page → API 인증 토큰 → 발급 (한 번만 표시).

**프로젝트 도구 (8개):** `dooray_projects` `dooray_members` `dooray_workflows` `dooray_tasks` `dooray_task_get` `dooray_task_create` `dooray_task_update` `dooray_task_comment`

**메신저 도구 (3개):** `dooray_messenger_channels` `dooray_messenger_send` `dooray_messenger_history`

**사용 예:**
```
"내 담당 진행중 업무 보여줘"
"새 업무 만들어줘: 제목 'X 처리', 담당자 [Y]"
"이 업무 완료로 변경해줘"
"#alerts 채널에 '배포 완료' 보내줘"
```

**초기 설정 순서:**
1. `dooray_projects` → project_id 확인 → `DOORAY_DEFAULT_PROJECT_ID`에 저장
2. `dooray_workflows` → workflow ID 확인 (상태 변경 시 필요)
3. `dooray_members` → 담당자 ID 확인 (업무 할당 시 필요)

---

### GitHub Wiki (github-wiki-mcp)

GitHub Wiki 페이지 조회/검색/생성/갱신. git 기반 (clone → pull → push).

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `GITHUB_TOKEN` | O | | PAT (`repo` 스코프 필요) |
| `WIKI_REPOS` | O | | JSON map: `{"단축명":"org/repo"}` |
| `WIKI_CACHE_DIR` | | `~/.cache/github-wiki-mcp` | clone 캐시 |
| `WIKI_PULL_TTL_SEC` | | `300` | pull 간격 (초) |

> Wiki가 비활성화된 레포는 동작하지 않음. Settings → Features → Wikis 체크 + Home 페이지 1개 생성 필요.

**도구:** `wiki_list` `wiki_get` `wiki_search` `wiki_write` `wiki_history`

**사용 예:**
```
"adapter wiki 페이지 목록 보여줘"
"wiki에서 'OutOfGas' 검색해줘"
"'Deployment' 페이지 업데이트해줘"
```

---

### Workflow (workflow-mcp)

GitHub 이슈 기반 작업 자동화. 이슈 생성 → 브랜치 → 커밋 → PR.

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `PROJECT_DIR` | | `cwd` | 프로젝트 경로 |
| `GITHUB_REPO` | | `gh repo view` 자동 감지 | `org/repo` |

> `gh` CLI 설치되어 있으면 `GITHUB_REPO` 생략 가능.

**도구:** `wf_create` `wf_start` `wf_commit` `wf_pr` `wf_status`

**사용 예:**
```
"계정 중복 체크 기능 이슈 만들고 작업 시작해줘"
"이슈 42번 작업 시작해줘"
"커밋해줘"
"PR 올려줘"
"지금 작업 상태 보여줘"
```

---

### RCA (rca-mcp)

에러 근본 원인 분석. Kibana 로그 타임라인 + 성공/실패 비교 + 온체인 추적.

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `KIBANA_URL` | O | | Kibana 베이스 URL |
| `KIBANA_API_KEY` | △ | | API Key (base64) |
| `KIBANA_COOKIE` | △ | | 세션 쿠키 (fallback) |
| `RPC_TIMEOUT_MS` | | `10000` | EVM RPC 타임아웃 |

> △ API_KEY 또는 COOKIE 중 하나 필수.

EVM RPC URL은 `chain_id`로 자동 선택 (KCP=56357, Fuji=43113, Sepolia=11155111).

**도구:** `rca_timeline` `rca_compare` `rca_onchain`

**사용 예:**
```
"이 요청 타임라인 보여줘: reqId=abc-123"
"실패 요청 abc-123 성공 건이랑 비교해줘"
"txHash 0xabcd... 온체인 상태 확인해줘"
```

**RCA 분석 흐름:**
1. `rca_timeline` — request_id로 전 서비스 로그 시간순 조합
2. `rca_compare` — 동일 시간대 성공 건 자동 비교
3. `rca_onchain` — 관련 txHash 온체인 추적 (receipt + nonce + 잔고 + allowance)

---

## 4. 역할별 추천 구성

모든 서버를 다 등록할 필요 없다. 역할에 맞게 필요한 것만:

### 백엔드 개발자

```
evm-mcp, kafka-mcp, redis-mcp, kibana-mcp, workflow-mcp
```

### 운영/장애 대응

```
evm-mcp, kibana-mcp, rca-mcp, slack-mcp, grafana-mcp
```

### PM / 기획

```
dooray-mcp, slack-mcp, github-wiki-mcp
```

### 전체 (인프라/DevOps)

```
전부
```

---

## 5. 업데이트

```bash
npm update -g @stableteam/team-mcp
```

MCP 서버는 Claude Code 재시작 시 최신 코드로 실행되므로, 업데이트 후 Claude Code만 재시작하면 된다.

---

## 6. 트러블슈팅

### MCP 서버가 로드되지 않음

```bash
# CLI가 설치됐는지 확인
team-mcp

# 특정 서버 직접 실행 테스트
team-mcp evm
# Ctrl+C로 종료
```

`team-mcp` 명령이 안 되면 npm global bin이 PATH에 없는 것:

```bash
npm config get prefix
# 출력된 경로/bin 이 PATH에 있는지 확인
```

### Kibana 세션 만료

```
KIBANA_COOKIE의 sid 값은 주기적으로 만료된다.
Kibana UI 재로그인 → DevTools → Application → Cookies → sid 복사 → .mcp.json 갱신 → Claude Code 재시작
```

### Grafana 403

SA Token의 Role이 `Viewer`인데 `grafana_annotate`를 사용하면 403. `Editor`로 변경.

### GitHub Wiki clone 실패

- 레포 Wiki가 비활성화 → Settings → Features → Wikis 체크
- 페이지가 0개 → UI에서 Home 페이지 1개 생성
- PAT에 `repo` 스코프 없음 → 토큰 재발급

---

## 7. 전체 도구 요약 (55개)

| 서버 | 도구 수 | 도구 |
|------|:-------:|------|
| evm | 6 | `evm_balance` `evm_token_balance` `evm_tx` `evm_nonce` `evm_block` `evm_chain_info` |
| kafka | 4 | `kafka_list_topics` `kafka_publish` `kafka_consume` `kafka_offsets` |
| redis | 6 | `redis_keys` `redis_get` `redis_del` `redis_ttl` `redis_locks` `redis_info` |
| slack | 4 | `slack_post_message` `slack_history` `slack_replies` `slack_search` |
| kibana | 5 | `kibana_es_search` `kibana_es_request` `kibana_data_views` `kibana_saved_objects` `kibana_alerts` |
| grafana | 6 | `grafana_metrics` `grafana_logs` `grafana_alerts` `grafana_dashboards` `grafana_annotate` `grafana_datasources` |
| dooray | 11 | `dooray_projects` `dooray_members` `dooray_workflows` `dooray_tasks` `dooray_task_get` `dooray_task_create` `dooray_task_update` `dooray_task_comment` `dooray_messenger_channels` `dooray_messenger_send` `dooray_messenger_history` |
| github-wiki | 5 | `wiki_list` `wiki_get` `wiki_search` `wiki_write` `wiki_history` |
| workflow | 5 | `wf_create` `wf_start` `wf_commit` `wf_pr` `wf_status` |
| rca | 3 | `rca_timeline` `rca_compare` `rca_onchain` |
