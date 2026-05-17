# github-wiki-mcp

> GitHub Wiki 페이지 조회/검색/생성/갱신/이력 (git 기반)

GitHub Wiki는 본질적으로 `<repo>.wiki.git` 이라는 별도 git 저장소다. 이 MCP는 그걸 로컬에 clone해서 페이지를 다루고, 변경 시 자동으로 commit + push 한다. 별도 SDK 없이 `git` CLI만 사용.

---

## 설정

```json
"github-wiki-mcp": {
  "env": {
    "GITHUB_TOKEN": "ghp_xxxx",
    "WIKI_REPOS": "{\"adapter\":\"StableCoinTF/StableCoinBC_Adapter\",\"docs\":\"StableCoinTF/StableCoinBC_Adapter_Docs\"}",
    "WIKI_CACHE_DIR": "",
    "WIKI_PULL_TTL_SEC": "300"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `GITHUB_TOKEN` | | (필수) Personal Access Token. **`repo` 스코프 + Wiki write 권한** 필요 |
| `WIKI_REPOS` | | (필수) JSON map. key=레포 단축명, value=`owner/repo` |
| `WIKI_CACHE_DIR` | `~/.cache/github-wiki-mcp` | clone 캐시 경로 |
| `WIKI_PULL_TTL_SEC` | `300` | 같은 레포 재pull 최소 간격 (초). 너무 짧으면 매 호출마다 git 통신 |

### Wiki 활성화 확인

Wiki가 비활성화된 레포는 `.wiki.git` 자체가 존재하지 않아 clone이 실패한다. 레포 **Settings → Features → Wikis** 체크 + 최초 페이지 1개 (Home) 생성.

### 토큰 권한

- **Classic PAT**: `repo` 스코프 (wiki 포함)
- **Fine-grained PAT**: Repository permissions → **Contents: Read and write** (wiki는 contents 권한에 묶여있음)

---

## 도구 (5개)

### `wiki_list`

Wiki 페이지 목록.

```
"adapter wiki 페이지 목록 보여줘"
```

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|:--:|---|
| `repo` | string | O | `WIKI_REPOS` 키 (예: `adapter`) |

---

### `wiki_get`

페이지 본문 조회.

```
"adapter wiki에서 'API Reference' 페이지 보여줘"
"docs wiki Home 페이지 내용"
```

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|:--:|---|
| `repo` | string | O | |
| `page` | string | O | 페이지 이름 (.md 생략 가능, 공백 자동→대시) |

> GitHub Wiki는 페이지명 `API Reference` ↔ 파일명 `API-Reference.md`. 자동 변환됨.

---

### `wiki_search`

전체 페이지에서 키워드 검색 (`git grep`).

```
"adapter wiki에서 'OutOfGas' 검색해줘"
"deployment 관련 문서 찾아줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `repo` | string | O | | |
| `query` | string | O | | 검색 키워드 |
| `case_sensitive` | boolean | | `false` | |
| `max_results` | number | | `100` | |

---

### `wiki_write`

페이지 생성 또는 갱신. **변경 사항이 있으면 자동으로 commit + push.**

```
"adapter wiki의 'Deployment' 페이지를 새 내용으로 업데이트해줘"
"docs wiki에 'Troubleshooting' 페이지 새로 만들고 내용은 ..."
```

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|:--:|---|
| `repo` | string | O | |
| `page` | string | O | 페이지 이름 |
| `content` | string | O | markdown 본문 |
| `message` | string | | 커밋 메시지 (기본: `Create/Update {filename}`) |

**동작:**
1. 최신 상태로 pull (TTL 지났으면)
2. 파일 쓰기 + `git add`
3. 변경 없으면 "변경 없음" 반환하고 종료
4. 있으면 commit + push
5. 결과로 Wiki URL 반환

---

### `wiki_history`

변경 이력 (`git log`).

```
"adapter wiki 최근 변경 이력 10건"
"Home 페이지 누가 언제 수정했어?"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `repo` | string | O | | |
| `page` | string | | | 특정 페이지만 (생략 시 전체) |
| `limit` | number | | `20` | |

---

## 동작 원리

```
[Claude Code]
   │
   ▼
[github-wiki-mcp]
   │
   ├── 최초 호출 시: git clone https://token@github.com/{repo}.wiki.git
   │                 → ~/.cache/github-wiki-mcp/{name}/
   │
   ├── 조회: 로컬 파일 read (TTL 지났으면 pull 먼저)
   │
   └── 갱신: 파일 write → git add → git commit → git push
              → 즉시 https://github.com/{repo}/wiki 에 반영
```

캐시 디렉터리는 처음 한 번만 clone되고 이후엔 pull. 여러 레포면 각각 별도 디렉터리.

---

## 주의사항

- **충돌**: 누군가 동시에 wiki를 수정 중이면 `git pull --ff-only`가 실패. 캐시 디렉터리 지우고 재시도하거나, 잠시 후 다시 시도
- **첫 페이지 필요**: GitHub Wiki는 페이지가 0개면 `.wiki.git`이 존재하지 않음. UI에서 Home 페이지 1개 만든 뒤 사용
- **삭제 미지원**: 의도적으로 빠짐. 페이지 삭제는 GitHub UI로 (실수 방지)
- **첨부파일**: 이 MCP는 markdown 페이지(.md)만 다룸. 이미지 등 첨부는 별도 처리 필요
- **토큰 노출 방지**: 에러 메시지에서 토큰 문자열은 `***`로 마스킹됨
- **Wiki API 부재**: GitHub은 Wiki용 REST API를 제공하지 않음 (git이 유일한 인터페이스). 이 점 때문에 이 MCP가 필요
