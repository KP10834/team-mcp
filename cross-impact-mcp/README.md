# cross-impact-mcp

> 변경한 코드가 다른 프로젝트에 영향을 주는지 자동으로 분석. 설정은 레포 목록만.

---

## 설정

```json
"cross-impact-mcp": {
  "env": {
    "GITHUB_TOKEN": "<token>",
    "REPOS": "{\"adapter\":{\"repo\":\"StableCoinTF/StableCoinBC_Adapter\",\"base\":\"main\"},\"backend\":{\"repo\":\"StableCoinTF/StableCoinBE_Wallet\",\"base\":\"wallet_master\"},\"frontend\":\"StableCoinTF/StableCoinFE\",\"listener\":\"StableCoinTF/StableCoinBC_Adapter_Listener\",\"docs\":\"StableCoinTF/StableCoinBC_Adapter_Docs\"}"
  }
}
```

| 변수 | 필수 | 설명 |
|------|:----:|------|
| `GITHUB_TOKEN` | O | GitHub API 토큰 |
| `GITHUB_API_URL` | | Enterprise용 (기본: `https://api.github.com`) |
| `REPOS` | O | 레포 목록 JSON |

### REPOS 형식

```json
{
  "adapter": { "repo": "StableCoinTF/StableCoinBC_Adapter", "base": "main" },
  "backend": { "repo": "StableCoinTF/StableCoinBE_Wallet", "base": "wallet_master" },
  "frontend": "StableCoinTF/StableCoinFE",
  "listener": "StableCoinTF/StableCoinBC_Adapter_Listener",
  "docs": "StableCoinTF/StableCoinBC_Adapter_Docs"
}
```

> 단축형 `"org/repo"` = `{ "repo": "org/repo", "base": "main" }`
> 경로 설정, 토픽 설정 불필요 — 변경 내용에서 자동 추출

---

## 동작 원리

```
1. 변경 파일에서 키워드 자동 추출
   ┌─ 파일명:  payment.controller.ts → "payment"
   ├─ diff:    "adapter.payment.request" → Kafka 토픽명
   ├─ diff:    "/api/payment/refund" → API 경로
   └─ diff:    export interface PaymentDto → 타입명

2. 추출된 키워드를 다른 레포에서 GitHub 코드 검색

3. 위험도 자동 판단
   ┌─ CRITICAL: 파일 삭제, 파일명 변경, export/타입/인터페이스 삭제
   ├─ WARNING:  필드 변경, 시그니처 수정 (삭제+추가 동시)
   └─ INFO:    코드 추가만 (하위호환 가능성 높음)
```

---

## 슬래시 커맨드

```
/impact adapter feature/add-fee          → adapter 브랜치 영향 분석
/impact backend fix/payment --base dev   → dev 기준 비교
/impact                                   → 등록된 레포 목록
```

---

## 도구 (4개)

### `cross_impact_changes` — 내 변경이 어디에 영향을 주는지

변경 파일에서 키워드를 자동 추출하고, 다른 레포에서 해당 키워드를 사용하는 곳을 찾아 위험도 리포트.

```
"backend feature/payment-refund 영향 분석해줘"
"adapter에서 바꾼 거 다른 데 영향 있어?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `repo` | string | O | | 분석할 레포 이름 |
| `head` | string | O | | 비교할 브랜치/태그 |
| `base` | string | | 레포별 기본 | 기준 브랜치 |

**응답 예시:**

```markdown
## backend (feature/payment-refund) 영향 분석

변경 파일: 4개
추출 키워드: 5개
영향 레포: 2개

### CRITICAL (배포 시 버그 위험)

| 대상 | 키워드 | 위험 사유 | 내 파일 | 상대 파일 |
| --- | --- | --- | --- | --- |
| frontend | `payment-legacy` | 파일 삭제됨 | src/dto/payment-legacy.dto.ts | src/api/payment-legacy.ts |

### WARNING (동작하지만 문제 가능)

| 대상 | 키워드 | 위험 사유 | 내 파일 | 상대 파일 |
| --- | --- | --- | --- | --- |
| frontend | `PaymentRefundDto` | export/타입 변경 | apps/api/controllers/payment.controller.ts | src/types/payment.d.ts |
| frontend | `/api/payment/refund` | 코드 수정 | src/routes/payment.route.ts | src/api/payment.ts |
| adapter | `adapter.payment.request` | 코드 수정 | apps/worker/payment/payment.handler.ts | payment.handler.ts |

### INFO (확인 권장)

| 대상 | 키워드 | 위험 사유 | 내 파일 | 상대 파일 |
| --- | --- | --- | --- | --- |
| frontend | `payment` | 코드 수정 | apps/api/controllers/payment.controller.ts | src/services/paymentService.ts |

---
요약: CRITICAL 1건, WARNING 3건, INFO 1건
```

---

### `cross_impact_compare` — 양쪽 코드 상세 비교

특정 키워드 기준으로 내 diff와 상대 레포의 관련 코드를 나란히 비교.

```
"PaymentRefundDto 기준으로 backend랑 frontend 코드 비교해줘"
"adapter.payment.request 토픽 양쪽 코드 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `keyword` | string | O | | 비교할 키워드 (토픽명, 리소스명, 타입명 등) |
| `sourceRepo` | string | O | | 변경이 발생한 레포 |
| `head` | string | O | | 변경 브랜치 |
| `targetRepo` | string | | 나머지 전체 | 비교 대상 레포 |
| `base` | string | | 레포별 기본 | 기준 브랜치 |

**응답 예시:**

```json
{
  "keyword": "PaymentRefundDto",
  "source": {
    "repo": "backend",
    "head": "feature/payment-refund",
    "changedFiles": ["apps/api/controllers/payment.controller.ts"],
    "diffs": {
      "apps/api/controllers/payment.controller.ts": "@@ -15,7 +15,8 @@\n-export interface PaymentRefundDto {\n-  requestId: string;\n-  amount: number;\n+export interface PaymentRefundDto {\n+  requestId: string;\n+  amount: number;\n+  reason: string;  // 새 필수 필드"
    }
  },
  "targets": {
    "frontend": {
      "src/types/payment.d.ts": [
        {
          "file": "src/types/payment.d.ts",
          "lineStart": 42,
          "content": "export interface PaymentRefundDto {\n  requestId: string;\n  amount: number;\n}\n\n// reason 필드 없음 → 프론트에서 보내지 않아서 백엔드 validation 실패 가능"
        }
      ]
    }
  }
}
```

---

### `cross_impact_watch` — 다른 팀이 바꾼 것 중 나한테 영향 있는 것

다른 레포의 최근 PR 중 내 프로젝트에 영향을 줄 수 있는 변경을 자동 탐지.

```
"최근에 다른 프로젝트에서 adapter에 영향 줄 만한 변경 있어?"
"backend 쪽 최근 변경이 우리 프론트에 영향 주는 거 있어?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `myRepo` | string | O | | 내 레포 이름 |
| `days` | number | | `7` | 최근 N일 |
| `count` | number | | `10` | 레포당 PR 수 |

**응답 예시:**

```markdown
## adapter에 영향 가능한 최근 7일 변경

| 위험 | 레포 | PR | 상태 | 영향 키워드 | 내 파일 |
| --- | --- | --- | --- | --- | --- |
| **CRITICAL** | backend | #89 결제 스키마 리팩토링 | merged | payment, PaymentRequest | payment.handler.ts |
| **WARNING** | backend | #91 정산 배치 수정 | open | settlement | settlement.handler.ts |
| **INFO** | frontend | #203 잔액 조회 UI 개선 | merged | balance | balance.handler.ts |

총 3건
```

---

### `cross_impact_repos` — 등록된 레포 목록

```
"등록된 레포 보여줘"
```

**응답 예시:**

```markdown
## 등록된 레포

- **adapter**: StableCoinTF/StableCoinBC_Adapter (base: main)
- **backend**: StableCoinTF/StableCoinBE_Wallet (base: wallet_master)
- **frontend**: StableCoinTF/StableCoinFE (base: main)
- **listener**: StableCoinTF/StableCoinBC_Adapter_Listener (base: main)
- **docs**: StableCoinTF/StableCoinBC_Adapter_Docs (base: main)
```

---

## 프롬프트: `cross-impact-analyze`

전체 분석을 한 번에 실행. `changes` → `compare` → 리포트.

```
"backend feature/payment-refund 브랜치 전체 영향 분석해줘"
```

**전체 흐름:**

```
1. cross_impact_changes 호출
   → 키워드 추출 + 다른 레포 검색 + 위험도 분류

2. CRITICAL/WARNING 항목에 대해 cross_impact_compare 호출
   → 양쪽 코드 비교, 구체적인 호환성 문제 분석

3. 최종 리포트
   → 영향 요약 + 상세 분석 + 조치 체크리스트
```

---

## 위험도 기준

| 등급 | 자동 판단 기준 | 예시 |
|------|-------------|------|
| **CRITICAL** | 파일 삭제, 파일명 변경, export/타입/인터페이스 삭제 | dto 삭제 → 프론트 import 깨짐 |
| **WARNING** | 필드 변경, 시그니처 수정, 코드 수정(삭제+추가) | 필수 필드 추가 → 상대쪽 validation 실패 |
| **INFO** | 코드 추가만 (하위호환 가능성 높음) | 새 엔드포인트 추가 |

---

## 사용 시나리오

### 백엔드 개발자

```
"backend feature/payment-refund 영향 분석해줘"
→ 프론트: payment-legacy.dto 삭제 CRITICAL, PaymentRefundDto 변경 WARNING
→ adapter: payment 토픽 관련 코드 수정 WARNING
```

### 어댑터 개발자

```
"adapter feature/add-fee 영향 분석해줘"
→ backend: payment.handler 변경 → Kafka 메시지 스키마 WARNING
→ docs: AsyncAPI 불일치 INFO
```

### 프론트엔드 개발자

```
"최근에 다른 프로젝트에서 frontend에 영향 줄 만한 변경 있어?"
→ backend #89 결제 스키마 리팩토링 CRITICAL
→ backend #92 새 API 추가 INFO
```
