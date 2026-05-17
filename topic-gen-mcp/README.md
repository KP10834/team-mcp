# topic-gen-mcp

> Kafka 토픽 스켈레톤 자동 생성 및 ABI ↔ ChainReaderPort 동기화

---

## 설정

```json
"topic-gen-mcp": {
  "env": {
    "BOARD_DIR": "/absolute/path/to/StableCoinBC_Adapter_Board"
  }
}
```

| 환경변수 | 필수 | 기본값 | 설명 |
|---------|:----:|--------|------|
| `BOARD_DIR` | O | | StableCoinBC_Adapter_Board 레포 절대 경로 |

> `board_dir` 파라미터로 호출 시 오버라이드 가능.

---

## 도구 (2개)

### `topic_gen`

Kafka 토픽 처리에 필요한 파일을 자동 생성하고 기존 파일(`index.ts`, `env.ts`)을 수정.

```
"networkInquiry 토픽 스켈레톤 만들어줘"
"adapter.board.balanceInquiry 핸들러 생성해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `topic_key` | string | O | | camelCase 토픽 키 (예: `networkInquiry`) |
| `request_fields` | string | O | | 요청 필드 JSON (예: `{"requestId":"string","chainId":"string"}`) |
| `response_fields` | string | O | | 응답 필드 JSON (예: `{"networkId":"string","blockNumber":"number"}`) |
| `board_dir` | string | | `BOARD_DIR` 환경변수 | 경로 오버라이드 |

**생성되는 파일:**

| 파일 | 설명 |
|------|------|
| `src/domain/port/in/<kebab>.port.ts` | 입력 포트 인터페이스 |
| `src/application/<camel>/<kebab>.service.ts` | 서비스 스텁 (`// TODO: 비즈니스 로직 구현`) |
| `src/adapter/in/kafka/handlers/<kebab>.handler.ts` | Kafka 핸들러 |

**수정되는 파일:**

| 파일 | 변경 내용 |
|------|---------|
| `src/adapter/in/kafka/handlers/index.ts` | 핸들러 export 추가 |
| `src/infra/config/env.ts` | 토픽명 상수 추가 |

**Kafka 토픽 컨벤션:**
- 요청: `adapter.board.<kebab>.request`
- 응답: `adapter.board.<kebab>.result`

**출력 예시:**

```
## 스켈레톤 생성 완료

**토픽 키**: `networkInquiry`

### 생성된 파일
- .../src/domain/port/in/network-inquiry.port.ts
- .../src/application/networkInquiry/network-inquiry.service.ts
- .../src/adapter/in/kafka/handlers/network-inquiry.handler.ts

### 수정된 파일
- .../src/adapter/in/kafka/handlers/index.ts
- .../src/infra/config/env.ts

### 다음 단계
1. network-inquiry.service.ts — 비즈니스 로직 구현
2. src/index.ts — NetworkInquiryService 인스턴스 추가
3. Kafka 토픽명: adapter.board.network-inquiry.request / adapter.board.network-inquiry.result
```

---

### `topic_abi_check`

ABI JSON 파일과 `chain-reader.port.ts`를 비교하여 누락/제거된 메서드를 감지하고 구현 스니펫을 제안.

```
"ABI 변경사항 확인해줘"
"chain-reader.port.ts 동기화 필요한 메서드 있어?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `abi_path` | string | O | | ABI JSON 파일 절대 경로 |
| `board_dir` | string | | `BOARD_DIR` 환경변수 | 경로 오버라이드 |

**비교 대상:** `src/domain/port/out/chain-reader.port.ts`

**출력 예시:**

```markdown
## ABI ↔ ChainReaderPort 분석 결과

- ABI 함수: 12개
- 포트 메서드: 10개

### 누락된 메서드 (2개) — 추가 필요

#### `getBalance`

**ChainReaderPort 추가:**
```ts
getBalance(address: string): Promise<bigint>;
```

**EthersChainReaderAdapter 구현:**
```ts
async getBalance(address: string): Promise<bigint> {
  return this.contract.getBalance(address);
}
```

### ABI에 없는 포트 메서드 (1개) — 참고용
- `legacyMethod`
```
