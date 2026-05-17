# dooray-mcp

> NHN Dooray Project(업무) + Messenger 연동

업무 생성/조회/수정/댓글 + 메신저 채널 메시지 발송/조회. 별도 SDK 없이 fetch 기반.

---

## 설정

```json
"dooray-mcp": {
  "env": {
    "DOORAY_API_URL": "https://api.dooray.com",
    "DOORAY_TOKEN": "your-personal-api-token",
    "DOORAY_DEFAULT_PROJECT_ID": "",
    "DOORAY_DEFAULT_CHANNEL_ID": ""
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DOORAY_API_URL` | `https://api.dooray.com` | NHN Cloud 두레이. 사내 호스팅이면 `https://{tenant}.dooray.com/api` |
| `DOORAY_TOKEN` | | (필수) 개인 API 인증 토큰 |
| `DOORAY_DEFAULT_PROJECT_ID` | | 자주 쓰는 프로젝트 ID — 도구에서 `project_id` 생략 시 사용 |
| `DOORAY_DEFAULT_CHANNEL_ID` | | 자주 쓰는 메신저 채널 ID — `channel_id` 생략 시 사용 |

### API 토큰 발급

두레이 우측 상단 프로필 → **My Page → API 인증 토큰** → 발급. 한 번만 표시되므로 즉시 복사.

### 인증 헤더

```
Authorization: dooray-api {TOKEN}
```

이 MCP가 자동으로 모든 요청에 첨부.

### 응답 구조

두레이 API는 모든 응답을 다음 구조로 감싼다:
```json
{ "header": { "isSuccessful": true, "resultCode": 0, "resultMessage": "" }, "result": ... }
```

이 MCP가 자동으로 `result`만 추출. `isSuccessful: false`면 에러로 변환.

---

## Project 도구 (8개)

### `dooray_projects`

참여 중인 프로젝트 목록 (project ID 확인용).

```
"내 두레이 프로젝트 목록 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `member_id` | string | | 본인 | 특정 멤버 ID 필터 |
| `size` | number | | `50` | 최대 100 |

---

### `dooray_members`

프로젝트 멤버 목록 (담당자 ID 확인용).

```
"adapter 프로젝트 멤버 보여줘"
"김XX 담당자 ID 찾아줘"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `project_id` | string | | env | |
| `name` | string | | | 이름 부분 매칭 |
| `size` | number | | `50` | |

---

### `dooray_workflows`

프로젝트 워크플로우(상태) 목록 — `task_update`의 `workflow_id` 확인용.

```
"adapter 프로젝트 상태 목록 보여줘"
```

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|:--:|---|
| `project_id` | string | | env |

**출력:**

```
## 워크플로우 (4개)

- **등록** [registered] (id: `abc-1`) · order: 0
- **진행중** [working] (id: `abc-2`) · order: 1
- **완료** [closed] (id: `abc-3`) · order: 2
```

---

### `dooray_tasks`

업무 목록 (담당자/상태/검색어 필터).

```
"내 담당 진행중 업무 보여줘"
"adapter 프로젝트에서 'OutOfGas' 들어간 업무 찾아줘"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `project_id` | string | | env | |
| `workflow_class` | enum | | | `registered` / `working` / `closed` |
| `to_member_ids` | string[] | | | 담당자 ID |
| `subject` | string | | | 제목 검색어 |
| `tag_ids` | string[] | | | |
| `milestone_ids` | string[] | | | |
| `page` | number | | `0` | 0-based |
| `size` | number | | `20` | 최대 100 |
| `order` | string | | `-createdAt` | 예: `-createdAt`, `dueDate` |

---

### `dooray_task_get`

업무 상세 + 댓글 조회.

```
"이 업무 자세히 보여줘 (id: ...)"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `project_id` | string | | env | |
| `task_id` | string | O | | |
| `include_comments` | boolean | | `true` | |

---

### `dooray_task_create`

업무 생성.

```
"새 업무 만들어줘: 제목 'X 처리', 담당자 [Y], 우선순위 high"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `project_id` | string | | env | |
| `subject` | string | O | | 제목 |
| `body` | string | O | | 본문 (markdown/HTML) |
| `body_type` | enum | | `text/x-markdown` | `text/x-markdown` / `text/html` |
| `to_member_ids` | string[] | | `[]` | 담당자 |
| `cc_member_ids` | string[] | | `[]` | 참조자 |
| `priority` | enum | | `normal` | `lowest`/`low`/`normal`/`high`/`highest` |
| `due_date` | string | | | ISO datetime (예: `2026-05-20T18:00:00+09:00`) |
| `milestone_id` | string | | | |
| `tag_ids` | string[] | | | |

---

### `dooray_task_update`

업무 수정 — **필드 변경 + 워크플로우(상태) 변경 둘 다 처리**.

```
"이 업무 완료로 변경해줘"  ← workflow_id로 닫힘 상태로
"담당자를 Y로 바꿔줘"     ← to_member_ids 갱신
"마감일 다음주 월요일로"   ← due_date 갱신
```

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|:--:|---|
| `project_id` | string | | env |
| `task_id` | string | O | |
| `subject` | string | | 제목 변경 |
| `body` | string | | 본문 변경 |
| `body_type` | enum | | |
| `to_member_ids` | string[] | | 담당자 **전체 교체** |
| `priority` | enum | | |
| `due_date` | string | | |
| `workflow_id` | string | | 상태 변경 (`dooray_workflows`로 ID 확인) |

필드 + workflow를 동시에 줘도 OK (PUT + workflow POST 둘 다 호출).

---

### `dooray_task_comment`

업무에 댓글 추가.

```
"이 업무에 'PR #142 merged' 댓글 달아줘"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `project_id` | string | | env | |
| `task_id` | string | O | | |
| `content` | string | O | | 댓글 본문 |
| `body_type` | enum | | `text/x-markdown` | |

---

## Messenger 도구 (3개)

### `dooray_messenger_channels`

참여 중인 채널 목록 (channel ID 확인용).

```
"두레이 메신저 채널 보여줘"
"public 채널만 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `type` | enum | | `all` | `bot` / `private` / `direct` / `group` / `public` / `all` |
| `size` | number | | `50` | |

---

### `dooray_messenger_send`

채널에 메시지 발송.

```
"#bc-adapter-alerts 채널에 '배포 완료' 보내줘"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `channel_id` | string | | env | |
| `text` | string | O | | 메시지 본문 |

> 토큰 사용자가 해당 채널 멤버여야 발송 가능.

---

### `dooray_messenger_history`

채널 최근 메시지 조회.

```
"#bc-adapter-alerts 최근 20개 메시지 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본 | 설명 |
|---|---|:--:|---|---|
| `channel_id` | string | | env | |
| `size` | number | | `20` | 최대 100 |

---

## 일반적 워크플로우

```
1. dooray_projects 로 project_id 확인 (한 번)
   → DOORAY_DEFAULT_PROJECT_ID 에 저장
2. dooray_workflows 로 워크플로우 ID 확인 (필요 시)
3. dooray_members 로 담당자 ID 확인 (필요 시)
4. 이후엔 자연어로:
   "내 진행중 업무" → dooray_tasks (workflow_class=working)
   "X 업무 완료" → dooray_task_update (workflow_id=closed의 ID)
   "이 업무에 댓글" → dooray_task_comment
```

---

## 주의사항

- **권한**: API 토큰은 발급자 본인 권한으로 동작. 본인이 접근 못하는 프로젝트/채널은 못 봄
- **NHN Cloud vs 사내 호스팅**: API URL이 다름. 사내 호스팅이면 `DOORAY_API_URL` 변경
- **markdown vs HTML**: 두레이는 둘 다 지원. 기본 `text/x-markdown` 권장 (Claude 출력이 자연스러움)
- **담당자 변경**: `to_member_ids`는 **전체 교체**. 일부만 추가하려면 먼저 `dooray_task_get`으로 현재 담당자 확인 후 합쳐서 전달
- **메신저 발송 제한**: bot 채널이 아닌 일반 채널은 사용자 토큰의 본인 발송으로 간주됨 (메시지가 본인 이름으로 표시)
