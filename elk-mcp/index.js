import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "elk-mcp", version: "1.0.0" });

const ES_URL = (process.env.ES_URL || "http://localhost:9200").replace(/\/$/, "");
const ES_API_KEY = process.env.ES_API_KEY || "";
const ES_USER = process.env.ES_USER || "";
const ES_PASSWORD = process.env.ES_PASSWORD || "";
const ES_INDEX_PATTERN = process.env.ES_INDEX_PATTERN || "logs-*";

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (ES_API_KEY) {
    headers["Authorization"] = `ApiKey ${ES_API_KEY}`;
  } else if (ES_USER && ES_PASSWORD) {
    headers["Authorization"] = `Basic ${Buffer.from(`${ES_USER}:${ES_PASSWORD}`).toString("base64")}`;
  }
  return headers;
}

async function esQuery(path, body) {
  const url = `${ES_URL}${path}`;
  const opts = { method: "POST", headers: authHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function esGet(path) {
  const url = `${ES_URL}${path}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function timeRange(minutes) {
  if (!minutes) return {};
  return { range: { "@timestamp": { gte: `now-${minutes}m`, lte: "now" } } };
}

function formatHit(hit) {
  const s = hit._source || {};
  const ts = s["@timestamp"] || s.time || s.timestamp || "";
  const level = s.level || s.lvl || "";
  const service = s.service || s.app || s.pm2_name || hit._index || "";
  const code = s.errorCode || s.err?.code || s.code || "";
  const msg = s.msg || s.message || "";
  const reqId = s.requestId || "";
  const extra = [];
  if (s.txHash) extra.push(`txHash: ${s.txHash}`);
  if (s.chainId) extra.push(`chainId: ${s.chainId}`);
  if (s.address) extra.push(`address: ${s.address}`);
  if (s.topic) extra.push(`topic: ${s.topic}`);
  return { ts, level, service, code, msg, requestId: reqId, extra: extra.join(", ") };
}

// --- 도구 1: 로그 검색 ---
server.tool(
  "elk_search",
  "Elasticsearch에서 로그 검색 (서비스, 레벨, 키워드, 시간범위)",
  {
    query: z.string().optional().describe("검색 키워드 (에러코드, 메시지 등). 생략 시 전체"),
    service: z.string().optional().describe("서비스/프로세스 이름 필터"),
    level: z.enum(["error", "warn", "info", "debug", "fatal"]).optional().describe("로그 레벨 필터"),
    minutes: z.number().optional().describe("최근 N분 이내 (생략 시 전체)"),
    size: z.number().default(20).describe("조회 건수 (기본: 20, 최대: 100)"),
  },
  async ({ query, service, level, minutes, size }) => {
    const must = [];

    if (query) {
      must.push({ query_string: { query, default_field: "message", lenient: true } });
    }
    if (service) {
      must.push({
        bool: {
          should: [
            { term: { "service": service } },
            { term: { "app": service } },
            { term: { "pm2_name": service } },
          ],
        },
      });
    }
    if (level) {
      const levelNum = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[level];
      must.push({
        bool: {
          should: [
            { term: { "level": level } },
            { term: { "level": levelNum } },
            { term: { "lvl": level } },
            { term: { "lvl": levelNum } },
          ],
        },
      });
    }
    if (minutes) {
      must.push(timeRange(minutes));
    }

    try {
      const result = await esQuery(`/${ES_INDEX_PATTERN}/_search`, {
        query: must.length > 0 ? { bool: { must } } : { match_all: {} },
        sort: [{ "@timestamp": "desc" }],
        size: Math.min(size, 100),
        _source: true,
      });

      const hits = result.hits?.hits || [];
      if (hits.length === 0) {
        return { content: [{ type: "text", text: "검색 결과 없음" }] };
      }

      const rows = hits.map((hit, i) => {
        const f = formatHit(hit);
        const parts = [`**[${i + 1}]** \`${f.ts}\` **${f.service}** [${f.level}]`];
        if (f.code) parts.push(`**${f.code}**`);
        parts.push(f.msg);
        if (f.requestId) parts.push(`_requestId: ${f.requestId}_`);
        if (f.extra) parts.push(`_${f.extra}_`);
        return parts.join("\n");
      });

      const total = result.hits?.total?.value || hits.length;
      return {
        content: [{
          type: "text",
          text: `## 검색 결과 (${hits.length}/${total}건)\n\n${rows.join("\n\n---\n\n")}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// --- 도구 2: requestId 추적 ---
server.tool(
  "elk_trace",
  "requestId로 전체 서비스 흐름 추적 (cross-service)",
  {
    requestId: z.string().describe("추적할 requestId"),
    minutes: z.number().optional().describe("검색 범위 - 최근 N분 (생략 시 24시간)"),
  },
  async ({ requestId, minutes }) => {
    const must = [
      {
        bool: {
          should: [
            { term: { "requestId": requestId } },
            { term: { "requestId.keyword": requestId } },
            { match_phrase: { message: requestId } },
          ],
        },
      },
    ];

    const range = minutes || 1440;
    must.push(timeRange(range));

    try {
      const result = await esQuery(`/${ES_INDEX_PATTERN}/_search`, {
        query: { bool: { must } },
        sort: [{ "@timestamp": "asc" }],
        size: 200,
        _source: true,
      });

      const hits = result.hits?.hits || [];
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `requestId "${requestId}" 로그 없음 (최근 ${range}분)` }] };
      }

      // group by service
      const services = new Map();
      const timeline = [];

      for (const hit of hits) {
        const f = formatHit(hit);
        const svc = f.service || "unknown";
        if (!services.has(svc)) services.set(svc, []);
        services.get(svc).push(f);
        timeline.push(f);
      }

      // build output
      const lines = [];

      // timeline
      lines.push("## 타임라인\n");
      lines.push("| 시간 | 서비스 | 레벨 | 에러코드 | 메시지 |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const f of timeline) {
        const msg = f.msg.length > 80 ? f.msg.slice(0, 80) + "..." : f.msg;
        lines.push(`| ${f.ts} | ${f.service} | ${f.level} | ${f.code || "-"} | ${msg} |`);
      }

      // service summary
      lines.push(`\n## 서비스별 로그 수\n`);
      for (const [svc, logs] of services) {
        const errorCount = logs.filter((l) => l.level === "error" || l.level === 50 || l.level === "fatal" || l.level === 60).length;
        lines.push(`- **${svc}**: ${logs.length}건${errorCount > 0 ? ` (에러 ${errorCount}건)` : ""}`);
      }

      // errors detail
      const errors = timeline.filter((f) => f.level === "error" || f.level === 50 || f.level === "fatal" || f.level === 60);
      if (errors.length > 0) {
        lines.push(`\n## 에러 상세\n`);
        for (const f of errors) {
          lines.push(`### ${f.ts} — ${f.service}`);
          lines.push(`- **에러코드**: ${f.code || "UNCATEGORIZED"}`);
          lines.push(`- **메시지**: ${f.msg}`);
          if (f.extra) lines.push(`- **컨텍스트**: ${f.extra}`);
          lines.push("");
        }
      }

      return {
        content: [{
          type: "text",
          text: `# 요청 추적: ${requestId}\n\n전체 ${hits.length}건, ${services.size}개 서비스\n\n${lines.join("\n")}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// --- 도구 3: 에러 추이 ---
server.tool(
  "elk_error_trend",
  "시간대별/서비스별 에러 발생 추이",
  {
    service: z.string().optional().describe("서비스 필터 (생략 시 전체)"),
    minutes: z.number().default(360).describe("분석 범위 - 최근 N분 (기본: 360 = 6시간)"),
    interval: z.enum(["5m", "10m", "30m", "1h", "6h", "1d"]).default("1h").describe("집계 구간 (기본: 1h)"),
  },
  async ({ service, minutes, interval }) => {
    const must = [
      {
        bool: {
          should: [
            { term: { "level": "error" } },
            { term: { "level": 50 } },
            { term: { "level": "fatal" } },
            { term: { "level": 60 } },
          ],
        },
      },
      timeRange(minutes),
    ];

    if (service) {
      must.push({
        bool: {
          should: [
            { term: { "service": service } },
            { term: { "app": service } },
            { term: { "pm2_name": service } },
          ],
        },
      });
    }

    try {
      const result = await esQuery(`/${ES_INDEX_PATTERN}/_search`, {
        query: { bool: { must } },
        size: 0,
        aggs: {
          trend: {
            date_histogram: {
              field: "@timestamp",
              fixed_interval: interval,
              min_doc_count: 0,
              extended_bounds: {
                min: `now-${minutes}m`,
                max: "now",
              },
            },
            aggs: {
              by_service: {
                terms: { field: "service", size: 10 },
              },
              by_code: {
                terms: { field: "errorCode", size: 5 },
              },
            },
          },
        },
      });

      const buckets = result.aggregations?.trend?.buckets || [];
      if (buckets.length === 0) {
        return { content: [{ type: "text", text: "에러 없음" }] };
      }

      const lines = [];
      lines.push("| 시간 | 건수 | 서비스 | 주요 에러코드 |");
      lines.push("| --- | ---: | --- | --- |");

      let totalErrors = 0;
      for (const b of buckets) {
        const time = new Date(b.key_as_string || b.key).toISOString().slice(0, 16);
        const count = b.doc_count;
        totalErrors += count;
        const svcList = (b.by_service?.buckets || [])
          .map((s) => `${s.key}(${s.doc_count})`)
          .join(", ");
        const codeList = (b.by_code?.buckets || [])
          .map((c) => `${c.key}(${c.doc_count})`)
          .join(", ");
        if (count > 0) {
          lines.push(`| ${time} | ${count} | ${svcList || "-"} | ${codeList || "-"} |`);
        }
      }

      const scope = service ? `${service}` : "전체";
      return {
        content: [{
          type: "text",
          text: `## 에러 추이 (${scope}, 최근 ${minutes}분, ${interval} 단위)\n\n총 ${totalErrors}건\n\n${lines.join("\n")}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// --- 도구 4: 에러 요약 ---
server.tool(
  "elk_error_summary",
  "에러코드별/서비스별 발생 빈도 집계",
  {
    service: z.string().optional().describe("서비스 필터 (생략 시 전체)"),
    minutes: z.number().default(60).describe("분석 범위 - 최근 N분 (기본: 60)"),
  },
  async ({ service, minutes }) => {
    const must = [
      {
        bool: {
          should: [
            { term: { "level": "error" } },
            { term: { "level": 50 } },
            { term: { "level": "fatal" } },
            { term: { "level": 60 } },
          ],
        },
      },
      timeRange(minutes),
    ];

    if (service) {
      must.push({
        bool: {
          should: [
            { term: { "service": service } },
            { term: { "app": service } },
            { term: { "pm2_name": service } },
          ],
        },
      });
    }

    try {
      const result = await esQuery(`/${ES_INDEX_PATTERN}/_search`, {
        query: { bool: { must } },
        size: 0,
        aggs: {
          by_code: {
            terms: { field: "errorCode", size: 30 },
            aggs: {
              by_service: {
                terms: { field: "service", size: 5 },
              },
              last_seen: {
                max: { field: "@timestamp" },
              },
              sample: {
                top_hits: { size: 1, sort: [{ "@timestamp": "desc" }], _source: ["msg", "message"] },
              },
            },
          },
          by_service: {
            terms: { field: "service", size: 20 },
          },
        },
      });

      const codeBuckets = result.aggregations?.by_code?.buckets || [];
      const svcBuckets = result.aggregations?.by_service?.buckets || [];
      const total = codeBuckets.reduce((sum, b) => sum + b.doc_count, 0);

      if (total === 0) {
        return { content: [{ type: "text", text: `에러 없음 (최근 ${minutes}분)` }] };
      }

      const lines = [];

      // by error code
      lines.push("### 에러코드별\n");
      lines.push("| 에러코드 | 횟수 | 서비스 | 마지막 발생 | 메시지 샘플 |");
      lines.push("| --- | ---: | --- | --- | --- |");
      for (const b of codeBuckets) {
        const svcList = (b.by_service?.buckets || []).map((s) => s.key).join(", ");
        const lastSeen = b.last_seen?.value_as_string
          ? new Date(b.last_seen.value_as_string).toISOString().slice(0, 19)
          : "-";
        const sampleSrc = b.sample?.hits?.hits?.[0]?._source || {};
        const sampleMsg = (sampleSrc.msg || sampleSrc.message || "").slice(0, 60);
        lines.push(`| ${b.key} | ${b.doc_count} | ${svcList || "-"} | ${lastSeen} | ${sampleMsg} |`);
      }

      // by service
      lines.push("\n### 서비스별\n");
      lines.push("| 서비스 | 에러 수 |");
      lines.push("| --- | ---: |");
      for (const b of svcBuckets) {
        lines.push(`| ${b.key} | ${b.doc_count} |`);
      }

      const scope = service ? `${service}` : "전체";
      return {
        content: [{
          type: "text",
          text: `## 에러 요약 (${scope}, 최근 ${minutes}분, 총 ${total}건)\n\n${lines.join("\n")}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// --- 도구 5: 인덱스 목록 ---
server.tool(
  "elk_indices",
  "Elasticsearch 인덱스 목록 및 상태 조회",
  {},
  async () => {
    try {
      const data = await esGet("/_cat/indices?format=json&s=index&h=index,health,status,docs.count,store.size");

      if (!Array.isArray(data) || data.length === 0) {
        return { content: [{ type: "text", text: "인덱스 없음" }] };
      }

      // filter out system indices
      const indices = data.filter((idx) => !idx.index.startsWith("."));

      const lines = [];
      lines.push("| 인덱스 | 상태 | 문서 수 | 크기 |");
      lines.push("| --- | --- | ---: | --- |");
      for (const idx of indices) {
        lines.push(`| ${idx.index} | ${idx.health}/${idx.status} | ${idx["docs.count"] || 0} | ${idx["store.size"] || "-"} |`);
      }

      return {
        content: [{
          type: "text",
          text: `## ES 인덱스 (${indices.length}개)\n\n현재 인덱스 패턴: \`${ES_INDEX_PATTERN}\`\n\n${lines.join("\n")}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
