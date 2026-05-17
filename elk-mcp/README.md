# elk-mcp

> Elasticsearch 기반 통합 로그 검색, requestId 추적, 에러 분석

---

## 설정

```json
"elk-mcp": {
  "env": {
    "ES_URL": "http://<internal-es-host>:9200",
    "ES_API_KEY": "<api-key>",
    "ES_INDEX_PATTERN": "logs-*"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `ES_URL` | `http://localhost:9200` | Elasticsearch URL |
| `ES_API_KEY` | | API Key 인증 |
| `ES_USER` | | Basic 인증 사용자명 |
| `ES_PASSWORD` | | Basic 인증 비밀번호 |
| `ES_INDEX_PATTERN` | `logs-*` | 검색 인덱스 패턴 |

> 인증 우선순위: `API Key` > `Basic Auth`

---

## 도구 (5개)

### `elk_search`

로그 검색. 서비스, 레벨, 키워드, 시간범위로 필터링.

```
"최근 30분 adapter 에러 보여줘"
"BUNDLER_BUILD_FAILED 검색해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `query` | string | | | 검색 키워드 |
| `service` | string | | | 서비스 필터 |
| `level` | enum | | | `error` `warn` `info` `debug` `fatal` |
| `minutes` | number | | | 최근 N분 |
| `size` | number | | `20` | 조회 건수 (최대 100) |

**출력 예시:**

```
## 로그 검색 결과 (3건)

쿼리: BUNDLER_BUILD_FAILED | 서비스: adapter | 레벨: error

### 2026-04-20T09:58:12Z | adapter | ERROR
requestId: req-001 | errorCode: BUNDLER_BUILD_FAILED
빌더 트랜잭션 생성 실패: insufficient gas

### 2026-04-20T09:55:30Z | adapter | ERROR
requestId: req-002 | errorCode: BUNDLER_BUILD_FAILED
빌더 응답 타임아웃 (5000ms)
```

---

### `elk_trace`

**requestId로 전체 서비스 흐름 추적.** cross-service 타임라인 + 서비스별 로그 수 + 에러 상세.

```
"이 requestId 추적해줘: abc-123-def"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `requestId` | string | O | | 추적할 requestId |
| `minutes` | number | | `1440` | 검색 범위 (기본 24시간) |

**출력 예시:**
```
# 요청 추적: abc-123-def
전체 15건, 3개 서비스

## 타임라인
| 시간 | 서비스 | 레벨 | 에러코드 | 메시지 |

## 서비스별 로그 수
- backend: 5건
- adapter: 8건 (에러 1건)
- listener: 2건

## 에러 상세
...
```

---

### `elk_error_trend`

시간대별/서비스별 에러 추이.

```
"최근 6시간 에러 추이 보여줘"
"adapter 에러 10분 단위로 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `service` | string | | | 서비스 필터 |
| `minutes` | number | | `360` | 분석 범위 (기본 6시간) |
| `interval` | enum | | `1h` | `5m` `10m` `30m` `1h` `6h` `1d` |

**출력 예시:**

```
## 에러 추이 (최근 6시간, 1h 단위)

| 시간 | adapter | backend | listener |
|------|---------|---------|---------|
| 04:00 | 0 | 2 | 0 |
| 05:00 | 3 | 1 | 0 |
| 06:00 | 12 | 0 | 1 |
| 07:00 | 8 | 0 | 0 |
| 08:00 | 1 | 3 | 0 |
| 09:00 | 0 | 1 | 0 |
```

---

### `elk_error_summary`

에러코드별/서비스별 빈도 집계. 횟수, 서비스, 마지막 발생, 메시지 샘플.

```
"지금 제일 많이 나는 에러가 뭐야?"
"adapter 최근 1시간 에러 요약해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `service` | string | | | 서비스 필터 |
| `minutes` | number | | `60` | 분석 범위 |

**출력 예시:**

```
## 에러 요약 (최근 1시간)

| 에러코드 | 횟수 | 서비스 | 마지막 발생 | 메시지 샘플 |
|---------|------|--------|------------|------------|
| BUNDLER_BUILD_FAILED | 12 | adapter | 09:58 | insufficient gas |
| INSUFFICIENT_BALANCE | 5 | adapter | 09:45 | balance 0 < amount 1000 |
| KAFKA_TIMEOUT | 3 | listener | 09:30 | consumer group lag |
```

---

### `elk_indices`

인덱스 목록 및 상태 조회. 시스템 인덱스(`.` prefix) 제외.

```
"ES 인덱스 목록 보여줘"
"어떤 인덱스들이 있어?"
```

파라미터 없음.

**출력 예시:**

```
## Elasticsearch 인덱스 목록

| 인덱스 | 상태 | 문서 수 | 크기 |
|--------|------|---------|------|
| logs-adapter-2026.04.20 | green | 142,831 | 245MB |
| logs-backend-2026.04.20 | green | 89,201 | 158MB |
| logs-listener-2026.04.20 | green | 23,541 | 42MB |
| logs-adapter-2026.04.19 | green | 521,234 | 912MB |
```

---

## 로그 필드 매핑

| 용도 | 필드 (우선순위순) |
|------|-----------------|
| 타임스탬프 | `@timestamp` > `time` > `timestamp` |
| 레벨 | `level` / `lvl` (문자열 또는 숫자) |
| 서비스 | `service` > `app` > `pm2_name` |
| 에러코드 | `errorCode` > `err.code` > `code` |
| 메시지 | `msg` > `message` |
| 추가 컨텍스트 | `requestId`, `txHash`, `chainId`, `address`, `topic` |
