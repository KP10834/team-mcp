import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GRAFANA_URL = (process.env.GRAFANA_URL || "").replace(/\/$/, "");
const TOKEN = process.env.GRAFANA_SA_TOKEN || process.env.GRAFANA_API_KEY || "";
const PROM_UID = process.env.GRAFANA_PROM_DATASOURCE_UID || "";
const LOKI_UID = process.env.GRAFANA_LOKI_DATASOURCE_UID || "";

if (!GRAFANA_URL) {
  console.error("[grafana-mcp] GRAFANA_URL 필수");
  process.exit(1);
}
if (!TOKEN) {
  console.error("[grafana-mcp] GRAFANA_SA_TOKEN 또는 GRAFANA_API_KEY 중 하나 필수");
  process.exit(1);
}

async function gfFetch(path, opts = {}) {
  const res = await fetch(`${GRAFANA_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Grafana ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function parseRangeSec({ minutes, from, to }) {
  if (from && to) return { start: from, end: to };
  const end = Math.floor(Date.now() / 1000);
  const start = end - (minutes || 30) * 60;
  return { start, end };
}

function fmtTime(unixSec) {
  return new Date(unixSec * 1000).toISOString().replace("T", " ").slice(0, 19);
}

const server = new McpServer({ name: "grafana-mcp", version: "1.0.0" });

// ─── 1. Prometheus 쿼리 (Datasource Proxy) ─────────────────────
server.tool(
  "grafana_metrics",
  "Prometheus PromQL 쿼리 (Grafana datasource proxy 경유)",
  {
    query: z.string().describe("PromQL (예: rate(http_requests_total[5m]))"),
    minutes: z.number().default(30).describe("최근 N분 (from/to 없을 때)"),
    from: z.number().optional().describe("시작 unix timestamp (초)"),
    to: z.number().optional().describe("종료 unix timestamp (초)"),
    step: z.string().default("30s").describe("샘플 간격 (예: 15s, 1m)"),
    datasource_uid: z.string().optional().describe("Prometheus 데이터소스 UID (기본: env)"),
  },
  async ({ query, minutes, from, to, step, datasource_uid }) => {
    const uid = datasource_uid || PROM_UID;
    if (!uid) throw new Error("Prometheus datasource UID 필요 (env GRAFANA_PROM_DATASOURCE_UID 또는 인자)");
    const { start, end } = parseRangeSec({ minutes, from, to });
    const params = new URLSearchParams({ query, start: String(start), end: String(end), step });
    const data = await gfFetch(`/api/datasources/proxy/uid/${uid}/api/v1/query_range?${params}`);

    const result = data.data?.result || [];
    if (!result.length) {
      return { content: [{ type: "text", text: `결과 없음 (query: \`${query}\`)` }] };
    }

    const lines = result.slice(0, 20).map((series) => {
      const labels = Object.entries(series.metric || {})
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ");
      const values = series.values || [];
      const last = values.length ? values[values.length - 1][1] : "?";
      const tail = values.slice(-10).map((v) => v[1]).join(" → ");
      return `- {${labels}}\n  latest: \`${last}\`\n  last 10: ${tail}`;
    }).join("\n\n");

    return {
      content: [{
        type: "text",
        text: `## PromQL: \`${query}\`\n범위: ${fmtTime(start)} ~ ${fmtTime(end)} (step ${step})\n시리즈 ${result.length}개${result.length > 20 ? " (상위 20개 표시)" : ""}\n\n${lines}`,
      }],
    };
  },
);

// ─── 2. Loki 로그 쿼리 (Datasource Proxy) ──────────────────────
server.tool(
  "grafana_logs",
  "Loki LogQL 쿼리 (Grafana datasource proxy 경유)",
  {
    query: z.string().describe('LogQL (예: {service="adapter"} |= "ERROR")'),
    minutes: z.number().default(30).describe("최근 N분"),
    limit: z.number().default(50).describe("최대 라인 수"),
    datasource_uid: z.string().optional().describe("Loki 데이터소스 UID (기본: env)"),
  },
  async ({ query, minutes, limit, datasource_uid }) => {
    const uid = datasource_uid || LOKI_UID;
    if (!uid) throw new Error("Loki datasource UID 필요 (env GRAFANA_LOKI_DATASOURCE_UID 또는 인자)");
    const endNs = BigInt(Date.now()) * 1_000_000n;
    const startNs = endNs - BigInt(minutes) * 60_000_000_000n;
    const params = new URLSearchParams({
      query,
      start: startNs.toString(),
      end: endNs.toString(),
      limit: String(limit),
      direction: "backward",
    });
    const data = await gfFetch(`/api/datasources/proxy/uid/${uid}/loki/api/v1/query_range?${params}`);

    const streams = data.data?.result || [];
    const entries = [];
    for (const s of streams) {
      const labels = Object.entries(s.stream || {}).map(([k, v]) => `${k}=${v}`).join(",");
      for (const [ts, line] of s.values || []) {
        const ms = Number(BigInt(ts) / 1_000_000n);
        const date = new Date(ms).toISOString().slice(0, 19).replace("T", " ");
        entries.push({ date, labels, line });
      }
    }
    entries.sort((a, b) => b.date.localeCompare(a.date));

    if (!entries.length) {
      return { content: [{ type: "text", text: `로그 없음 (query: \`${query}\`)` }] };
    }

    const body = entries.slice(0, limit)
      .map((e) => `- **${e.date}** \`${e.labels}\`\n  ${e.line}`)
      .join("\n\n");

    return {
      content: [{
        type: "text",
        text: `## Loki: \`${query}\` (${entries.length}건)\n최근 ${minutes}분\n\n${body}`,
      }],
    };
  },
);

// ─── 3. 발생 중 알림 ────────────────────────────────────────────
server.tool(
  "grafana_alerts",
  "현재 발생 중 알림 조회 (Unified Alerting)",
  {
    state: z.enum(["active", "suppressed", "unprocessed", "all"]).default("active"),
  },
  async ({ state }) => {
    const data = await gfFetch(`/api/alertmanager/grafana/api/v2/alerts`);
    const filtered = state === "all" ? data : data.filter((a) => a.status?.state === state);

    if (!filtered.length) {
      return { content: [{ type: "text", text: `${state} 상태 알림 없음` }] };
    }

    const body = filtered.map((a) => {
      const name = a.labels?.alertname || "(no name)";
      const severity = a.labels?.severity || "";
      const summary = a.annotations?.summary || a.annotations?.description || "";
      const startsAt = a.startsAt ? a.startsAt.replace("T", " ").slice(0, 19) : "";
      const labels = Object.entries(a.labels || {})
        .filter(([k]) => !["alertname", "severity"].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `- **${name}** ${severity ? `[${severity}]` : ""} (${a.status?.state})\n  since: ${startsAt}\n  ${summary}${labels ? `\n  labels: ${labels}` : ""}`;
    }).join("\n\n");

    return {
      content: [{ type: "text", text: `## Grafana Alerts — ${state} (${filtered.length}개)\n\n${body}` }],
    };
  },
);

// ─── 4. 대시보드 검색 ──────────────────────────────────────────
server.tool(
  "grafana_dashboards",
  "대시보드 검색",
  {
    query: z.string().optional().describe("제목 검색어 (생략 시 전체)"),
    tag: z.string().optional().describe("태그 필터"),
    limit: z.number().default(20),
  },
  async ({ query, tag, limit }) => {
    const params = new URLSearchParams({ type: "dash-db", limit: String(limit) });
    if (query) params.set("query", query);
    if (tag) params.set("tag", tag);
    const data = await gfFetch(`/api/search?${params}`);

    if (!data.length) return { content: [{ type: "text", text: "대시보드 없음" }] };

    const body = data.map((d) => {
      const tags = (d.tags || []).length ? ` [${d.tags.join(", ")}]` : "";
      return `- **${d.title}**${tags}\n  uid: \`${d.uid}\` · ${GRAFANA_URL}${d.url}`;
    }).join("\n\n");

    return {
      content: [{ type: "text", text: `## 대시보드 (${data.length}개)\n\n${body}` }],
    };
  },
);

// ─── 5. 어노테이션 추가 (배포 마커 등) ──────────────────────────
server.tool(
  "grafana_annotate",
  "시계열에 마커 추가 (배포/이벤트 표시)",
  {
    text: z.string().describe("마커 설명 (예: 'v1.4.2 deploy')"),
    tags: z.array(z.string()).default([]).describe("태그 (예: ['deploy', 'adapter'])"),
    time: z.number().optional().describe("시작 unix ms (기본: 지금)"),
    timeEnd: z.number().optional().describe("종료 unix ms (range 마커일 때)"),
    dashboard_uid: z.string().optional().describe("특정 대시보드에만 추가"),
    panel_id: z.number().optional().describe("특정 패널에만 추가 (dashboard_uid와 함께)"),
  },
  async ({ text, tags, time, timeEnd, dashboard_uid, panel_id }) => {
    const body = {
      text,
      tags,
      time: time || Date.now(),
      ...(timeEnd && { timeEnd }),
      ...(dashboard_uid && { dashboardUID: dashboard_uid }),
      ...(panel_id && { panelId: panel_id }),
    };
    const data = await gfFetch(`/api/annotations`, { method: "POST", body: JSON.stringify(body) });
    return {
      content: [{
        type: "text",
        text: `## 어노테이션 추가\n- id: \`${data.id}\`\n- text: ${text}\n- tags: ${tags.join(", ") || "(없음)"}\n- time: ${fmtTime(Math.floor((time || Date.now()) / 1000))}`,
      }],
    };
  },
);

// ─── 6. 데이터소스 목록 (UID 확인용) ──────────────────────────
server.tool(
  "grafana_datasources",
  "데이터소스 목록 조회 (UID/type 확인용)",
  {},
  async () => {
    const data = await gfFetch(`/api/datasources`);
    if (!data.length) return { content: [{ type: "text", text: "데이터소스 없음" }] };
    const body = data.map((d) =>
      `- **${d.name}** (\`${d.type}\`) — uid: \`${d.uid}\`${d.isDefault ? " · default" : ""}`,
    ).join("\n");
    return {
      content: [{ type: "text", text: `## Grafana 데이터소스 (${data.length}개)\n\n${body}` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
