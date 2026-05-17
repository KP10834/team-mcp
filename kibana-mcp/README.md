# kibana-mcp

> Kibana API + Console Proxy를 통한 ES 검색 / Saved Object / 알림 룰 조회

**핵심:** Kibana의 **Console Proxy** (`/api/console/proxy`)를 거쳐 Elasticsearch에 접근하므로, ES 9200 포트가 차단되어 있어도 Kibana URL만 닿으면 동작한다. `elk-mcp`의 우회 버전이라고 보면 됨.

---

## 설정

```json
"kibana-mcp": {
  "env": {
    "KIBANA_URL": "https://kibana.company.com",
    "KIBANA_API_KEY": "VnVhQ2ZHY0JDZGJrUW…"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `KIBANA_URL` | | (필수) Kibana 베이스 URL |
| `KIBANA_API_KEY` | | API Key (base64 인코딩된 `id:api_key`). **권장** |
| `KIBANA_COOKIE` | | 세션 쿠키 (SSO/Okta 환경 fallback). 형식: `sid=...; ...` |

> API_KEY 또는 COOKIE 중 **하나는 필수**. 둘 다 없으면 서버가 시작되지 않는다.

### API Key 발급

Kibana UI: **Stack Management → API keys → Create API key**.
- Role은 최소한 `kibana_admin` 또는 read-only 역할
- 발급되면 표시되는 `encoded` 값을 그대로 `KIBANA_API_KEY`에 저장

### Session Cookie (SSO 환경)

UI 로그인 → DevTools → Application → Cookies → 도메인의 `sid` 쿠키 복사:

```
KIBANA_COOKIE=sid=Fe26.2**abc123...
```

만료(보통 8시간~며칠)되면 다시 복사.

---

## 도구 (5개)

### `kibana_es_search`

ES 로그 검색 (Console Proxy 경유).

```
"오늘 adapter 서비스 ERROR 로그"
"최근 1시간 withdraw 관련 로그 50건"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `index` | string | | `logs-*` | 인덱스 패턴 |
| `query` | string | | | lucene/키워드 쿼리 |
| `service` | string | | | service 필드 매치 |
| `level` | enum | | | `error` / `warn` / `info` / `debug` / `fatal` |
| `minutes` | number | | | 최근 N분 |
| `size` | number | | `20` | 조회 건수 (최대 100) |

**출력 예시:**

```
## ES 검색 (3/47건)

- **2026-05-17T13:24:10.123Z** [error] `adapter` reqId=abc-123
  withdraw failed: OutOfGas (txHash: 0xabc...)
```

---

### `kibana_es_request`

ES 임의 요청 (모든 method/path).

```
"_cluster/health 확인해줘"
"my-index/_count 호출해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `path` | string | O | | ES 경로 (예: `_cluster/health`) |
| `method` | enum | | `GET` | `GET` / `POST` / `PUT` / `DELETE` / `HEAD` |
| `body` | object | | | JSON 요청 body |

**출력 예시:**

```
## GET _cluster/health
```json
{
  "cluster_name": "elasticsearch",
  "status": "green",
  "number_of_nodes": 3,
  ...
}
```
```

---

### `kibana_saved_objects`

대시보드 / 검색 / 시각화 등 Saved Object 조회.

```
"payment 관련 대시보드 찾아줘"
"discover에 저장된 검색 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `type` | enum | | `dashboard` | `dashboard` / `search` / `visualization` / `index-pattern` / `lens` / `map` |
| `search` | string | | | 제목 검색어 |
| `per_page` | number | | `20` | |

**출력 예시:**

```
## dashboard (2/8개)

- **Adapter Overview** (id: `abc-123`)
  https://kibana.company.com/app/dashboards#/view/abc-123
```

---

### `kibana_alerts`

Kibana Alerting 룰 목록.

```
"활성 알림 룰 보여줘"
"adapter 관련 알림 룰 검색"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `search` | string | | | 룰 이름 검색 |
| `per_page` | number | | `20` | |

---

### `kibana_data_views`

Data View (인덱스 패턴) 목록.

```
"kibana 인덱스 패턴 목록 보여줘"
```

파라미터 없음.

---

## elk-mcp vs kibana-mcp

| | `elk-mcp` | `kibana-mcp` |
|---|---|---|
| 접근 방식 | ES 9200 직접 호출 | Kibana Console proxy 경유 |
| 필요한 포트 | ES `9200` (보통 막힘) | Kibana `443/5601` (보통 열림) |
| 인증 | ES API Key / Basic | Kibana API Key / Session Cookie |
| Kibana 자체 API | ❌ 안 됨 | ✅ Saved Objects / Alerts 등 가능 |
| 권장 환경 | dev망 (직접 접근 가능) | prod / 격리망 (UI만 열린 환경) |

같은 ES 클러스터를 두 가지 방법으로 조회 가능. 환경에 맞춰 선택.

---

## 사용 시나리오: ES 9200이 막힌 환경

```
[Claude Code 로컬]
   │ HTTPS (Kibana API Key)
   ▼
[kibana.company.com:443]       ← 이거만 열려있으면 OK
   │ 내부망
   └─→ Elasticsearch:9200       ← 외부 차단
```

ES query DSL을 그대로 호출 가능. `elk-mcp` 도구를 그대로 옮겨와도 동작.

---

## 주의사항

- **kbn-xsrf 헤더 필수**: 자동으로 첨부됨. 직접 fetch할 때만 신경 쓰면 됨
- **권한**: API Key에 부여된 ES 권한 + Kibana 권한이 둘 다 적용됨
- **Bulk API 제한**: `_bulk` 대용량 스트리밍은 Console proxy로 제대로 동작 안 함. 작은 단위로 분할 권장
- **Timeout**: Kibana 기본 30s. 무거운 집계는 size 줄이거나 filter 강화
