import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { z } from "zod";
import { resolve } from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";

// SQLITE_DATABASES 환경변수로 DB 목록 설정 가능
// 형식: "name1:file1.db,name2:file2.db"
// 기본값: account, config, outbox, keys
function buildDbMap() {
  const custom = process.env.SQLITE_DATABASES;
  if (custom) {
    const map = {};
    for (const entry of custom.split(",")) {
      const [name, file] = entry.trim().split(":");
      if (name && file) map[name] = resolve(DATA_DIR, file);
    }
    return map;
  }
  return {
    account: resolve(DATA_DIR, "account.db"),
    config: resolve(DATA_DIR, "config.db"),
    outbox: resolve(DATA_DIR, "outbox.db"),
    keys: resolve(DATA_DIR, "keys.db"),
  };
}

const DB_MAP = buildDbMap();
const dbNames = Object.keys(DB_MAP);

function getDb(name) {
  const path = DB_MAP[name];
  if (!path) throw new Error(`Unknown database: ${name}. Available: ${dbNames.join(", ")}`);
  return new Database(path, { readonly: true });
}

const server = new McpServer({ name: "sqlite-mcp", version: "1.0.0" });

// DB 목록 및 테이블 조회
server.tool(
  "sqlite_tables",
  "데이터베이스 목록 및 테이블/컬럼 정보 조회",
  {
    db: z.string().optional().describe(`DB명 (생략 시 전체). 가능: ${dbNames.join(", ")}`),
  },
  async ({ db: dbName }) => {
    const targets = dbName ? [dbName] : dbNames;
    const sections = [];

    for (const name of targets) {
      try {
        const db = getDb(name);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        const tableInfos = tables.map((t) => {
          const columns = db.prepare(`PRAGMA table_info('${t.name}')`).all();
          const cols = columns.map((c) => `  - ${c.name} (${c.type}${c.pk ? ", PK" : ""}${c.notnull ? ", NOT NULL" : ""})`);
          const count = db.prepare(`SELECT COUNT(*) as cnt FROM '${t.name}'`).get();
          return `### ${t.name} (${count.cnt}행)\n${cols.join("\n")}`;
        });
        sections.push(`## ${name}.db\npath: ${DB_MAP[name]}\n\n${tableInfos.join("\n\n")}`);
        db.close();
      } catch (e) {
        sections.push(`## ${name}.db\n⚠ ${e.message}`);
      }
    }

    return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
  },
);

// SQL 쿼리 실행 (읽기 전용)
server.tool(
  "sqlite_query",
  "SQL SELECT 쿼리 실행 (읽기 전용)",
  {
    db: z.string().describe(`대상 DB (${dbNames.join(", ")})`),
    sql: z.string().describe("SELECT 쿼리"),
    limit: z.number().default(50).describe("결과 제한 (기본: 50)"),
  },
  async ({ db: dbName, sql, limit }) => {
    const trimmed = sql.trim().toLowerCase();
    if (!trimmed.startsWith("select") && !trimmed.startsWith("with") && !trimmed.startsWith("pragma")) {
      return { content: [{ type: "text", text: "ERROR: SELECT/WITH/PRAGMA 쿼리만 허용됩니다" }] };
    }

    try {
      const db = getDb(dbName);
      const limitedSql = trimmed.includes("limit") ? sql : `${sql.replace(/;?\s*$/, "")} LIMIT ${limit}`;
      const rows = db.prepare(limitedSql).all();
      db.close();

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "결과 없음" }] };
      }

      // 테이블 형식
      const keys = Object.keys(rows[0]);
      const header = `| ${keys.join(" | ")} |`;
      const separator = `| ${keys.map(() => "---").join(" | ")} |`;
      const body = rows.map((r) => `| ${keys.map((k) => String(r[k] ?? "NULL")).join(" | ")} |`).join("\n");

      return {
        content: [{ type: "text", text: `${rows.length}건 조회\n\n${header}\n${separator}\n${body}` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// 특정 테이블 최근 데이터
server.tool(
  "sqlite_recent",
  "테이블의 최근 N건 조회",
  {
    db: z.string().describe(`대상 DB (${dbNames.join(", ")})`),
    table: z.string().describe("테이블명"),
    count: z.number().default(10).describe("조회 건수 (기본: 10)"),
    order_by: z.string().optional().describe("정렬 컬럼 (기본: rowid DESC)"),
  },
  async ({ db: dbName, table, count, order_by }) => {
    try {
      const db = getDb(dbName);
      const orderCol = order_by || "rowid";
      const rows = db.prepare(`SELECT * FROM '${table}' ORDER BY ${orderCol} DESC LIMIT ?`).all(count);
      db.close();

      if (rows.length === 0) {
        return { content: [{ type: "text", text: `${table}: 데이터 없음` }] };
      }

      const keys = Object.keys(rows[0]);
      const header = `| ${keys.join(" | ")} |`;
      const separator = `| ${keys.map(() => "---").join(" | ")} |`;
      const body = rows.map((r) => `| ${keys.map((k) => String(r[k] ?? "NULL")).join(" | ")} |`).join("\n");

      return {
        content: [{ type: "text", text: `## ${table} (최근 ${rows.length}건)\n\n${header}\n${separator}\n${body}` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// 테이블 행 수 카운트
server.tool(
  "sqlite_count",
  "테이블별 행 수 조회",
  {
    db: z.string().optional().describe(`DB명 (생략 시 전체). 가능: ${dbNames.join(", ")}`),
  },
  async ({ db: dbName }) => {
    const targets = dbName ? [dbName] : dbNames;
    const sections = [];

    for (const name of targets) {
      try {
        const db = getDb(name);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        const counts = tables.map((t) => {
          const row = db.prepare(`SELECT COUNT(*) as cnt FROM '${t.name}'`).get();
          return `- ${t.name}: ${row.cnt}행`;
        });
        sections.push(`## ${name}.db\n${counts.join("\n")}`);
        db.close();
      } catch (e) {
        sections.push(`## ${name}.db\n⚠ ${e.message}`);
      }
    }

    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
