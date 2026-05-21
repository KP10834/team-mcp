# redis-mcp

> Redis 키 조회/삭제, 락 관리, 서버 모니터링

---

## 설정

```json
"redis-mcp": {
  "env": {
    "REDIS_HOST": "<internal-host>",
    "REDIS_PORT": "6379",
    "REDIS_DB": "0",
    "REDIS_KEY_PREFIX": "myapp:"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `REDIS_HOST` | `localhost` | 호스트 |
| `REDIS_PORT` | `6379` | 포트 |
| `REDIS_DB` | `0` | DB 인덱스 |
| `REDIS_PASSWORD` | | 비밀번호 |
| `REDIS_KEY_PREFIX` | _(empty)_ | 키 프리픽스 (조회 시 자동 적용) |

---

## 도구 (6개)

### `redis_keys`

패턴으로 키 검색. `REDIS_KEY_PREFIX` 자동 적용.

```
"redis에 account 관련 키 있어?"
"nonce 키 목록 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `pattern` | string | | `*` | 검색 패턴 (예: `account:*`, `lock:*`) |

**출력 예시:**

```
## Redis 키 목록 (pattern: account:*)

- myapp:account:0x1111...1111
- myapp:account:0x2222...2222
- myapp:account:0x3333...3333

총 3개
```

---

### `redis_get`

키 값 조회. `string` / `hash` / `list` / `set` / `zset` 타입 자동 감지.

```
"redis에서 account:0x1234 값 보여줘"
"nonce:0xABC 확인해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `key` | string | O | | 키 (prefix 제외) |

**출력 예시:**

```
## myapp:account:0x1234...

타입: hash
TTL: 3600초

{
  "address": "0x1234...",
  "nonce": "42",
  "status": "ACTIVE"
}
```

---

### `redis_del`

키 삭제.

```
"redis에서 lock:payment:test-001 삭제해줘"
"account:0x1234 키 지워줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `key` | string | O | | 키 (prefix 제외) |

**출력 예시:**

```
## 삭제 완료

키: myapp:lock:payment:test-001
```

---

### `redis_ttl`

키 TTL 조회.

```
"account:0x1234 TTL 확인해줘"
"이 키 언제 만료돼?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `key` | string | O | | 키 (prefix 제외) |

> 결과: `-2` (키 없음/만료) / `-1` (영구) / `N` (남은 초)

**출력 예시:**

```
## myapp:account:0x1234... TTL

남은 시간: 1800초 (30분)
```

---

### `redis_locks`

활성 락 목록 조회. `{prefix}lock:*` 패턴으로 자동 검색.

```
"redis에 락 걸린 키 있어?"
"현재 활성 락 보여줘"
```

파라미터 없음.

**출력 예시:**

```
## 활성 락 목록 (3개)

| 키 | TTL |
|----|-----|
| myapp:lock:payment:req-001 | 28초 |
| myapp:lock:withdraw:req-002 | 55초 |
| myapp:lock:nonce:0x1234 | 12초 |
```

---

### `redis_info`

Redis 서버 정보 요약. memory / clients / keyspace / server 섹션만 표시.

```
"redis 서버 상태 보여줘"
"redis 메모리 얼마나 써?"
```

파라미터 없음.

**출력 예시:**

```
## Redis 서버 정보

### Server
- redis_version: 7.0.11
- uptime_in_days: 12

### Memory
- used_memory_human: 48.23M
- maxmemory_human: 0B (제한 없음)

### Clients
- connected_clients: 8

### Keyspace
- db0: keys=1243, expires=891
```
