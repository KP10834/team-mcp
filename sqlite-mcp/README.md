# sqlite-mcp

> SQLite 데이터베이스 읽기 전용 조회

---

## 설정

```json
"sqlite-mcp": {
  "env": { "DATA_DIR": "./data" }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DATA_DIR` | `./data` | DB 파일 디렉토리 |
| `SQLITE_DATABASES` | | DB 매핑 (`name1:file1.db,name2:file2.db`) |

기본 로드 DB: `account.db`, `config.db`, `outbox.db`, `keys.db`

다른 DB를 사용하는 프로젝트는 `SQLITE_DATABASES`로 지정:

```json
"env": {
  "DATA_DIR": "./data",
  "SQLITE_DATABASES": "users:users.db,orders:orders.db"
}
```

> 읽기 전용 (`SELECT`, `WITH`, `PRAGMA` 만 허용). INSERT/UPDATE/DELETE 차단.

---

## 도구 (4개)

### `sqlite_tables`

DB 테이블 및 컬럼 구조 조회. 컬럼명, 타입, PK, NOT NULL 자동 추출.

```
"account DB 테이블 구조 보여줘"
"DB에 어떤 테이블들 있어?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `db` | string | | | DB명. 생략 시 전체 DB 표시 |

**출력 예시:**

```
## account.db 테이블 목록

### accounts (5개 컬럼)
| 컬럼 | 타입 | PK | NOT NULL |
|------|------|:--:|:--------:|
| id | TEXT | O | O |
| address | TEXT | | O |
| status | TEXT | | O |
| created_at | INTEGER | | O |
| updated_at | INTEGER | | |

### nonces (3개 컬럼)
| 컬럼 | 타입 | PK | NOT NULL |
|------|------|:--:|:--------:|
| address | TEXT | O | O |
| nonce | INTEGER | | O |
| updated_at | INTEGER | | |
```

---

### `sqlite_query`

SQL SELECT 쿼리 직접 실행.

```
"account DB에서 최근 생성된 계정 10개 보여줘"
"status가 ACTIVE인 계정 수 알려줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `db` | string | O | | DB명 |
| `sql` | string | O | | SELECT 쿼리 |
| `limit` | number | | `50` | 최대 결과 수 |

**출력 예시:**

```
## 쿼리 결과 (3건)

SQL: SELECT * FROM accounts WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 3

| id | address | status | created_at |
|----|---------|--------|------------|
| acc-001 | 0x1111... | ACTIVE | 1713600000 |
| acc-002 | 0x2222... | ACTIVE | 1713599000 |
| acc-003 | 0x3333... | ACTIVE | 1713598000 |
```

---

### `sqlite_recent`

테이블 최근 N건 조회. `created_at` 또는 `id` 기준 자동 정렬.

```
"outbox 테이블 최근 5건 보여줘"
"account DB payment 테이블 최근 데이터 확인해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `db` | string | O | | DB명 |
| `table` | string | O | | 테이블명 |
| `count` | number | | `10` | 조회 건수 |
| `order_by` | string | | | 정렬 컬럼 (생략 시 자동 감지) |

**출력 예시:**

```
## outbox.db / outbox 최근 5건

| id | topic | status | created_at |
|----|-------|--------|------------|
| out-005 | adapter.payment.request | SENT | 1713600500 |
| out-004 | adapter.withdraw.request | SENT | 1713600400 |
| out-003 | adapter.payment.request | FAILED | 1713600300 |
| out-002 | adapter.payment.request | SENT | 1713600200 |
| out-001 | adapter.account.create | SENT | 1713600100 |
```

---

### `sqlite_count`

DB별 / 테이블별 행 수 조회.

```
"DB별 데이터 몇 건씩 있어?"
"account 테이블 몇 개야?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `db` | string | | | DB명. 생략 시 전체 DB |

**출력 예시:**

```
## DB 행 수 현황

### account.db
| 테이블 | 행 수 |
|--------|-------|
| accounts | 1,243 |
| nonces | 1,198 |

### outbox.db
| 테이블 | 행 수 |
|--------|-------|
| outbox | 48,721 |
```
