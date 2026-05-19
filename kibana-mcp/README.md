# kibana-mcp

> Kibana API + Console Proxy를 통한 ES 검색 / Saved Object / 알림 룰 조회

**핵심:** Kibana의 **Console Proxy** (`/api/console/proxy`)를 거쳐 Elasticsearch에 접근하므로, ES 9200 포트가 차단되어 있어도 Kibana URL만 닿으면 동작한다.

---

## 설정

```json
"kibana-mcp": {
  "type": "stdio",
  "command": "node",
  "args": ["<team-mcp 경로>/kibana-mcp/index.js"],
  "env": {
    "KIBANA_URL": "http://<kibana-host>:5601",
    "KIBANA_API_KEY": "<encoded-api-key>",
    "KIBANA_COOKIE": "sid=<session-cookie>"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `KIBANA_URL` | | (필수) Kibana 베이스 URL |
| `KIBANA_COOKIE` | | (필수) 세션 쿠키. 형식: `sid=...` |

### Session Cookie 얻기

UI 로그인 → DevTools → Application → Cookies → 도메인의 `sid` 쿠키 복사.
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

## 사용 시나리오: ES 9200이 막힌 환경

```
[Claude Code 로컬]
   │ HTTPS (Kibana API Key)
   ▼
[kibana.company.com:443]       ← 이거만 열려있으면 OK
   │ 내부망
   └─→ Elasticsearch:9200       ← 외부 차단
```

ES query DSL을 그대로 호출 가능.

---

## 주의사항

- **kbn-xsrf 헤더 필수**: 자동으로 첨부됨. 직접 fetch할 때만 신경 쓰면 됨
- **권한**: API Key에 부여된 ES 권한 + Kibana 권한이 둘 다 적용됨
- **Bulk API 제한**: `_bulk` 대용량 스트리밍은 Console proxy로 제대로 동작 안 함. 작은 단위로 분할 권장
- **Timeout**: Kibana 기본 30s. 무거운 집계는 size 줄이거나 filter 강화
