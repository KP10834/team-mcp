# grafana-mcp

> Grafana API + Datasource Proxy를 통한 메트릭/로그/알림/대시보드 조회

**핵심:** Grafana의 **Datasource Proxy**를 거쳐 Prometheus/Loki에 접근하므로, 백엔드 포트(9090, 3100 등)가 차단되어 있어도 Grafana URL만 닿으면 동작한다.

---

## 설정

```json
"grafana-mcp": {
  "env": {
    "GRAFANA_URL": "https://grafana.company.com",
    "GRAFANA_SA_TOKEN": "glsa_xxxxxxxxxxxx",
    "GRAFANA_PROM_DATASOURCE_UID": "prom-default",
    "GRAFANA_LOKI_DATASOURCE_UID": "loki-default"
  }
}
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `GRAFANA_URL` | | (필수) Grafana 베이스 URL |
| `GRAFANA_SA_TOKEN` | | Service Account Token (`glsa_…`). **권장** |
| `GRAFANA_API_KEY` | | 레거시 API Key (SA Token 없을 때 fallback) |
| `GRAFANA_PROM_DATASOURCE_UID` | | Prometheus 데이터소스 UID (없으면 도구 호출 시 인자로) |
| `GRAFANA_LOKI_DATASOURCE_UID` | | Loki 데이터소스 UID (없으면 도구 호출 시 인자로) |

### Service Account Token 발급

Grafana UI: **Administration → Service accounts → Add service account → Add token**.
Role은 최소 `Viewer` (조회만), 어노테이션 쓸 거면 `Editor`.

### 데이터소스 UID 확인

처음 한 번 `grafana_datasources` 호출해서 UID 확인 후 env에 저장.

---

## 도구 (6개)

### `grafana_metrics`

Prometheus PromQL 쿼리 (Datasource Proxy 경유).

```
"최근 30분 adapter 서비스 에러율 보여줘"
"노드별 CPU 사용률 1시간"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `query` | string | O | | PromQL |
| `minutes` | number | | `30` | 최근 N분 |
| `from` / `to` | number | | | unix 초 (절대 범위) |
| `step` | string | | `30s` | 샘플 간격 |
| `datasource_uid` | string | | env | Prometheus UID 오버라이드 |

**출력 예시:**

```
## PromQL: `rate(http_requests_total[5m])`
범위: 2026-05-17 13:00:00 ~ 2026-05-17 13:30:00 (step 30s)
시리즈 3개

- {service="adapter", code="500"}
  latest: `0.83`
  last 10: 0.5 → 0.6 → 0.7 → 0.83
```

---

### `grafana_logs`

Loki LogQL 쿼리 (Datasource Proxy 경유).

```
"최근 1시간 adapter 에러 로그"
"{service=\"withdraw\"} |= \"OutOfGas\" 검색"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `query` | string | O | | LogQL |
| `minutes` | number | | `30` | 최근 N분 |
| `limit` | number | | `50` | 최대 라인 수 |
| `datasource_uid` | string | | env | Loki UID 오버라이드 |

**출력 예시:**

```
## Loki: `{service="adapter"} |= "ERROR"` (12건)
최근 30분

- **2026-05-17 13:24:10** `service=adapter,level=error`
  withdraw failed: OutOfGas (txHash: 0xabc...)
```

---

### `grafana_alerts`

현재 발생 중 알림 (Unified Alerting / Alertmanager).

```
"지금 firing 알림 뭐 있어?"
"활성 알림 다 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `state` | enum | | `active` | `active` / `suppressed` / `unprocessed` / `all` |

**출력 예시:**

```
## Grafana Alerts — active (2개)

- **HighErrorRate** [critical] (active)
  since: 2026-05-17 13:15:33
  adapter error rate > 5%
  labels: service=adapter, env=prod

- **DiskAlmostFull** [warning] (active)
  since: 2026-05-17 12:50:01
  disk usage > 85%
```

---

### `grafana_dashboards`

대시보드 검색.

```
"payment 관련 대시보드 찾아줘"
"adapter 태그 대시보드 보여줘"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `query` | string | | | 제목 검색어 |
| `tag` | string | | | 태그 필터 |
| `limit` | number | | `20` | |

---

### `grafana_annotate`

시계열에 마커 추가 (배포, 인시던트 등).

```
"지금 'v1.4.2 deploy' 마커 찍어줘"
"adapter 대시보드에 'incident #42' 마커"
```

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|:--:|---|---|
| `text` | string | O | | 마커 설명 |
| `tags` | string[] | | `[]` | 태그 |
| `time` | number | | now | 시작 unix ms |
| `timeEnd` | number | | | 종료 unix ms (range 마커) |
| `dashboard_uid` | string | | | 특정 대시보드에만 |
| `panel_id` | number | | | 특정 패널에만 |

> SA Token에 `Editor` 권한 필요.

---

### `grafana_datasources`

데이터소스 목록 (UID/type 확인용).

```
"grafana 데이터소스 목록 보여줘"
```

파라미터 없음.

**출력 예시:**

```
## Grafana 데이터소스 (4개)

- **Prometheus** (`prometheus`) — uid: `prom-default` · default
- **Loki** (`loki`) — uid: `loki-default`
- **Tempo** (`tempo`) — uid: `tempo-1`
- **PostgreSQL** (`postgres`) — uid: `pg-1`
```

---

## 사용 시나리오: 백엔드 포트가 막힌 환경

```
[Claude Code 로컬]
   │ HTTPS (Grafana 토큰)
   ▼
[grafana.company.com:443]      ← 이거만 열려있으면 OK
   │ 내부망
   ├─→ Prometheus:9090         ← 외부 차단
   └─→ Loki:3100              ← 외부 차단
```

PromQL/LogQL을 그대로 호출 가능. 별도 사이드카/터널 불필요.

---

## 주의사항

- **권한**: SA Token에 부여된 데이터소스 권한이 그대로 적용됨. read-only로 발급 권장
- **Timeout**: Grafana 기본 타임아웃이 ES/Prom 직접보다 짧음 (보통 30s). 무거운 집계는 step을 늘리거나 range를 줄이기
- **Rate limit**: Grafana 자체는 약하지만 백엔드(Prom/Loki) 보호 위해 자제
- **Annotation 권한**: 쓰기 작업이므로 SA Token Role이 `Viewer`면 403
