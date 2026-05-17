# qa-mcp

> 현재 브랜치 자동 테스트 — 핸들러 코드를 읽고 테스트 메시지를 자동 생성하여 Kafka 기반 E2E 테스트 실행

---

## 설정

```json
"qa-mcp": {}
```

> **설정 불필요.** 프로젝트 `.env` 파일에서 Kafka, Redis 등 자동 로드.

### 슬래시 커맨드

`/qa` 슬래시 커맨드로 `qa_test_branch`를 간편하게 실행 가능:

```
/qa                    → 변경 핸들러만 테스트
/qa --all              → 전체 회귀 테스트 포함
/qa --skip-build       → 빌드 건너뛰기
/qa --base dev         → dev 기준 비교
/qa --keep-alive       → 테스트 후 서비스 유지
```

<details>
<summary>자동 감지 항목</summary>

| 항목 | 감지 소스 | 기본값 |
|------|----------|--------|
| 프로젝트 경로 | `process.cwd()` | 현재 디렉토리 |
| 빌드 명령어 | `package.json` scripts | `npm run build` |
| 시작 명령어 | `package.json` scripts | `npm run start:dev` |
| Kafka 브로커 | `.env` → `KAFKA_BROKERS` | `localhost:9092` |
| Redis 접속 | `.env` → `REDIS_HOST`, `REDIS_PORT` | `localhost:6379` |
| Bundler URL | `.env` → `BUNDLER_URL` | `http://localhost:3000/api/bundler` |
| 핸들러 경로 | | `src/adapter/in/kafka/handlers` |
| 부모 브랜치 | `git reflog` → `Created from xxx` | `dev` |

</details>

---

## 핵심 사용법

### "테스트해줘" → `qa_test_branch`

현재 브랜치에서 변경한 내용을 자동으로 테스트.

```
"테스트해줘"
"전체 회귀 테스트도 같이 돌려줘"  →  testAll: true
```

**실행 흐름:**

```
1. 변경 분석
   git diff {부모브랜치} → 변경 파일 파악 → 영향 핸들러 감지

2. 빌드
   npm run build → 실패 시 에러 리포트하고 중단

3. 서비스 시작
   pm2 start → 프로세스 상태 확인 → 실패 시 에러 로그 출력하고 중단

4. 인프라 연결 확인
   Kafka / Redis / Bundler / RPC / Database / Health 체크
   → Kafka 실패 시 중단, 나머지는 경고 후 계속

5. 변경 기능 테스트
   핸들러 코드의 Zod 스키마 → 테스트 메시지 자동 생성 → Kafka 발행 → 응답 검증

6. 회귀 테스트 (testAll 시)
   나머지 전체 핸들러도 동일하게 테스트

7. 서비스 중지
```

| 파라미터 | 타입 | 기본값 | 설명 |
|---------|------|--------|------|
| `base` | string | 부모 자동 감지 | 비교 기준 브랜치 |
| `skipBuild` | boolean | `false` | 빌드 건너뛰기 |
| `keepAlive` | boolean | `false` | 테스트 후 서비스 유지 |
| `timeout` | number | `15000` | 응답 대기 ms |
| `testAll` | boolean | `false` | 회귀 테스트 포함 |

---

## 개별 도구

### `qa_handlers`

핸들러 목록 조회. 코드에서 토픽/필드 수 자동 분석.

```
"핸들러 목록 보여줘"
"어떤 핸들러들 있어?"
```

파라미터 없음.

**출력 예시:**

```
## 핸들러 목록 (4개)

| 핸들러 | 토픽 | 필드 수 |
|--------|------|---------|
| payment | adapter.payment.request | 8 |
| withdraw | adapter.withdraw.request | 6 |
| account-create | adapter.account.create | 4 |
| balance | adapter.balance.inquiry | 3 |
```

---

### `qa_analyze`

핸들러 스키마 상세 분석. 필드별 타입/필수/nullable + 자동 생성된 테스트 메시지 표시.

```
"payment 스키마 분석해줘"
"withdraw 핸들러 테스트 메시지 어떻게 생성돼?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `handler` | string | O | | 핸들러 이름 (예: `payment`, `account-create`) |

**출력 예시:**

```
## payment 핸들러 분석

토픽: adapter.payment.request → adapter.payment.result

### 스키마
| 필드 | 타입 | 필수 | nullable |
|------|------|:----:|:--------:|
| requestId | string | O | |
| fromAddress | string | O | |
| toAddress | string | O | |
| amount | string | O | |
| chainId | string | O | |

### 자동 생성 테스트 메시지
{
  "requestId": "qa-test-1713000000000",
  "fromAddress": "0x1111...1111",
  "toAddress": "0x2222...2222",
  "amount": "1000",
  "chainId": "1"
}
```

---

### `qa_test`

특정 핸들러 단건 테스트.

```
"payment 테스트해줘"
"payment amount 5000으로 테스트해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `handler` | string | O | | 핸들러 이름 |
| `overrides` | string | | | 필드 덮어쓰기 JSON |
| `timeout` | number | | `15000` | 응답 대기 ms |

---

### `qa_test_all`

전체 또는 지정 핸들러 일괄 테스트.

```
"전체 핸들러 테스트 돌려줘"
"payment, withdraw만 테스트해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `handlers` | string | | 전체 | 콤마 구분 핸들러 목록 |
| `timeout` | number | | `15000` | 응답 대기 ms |

---

### `qa_build` / `qa_start` / `qa_stop`

빌드, 서비스 시작/중지를 개별 실행.

```
"빌드만 해봐"
"서비스 올려줘"
"서비스 내려줘"
```

---

### `qa_pipeline`

풀 파이프라인 (빌드 → 시작 → 테스트 → 중지). `qa_test_branch`와 달리 git diff 없이 지정 핸들러 테스트.

```
"payment, withdraw 파이프라인 돌려줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `handlers` | string | | 전체 | 콤마 구분 핸들러 목록 |
| `skipBuild` | boolean | | `false` | 빌드 건너뛰기 |
| `keepAlive` | boolean | | `false` | 서비스 유지 |
| `timeout` | number | | `15000` | 응답 대기 ms |

---

## 자동 감지 상세

### 부모 브랜치 감지

```
git checkout -b feature/add-fee dev
→ reflog: "branch: Created from dev"
→ 부모: dev
```

1. `git reflog`에서 `Created from xxx` 기록
2. 없으면 커밋 거리가 가장 가까운 브랜치

---

### 변경 영향 핸들러 감지

| 변경 파일 | 감지 결과 |
|----------|----------|
| `kafka/handlers/payment.handler.ts` | → `payment` 직접 변경 |
| `application/payment.service.ts` | → `payment` 연관 |
| `domain/model/payment.model.ts` | → `payment` 연관 |
| `adapter/out/bundler/...` | → import하는 핸들러 전부 |
| `config/env.ts` `bootstrap/...` | → **전체 핸들러** |

---

### 테스트 메시지 자동 생성

Zod 스키마를 파싱하여 필드별 적절한 테스트 값 생성:

| 필드 패턴 | 생성 값 |
|----------|---------|
| `requestId` | `qa-test-1713000000000` |
| `*address*` | `0x1111...1111` (40자리) |
| `*txHash*` | `0xaaaa...aaaa` (64자리) |
| `*Id` | `test-{필드명}-001` |
| `*amount*` | `1000` |
| `*chainId*` | `1` |
| `*currency*` | `KRW` |
| enum | 첫 번째 값 |

---

### 인프라 헬스 체크

서비스 시작 후, 테스트 전에 전체 인프라 연결 상태를 확인:

| 서비스 | 체크 방법 | 실패 시 |
|--------|---------|---------|
| **Kafka** | `admin.listTopics()` | 파이프라인 **중단** |
| Health | `GET :8081/health` | 경고 후 계속 |
| Redis | `PING` | 경고 후 계속 |
| Bundler | `GET {BUNDLER_URL}` | 경고 후 계속 |
| RPC | `eth_blockNumber` | 경고 후 계속 |
| Database | 파일 존재 확인 | 경고 후 계속 |

> Kafka만 critical. 나머지는 경고 후 테스트 진행하며, 관련 핸들러에서 비즈니스 에러로 실패 원인 표시.
