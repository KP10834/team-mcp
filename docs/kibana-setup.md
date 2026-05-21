# kibana-mcp 설치 가이드

Kibana Console Proxy를 통한 ES 검색 MCP 서버. ES 9200 포트가 차단되어 있어도 Kibana URL만 닿으면 동작한다.

---

## 1. 설치

```bash
# 패키지 설치 (최초 1회)
npm i -g @stableteam/team-mcp

# 설치 확인
team-mcp
# Usage: team-mcp <server|setup>
# Servers: evm, kafka, redis, slack, grafana, kibana, ...
```   

Node 20+ 필수.

---

## 2. MCP 서버 등록

```bash
team-mcp setup kibana
```

실행하면 `~/.claude/.mcp.json`에 kibana-mcp이 등록된다. 이후 파일을 열어서 `<placeholder>`를 실제 값으로 교체.

또는 직접 `~/.claude/.mcp.json`을 편집:

```json
{
  "mcpServers": {
    "kibana-mcp": {
      "command": "team-mcp",
      "args": ["kibana"],
      "env": {
        "KIBANA_URL": "http://<kibana-host>:5601",
        "KIBANA_COOKIE": "sid=<session-cookie>"
      }
    }
  }
}
```

---

## 3. 인증 설정

API_KEY 또는 COOKIE 중 **하나 필수**. 둘 다 없으면 서버가 시작되지 않는다.

| 변수 | 필수 | 설명 |
|------|:----:|------|
| `KIBANA_URL` | O | Kibana 베이스 URL |
| `KIBANA_API_KEY` | △ | API Key (base64 인코딩된 `id:api_key`) |
| `KIBANA_COOKIE` | △ | 세션 쿠키 (`sid=...`) |

### 방법 1: Session Cookie (가장 간단)

SSO/Okta 환경이거나 API Key 발급 권한이 없을 때 사용.

1. 브라우저에서 Kibana에 로그인
2. **F12** (DevTools) → **Application** 탭 → 좌측 **Cookies** → Kibana 도메인 선택
3. `sid` 쿠키의 **Value** 전체를 복사
4. `~/.claude/.mcp.json`에 설정:
   ```json
   "KIBANA_COOKIE": "sid=<복사한 값>"
   ```

> 쿠키는 보통 8시간~며칠 후 만료된다. 만료되면 위 과정 반복.
> Claude Code에서 `Kibana 401` 에러가 나면 쿠키 갱신이 필요하다는 뜻.

### 방법 2: API Key (장기 사용)

Kibana Stack Management에서 발급 가능할 때 사용. 만료 없이 쓸 수 있어서 편함.

1. Kibana → **Stack Management** → **API keys** → **Create API key**
2. Name: `claude-mcp` (아무거나)
3. Role 설정: 기본(현재 유저 권한 상속) 또는 커스텀
4. 생성 후 표시되는 **Base64 encoded** 값을 복사
5. `~/.claude/.mcp.json`에 설정:
   ```json
   "KIBANA_API_KEY": "<base64 값>"
   ```

> API Key가 설정되면 Cookie보다 우선 사용된다.

---

## 4. Claude Code 재시작

등록 후 Claude Code를 재시작하면 kibana-mcp이 로드된다.

---

## 5. 사용법

### 도구 (5개)

| 도구 | 설명 | 사용 예 |
|------|------|---------|
| `kibana_es_search` | ES 로그 검색 (서비스/레벨/시간 필터) | "최근 1시간 ERROR 로그 50건" |
| `kibana_es_request` | ES 임의 요청 (모든 method/path) | "_cluster/health 확인해줘" |
| `kibana_saved_objects` | 대시보드/시각화/검색 조회 | "대시보드 목록 보여줘" |
| `kibana_alerts` | Alerting 룰 조회 | "알림 룰 상태 보여줘" |
| `kibana_data_views` | Data View (인덱스 패턴) 목록 | "인덱스 패턴 뭐 있어?" |

### 자연어 예시

```
"오늘 ERROR 로그 보여줘"
"최근 30분 withdraw 관련 로그"
"service가 adapter인 로그만 50건"
"_cluster/health 확인해줘"
"logs-* 인덱스에서 'timeout' 검색해줘"
"대시보드 목록 보여줘"
"알림 룰 상태 확인해줘"
```

### `kibana_es_search` 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| `index` | string | `logs-*` | 인덱스 패턴 |
| `query` | string | | lucene/키워드 쿼리 |
| `service` | string | | service 필드 필터 |
| `level` | enum | | `error` / `warn` / `info` / `debug` / `fatal` |
| `minutes` | number | | 최근 N분 |
| `size` | number | `20` | 조회 건수 (최대 100) |

---

## 6. 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `Kibana 401` | 쿠키 만료 또는 API Key 무효 | 쿠키 재발급 또는 API Key 재생성 |
| `Kibana 403` | 권한 부족 | API Key의 role에 인덱스 읽기 권한 추가 |
| `서버 시작 안 됨` | `KIBANA_URL` 미설정 | env 확인 |
| `검색 결과 0건` | 인덱스 패턴 불일치 | `kibana_data_views`로 사용 가능한 패턴 확인 후 `index` 파라미터 지정 |
| `team-mcp 명령 안 됨` | npm global bin이 PATH에 없음 | `npm config get prefix` 확인 후 PATH에 추가 |

---

## 7. 업데이트

```bash
npm update -g @stableteam/team-mcp
```

업데이트 후 Claude Code 재시작하면 반영.
