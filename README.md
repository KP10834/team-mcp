# team-mcp

팀이 공유하는 Claude Code MCP 서버 모음.
인프라(Kafka, Redis, ELK, Grafana 등)·외부 서비스(Slack, Dooray, GitHub Wiki)·블록체인(EVM)·개발 도구(QA, workflow, cross-impact)에 대한 MCP 통합.

각 서버는 단일 `index.js` + `README.md`로 구성된 stdio MCP. 추가 빌드 단계 없음.

---

## 구성

| 서버 | 용도 |
|---|---|
| `evm-mcp` | EVM 블록체인 RPC (잔액, 트랜잭션, nonce, 블록) |
| `kafka-mcp` | Kafka 토픽 발행·조회 |
| `redis-mcp` | Redis 키·값 조회·관리 |
| `slack-mcp` | Slack 메시지 발행·조회 |
| `dooray-mcp` | Dooray 메신저 연동 |
| `kibana-mcp` | Kibana 대시보드·쿼리 |
| `grafana-mcp` | Grafana 대시보드·메트릭 |
| `github-wiki-mcp` | GitHub Wiki 페이지 관리 |
| `rca-mcp` | 에러 근본 원인 분석 (로그 타임라인 + 온체인 추적) |
| `workflow-mcp` | git workflow (commit, PR) 자동화 |

각 서버의 상세 설정·도구 목록은 해당 디렉토리의 `README.md` 참조.

---

## 설치

```sh
npm i -g @stableteam/team-mcp
```

또는 로컬 클론:

```sh
git clone https://github.com/your-org/team-mcp.git
cd team-mcp
npm install
```

Node 20+ 권장. `type: "module"` 이므로 ESM 환경.

---

## Claude Code에 등록 (setup)

`team-mcp setup`으로 `~/.claude/.mcp.json`에 MCP 서버를 자동 등록한다.

```sh
# 대화형 — 등록할 서버 선택
team-mcp setup

# 전체 서버 등록
team-mcp setup --all

# 특정 서버만 등록
team-mcp setup evm kibana rca
```

실행하면:
1. `~/.claude/.mcp.json`에 선택한 서버가 추가됨
2. 이미 등록된 서버는 건너뜀 (기존 설정 유지)
3. 필수 env가 있는 서버는 `<placeholder>`로 채워지므로, 파일을 열어 실제 값으로 교체
4. Claude Code 재시작하면 반영

### 수동 등록

`setup` 대신 직접 `~/.claude/.mcp.json`을 편집할 수도 있다:

```json
{
  "mcpServers": {
    "evm-mcp": {
      "command": "team-mcp",
      "args": ["evm"],
      "env": {
        "EVM_RPC_URL": "http://<rpc-host>:8545"
      }
    }
  }
}
```

---

## 새 MCP 추가하기

1. 루트에 `<name>-mcp/` 디렉토리 생성
2. `index.js` 작성 (`McpServer` + `StdioServerTransport` 패턴 — 기존 서버 참고)
3. `README.md`에 도구 목록·환경변수·예시 작성
4. 루트 `package.json`의 `scripts`에 `start:<name>` 추가
5. 본 README 표에 추가

명명 규칙: `kebab-case` + `-mcp` suffix.

---

## team-claude와 함께 사용하기 (전체 세팅 순서)

이 패키지(team-mcp)는 MCP **런타임 서버**이고, [team-claude](https://github.com/KP10834/team-claude)는 Claude Code **설정 템플릿** (agents, skills, commands, rules)이다. 새 프로젝트에서 둘을 함께 쓰려면:

```sh
# ━━━ Step 1. MCP 서버 설치 (글로벌, 1회) ━━━
npm i -g @stableteam/team-mcp

# ━━━ Step 2. MCP 서버를 Claude Code에 등록 ━━━
team-mcp setup                    # 대화형 — 필요한 서버 선택
# team-mcp setup --all            # 전체 등록
# team-mcp setup evm kibana rca   # 특정 서버만

# → ~/.claude/.mcp.json 에 등록됨
# → 필수 env(<placeholder>)를 실제 값으로 교체

# ━━━ Step 3. Claude Code 설정 복사 (프로젝트별) ━━━
cd /path/to/your-project
npx degit KP10834/team-claude/.claude .claude

# ━━━ Step 4. CLAUDE.md 작성 ━━━
# CLAUDE.template.md 참고하여 프로젝트 루트에 CLAUDE.md 생성
# → 빌드 명령, 기술 스택, 아키텍처 등 채우기

# ━━━ Step 5. 도메인 컨벤션 적용 ━━━
cd .claude/rules/conventions
mv backend.example.md backend.md       # 사용하는 도메인만
rm frontend.example.md                 # 안 쓰는 건 삭제

# ━━━ Step 6. Claude Code 재시작 ━━━
```

### 최종 구조

```
your-project/
├── .claude/                    ← team-claude에서 복사 (agents, skills, commands, rules)
├── CLAUDE.md                   ← 프로젝트별 설정 (빌드 명령, 스택, 컨벤션)
└── src/

~/.claude/.mcp.json             ← team-mcp setup이 등록 (글로벌, 모든 프로젝트 공유)
```

### 두 repo의 역할 차이

| | team-mcp (여기) | team-claude |
|---|---|---|
| **성격** | 실행되는 MCP 서버 (npm 패키지) | Claude Code 설정 템플릿 |
| **설치** | `npm i -g` (글로벌 1회) | 프로젝트마다 `.claude/` 복사 |
| **등록 위치** | `~/.claude/.mcp.json` | 프로젝트 루트 `.claude/` |
| **업데이트** | `npm update -g @stableteam/team-mcp` | degit 재실행 또는 subtree pull |
| **공유 범위** | 글로벌 — 모든 프로젝트가 같은 서버 사용 | 프로젝트별 — 각자 커스터마이즈 가능 |

