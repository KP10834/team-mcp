import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KIBANA_URL = (process.env.KIBANA_URL || "").replace(/\/$/, "");
const API_KEY = process.env.KIBANA_API_KEY || "";
const COOKIE = process.env.KIBANA_COOKIE || "";

if (!KIBANA_URL) {
  console.error("[kibana-mcp] KIBANA_URL 필수");
  process.exit(1);
}
if (!API_KEY && !COOKIE) {
  console.error("[kibana-mcp] KIBANA_API_KEY 또는 KIBANA_COOKIE 중 하나 필수");
  process.exit(1);
}

function authHeaders() {
  const h = { "kbn-xsrf": "true" };
  if (API_KEY) h.Authorization = `ApiKey ${API_KEY}`;
  else if (COOKIE) h.Cookie = COOKIE;
  return h;
}

async function kbFetch(path, opts = {}) {
  const res = await fetch(`${KIBANA_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kibana ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function esProxy(esPath, method = "GET", body) {
  const cleanPath = esPath.replace(/^\//, "");
  const params = new URLSearchParams({ path: cleanPath, method });
  const res = await fetch(`${KIBANA_URL}/api/console/proxy?${params}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kibana ES proxy ${res.status} (${method} ${esPath}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

const server = new McpServer({ name: "kibana-mcp", version: "1.0.0" });

// ─── 1. ES 로그 검색 (Console Proxy) ───────────────────────────
server.tool(
  "kibana_es_search",
  "Elasticsearch 로그 검색 (Kibana Console proxy 경유, ES 9200 막혀도 동작)",
  {
    index: z.string().default("logs-*").describe("인덱스 패턴"),
    query: z.string().optional().describe("키워드 / lucene query (생략 시 전체)"),
    service: z.string().optional().describe("service 필드 필터"),
    level: z.enum(["error", "warn", "info", "debug", "fatal"]).optional(),
    minutes: z.number().optional().describe("최근 N분 (생략 시 전체)"),
    size: z.number().default(20).describe("조회 건수 (기본 20, 최대 100)"),
  },
  async ({ index, query, service, level, minutes, size }) => {
    const must = [];
    if (query) must.push({ query_string: { query } });
    if (service) must.push({ match: { service } });
    if (level) must.push({ match: { level } });
    if (minutes) must.push({ range: { "@timestamp": { gte: `now-${minutes}m`, lte: "now" } } });

    const body = {
      size: Math.min(size, 100),
      sort: [{ "@timestamp": "desc" }],
      query: { bool: { must: must.length ? must : [{ match_all: {} }] } },
    };

    const data = await esProxy(`${index}/_search`, "POST", body);
    const hits = data.hits?.hits || [];
    const total = data.hits?.total?.value ?? hits.length;
    if (!hits.length) {
      return { content: [{ type: "text", text: `결과 없음 (index: ${index})` }] };
    }

    const lines = hits.map((h) => {
      const s = h._source || {};
      const ts = s["@timestamp"] || "";
      const lvl = s.level || "";
      const svc = s.service || s.app || h._index || "";
      const msg = s.msg || s.message || "";
      const reqId = s.requestId ? ` reqId=${s.requestId}` : "";
      return `- **${ts}** [${lvl}] \`${svc}\`${reqId}\n  ${msg}`;
    }).join("\n\n");

    return {
      content: [{ type: "text", text: `## ES 검색 (${hits.length}/${total}건)\n\n${lines}` }],
    };
  },
);

// ─── 2. ES 임의 요청 ───────────────────────────────────────────
server.tool(
  "kibana_es_request",
  "ES 임의 요청 (Kibana Console proxy 경유). 모든 path/method 지원",
  {
    path: z.string().describe("ES 경로 (예: _cluster/health, my-index/_count)"),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "HEAD"]).default("GET"),
    body: z.record(z.any()).optional().describe("요청 body (JSON 객체)"),
  },
  async ({ path, method, body }) => {
    const data = await esProxy(path, method, body);
    const json = JSON.stringify(data, null, 2);
    const truncated = json.length > 4000 ? json.slice(0, 4000) + "\n... (truncated)" : json;
    return {
      content: [{
        type: "text",
        text: `## ${method} ${path}\n\`\`\`json\n${truncated}\n\`\`\``,
      }],
    };
  },
);

// ─── 3. Saved Objects 검색 (대시보드/검색/시각화) ──────────────
server.tool(
  "kibana_saved_objects",
  "Saved object 검색 (dashboard / search / visualization / lens 등)",
  {
    type: z.enum(["dashboard", "search", "visualization", "index-pattern", "lens", "map"]).default("dashboard"),
    search: z.string().optional().describe("제목 검색어"),
    per_page: z.number().default(20),
  },
  async ({ type, search, per_page }) => {
    const params = new URLSearchParams({ type, per_page: String(per_page) });
    if (search) params.set("search", search);
    const data = await kbFetch(`/api/saved_objects/_find?${params}`);

    const objects = data.saved_objects || [];
    if (!objects.length) return { content: [{ type: "text", text: `${type} 없음` }] };

    const urlMap = {
      dashboard: (id) => `${KIBANA_URL}/app/dashboards#/view/${id}`,
      search: (id) => `${KIBANA_URL}/app/discover#/view/${id}`,
      visualization: (id) => `${KIBANA_URL}/app/visualize#/edit/${id}`,
      lens: (id) => `${KIBANA_URL}/app/lens#/edit/${id}`,
      "index-pattern": (id) => `${KIBANA_URL}/app/management/kibana/dataViews/dataView/${id}`,
      map: (id) => `${KIBANA_URL}/app/maps/map/${id}`,
    };

    const body = objects.map((o) => {
      const title = o.attributes?.title || "(no title)";
      const url = urlMap[type] ? urlMap[type](o.id) : "";
      return `- **${title}** (id: \`${o.id}\`)${url ? `\n  ${url}` : ""}`;
    }).join("\n\n");

    return {
      content: [{ type: "text", text: `## ${type} (${objects.length}/${data.total}개)\n\n${body}` }],
    };
  },
);

// ─── 4. Alerting Rules ─────────────────────────────────────────
server.tool(
  "kibana_alerts",
  "Kibana Alerting 룰 조회",
  {
    search: z.string().optional().describe("룰 이름 검색"),
    per_page: z.number().default(20),
  },
  async ({ search, per_page }) => {
    const params = new URLSearchParams({ per_page: String(per_page) });
    if (search) params.set("search", search);
    const data = await kbFetch(`/api/alerting/rules/_find?${params}`);

    const rules = data.data || [];
    if (!rules.length) return { content: [{ type: "text", text: "알림 룰 없음" }] };

    const body = rules.map((r) => {
      const status = r.execution_status?.status || "?";
      const last = r.execution_status?.last_execution_date
        ? r.execution_status.last_execution_date.replace("T", " ").slice(0, 19)
        : "?";
      return `- **${r.name}** [${r.enabled ? "enabled" : "disabled"}]\n  last: ${status} at ${last}\n  consumer: ${r.consumer || ""} · type: ${r.rule_type_id || ""}`;
    }).join("\n\n");

    return {
      content: [{ type: "text", text: `## Alert Rules (${rules.length}/${data.total}개)\n\n${body}` }],
    };
  },
);

// ─── 5. Data Views (index patterns) ────────────────────────────
server.tool(
  "kibana_data_views",
  "Data View (인덱스 패턴) 목록 조회",
  {},
  async () => {
    const data = await kbFetch(`/api/data_views`);
    const views = data.data_view || [];
    if (!views.length) return { content: [{ type: "text", text: "Data View 없음" }] };
    const body = views.map((v) =>
      `- **${v.name || v.title}** — pattern: \`${v.title}\` (id: \`${v.id}\`)`,
    ).join("\n");
    return {
      content: [{ type: "text", text: `## Data Views (${views.length}개)\n\n${body}` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
