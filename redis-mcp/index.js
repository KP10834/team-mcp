import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Redis from "ioredis";
import { z } from "zod";

const host = process.env.REDIS_HOST || "localhost";
const port = parseInt(process.env.REDIS_PORT || "6379", 10);
const db = parseInt(process.env.REDIS_DB || "0", 10);
const password = process.env.REDIS_PASSWORD || undefined;
const keyPrefix = process.env.REDIS_KEY_PREFIX || "bc-adapter:";

const redis = new Redis({ host, port, db, password, lazyConnect: true });
await redis.connect();

const server = new McpServer({ name: "redis-mcp", version: "1.0.0" });

// 키 검색
server.tool(
  "redis_keys",
  "패턴으로 Redis 키 검색 (prefix 자동 적용)",
  {
    pattern: z.string().default("*").describe("검색 패턴 (기본: *)"),
  },
  async ({ pattern }) => {
    const keys = await redis.keys(`${keyPrefix}${pattern}`);
    if (keys.length === 0) {
      return { content: [{ type: "text", text: `패턴 '${keyPrefix}${pattern}'에 해당하는 키 없음` }] };
    }
    const text = keys.sort().map((k) => `- \`${k}\``).join("\n");
    return { content: [{ type: "text", text: `## Keys (${keys.length}개)\n${text}` }] };
  },
);

// 키 값 조회
server.tool(
  "redis_get",
  "Redis 키 값 조회 (string, hash, list, set, zset 자동 감지)",
  {
    key: z.string().describe("조회할 키 (prefix 제외, 자동 적용)"),
  },
  async ({ key }) => {
    const fullKey = `${keyPrefix}${key}`;
    const type = await redis.type(fullKey);

    if (type === "none") {
      return { content: [{ type: "text", text: `키 '${fullKey}' 없음` }] };
    }

    let value;
    switch (type) {
      case "string":
        value = await redis.get(fullKey);
        break;
      case "hash":
        value = JSON.stringify(await redis.hgetall(fullKey), null, 2);
        break;
      case "list":
        value = JSON.stringify(await redis.lrange(fullKey, 0, -1), null, 2);
        break;
      case "set":
        value = JSON.stringify(await redis.smembers(fullKey), null, 2);
        break;
      case "zset":
        value = JSON.stringify(await redis.zrange(fullKey, 0, -1, "WITHSCORES"), null, 2);
        break;
      default:
        value = `(unsupported type: ${type})`;
    }

    const ttl = await redis.ttl(fullKey);
    const ttlText = ttl === -1 ? "없음" : ttl === -2 ? "만료됨" : `${ttl}초`;
    return {
      content: [{ type: "text", text: `## ${fullKey}\n- **type**: ${type}\n- **TTL**: ${ttlText}\n\`\`\`json\n${value}\n\`\`\`` }],
    };
  },
);

// 키 삭제
server.tool(
  "redis_del",
  "Redis 키 삭제",
  {
    key: z.string().describe("삭제할 키 (prefix 제외, 자동 적용)"),
  },
  async ({ key }) => {
    const fullKey = `${keyPrefix}${key}`;
    const result = await redis.del(fullKey);
    return {
      content: [{ type: "text", text: result ? `삭제 완료: ${fullKey}` : `키 '${fullKey}' 없음` }],
    };
  },
);

// TTL 조회
server.tool(
  "redis_ttl",
  "Redis 키 TTL 조회",
  {
    key: z.string().describe("조회할 키 (prefix 제외, 자동 적용)"),
  },
  async ({ key }) => {
    const fullKey = `${keyPrefix}${key}`;
    const ttl = await redis.ttl(fullKey);
    let text;
    if (ttl === -2) text = `키 '${fullKey}' 없음`;
    else if (ttl === -1) text = `${fullKey}: TTL 없음 (영구)`;
    else text = `${fullKey}: ${ttl}초 남음`;
    return { content: [{ type: "text", text }] };
  },
);

// 락 상태 확인
server.tool(
  "redis_locks",
  "현재 활성 락(lock) 목록 조회",
  {},
  async () => {
    const keys = await redis.keys(`${keyPrefix}lock:*`);
    if (keys.length === 0) {
      return { content: [{ type: "text", text: "활성 락 없음" }] };
    }
    const results = [];
    for (const k of keys.sort()) {
      const value = await redis.get(k);
      const ttl = await redis.ttl(k);
      results.push(`- \`${k}\` = \`${value}\` (TTL: ${ttl}초)`);
    }
    return { content: [{ type: "text", text: `## 활성 락 (${keys.length}개)\n${results.join("\n")}` }] };
  },
);

// Redis INFO
server.tool(
  "redis_info",
  "Redis 서버 정보 요약 (메모리, 클라이언트, keyspace)",
  {},
  async () => {
    const info = await redis.info();
    const sections = ["memory", "clients", "keyspace", "server"];
    const lines = info.split("\n");
    const filtered = [];
    let include = false;
    for (const line of lines) {
      if (line.startsWith("# ")) {
        const section = line.replace("# ", "").trim().toLowerCase();
        include = sections.includes(section);
        if (include) filtered.push(`\n## ${section}`);
      } else if (include && line.trim()) {
        filtered.push(line.trim());
      }
    }
    return { content: [{ type: "text", text: filtered.join("\n") }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
