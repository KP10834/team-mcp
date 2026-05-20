# Kibana MCP 설치 가이드

## 1. Claude Code 설정

`~/.claude/settings.json` 또는 프로젝트 `.mcp.json`에 추가:

```json
{
  "mcpServers": {
    "kibana-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@stableteam/team-mcp", "kibana"],
      "env": {
        "KIBANA_URL": "http://<kibana-host>:5601",
        "KIBANA_COOKIE": "sid=your-session-cookie"
      }
    }
  }
}
```

> `npm install` 불필요. `npx -y`가 자동으로 다운로드 후 실행합니다.

## 2. 환경변수

| 변수 | 설명 |
|------|------|
| `KIBANA_URL` | (필수) Kibana 베이스 URL |
| `KIBANA_API_KEY` | (선택) API Key 인증 |
| `KIBANA_COOKIE` | (선택) 세션 쿠키 인증 |

> `KIBANA_API_KEY` 또는 `KIBANA_COOKIE` 중 하나는 필수입니다.

## 3. Session Cookie 얻는 법

1. 브라우저에서 Kibana에 로그인
2. F12 → Application → Cookies → 해당 도메인
3. `sid` 쿠키 값 복사
4. `KIBANA_COOKIE`에 `sid=복사한값` 형식으로 입력

> 쿠키는 만료(보통 8시간~며칠)되면 다시 복사해야 합니다.

## 4. 사용 예시

Claude Code에서 자연어로 요청:

```
"오늘 ERROR 로그 보여줘"
"최근 1시간 withdraw 관련 로그 50건"
"_cluster/health 확인해줘"
"대시보드 목록 보여줘"
"알림 룰 조회해줘"
```

## 5. 제공 도구

| 도구 | 설명 |
|------|------|
| `kibana_es_search` | ES 로그 검색 (index, query, service, level, minutes 등) |
| `kibana_es_request` | ES 임의 요청 (모든 method/path) |
| `kibana_saved_objects` | Saved object 검색 (dashboard, search, visualization 등) |
| `kibana_alerts` | Alerting 룰 조회 |
| `kibana_data_views` | Data View (인덱스 패턴) 목록 조회 |
