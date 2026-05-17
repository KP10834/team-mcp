# evm-mcp

> EVM 블록체인 RPC 호출 (잔액, 트랜잭션, nonce, 블록)

---

## 설정

```json
"evm-mcp": {
  "env": {
    "EVM_RPC_URL": "http://<internal-rpc-host>:8545",
    "RPC_TIMEOUT_MS": "10000"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `EVM_RPC_URL` | `http://localhost:8545` | RPC 엔드포인트 |
| `RPC_TIMEOUT_MS` | `10000` | 타임아웃 (ms) |

> 각 도구에서 `rpc_url` 파라미터로 호출 시 오버라이드 가능.

---

## 도구 (6개)

### `evm_balance`

네이티브 토큰 잔액 조회. wei → ETH 자동 변환.

```
"이 주소 잔액 확인해줘: 0x1234..."
"0xABC 주소에 ETH 얼마나 있어?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `address` | string | O | | 지갑 주소 |
| `rpc_url` | string | | | RPC URL 오버라이드 |

**출력 예시:**

```
## 잔액 조회

주소: 0x1234...abcd
잔액: 1.523400000000000000 ETH (1523400000000000000 wei)
```

---

### `evm_token_balance`

ERC20 토큰 잔액 조회. `decimals`, `symbol`, `name` 자동 표시.

```
"이 주소의 USDT 잔액 확인해줘"
"0xABC 주소 토큰 잔액 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `address` | string | O | | 지갑 주소 |
| `token` | string | O | | ERC20 컨트랙트 주소 |
| `rpc_url` | string | | | RPC URL 오버라이드 |

**출력 예시:**

```
## ERC20 토큰 잔액

주소: 0x1234...abcd
토큰: USDT (Tether USD)
컨트랙트: 0xdAC1...
잔액: 10,000.000000 USDT
```

---

### `evm_tx`

트랜잭션 정보 + 영수증 조회. `success` / `failed` 자동 판정.

```
"이 트랜잭션 상태 확인해줘: 0xabcd..."
"txHash 0xEFGH 결과 어떻게 됐어?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `tx_hash` | string | O | | 트랜잭션 해시 |
| `rpc_url` | string | | | RPC URL 오버라이드 |

**출력 예시:**

```
## 트랜잭션 조회

해시: 0xabcd...1234
상태: SUCCESS
블록: 18,542,300
from: 0x1111...
to: 0x2222...
value: 0 ETH
gas used: 48,231 / 100,000

입력 데이터:
0xa9059cbb...
```

---

### `evm_nonce`

주소의 현재 nonce 조회. confirmed / pending 모두 표시, pending 개수 자동 계산.

```
"이 주소 nonce 확인해줘"
"0xABC 현재 nonce 몇이야?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `address` | string | O | | 주소 |
| `rpc_url` | string | | | RPC URL 오버라이드 |

**출력 예시:**

```
## Nonce 조회

주소: 0x1234...abcd
confirmed nonce: 42
pending nonce: 44
pending 트랜잭션: 2개
```

---

### `evm_block`

블록 정보 조회.

```
"최신 블록 정보 보여줘"
"블록 번호 18542300 정보 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `block` | string | | `latest` | 블록 번호 또는 `latest` |
| `rpc_url` | string | | | RPC URL 오버라이드 |

**출력 예시:**

```
## 블록 정보

번호: 18,542,300
해시: 0xblock...hash
타임스탬프: 2026-04-20T10:00:00Z
트랜잭션 수: 142
gas used: 14,999,847 / 15,000,000 (99.9%)
```

---

### `evm_chain_info`

체인 정보 (chainId, name) + 최신 블록 번호 조회.

```
"연결된 체인 정보 보여줘"
"RPC 연결 상태 확인해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `rpc_url` | string | | | RPC URL 오버라이드 |

**출력 예시:**

```
## 체인 정보

chainId: 1 (Ethereum Mainnet)
최신 블록: 18,542,300
RPC: http://<internal-rpc-host>:8545
```
