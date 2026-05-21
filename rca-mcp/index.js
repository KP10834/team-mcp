import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JsonRpcProvider, formatEther, formatUnits, Contract, FetchRequest } from "ethers";
import { z } from "zod";

// ─── Kibana / ES config ────────────────────────────────────────
const KIBANA_URL = (process.env.KIBANA_URL || "").replace(/\/$/, "");
const API_KEY = process.env.KIBANA_API_KEY || "";
const COOKIE = process.env.KIBANA_COOKIE || "";

if (!KIBANA_URL) {
  console.error("[rca-mcp] KIBANA_URL 필수");
  process.exit(1);
}
if (!API_KEY && !COOKIE) {
  console.error("[rca-mcp] KIBANA_API_KEY 또는 KIBANA_COOKIE 중 하나 필수");
  process.exit(1);
}

function authHeaders() {
  const h = { "kbn-xsrf": "true" };
  if (API_KEY) h.Authorization = `ApiKey ${API_KEY}`;
  else if (COOKIE) h.Cookie = COOKIE;
  return h;
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

// ─── EVM config ────────────────────────────────────────────────
const CHAIN_CONFIG = {
  "11155111": { name: "Sepolia", rpc: process.env.RPC_SEPOLIA || "" },
  "43113": { name: "Fuji", rpc: process.env.RPC_FUJI || "" },
};

// Load additional chains from RCA_CHAIN_CONFIG env var (JSON string)
// Format: { "<chainId>": { "name": "...", "rpc": "..." }, ... }
if (process.env.RCA_CHAIN_CONFIG) {
  try {
    const extra = JSON.parse(process.env.RCA_CHAIN_CONFIG);
    for (const [id, cfg] of Object.entries(extra)) {
      CHAIN_CONFIG[id] = { name: cfg.name || id, rpc: cfg.rpc || "" };
    }
  } catch (e) {
    console.error("[rca-mcp] RCA_CHAIN_CONFIG JSON parse error:", e.message);
  }
}

const RPC_TIMEOUT = parseInt(process.env.RPC_TIMEOUT_MS || "10000", 10);

function getProvider(chainId, rpcUrlOverride) {
  if (rpcUrlOverride) {
    const req = new FetchRequest(rpcUrlOverride);
    req.timeout = RPC_TIMEOUT;
    return new JsonRpcProvider(req);
  }
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) throw new Error(`Unknown chainId: ${chainId}. Supported: ${Object.keys(CHAIN_CONFIG).join(", ")}`);
  const req = new FetchRequest(cfg.rpc);
  req.timeout = RPC_TIMEOUT;
  return new JsonRpcProvider(req);
}

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ─── Shared: source fields & formatting ────────────────────────
const LOG_INDEX_PATTERN = process.env.ES_INDEX_PATTERN || "*";

const SOURCE_FIELDS = [
  "@timestamp", "message",
  "log.level", "log.logger", "logger_name",
  "host.name", "service.name", "app",
  "requestId", "txHash", "chainId",
  "err.cause", "err.code", "err.message", "err.retryable",
  "thread_name",
];

function extractField(source, ...keys) {
  for (const key of keys) {
    const parts = key.split(".");
    let v = source;
    for (const p of parts) {
      if (v == null) break;
      v = v[p];
    }
    if (v != null && v !== "") return v;
  }
  return "";
}

function formatLogLine(source) {
  const ts = extractField(source, "@timestamp");
  const level = (extractField(source, "log.level") || "").toLowerCase();
  const logger = extractField(source, "log.logger", "logger_name");
  const service = extractField(source, "service.name", "app");
  const host = extractField(source, "host.name");
  const msg = extractField(source, "message");
  const reqId = extractField(source, "requestId");
  const txHash = extractField(source, "txHash");
  const thread = extractField(source, "thread_name");

  const errParts = [];
  const errCode = extractField(source, "err.code");
  const errMsg = extractField(source, "err.message");
  const errCause = extractField(source, "err.cause");
  const errRetryable = extractField(source, "err.retryable");
  if (errCode) errParts.push(`code=${errCode}`);
  if (errMsg) errParts.push(errMsg);
  if (errCause) errParts.push(`cause=${errCause}`);
  if (errRetryable !== "") errParts.push(`retryable=${errRetryable}`);
  const errStr = errParts.length ? `\n    err: ${errParts.join(" | ")}` : "";

  const isHighlight = level === "error" || level === "warn" || level === "fatal";
  const levelTag = isHighlight ? `***${level.toUpperCase()}***` : level.toUpperCase();

  const meta = [
    service ? `\`${service}\`` : "",
    logger ? `logger=${logger}` : "",
    host ? `host=${host}` : "",
    reqId ? `reqId=${reqId}` : "",
    txHash ? `txHash=${txHash}` : "",
    thread ? `thread=${thread}` : "",
  ].filter(Boolean).join(" · ");

  return `- **${ts}** [${levelTag}] ${meta}\n  ${msg}${errStr}`;
}

function formatTimeline(hits) {
  if (!hits.length) return "결과 없음";
  return hits.map((h) => formatLogLine(h._source || {})).join("\n\n");
}

// ─── MCP Server ────────────────────────────────────────────────
const server = new McpServer({ name: "rca-mcp", version: "1.0.0" });

// ─── Tool 1: rca_timeline ──────────────────────────────────────
server.tool(
  "rca_timeline",
  "request_id 또는 txHash의 에러 관련 로그를 시간순 타임라인으로 조합. around로 특정 시각 기준 조회 가능.",
  {
    request_id: z.string().optional().describe("요청 ID"),
    tx_hash: z.string().optional().describe("트랜잭션 해시"),
    around: z.string().optional().describe("기준 시각 (ISO8601). 없으면 now 기준"),
    minutes: z.number().default(5).describe("기준 시각 ±N분 (기본 5)"),
    error_only: z.boolean().default(false).describe("true면 ERROR/WARN만 필터"),
    size: z.number().default(50).describe("최대 조회 건수 (기본 50)"),
  },
  async ({ request_id, tx_hash, around, minutes, error_only, size }) => {
    if (!request_id && !tx_hash) {
      return { content: [{ type: "text", text: "ERROR: request_id 또는 tx_hash 중 하나 이상 필수" }] };
    }

    try {
      const should = [];
      const identifier = request_id || tx_hash;

      if (request_id) {
        should.push({ match: { requestId: request_id } });
        should.push({ match_phrase: { message: request_id } });
      }
      if (tx_hash) {
        should.push({ match: { txHash: tx_hash } });
        should.push({ match_phrase: { message: tx_hash } });
      }

      // Phase A: if no 'around', find the event timestamp first
      let anchor = around;
      if (!anchor) {
        const probe = {
          size: 1,
          sort: [{ "@timestamp": "desc" }],
          _source: ["@timestamp"],
          query: { bool: { should, minimum_should_match: 1 } },
        };
        const probeData = await esProxy(`${LOG_INDEX_PATTERN}/_search`, "POST", probe);
        const probeHit = probeData.hits?.hits?.[0];
        if (probeHit) {
          anchor = probeHit._source["@timestamp"];
        }
      }

      // Build time range around anchor (or fallback to now-minutes)
      let timeRange;
      if (anchor) {
        const anchorMs = new Date(anchor).getTime();
        const gte = new Date(anchorMs - minutes * 60000).toISOString();
        const lte = new Date(anchorMs + minutes * 60000).toISOString();
        timeRange = { range: { "@timestamp": { gte, lte } } };
      } else {
        timeRange = { range: { "@timestamp": { gte: `now-${minutes}m`, lte: "now" } } };
      }

      const must = [timeRange];

      // error_only filter
      if (error_only) {
        must.push({
          bool: {
            should: [
              { term: { "log.level": "error" } },
              { term: { "log.level": "ERROR" } },
              { term: { "log.level": "warn" } },
              { term: { "log.level": "WARN" } },
              { term: { "log.level": "fatal" } },
              { term: { "log.level": "FATAL" } },
            ],
            minimum_should_match: 1,
          },
        });
      }

      const body = {
        size: Math.min(size, 200),
        sort: [{ "@timestamp": "asc" }],
        _source: SOURCE_FIELDS,
        query: { bool: { must, should, minimum_should_match: 1 } },
      };

      const data = await esProxy(`${LOG_INDEX_PATTERN}/_search`, "POST", body);
      const hits = data.hits?.hits || [];
      const total = data.hits?.total?.value ?? hits.length;

      if (!hits.length) {
        return { content: [{ type: "text", text: `결과 없음 (identifier: ${identifier}, ±${minutes}분${anchor ? `, anchor=${anchor}` : ""})` }] };
      }

      const timeline = formatTimeline(hits);
      const anchorNote = anchor ? `\n**기준 시각**: ${anchor} (±${minutes}분)` : `\n**범위**: 최근 ${minutes}분`;
      const filterNote = error_only ? " [ERROR/WARN only]" : "";
      return {
        content: [{ type: "text", text: `## RCA Timeline (${hits.length}/${total}건)${filterNote}\n**식별자**: ${identifier}${anchorNote}\n\n${timeline}` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// ─── Tool 2: rca_compare ───────────────────────────────────────
server.tool(
  "rca_compare",
  "실패 request_id와 동일 시간대 성공 건을 자동 비교. 에러 로그 차이에 집중.",
  {
    failed_id: z.string().describe("실패한 요청의 request_id"),
    success_id: z.string().optional().describe("성공한 요청의 request_id (생략 시 자동 탐색)"),
    around: z.string().optional().describe("기준 시각 (ISO8601). 없으면 자동 탐색"),
    minutes: z.number().default(10).describe("기준 시각 ±N분 (기본 10)"),
  },
  async ({ failed_id, success_id, around, minutes }) => {
    try {
      // Find anchor time from failed request
      let anchor = around;
      if (!anchor) {
        const probe = {
          size: 1,
          sort: [{ "@timestamp": "desc" }],
          _source: ["@timestamp"],
          query: { bool: { should: [{ match: { requestId: failed_id } }, { match_phrase: { message: failed_id } }], minimum_should_match: 1 } },
        };
        const probeData = await esProxy(`${LOG_INDEX_PATTERN}/_search`, "POST", probe);
        const probeHit = probeData.hits?.hits?.[0];
        if (probeHit) anchor = probeHit._source["@timestamp"];
      }

      // Build time range
      let timeRange;
      if (anchor) {
        const anchorMs = new Date(anchor).getTime();
        timeRange = { range: { "@timestamp": { gte: new Date(anchorMs - minutes * 60000).toISOString(), lte: new Date(anchorMs + minutes * 60000).toISOString() } } };
      } else {
        timeRange = { range: { "@timestamp": { gte: `now-${minutes * 2}m`, lte: "now" } } };
      }

      // Step 1: fetch failed timeline
      const failedQuery = {
        size: 100,
        sort: [{ "@timestamp": "asc" }],
        _source: SOURCE_FIELDS,
        query: {
          bool: {
            must: [timeRange],
            should: [
              { match: { requestId: failed_id } },
              { match_phrase: { message: failed_id } },
            ],
            minimum_should_match: 1,
          },
        },
      };

      const failedData = await esProxy(`${LOG_INDEX_PATTERN}/_search`, "POST", failedQuery);
      const failedHits = failedData.hits?.hits || [];

      if (!failedHits.length) {
        return { content: [{ type: "text", text: `실패 요청 '${failed_id}' 로그 없음 (±${minutes}분)` }] };
      }

      // Step 2: resolve success_id if not provided
      let resolvedSuccessId = success_id;
      if (!resolvedSuccessId) {
        const aggsQuery = {
          size: 0,
          query: {
            bool: {
              must: [timeRange, { exists: { field: "requestId" } }],
              must_not: [{ term: { "requestId.keyword": failed_id } }],
            },
          },
          aggs: {
            by_request: {
              terms: { field: "requestId.keyword", size: 20 },
              aggs: {
                error_count: {
                  filter: {
                    bool: {
                      should: [
                        { term: { "log.level": "error" } },
                        { term: { "log.level": "ERROR" } },
                        { term: { "log.level": "fatal" } },
                        { term: { "log.level": "FATAL" } },
                      ],
                    },
                  },
                },
              },
            },
          },
        };

        const aggsData = await esProxy(`${LOG_INDEX_PATTERN}/_search`, "POST", aggsQuery);
        const buckets = aggsData.aggregations?.by_request?.buckets || [];

        if (!buckets.length) {
          return {
            content: [{ type: "text", text: `## 비교 실패\n동일 시간대에 다른 requestId를 찾을 수 없음.\n\n### 실패 건 에러 로그 (${failed_id})\n${formatTimeline(failedHits.filter(h => { const lvl = (extractField(h._source || {}, "log.level") || "").toLowerCase(); return lvl === "error" || lvl === "warn" || lvl === "fatal"; }))}` }],
          };
        }

        buckets.sort((a, b) => a.error_count.doc_count - b.error_count.doc_count);
        resolvedSuccessId = buckets[0].key;
      }

      // Step 3: fetch success timeline
      const successQuery = {
        size: 100,
        sort: [{ "@timestamp": "asc" }],
        _source: SOURCE_FIELDS,
        query: {
          bool: {
            must: [timeRange],
            should: [
              { match: { requestId: resolvedSuccessId } },
              { match_phrase: { message: resolvedSuccessId } },
            ],
            minimum_should_match: 1,
          },
        },
      };

      const successData = await esProxy(`${LOG_INDEX_PATTERN}/_search`, "POST", successQuery);
      const successHits = successData.hits?.hits || [];

      // Step 4: format — show errors first, then full timeline
      const failedErrors = failedHits.filter(h => {
        const lvl = (extractField(h._source || {}, "log.level") || "").toLowerCase();
        return lvl === "error" || lvl === "warn" || lvl === "fatal";
      });

      const autoNote = success_id ? "" : ` (자동 탐색됨)`;
      return {
        content: [{
          type: "text",
          text: [
            `## RCA Compare`,
            anchor ? `**기준 시각**: ${anchor} (±${minutes}분)` : "",
            "",
            `### FAILED 에러 요약: ${failed_id} (에러 ${failedErrors.length}건 / 전체 ${failedHits.length}건)`,
            failedErrors.length ? formatTimeline(failedErrors) : "(에러 로그 없음 — 전체 타임라인 참고)",
            "",
            `### FAILED 전체 타임라인`,
            formatTimeline(failedHits),
            "",
            `### SUCCESS: ${resolvedSuccessId}${autoNote} (${successHits.length}건)`,
            successHits.length ? formatTimeline(successHits) : "로그 없음",
          ].filter(Boolean).join("\n"),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// ─── Tool 3: rca_onchain ───────────────────────────────────────
server.tool(
  "rca_onchain",
  "txHash의 온체인 상태를 한 번에 조회 (receipt + nonce + 잔고 + allowance)",
  {
    tx_hash: z.string().describe("트랜잭션 해시"),
    chain_id: z.string().describe("체인 ID (예: 11155111=Sepolia, 43113=Fuji)"),
    token_address: z.string().optional().describe("ERC20 토큰 주소 (잔액/allowance 조회)"),
    spender_address: z.string().optional().describe("Spender 주소 (기본: tx.to)"),
    rpc_url: z.string().optional().describe("RPC URL 직접 지정 (체인 설정 무시)"),
  },
  async ({ tx_hash, chain_id, token_address, spender_address, rpc_url }) => {
    try {
      const provider = getProvider(chain_id, rpc_url);
      const chainLabel = rpc_url
        ? `custom (${rpc_url})`
        : `${CHAIN_CONFIG[chain_id]?.name || chain_id} (${chain_id})`;

      // Fetch tx + receipt
      const [tx, receipt] = await Promise.all([
        provider.getTransaction(tx_hash),
        provider.getTransactionReceipt(tx_hash),
      ]);

      if (!tx) {
        return { content: [{ type: "text", text: `트랜잭션 '${tx_hash}' 없음 (chain: ${chainLabel})` }] };
      }

      const lines = [
        `## RCA On-chain: ${tx_hash}`,
        `**chain**: ${chainLabel}`,
        "",
        `### Transaction`,
        `- **from**: ${tx.from}`,
        `- **to**: ${tx.to}`,
        `- **value**: ${formatEther(tx.value)} native`,
        `- **nonce**: ${tx.nonce}`,
        `- **gasLimit**: ${tx.gasLimit.toString()}`,
        `- **block**: ${tx.blockNumber ?? "pending"}`,
      ];

      if (receipt) {
        lines.push(
          "",
          `### Receipt`,
          `- **status**: ${receipt.status === 1 ? "SUCCESS" : "***FAILED***"}`,
          `- **gasUsed**: ${receipt.gasUsed.toString()}`,
          `- **logs**: ${receipt.logs.length}건`,
        );
      } else {
        lines.push("", `### Receipt`, "아직 confirm 되지 않음 (pending)");
      }

      // Nonce info
      const [confirmedNonce, pendingNonce] = await Promise.all([
        provider.getTransactionCount(tx.from, "latest"),
        provider.getTransactionCount(tx.from, "pending"),
      ]);
      lines.push(
        "",
        `### Nonce (${tx.from})`,
        `- **confirmed**: ${confirmedNonce}`,
        `- **pending**: ${pendingNonce}${pendingNonce > confirmedNonce ? ` (${pendingNonce - confirmedNonce}건 pending)` : ""}`,
      );

      // Native balance at tx block
      if (tx.blockNumber) {
        const balance = await provider.getBalance(tx.from, tx.blockNumber);
        lines.push(
          "",
          `### Native Balance (block ${tx.blockNumber})`,
          `- **${tx.from}**: ${formatEther(balance)} native`,
        );
      }

      // ERC20 info if token_address provided
      if (token_address && tx.blockNumber) {
        const contract = new Contract(token_address, ERC20_ABI, provider);
        const spender = spender_address || tx.to;

        let decimals = 18;
        let symbol = "TOKEN";
        try {
          [decimals, symbol] = await Promise.all([
            contract.decimals(),
            contract.symbol(),
          ]);
        } catch {
          // fallback to defaults
        }

        const blockBefore = tx.blockNumber - 1;
        const blockAfter = tx.blockNumber;

        const [balBefore, balAfter] = await Promise.all([
          contract.balanceOf(tx.from, { blockTag: blockBefore }),
          contract.balanceOf(tx.from, { blockTag: blockAfter }),
        ]);

        lines.push(
          "",
          `### ERC20 Balance — ${symbol} (${token_address})`,
          `- **before** (block ${blockBefore}): ${formatUnits(balBefore, decimals)} ${symbol}`,
          `- **after**  (block ${blockAfter}): ${formatUnits(balAfter, decimals)} ${symbol}`,
        );

        if (spender) {
          const [allowBefore, allowAfter] = await Promise.all([
            contract.allowance(tx.from, spender, { blockTag: blockBefore }),
            contract.allowance(tx.from, spender, { blockTag: blockAfter }),
          ]);

          lines.push(
            "",
            `### ERC20 Allowance — ${symbol} (spender: ${spender})`,
            `- **before** (block ${blockBefore}): ${formatUnits(allowBefore, decimals)} ${symbol}`,
            `- **after**  (block ${blockAfter}): ${formatUnits(allowAfter, decimals)} ${symbol}`,
          );
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// ─── Start ─────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
