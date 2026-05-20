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
