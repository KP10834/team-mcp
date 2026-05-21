# rca-mcp

> 에러 근본 원인 분석 — 로그 타임라인 + 성공/실패 비교 + 온체인 추적

**핵심:** `kibana-mcp`의 ES 검색 기능 위에 RCA 특화 워크플로우를 얹은 서버. request_id 하나로 전 서비스 로그를 시간순 조합하고, 실패/성공 건을 자동 비교하고, 온체인 상태(receipt·nonce·잔고·allowance)까지 한 번에 조회한다.

---

## 설정

```json
"rca-mcp": {
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
| `ES_INDEX_PATTERN` | `*` | ES 인덱스 패턴 |
| `RPC_TIMEOUT_MS` | `10000` | EVM RPC 타임아웃 (ms) |
| `RCA_CHAIN_CONFIG` | | 추가 체인 설정 (JSON). 예: `{"1":{"name":"Mainnet","rpc":"https://..."}}` |

> API_KEY 또는 COOKIE 중 **하나는 필수**. 둘 다 없으면 서버가 시작되지 않는다.

EVM RPC URL은 `chain_id`로 자동 선택된다:

| chain_id | 체인 | 환경변수 |
|----------|------|----------|
| `43113` | Fuji | `RPC_FUJI` |
| `11155111` | Sepolia | `RPC_SEPOLIA` |

커스텀 체인은 `RCA_CHAIN_CONFIG` 환경변수(JSON)로 추가:

```json
{
  "RCA_CHAIN_CONFIG": "{\"1\":{\"name\":\"Mainnet\",\"rpc\":\"https://eth.llamarpc.com\"}}"
}
```

> 각 도구에서 `rpc_url` 파라미터로 호출 시 체인 설정을 오버라이드 가능.

---

## 도구 (3개)

### `rca_timeline`

request_id 또는 txHash로 전 서비스 로그를 시간순 타임라인으로 조합.

```
"이 요청 타임라인 보여줘: reqId=abc-123"
"txHash 0xabcd… 관련 로그 1시간치 조회"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `request_id` | string | △ | | 요청 ID |
| `tx_hash` | string | △ | | 트랜잭션 해시 |
| `minutes` | number | | `30` | 조회 범위 (최근 N분) |
| `size` | number | | `100` | 최대 조회 건수 |

> △ `request_id` 또는 `tx_hash` 중 하나 이상 필수.

**출력 예시:**

```
## RCA Timeline (12/47건, 30분)
**식별자**: abc-123

- **2026-05-17T13:24:08.100Z** [INFO] `gateway` · reqId=abc-123
  POST /api/withdraw received

- **2026-05-17T13:24:09.200Z** [INFO] `adapter` · reqId=abc-123
  sending tx to chain (chainId=11155111)

- **2026-05-17T13:24:10.123Z** [***ERROR***] `adapter` · reqId=abc-123 · txHash=0xabc…
  withdraw failed: OutOfGas
    err: code=CALL_EXCEPTION | execution reverted | cause=OutOfGas
```

---

### `rca_compare`

실패 request_id와 동일 시간대 성공 건을 자동 비교.

```
"실패 요청 abc-123 성공 건이랑 비교해줘"
"failed_id=abc-123 자동 비교"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `failed_id` | string | O | | 실패한 요청의 request_id |
| `success_id` | string | | | 성공한 요청의 request_id (생략 시 자동 탐색) |
| `minutes` | number | | `10` | 비교 시간 범위 |

> `success_id`를 생략하면 동일 시간대에서 에러가 가장 적은 requestId를 자동으로 찾아 비교한다.

**출력 예시:**

```
## RCA Compare (10분)

### FAILED: abc-123 (8건)
- **2026-05-17T13:24:08.100Z** [INFO] `gateway` · reqId=abc-123
  POST /api/withdraw received
  …
- **2026-05-17T13:24:10.123Z** [***ERROR***] `adapter` · reqId=abc-123
  withdraw failed: OutOfGas

### SUCCESS: def-456 (자동 탐색됨) (6건)
- **2026-05-17T13:24:07.050Z** [INFO] `gateway` · reqId=def-456
  POST /api/withdraw received
  …
- **2026-05-17T13:24:09.800Z** [INFO] `adapter` · reqId=def-456
  tx confirmed (txHash=0xdef…)
```

---

### `rca_onchain`

txHash의 온체인 상태를 한 번에 조회 (receipt + nonce + 잔고 + allowance).

```
"이 트랜잭션 온체인 상태 확인해줘: 0xabcd..."
"txHash 0xEFGH 온체인 분석 (체인: Fuji)"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `tx_hash` | string | O | | 트랜잭션 해시 |
| `chain_id` | string | O | | 체인 ID (예: `11155111`, `43113`) |
| `token_address` | string | | | ERC20 토큰 주소 (잔액/allowance 조회) |
| `spender_address` | string | | | Spender 주소 (기본: tx.to) |
| `rpc_url` | string | | | RPC URL 직접 지정 (체인 설정 무시) |

**출력 예시:**

```
## RCA On-chain: 0xabcd…1234
**chain**: Sepolia (11155111)

### Transaction
- **from**: 0x1111…
- **to**: 0x2222…
- **value**: 0.0 native
- **nonce**: 42
- **gasLimit**: 100000
- **block**: 1234567

### Receipt
- **status**: ***FAILED***
- **gasUsed**: 100000
- **logs**: 0건

### Nonce (0x1111…)
- **confirmed**: 43
- **pending**: 43

### Native Balance (block 1234567)
- **0x1111…**: 0.5 native

### ERC20 Balance — USDT (0xtoken…)
- **before** (block 1234566): 10000.000000 USDT
- **after**  (block 1234567): 10000.000000 USDT

### ERC20 Allowance — USDT (spender: 0x2222…)
- **before** (block 1234566): 50000.000000 USDT
- **after**  (block 1234567): 50000.000000 USDT
```

---

## team-claude `/root-cause` 커맨드와 함께 사용

team-claude의 `/root-cause` 커맨드가 이 서버의 도구를 자동으로 호출한다.

```
/root-cause abc-123
```

실행 흐름:
1. `rca_timeline` — request_id로 전 서비스 타임라인 조합
2. `rca_compare` — 동일 시간대 성공 건 자동 비교
3. `rca_onchain` — 관련 txHash 온체인 추적 (txHash가 로그에 있을 때)
4. AI가 타임라인 + 비교 + 온체인 결과를 종합해 근본 원인 보고서 생성

수동으로 각 도구를 개별 호출할 수도 있다.

---

## 주의사항

- **Kibana Console Proxy 경유**: `kibana-mcp`와 동일하게 ES 로그는 Kibana proxy를 거쳐 조회. ES 9200 직접 접근 불필요
- **인덱스 패턴**: `ES_INDEX_PATTERN` 환경변수로 설정 (기본: `*`). 특정 서비스만 필터는 로그의 `service.name` 필드로 자동 구분
- **size 제한**: `rca_timeline` 최대 500건, `rca_compare` 최대 200건. 무거운 조회는 `minutes` 줄여서 범위 좁힐 것
- **EVM RPC**: 지원 체인 외 사용 시 `rpc_url` 직접 지정 필수
