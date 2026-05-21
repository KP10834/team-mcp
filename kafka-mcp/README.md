# kafka-mcp

> Kafka 토픽 관리 및 메시지 발행/소비

---

## 설정

```json
"kafka-mcp": {
  "env": { "KAFKA_BROKERS": "<internal-host>:9092" }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `KAFKA_BROKERS` | `localhost:9092` | 브로커 주소 (쉼표 구분 다중 가능) |
| `KAFKA_TOPIC_PREFIX` | _(empty)_ | 토픽 필터 프리픽스 (설정 시 해당 프리픽스 토픽을 분류 표시) |

---

## 도구 (4개)

### `kafka_list_topics`

토픽 목록 조회. `KAFKA_TOPIC_PREFIX` 설정 시 해당 프리픽스 토픽과 기타를 분류하여 표시.

```
"카프카 토픽 목록 보여줘"
"현재 어떤 토픽들 있어?"
```

파라미터 없음.

**출력 예시:**

```
## Kafka 토픽 목록

- orders.created
- orders.updated
- payments.completed
- payments.failed
- users.registered
- __consumer_offsets
- connect-status
```

---

### `kafka_publish`

토픽에 JSON 메시지 발행.

```
"orders.created에 이 메시지 발행해줘"
"payment 테스트 메시지 보내줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `topic` | string | O | | 토픽명 |
| `message` | string | O | | JSON 메시지 |
| `key` | string | | | 메시지 키 |

**출력 예시:**

```
## 메시지 발행 완료

토픽: orders.created
파티션: 0
오프셋: 157
타임스탬프: 2026-04-20T10:00:00.000Z
```

---

### `kafka_consume`

토픽에서 최근 메시지 읽기. 임시 consumer group 생성 후 자동 삭제.

```
"payments.completed 최근 메시지 보여줘"
"payment 응답 메시지 3개 읽어줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `topic` | string | O | | 토픽명 |
| `count` | number | | `1` | 읽을 메시지 수 |
| `timeout` | number | | `5000` | 대기 시간 (ms) |

**출력 예시:**

```
## payments.completed 메시지 (2개)

### 메시지 1
파티션: 0 | 오프셋: 155 | 시각: 2026-04-20T09:58:12Z
{
  "orderId": "order-001",
  "status": "SUCCESS",
  "amount": 15000
}

### 메시지 2
파티션: 0 | 오프셋: 156 | 시각: 2026-04-20T09:59:30Z
{
  "orderId": "order-002",
  "status": "FAILED",
  "errorCode": "INSUFFICIENT_BALANCE"
}
```

---

### `kafka_offsets`

토픽의 파티션별 earliest / latest 오프셋 조회.

```
"orders.created 오프셋 확인해줘"
"payment 토픽에 메시지 몇 개 쌓여있어?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `topic` | string | O | | 토픽명 |

**출력 예시:**

```
## orders.created 오프셋

| 파티션 | earliest | latest | 메시지 수 |
|--------|----------|--------|----------|
| 0      | 0        | 157    | 157      |
```
