# team-mcp

팀이 공유하는 Claude Code / Cursor용 MCP 서버 모음.
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
| `sqlite-mcp` | 로컬 SQLite 조회 |
| `github-wiki-mcp` | GitHub Wiki 페이지 관리 |
| `cross-impact-mcp` | 멀티 레포 변경 영향 분석 |
| `qa-mcp` | 자동 빌드·테스트 (PM2 기반) |
| `topic-gen-mcp` | Kafka 토픽 생성 도우미 |
| `rca-mcp` | 에러 근본 원인 분석 (로그 타임라인 + 온체인 추적) |
| `workflow-mcp` | git workflow (commit, PR) 자동화 |

각 서버의 상세 설정·도구 목록은 해당 디렉토리의 `README.md` 참조.

---

## 설치

```sh
git clone https://github.com/KP10834/team-mcp.git
cd team-mcp
npm install
```

Node 20+ 권장. `type: "module"` 이므로 ESM 환경.

---

## Claude Code에 등록

`~/.claude/mcp.json` 또는 프로젝트 `.claude/settings.local.json`에 다음 형식으로 추가:

```json
{
  "mcpServers": {
    "evm": {
      "command": "node",
      "args": ["/absolute/path/to/team-mcp/evm-mcp/index.js"],
      "env": {
        "EVM_RPC_URL": "http://<rpc-host>:8545",
        "RPC_TIMEOUT_MS": "10000"
      }
    },
    "kafka": {
      "command": "node",
      "args": ["/absolute/path/to/team-mcp/kafka-mcp/index.js"],
      "env": {
        "KAFKA_BROKERS": "<broker-host>:9092"
      }
    }
  }
}
```

또는 npm script 사용:

```json
{
  "mcpServers": {
    "evm": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/team-mcp", "run", "start:evm"],
      "env": { "EVM_RPC_URL": "http://<rpc-host>:8545" }
    }
  }
}
```

---

## 환경변수

각 MCP는 `process.env`로 설정을 받는다. 하드코딩된 secret·연결 정보는 **없다**.
구체 변수 목록은 해당 디렉토리의 `README.md` 참조.

레포 자체에는 secret을 커밋하지 않는다. 운영 값은 각 사용 환경의 mcp config에 주입.

---

## 새 MCP 추가하기

1. 루트에 `<name>-mcp/` 디렉토리 생성
2. `index.js` 작성 (`McpServer` + `StdioServerTransport` 패턴 — 기존 서버 참고)
3. `README.md`에 도구 목록·환경변수·예시 작성
4. 루트 `package.json`의 `scripts`에 `start:<name>` 추가
5. 본 README 표에 추가

명명 규칙: `kebab-case` + `-mcp` suffix.

---

## team-claude와의 관계

[team-claude](https://github.com/KP10834/team-claude) = Claude Code agent/skill/command/rule **설정 템플릿**.
[team-mcp](https://github.com/KP10834/team-mcp) = Claude Code가 호출하는 **실행 가능한 MCP 서버**.

두 repo는 독립적이며 각자 다른 라이프사이클(setup config vs runtime server)을 갖는다.

---

## 라이선스 / 사용 범위

KP10834 팀 내부 사용. PR로 기여 환영.
