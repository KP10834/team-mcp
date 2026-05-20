# workflow-mcp

> GitHub 이슈 기반 작업 자동화 — 이슈 생성 → 브랜치 → 커밋 → PR

---

## 설정

```json
"workflow-mcp": {
  "env": {
    "PROJECT_DIR": "/path/to/project",
    "GITHUB_REPO": "org/repo"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PROJECT_DIR` | `process.cwd()` | 프로젝트 경로 |
| `GITHUB_REPO` | `gh repo view`로 자동 감지 | GitHub 레포 (예: `org/repo`) |

> `gh` CLI가 설치되어 있으면 `GITHUB_REPO` 생략 가능.

### 브랜치/커밋 네이밍 커스터마이징

`package.json`의 `workflow` 필드로 포맷 변경 가능:

```json
{
  "workflow": {
    "branchFormat": "{type}/issue-{issueNumber}",
    "commitFormat": "{type}: {message} #{issueNumber}",
    "prTitleFormat": "{type}: {issueTitle} #{issueNumber}",
    "defaultType": "feat",
    "labels": { "feat": "enhancement", "fix": "bug" }
  }
}
```

---

## 슬래시 커맨드

`/workflow` 슬래시 커맨드로 서브커맨드 형태로 사용 가능:

```
/workflow create 계정 생성 시 중복 체크 추가
/workflow start 42
/workflow commit 중복 체크 로직 추가
/workflow pr
/workflow status
```

---

## 도구 (5개)

### `wf_create`

이슈 생성 + 브랜치 생성 + 체크아웃까지 한번에.

```
"계정 중복 체크 기능 이슈 만들고 작업 시작해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `title` | string | O | | 이슈 제목 |
| `body` | string | | | 이슈 본문 |
| `type` | string | | `feat` | 작업 유형 (feat, fix, refactor, docs, chore, test) |
| `labels` | string | | | 라벨 (콤마 구분) |
| `base` | string | | 자동 감지 | 분기 기준 브랜치 |
| `confirmed` | boolean | | `false` | base 브랜치 확인 완료 여부 |

**흐름:**
1. GitHub 이슈 생성 (라벨 자동 매핑)
2. base 브랜치에서 `{type}/issue-{번호}` 브랜치 생성
3. 체크아웃

**출력 예시:**

```
## 이슈 생성 완료

이슈: #47 계정 중복 체크 기능 추가
브랜치: feat/issue-47
base: dev
현재 브랜치: feat/issue-47
```

---

### `wf_start`

기존 이슈 번호로 작업 시작. 이슈 읽기 → 브랜치 생성 → 체크아웃.

```
"이슈 42번 작업 시작해줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `issue` | number | O | | GitHub 이슈 번호 |
| `type` | string | | 라벨 자동 판단 | 브랜치 타입 |
| `base` | string | | 자동 감지 | 분기 기준 브랜치 |
| `confirmed` | boolean | | `false` | base 브랜치 확인 완료 여부 |

> 이미 존재하는 브랜치면 체크아웃만 수행 (작업 재개).

**출력 예시:**

```
## 작업 시작

이슈: #42 출금 요청 잔액 부족 에러 처리
브랜치: fix/issue-42 (신규 생성)
base: dev
현재 브랜치: fix/issue-42
```

---

### `wf_commit`

변경사항 분석 → Conventional Commits 형식으로 커밋.

```
"커밋해줘"                    → diff 정보 제공, 메시지 제안
"중복 체크 로직 추가 커밋해줘"  → 바로 커밋
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `message` | string | | | 커밋 메시지 (생략 시 diff 정보 제공) |
| `type` | string | | 브랜치명 추출 | 커밋 타입 |

**자동 처리:**
- 브랜치명 `feat/issue-42` → 커밋 타입 `feat`, 이슈 번호 `#42` 자동 추가
- 스테이지 안 된 파일이 있으면 목록만 표시하고 `git add`를 안내
- 커밋 메시지 포맷: `{type}: {message} #{issueNumber}`

**출력 예시:**

```
## 커밋 완료

커밋: feat: 계정 중복 체크 로직 추가 #47
해시: a3f2c1d
변경: 3 files changed, 52 insertions(+), 4 deletions(-)
```

---

### `wf_pr`

push + PR 생성. PR 템플릿 자동 적용, 이슈 자동 연결.

```
"PR 올려줘"
"드래프트 PR 만들어줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|:----:|--------|------|
| `title` | string | | 이슈 제목 기반 | PR 제목 |
| `draft` | boolean | | `false` | Draft PR 생성 |
| `base` | string | | 부모 브랜치 자동 감지 | PR 대상 브랜치 |

**자동 생성 PR 본문:**
- 개요 (이슈 연결)
- 변경 사항 (커밋 목록)
- 변경 유형 체크박스 (feat/fix/refactor 등 자동 체크)
- 변경 범위 체크박스 (domain/application/adapter 등 파일 경로 기반)
- 테스트 방법
- 체크리스트
- `closes #이슈번호` 자동 삽입

**출력 예시:**

```
## PR 생성 완료

PR #51: feat: 계정 중복 체크 기능 추가 #47
URL: https://github.com/org/repo/pull/51
base: dev ← feat/issue-47
closes #47
```

---

### `wf_status`

현재 작업 상태 조회. 브랜치, 이슈, 변경사항, 커밋 이력, PR 상태.

```
"지금 작업 상태 보여줘"
"현재 작업 중인 이슈 뭐야?"
```

파라미터 없음.

**출력 예시:**

```
## 작업 상태

브랜치: feat/issue-47
이슈: #47 계정 중복 체크 기능 추가 [open]
base: dev

변경 파일: 3개
- src/application/account/account.service.ts (M)
- src/adapter/in/kafka/handlers/account-create.handler.ts (M)
- src/domain/port/in/account.port.ts (M)

커밋 이력 (1개):
- feat: 계정 중복 체크 로직 추가 #47 (a3f2c1d)

PR: 없음
```

---

## 부모 브랜치 자동 감지

`wf_create`, `wf_start`, `wf_pr`에서 base 브랜치를 자동 감지:

1. `git reflog`에서 `Created from xxx` 기록
2. 없으면 커밋 거리가 가장 가까운 브랜치

감지 결과는 **확인을 요청**함 → `confirmed: true`로 재호출하거나 `base`를 직접 지정.

---

## 라벨 → 타입 자동 매핑

이슈 라벨에서 브랜치/커밋 타입을 자동 판단:

| 라벨 키워드 | 타입 |
|-----------|------|
| `bug`, `fix` | `fix` |
| `refactor` | `refactor` |
| `docs` | `docs` |
| `chore` | `chore` |
| 그 외 | `feat` |
