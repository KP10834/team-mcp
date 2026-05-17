import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Kafka } from "kafkajs";
import Redis from "ioredis";
import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { z } from "zod";

const server = new McpServer({ name: "qa-mcp", version: "1.0.0" });

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

// ─── 프로젝트 .env 자동 로드 ────────────────────────────────────

function loadProjectEnv() {
  const envFiles = [".env", ".env.dev", ".env.local"];
  const vars = {};
  for (const file of envFiles) {
    const envPath = resolve(PROJECT_DIR, file);
    if (!existsSync(envPath)) continue;
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (val) vars[key] = val;
    }
  }
  return vars;
}

function loadPackageScripts() {
  const pkgPath = resolve(PROJECT_DIR, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8")).scripts || {};
  } catch { return {}; }
}

const projectEnv = loadProjectEnv();
const pkgScripts = loadPackageScripts();

// env 우선순위: MCP 환경변수 > 프로젝트 .env > 기본값
function env(key, fallback) {
  return process.env[key] || projectEnv[key] || fallback;
}

const BUILD_CMD = env("BUILD_CMD", pkgScripts.build ? "npm run build" : "npm run build");
const START_CMD = env("START_CMD", pkgScripts["start:dev"] ? "npm run start:dev" : "npm start");
const STOP_CMD = env("STOP_CMD", "kill $(lsof -t -i:3000) 2>/dev/null; true");
const BASE_BRANCH = env("BASE_BRANCH", "dev");
const HANDLERS_DIR = resolve(PROJECT_DIR, env("HANDLERS_DIR", "src/adapter/in/kafka/handlers"));
const ENV_PATH = resolve(PROJECT_DIR, env("ENV_PATH", "src/infra/config/env.ts"));

const brokers = env("KAFKA_BROKERS", "localhost:9092").split(",");
const kafka = new Kafka({ clientId: "qa-mcp", brokers });

const REDIS_HOST = env("REDIS_HOST", "localhost");
const REDIS_PORT = Number(env("REDIS_PORT", "6379"));
const REDIS_PASSWORD = env("REDIS_PASSWORD", undefined);
const REDIS_KEY_PREFIX = env("REDIS_KEY_PREFIX", "bc-adapter:");
const BUNDLER_URL = env("BUNDLER_URL", "http://localhost:3000/api/bundler");
const HEALTH_PORT = env("HEALTH_PORT", "8081");
const HEALTH_HOST = env("HEALTH_HOST", "localhost");

// ─── 코드 분석: sync-docs.mjs 로직 재사용 ─────────────────────

function extractTopics() {
  if (!existsSync(ENV_PATH)) return {};
  const content = readFileSync(ENV_PATH, "utf-8");
  const topics = {};
  const re = /(\w+):\s*"(adapter\.[^"]+)"/g;
  let m;
  while ((m = re.exec(content))) topics[m[1]] = m[2];
  return topics;
}

const HANDLER_TOPIC_MAP = {
  "account-create": { reqKey: "accountCreate", resKey: "accountCreated" },
  "account-delete": { reqKey: "accountDelete", resKey: null },
  "account-deploy": { reqKey: "accountDeploy", resKey: "accountDeployed" },
  "withdraw": { reqKey: "withdrawRequest", resKey: "withdrawResult" },
  "payment": { reqKey: "paymentRequest", resKey: "paymentResult" },
  "settlement": { reqKey: "settlementRequest", resKey: "settlementResult" },
  "confirm": { reqKey: "commonConfirm", resKey: "commonConfirmed" },
  "balance": { reqKey: "balanceInquiry", resKey: "balanceResult" },
  "config-register": { reqKey: "configCreate", resKey: null },
  "reconciliation": { reqKey: "reconciliationInquiry", resKey: "reconciliationResult" },
};

function parseZodType(expr) {
  const info = { type: "string", required: true, nullable: false };
  if (expr.includes(".optional()")) info.required = false;
  if (expr.includes(".nullable()") || expr.includes("z.null()")) info.nullable = true;
  if (expr.includes("z.number()") || expr.includes("z.coerce.number()")) info.type = "number";
  else if (expr.includes("z.boolean()")) info.type = "boolean";
  else if (expr.includes("z.array(")) info.type = "array";
  else if (expr.includes("z.object(")) info.type = "object";
  else if (expr.includes("z.enum(")) {
    info.type = "string";
    const enumMatch = expr.match(/z\.enum\(\[([^\]]+)\]/);
    if (enumMatch) {
      info.enumValues = enumMatch[1].split(",").map((s) => s.trim().replace(/['"]/g, ""));
    }
  }
  return info;
}

function extractSchemaFields(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const objMatch = content.match(/z\.object\(\{([\s\S]*?)\}\)\s*satisfies/);
  if (!objMatch) return null;

  const body = objMatch[1];
  const fields = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const fieldMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (!fieldMatch) continue;
    const [, name, typeExpr] = fieldMatch;
    fields[name] = parseZodType(typeExpr);
  }
  return fields;
}

function generateTestValue(fieldName, info) {
  if (info.nullable && !info.required) return null;

  if (info.enumValues?.length > 0) return info.enumValues[0];

  switch (info.type) {
    case "number": return fieldName.includes("amount") ? 1000 : fieldName.includes("chainId") ? 1 : 1;
    case "boolean": return true;
    case "array": return [];
    case "object": return {};
    default:
      if (fieldName === "requestId") return `qa-test-${Date.now()}`;
      if (fieldName.includes("address") || fieldName.includes("Address")) return "0x" + "1".repeat(40);
      if (fieldName.includes("txHash") || fieldName.includes("Hash")) return "0x" + "a".repeat(64);
      if (fieldName.includes("userId") || fieldName.includes("Id")) return `test-${fieldName}-001`;
      if (fieldName.includes("currency")) return "KRW";
      return `test-${fieldName}`;
  }
}

function generateTestMessage(fields) {
  const msg = {};
  for (const [name, info] of Object.entries(fields)) {
    if (info.required) {
      msg[name] = generateTestValue(name, info);
    }
  }
  // requestId가 없으면 추가
  if (!msg.requestId) msg.requestId = `qa-test-${Date.now()}`;
  return msg;
}

function analyzeHandler(handlerName) {
  const filePath = resolve(HANDLERS_DIR, `${handlerName}.handler.ts`);
  if (!existsSync(filePath)) return null;

  const topics = extractTopics();
  const mapping = HANDLER_TOPIC_MAP[handlerName];
  if (!mapping) return null;

  const fields = extractSchemaFields(filePath);
  if (!fields) return null;

  return {
    handlerName,
    filePath,
    reqTopic: topics[mapping.reqKey] || null,
    resTopic: mapping.resKey ? (topics[mapping.resKey] || null) : null,
    fields,
    testMessage: generateTestMessage(fields),
  };
}

function listHandlers() {
  if (!existsSync(HANDLERS_DIR)) return [];
  return readdirSync(HANDLERS_DIR)
    .filter((f) => f.endsWith(".handler.ts"))
    .map((f) => basename(f, ".handler.ts"));
}

// ─── Git diff 기반 변경 분석 ────────────────────────────────────

function getChangedFiles(base) {
  const r = exec(`git diff ${base || BASE_BRANCH} --name-only`, PROJECT_DIR, 10000);
  if (!r.ok) return [];
  return r.output.split("\n").filter(Boolean);
}

function getBranchName() {
  const r = exec("git branch --show-current", PROJECT_DIR, 5000);
  return r.ok ? r.output : "unknown";
}

function detectParentBranch() {
  const current = getBranchName();

  // 1차: reflog에서 "Created from xxx" 기록 찾기
  const reflog = exec(`git reflog show ${current} --format=%gs`, PROJECT_DIR, 5000);
  if (reflog.ok) {
    const lines = reflog.output.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(/branch: Created from (.+)/);
      if (match) {
        const parent = match[1];
        // refs/heads/xxx → xxx
        return parent.replace("refs/heads/", "").replace("refs/remotes/origin/", "");
      }
    }
  }

  // 2차: 커밋 거리가 가장 가까운 브랜치 찾기
  const r = exec("git branch --format=%(refname:short)", PROJECT_DIR, 5000);
  if (!r.ok) return BASE_BRANCH;

  const branches = r.output.split("\n").filter((b) => b && b !== current);
  let best = BASE_BRANCH;
  let bestCount = Infinity;

  for (const branch of branches) {
    const count = exec(`git rev-list --count ${branch}..HEAD`, PROJECT_DIR, 5000);
    if (count.ok) {
      const n = parseInt(count.output);
      if (n < bestCount) { bestCount = n; best = branch; }
    }
  }

  return best;
}

function detectAffectedHandlers(changedFiles) {
  const allHandlers = listHandlers();
  const affected = new Set();

  for (const file of changedFiles) {
    const lower = file.toLowerCase();

    // 1. 핸들러 파일 직접 변경
    if (lower.includes("kafka/handlers/") && lower.endsWith(".handler.ts")) {
      const name = basename(file, ".handler.ts");
      if (allHandlers.includes(name)) affected.add(name);
      continue;
    }

    // 2. application 서비스 변경 → 핸들러에서 import하는지 확인
    if (lower.includes("application/")) {
      const serviceName = basename(file, ".ts").replace(".service", "").replace(".usecase", "");
      for (const handler of allHandlers) {
        if (handler.includes(serviceName) || serviceName.includes(handler.replace("-", ""))) {
          affected.add(handler);
        }
      }
      continue;
    }

    // 3. domain 모델/포트 변경 → 관련 핸들러 찾기
    if (lower.includes("domain/")) {
      const domainName = basename(file, ".ts").replace(".model", "").replace(".port", "").replace(".error", "");
      for (const handler of allHandlers) {
        if (handler.includes(domainName) || domainName.includes(handler.replace("-", ""))) {
          affected.add(handler);
        }
      }
      continue;
    }

    // 4. adapter/out 변경 → 관련 핸들러
    if (lower.includes("adapter/out/")) {
      for (const handler of allHandlers) {
        const handlerPath = resolve(HANDLERS_DIR, `${handler}.handler.ts`);
        if (existsSync(handlerPath)) {
          const content = readFileSync(handlerPath, "utf-8");
          const importName = basename(file, ".ts");
          if (content.includes(importName)) {
            affected.add(handler);
          }
        }
      }
      continue;
    }

    // 5. config/env 변경 → 전체 영향
    if (lower.includes("config/") || lower.includes("bootstrap/")) {
      allHandlers.forEach((h) => affected.add(h));
      break;
    }
  }

  return [...affected];
}

// ─── Infra health check ─────────────────────────────────────────

async function checkKafka() {
  const admin = kafka.admin();
  try {
    await admin.connect();
    const topics = await admin.listTopics();
    await admin.disconnect();
    return { ok: true, detail: `${topics.length}개 토픽` };
  } catch (e) {
    try { await admin.disconnect(); } catch {}
    return { ok: false, detail: e.message.slice(0, 100) };
  }
}

async function checkRedis() {
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD, lazyConnect: true, connectTimeout: 5000 });
  try {
    await redis.connect();
    await redis.ping();
    await redis.disconnect();
    return { ok: true, detail: `${REDIS_HOST}:${REDIS_PORT}` };
  } catch (e) {
    try { await redis.disconnect(); } catch {}
    return { ok: false, detail: e.message.slice(0, 100) };
  }
}

function checkService() {
  const r = exec("pm2 jlist", PROJECT_DIR, 5000);
  if (!r.ok) return { ok: false, detail: "pm2 조회 실패" };
  try {
    const procs = JSON.parse(r.output);
    const online = procs.filter((p) => p.pm2_env?.status === "online");
    const errored = procs.filter((p) => p.pm2_env?.status === "errored");
    if (procs.length === 0) return { ok: false, detail: "실행 중인 프로세스 없음" };
    if (errored.length > 0) return { ok: false, detail: `${errored.map((p) => p.name).join(", ")} 에러 상태` };
    return { ok: true, detail: `${online.length}개 프로세스 online` };
  } catch {
    return { ok: false, detail: "pm2 응답 파싱 실패" };
  }
}

async function checkBundler() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(BUNDLER_URL, { method: "GET", signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.status < 500, detail: `${BUNDLER_URL} → ${res.status}` };
  } catch (e) {
    return { ok: false, detail: `${BUNDLER_URL} → ${e.name === "AbortError" ? "타임아웃" : e.message.slice(0, 80)}` };
  }
}

async function checkRpc() {
  // config DB에서 RPC URL을 읽거나, .env에서 직접 가져오기
  const rpcUrl = env("EVM_RPC_URL", "");
  if (!rpcUrl) {
    // config DB에서 체인 설정 읽기 시도
    const dbPath = resolve(PROJECT_DIR, env("CONFIG_DATABASE_URL", "file:./data/config.db").replace("file:", ""));
    if (!existsSync(dbPath)) return { ok: false, detail: "RPC URL 없음 (config DB 없음)" };
    return { ok: true, detail: "config DB 존재 — RPC는 런타임에 로드" };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    const blockNum = parseInt(data.result, 16);
    return { ok: true, detail: `${rpcUrl} → block #${blockNum}` };
  } catch (e) {
    return { ok: false, detail: `${rpcUrl} → ${e.name === "AbortError" ? "타임아웃" : e.message.slice(0, 80)}` };
  }
}

function checkDatabase() {
  const dbs = [
    { name: "account", path: env("ACCOUNT_DATABASE_URL", "file:./data/account.db") },
    { name: "config", path: env("CONFIG_DATABASE_URL", "file:./data/config.db") },
    { name: "outbox", path: env("OUTBOX_DATABASE_URL", "file:./data/outbox.db") },
    { name: "keys", path: env("KEYS_DATABASE_URL", "file:./data/keys.db") },
  ];
  const results = [];
  for (const db of dbs) {
    const dbPath = resolve(PROJECT_DIR, db.path.replace("file:", ""));
    results.push({ name: db.name, exists: existsSync(dbPath) });
  }
  const missing = results.filter((r) => !r.exists);
  if (missing.length === 0) return { ok: true, detail: `${results.length}개 DB 정상` };
  return { ok: false, detail: `없음: ${missing.map((r) => r.name).join(", ")}` };
}

async function checkHealth() {
  try {
    const url = `http://${HEALTH_HOST}:${HEALTH_PORT}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.status < 500, detail: `:${HEALTH_PORT} → ${res.status}` };
  } catch (e) {
    return { ok: false, detail: `:${HEALTH_PORT} → ${e.name === "AbortError" ? "타임아웃" : "연결 불가"}` };
  }
}

// ─── Infra helpers ──────────────────────────────────────────────

function exec(cmd, cwd, timeoutMs = 60000) {
  try {
    const output = execSync(cmd, { encoding: "utf-8", cwd: cwd || PROJECT_DIR, timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, output: output.trim() };
  } catch (e) {
    return { ok: false, output: e.stdout?.toString()?.trim() || "", error: e.stderr?.toString()?.trim() || e.message };
  }
}

// ─── tsc 에러 파싱 ──────────────────────────────────────────────

function parseTscErrors(output) {
  const errors = [];
  const pattern = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    errors.push({
      file: match[1].trim(),
      line: parseInt(match[2]),
      column: parseInt(match[3]),
      code: match[4],
      message: match[5].trim(),
    });
  }
  return errors;
}

async function kafkaPublish(topic, message, key) {
  const producer = kafka.producer();
  await producer.connect();
  try {
    const value = typeof message === "string" ? message : JSON.stringify(message);
    await producer.send({ topic, messages: [{ key: key || undefined, value }] });
  } finally {
    await producer.disconnect();
  }
}

async function kafkaConsume(topic, timeoutMs = 10000) {
  const groupId = `qa-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  try {
    await consumer.subscribe({ topic, fromBeginning: false });
    const messages = [];
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      consumer.run({
        eachMessage: async ({ message: msg }) => {
          let parsed;
          try { parsed = JSON.parse(msg.value.toString()); } catch { parsed = msg.value.toString(); }
          messages.push(parsed);
          clearTimeout(timer);
          resolve();
        },
      });
    });
    return messages;
  } finally {
    await consumer.disconnect();
    const admin = kafka.admin();
    await admin.connect();
    await admin.deleteGroups([groupId]).catch(() => {});
    await admin.disconnect();
  }
}

async function redisGet(key) {
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD, lazyConnect: true });
  await redis.connect();
  try {
    const fullKey = `${REDIS_KEY_PREFIX}${key}`;
    const exists = await redis.exists(fullKey);
    if (!exists) return null;
    const type = await redis.type(fullKey);
    if (type === "string") return await redis.get(fullKey);
    if (type === "hash") return await redis.hgetall(fullKey);
    return `(type: ${type})`;
  } finally {
    await redis.disconnect();
  }
}

// ─── Tools ──────────────────────────────────────────────────────

server.tool(
  "qa_handlers",
  "adapter 핸들러 목록 조회 — 코드에서 토픽/스키마 자동 분석",
  {},
  async () => {
    const handlers = listHandlers();
    if (handlers.length === 0) {
      return { content: [{ type: "text", text: `핸들러 없음 (${HANDLERS_DIR})` }] };
    }

    const topics = extractTopics();
    const lines = ["## 핸들러 목록\n", "| 핸들러 | 요청 토픽 | 응답 토픽 | 필드 수 |", "| --- | --- | --- | ---: |"];

    for (const name of handlers) {
      const info = analyzeHandler(name);
      if (info) {
        lines.push(`| ${name} | ${info.reqTopic || "-"} | ${info.resTopic || "-"} | ${Object.keys(info.fields).length} |`);
      } else {
        lines.push(`| ${name} | - | - | - |`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "qa_analyze",
  "핸들러 코드를 읽고 스키마/토픽/테스트 메시지를 자동 분석",
  {
    handler: z.string().describe("핸들러 이름 (예: account-create, payment, withdraw)"),
  },
  async ({ handler }) => {
    const info = analyzeHandler(handler);
    if (!info) {
      const available = listHandlers().join(", ");
      return { content: [{ type: "text", text: `핸들러 "${handler}" 분석 불가.\n\n사용 가능: ${available}` }] };
    }

    const lines = [];
    lines.push(`## ${handler} 핸들러 분석\n`);
    lines.push(`**파일**: ${info.filePath}`);
    lines.push(`**요청 토픽**: ${info.reqTopic || "없음"}`);
    lines.push(`**응답 토픽**: ${info.resTopic || "없음"}\n`);

    lines.push("### 입력 스키마 (Zod)\n");
    lines.push("| 필드 | 타입 | 필수 | nullable |");
    lines.push("| --- | --- | --- | --- |");
    for (const [name, field] of Object.entries(info.fields)) {
      const enumStr = field.enumValues ? ` (${field.enumValues.join("|")})` : "";
      lines.push(`| ${name} | ${field.type}${enumStr} | ${field.required ? "Y" : "N"} | ${field.nullable ? "Y" : "N"} |`);
    }

    lines.push("\n### 자동 생성 테스트 메시지\n");
    lines.push("```json");
    lines.push(JSON.stringify(info.testMessage, null, 2));
    lines.push("```");

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "qa_build",
  "프로젝트 빌드",
  { cmd: z.string().optional().describe(`빌드 명령어 (기본: ${BUILD_CMD})`) },
  async ({ cmd }) => {
    const r = exec(cmd || BUILD_CMD, PROJECT_DIR, 120000);
    if (r.ok) return { content: [{ type: "text", text: `## 빌드 성공\n\n\`\`\`\n${r.output.slice(-2000)}\n\`\`\`` }] };
    return { content: [{ type: "text", text: `## 빌드 실패\n\n\`\`\`\n${r.error?.slice(-3000)}\n\`\`\`` }] };
  },
);

server.tool(
  "qa_start",
  "서비스 시작 (PM2)",
  { cmd: z.string().optional().describe(`시작 명령어 (기본: ${START_CMD})`) },
  async ({ cmd }) => {
    const r = exec(cmd || START_CMD, PROJECT_DIR, 30000);
    if (!r.ok) return { content: [{ type: "text", text: `## 시작 실패\n\n\`\`\`\n${r.error}\n\`\`\`` }] };
    await new Promise((r) => setTimeout(r, 2000));
    const status = exec("pm2 jlist", PROJECT_DIR, 10000);
    let info = "";
    if (status.ok) {
      try {
        const procs = JSON.parse(status.output);
        info = procs.map((p) => `- **${p.name}**: ${p.pm2_env?.status} (pid: ${p.pid})`).join("\n");
      } catch { info = status.output.slice(0, 500); }
    }
    return { content: [{ type: "text", text: `## 서비스 시작 완료\n\n${info}` }] };
  },
);

server.tool(
  "qa_stop",
  "서비스 중지",
  { cmd: z.string().optional().describe(`중지 명령어 (기본: ${STOP_CMD})`) },
  async ({ cmd }) => {
    exec(cmd || STOP_CMD, PROJECT_DIR, 15000);
    return { content: [{ type: "text", text: "서비스 중지 완료" }] };
  },
);

server.tool(
  "qa_test",
  "핸들러 코드를 읽고 자동으로 테스트 실행: 메시지 생성 → Kafka 발행 → 응답 대기 → 검증",
  {
    handler: z.string().describe("테스트할 핸들러 (예: account-create, payment, withdraw)"),
    overrides: z.string().optional().describe("테스트 메시지 필드 덮어쓰기 (JSON). 예: {\"amount\": \"5000\"}"),
    timeout: z.number().default(15000).describe("응답 대기 ms (기본: 15000)"),
  },
  async ({ handler, overrides, timeout }) => {
    const info = analyzeHandler(handler);
    if (!info) {
      const available = listHandlers().join(", ");
      return { content: [{ type: "text", text: `핸들러 "${handler}" 분석 불가. 사용 가능: ${available}` }] };
    }

    if (!info.reqTopic) {
      return { content: [{ type: "text", text: `핸들러 "${handler}"의 요청 토픽을 찾을 수 없음. env.ts를 확인하세요.` }] };
    }

    // build test message
    let testMsg = { ...info.testMessage };
    if (overrides) {
      try {
        Object.assign(testMsg, JSON.parse(overrides));
      } catch {}
    }

    const lines = [];
    lines.push(`## ${handler} 테스트\n`);
    lines.push(`**요청 토픽**: ${info.reqTopic}`);
    lines.push(`**응답 토픽**: ${info.resTopic || "없음"}\n`);
    lines.push("### 발행 메시지\n");
    lines.push("```json");
    lines.push(JSON.stringify(testMsg, null, 2));
    lines.push("```\n");

    try {
      // subscribe response topic first
      let consumePromise;
      if (info.resTopic) {
        consumePromise = kafkaConsume(info.resTopic, timeout);
      }

      // publish
      await kafkaPublish(info.reqTopic, testMsg, testMsg.requestId);
      lines.push("**발행**: 완료\n");

      // wait for response
      if (consumePromise) {
        const responses = await consumePromise;
        if (responses.length === 0) {
          lines.push(`### 응답: 없음 (${info.resTopic}, ${timeout}ms 대기)\n`);
          lines.push("**결과: FAIL** — 응답 타임아웃");
        } else {
          const res = responses[0];
          lines.push("### 응답 수신\n");
          lines.push("```json");
          lines.push(JSON.stringify(res, null, 2));
          lines.push("```\n");

          // basic validation
          const issues = [];
          if (res.requestId && res.requestId !== testMsg.requestId) {
            issues.push(`requestId 불일치: ${res.requestId} (expected ${testMsg.requestId})`);
          }
          if (res.result === "FAIL" || res.result === "ERROR") {
            issues.push(`result: ${res.result} — ${res.message || res.errorCode || ""}`);
          }

          if (issues.length > 0) {
            lines.push("### 검증 결과: FAIL\n");
            issues.forEach((i) => lines.push(`- ${i}`));
          } else {
            lines.push("**결과: PASS**");
          }
        }
      } else {
        lines.push("(응답 토픽 없음 — 발행만 완료)");
        lines.push("\n**결과: PASS** (fire-and-forget)");
      }
    } catch (e) {
      lines.push(`### 에러\n\n\`\`\`\n${e.message}\n\`\`\``);
      lines.push("\n**결과: FAIL**");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "qa_test_all",
  "모든 핸들러 또는 지정된 핸들러들을 순서대로 테스트",
  {
    handlers: z.string().optional().describe("테스트할 핸들러 목록 (콤마 구분). 생략 시 전체"),
    timeout: z.number().default(15000).describe("각 핸들러 응답 대기 ms"),
  },
  async ({ handlers, timeout }) => {
    const targetHandlers = handlers
      ? handlers.split(",").map((h) => h.trim())
      : listHandlers();

    const report = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    report.push("| # | 핸들러 | 토픽 | 결과 | 상세 |");
    report.push("| --- | --- | --- | --- | --- |");

    for (let i = 0; i < targetHandlers.length; i++) {
      const name = targetHandlers[i];
      const info = analyzeHandler(name);

      if (!info || !info.reqTopic) {
        skipped++;
        report.push(`| ${i + 1} | ${name} | - | SKIP | 분석 불가 |`);
        continue;
      }

      try {
        let consumePromise;
        if (info.resTopic) {
          consumePromise = kafkaConsume(info.resTopic, timeout);
        }

        await kafkaPublish(info.reqTopic, info.testMessage, info.testMessage.requestId);

        if (consumePromise) {
          const responses = await consumePromise;
          if (responses.length === 0) {
            failed++;
            report.push(`| ${i + 1} | ${name} | ${info.reqTopic} | **FAIL** | 응답 타임아웃 |`);
          } else {
            const res = responses[0];
            if (res.result === "FAIL" || res.result === "ERROR") {
              failed++;
              report.push(`| ${i + 1} | ${name} | ${info.reqTopic} | **FAIL** | ${res.errorCode || res.message || res.result} |`);
            } else {
              passed++;
              report.push(`| ${i + 1} | ${name} | ${info.reqTopic} | PASS | ${res.result || "OK"} |`);
            }
          }
        } else {
          passed++;
          report.push(`| ${i + 1} | ${name} | ${info.reqTopic} | PASS | fire-and-forget |`);
        }
      } catch (e) {
        failed++;
        report.push(`| ${i + 1} | ${name} | ${info.reqTopic || "-"} | **FAIL** | ${e.message.slice(0, 60)} |`);
      }
    }

    const summary = `**${passed} passed, ${failed} failed, ${skipped} skipped** / ${targetHandlers.length} handlers`;
    return {
      content: [{
        type: "text",
        text: `## 전체 테스트 결과\n\n${summary}\n\n${report.join("\n")}`,
      }],
    };
  },
);

server.tool(
  "qa_pipeline",
  "풀 파이프라인: 빌드 → 서비스 시작 → 핸들러 테스트 → 서비스 중지",
  {
    handlers: z.string().optional().describe("테스트할 핸들러 (콤마 구분). 생략 시 전체"),
    skipBuild: z.boolean().default(false).describe("빌드 건너뛰기"),
    keepAlive: z.boolean().default(false).describe("테스트 후 서비스 유지"),
    timeout: z.number().default(15000).describe("각 핸들러 응답 대기 ms"),
  },
  async ({ handlers, skipBuild, keepAlive, timeout }) => {
    const report = [];
    let pipelineOk = true;

    // 1. Build
    if (!skipBuild) {
      report.push("### 1. 빌드\n");
      const r = exec(BUILD_CMD, PROJECT_DIR, 120000);
      if (r.ok) { report.push("PASS\n"); }
      else {
        report.push(`FAIL\n\`\`\`\n${r.error?.slice(-2000)}\n\`\`\``);
        return { content: [{ type: "text", text: `## 파이프라인 중단 (빌드 실패)\n\n${report.join("\n")}` }] };
      }
    }

    // 2. Start
    report.push(`### ${skipBuild ? "1" : "2"}. 서비스 시작\n`);
    const startR = exec(START_CMD, PROJECT_DIR, 30000);
    if (!startR.ok) {
      report.push(`FAIL\n\`\`\`\n${startR.error}\n\`\`\``);
      return { content: [{ type: "text", text: `## 파이프라인 중단 (시작 실패)\n\n${report.join("\n")}` }] };
    }
    await new Promise((r) => setTimeout(r, 3000));
    report.push("PASS\n");

    // 3. Test
    report.push(`### ${skipBuild ? "2" : "3"}. 테스트\n`);
    const targetHandlers = handlers ? handlers.split(",").map((h) => h.trim()) : listHandlers();
    let passed = 0, failed = 0;

    for (const name of targetHandlers) {
      const info = analyzeHandler(name);
      if (!info || !info.reqTopic) {
        report.push(`- **SKIP** ${name} (분석 불가)`);
        continue;
      }

      try {
        let consumePromise;
        if (info.resTopic) consumePromise = kafkaConsume(info.resTopic, timeout);
        await kafkaPublish(info.reqTopic, info.testMessage, info.testMessage.requestId);

        if (consumePromise) {
          const responses = await consumePromise;
          if (responses.length === 0) {
            failed++; pipelineOk = false;
            report.push(`- **FAIL** ${name} — 응답 타임아웃`);
          } else {
            const res = responses[0];
            if (res.result === "FAIL" || res.result === "ERROR") {
              failed++; pipelineOk = false;
              report.push(`- **FAIL** ${name} — ${res.errorCode || res.message || ""}`);
            } else {
              passed++;
              report.push(`- **PASS** ${name}`);
            }
          }
        } else {
          passed++;
          report.push(`- **PASS** ${name} (fire-and-forget)`);
        }
      } catch (e) {
        failed++; pipelineOk = false;
        report.push(`- **FAIL** ${name} — ${e.message.slice(0, 80)}`);
      }
    }
    report.push(`\n**${passed} passed, ${failed} failed**\n`);

    // 4. Stop
    if (!keepAlive) {
      report.push(`### ${skipBuild ? "3" : "4"}. 서비스 중지\n`);
      exec(STOP_CMD, PROJECT_DIR, 15000);
      report.push("완료\n");
    }

    return {
      content: [{
        type: "text",
        text: `## 파이프라인 ${pipelineOk ? "성공" : "실패"}\n\n${report.join("\n")}`,
      }],
    };
  },
);

server.tool(
  "qa_test_branch",
  "현재 브랜치 변경사항 기반 자동 테스트: git diff → 영향 핸들러 감지 → 빌드 → 실행 → 테스트 → 중지",
  {
    base: z.string().optional().describe("비교 기준 브랜치 (생략 시 부모 브랜치 자동 감지)"),
    skipBuild: z.boolean().default(false).describe("빌드 건너뛰기"),
    keepAlive: z.boolean().default(false).describe("테스트 후 서비스 유지"),
    timeout: z.number().default(15000).describe("각 핸들러 응답 대기 ms"),
    testAll: z.boolean().default(false).describe("변경 핸들러 외에 전체 핸들러도 회귀 테스트"),
  },
  async ({ base, skipBuild, keepAlive, timeout, testAll }) => {
    const branch = getBranchName();
    const baseBranch = base || detectParentBranch();
    const report = [];

    // 1. 변경 분석
    report.push("### 1. 변경 분석\n");
    const changedFiles = getChangedFiles(baseBranch);
    if (changedFiles.length === 0) {
      return { content: [{ type: "text", text: `## 변경사항 없음\n\n${branch} ↔ ${baseBranch} 사이에 변경된 파일이 없습니다.` }] };
    }

    const affectedHandlers = detectAffectedHandlers(changedFiles);

    report.push(`**브랜치**: ${branch} (vs ${baseBranch})`);
    report.push(`**변경 파일**: ${changedFiles.length}개`);
    changedFiles.slice(0, 15).forEach((f) => report.push(`- ${f}`));
    if (changedFiles.length > 15) report.push(`- ... 외 ${changedFiles.length - 15}개`);
    report.push(`\n**영향 핸들러**: ${affectedHandlers.length > 0 ? affectedHandlers.join(", ") : "없음 (핸들러 외 변경)"}\n`);

    if (affectedHandlers.length === 0 && !testAll) {
      report.push("핸들러 변경이 없어 Kafka 테스트 대상이 없습니다.");
      report.push("전체 회귀 테스트를 원하면 `testAll: true`로 호출하세요.");
      return { content: [{ type: "text", text: `## 변경 분석 완료\n\n${report.join("\n")}` }] };
    }

    // 2. Build
    if (!skipBuild) {
      report.push("### 2. 빌드\n");
      const r = exec(BUILD_CMD, PROJECT_DIR, 120000);
      if (r.ok) { report.push("PASS\n"); }
      else {
        report.push(`FAIL\n\`\`\`\n${r.error?.slice(-2000)}\n\`\`\``);
        return { content: [{ type: "text", text: `## 파이프라인 중단 (빌드 실패)\n\n${report.join("\n")}` }] };
      }
    }

    // 3. Start
    report.push(`### ${skipBuild ? "2" : "3"}. 서비스 시작\n`);
    const startR = exec(START_CMD, PROJECT_DIR, 30000);
    if (!startR.ok) {
      report.push(`FAIL\n\`\`\`\n${startR.error}\n\`\`\``);
      return { content: [{ type: "text", text: `## 파이프라인 중단 (시작 실패)\n\n${report.join("\n")}` }] };
    }
    await new Promise((r) => setTimeout(r, 3000));

    // 서비스 상태 확인
    const svcCheck = checkService();
    if (!svcCheck.ok) {
      report.push(`FAIL — ${svcCheck.detail}\n`);
      // pm2 에러 로그 가져오기
      const errLog = exec("pm2 logs --nostream --lines 20 --err", PROJECT_DIR, 5000);
      if (errLog.ok && errLog.output) {
        report.push(`\`\`\`\n${errLog.output.slice(-1500)}\n\`\`\``);
      }
      if (!keepAlive) exec(STOP_CMD, PROJECT_DIR, 15000);
      return { content: [{ type: "text", text: `## 파이프라인 중단 (서비스 기동 실패)\n\n${report.join("\n")}` }] };
    }
    report.push(`PASS — ${svcCheck.detail}\n`);

    // 인프라 연결 확인
    const preStepNum = skipBuild ? 3 : 4;
    report.push(`### ${preStepNum}. 인프라 연결 확인\n`);
    const [kafkaCheck, redisCheck_, bundlerCheck, rpcCheck, dbCheck, healthCheck] = await Promise.all([
      checkKafka(), checkRedis(), checkBundler(), checkRpc(), Promise.resolve(checkDatabase()), checkHealth(),
    ]);

    const checks = [
      { name: "Health", result: healthCheck, critical: false },
      { name: "Kafka", result: kafkaCheck, critical: true },
      { name: "Redis", result: redisCheck_, critical: false },
      { name: "Bundler", result: bundlerCheck, critical: false },
      { name: "RPC", result: rpcCheck, critical: false },
      { name: "Database", result: dbCheck, critical: false },
    ];

    report.push("| 서비스 | 상태 | 상세 |");
    report.push("| --- | --- | --- |");
    const failedCritical = [];
    const failedNonCritical = [];
    for (const c of checks) {
      const status = c.result.ok ? "PASS" : "**FAIL**";
      report.push(`| ${c.name} | ${status} | ${c.result.detail} |`);
      if (!c.result.ok) {
        if (c.critical) failedCritical.push(c.name);
        else failedNonCritical.push(c.name);
      }
    }
    report.push("");

    if (failedCritical.length > 0) {
      report.push(`**${failedCritical.join(", ")} 연결 불가** — 테스트 진행 불가`);
      if (!keepAlive) exec(STOP_CMD, PROJECT_DIR, 15000);
      return { content: [{ type: "text", text: `## 파이프라인 중단 (인프라 연결 실패)\n\n${report.join("\n")}` }] };
    }
    if (failedNonCritical.length > 0) {
      report.push(`**${failedNonCritical.join(", ")}** 연결 실패 — 관련 기능 테스트에서 에러가 발생할 수 있습니다.\n`);
    }

    // 5. Test affected handlers
    const stepNum = preStepNum + 1;
    report.push(`### ${stepNum}. 변경 기능 테스트\n`);

    let passed = 0, failed = 0;

    async function runTest(name) {
      const info = analyzeHandler(name);
      if (!info || !info.reqTopic) {
        report.push(`- **SKIP** ${name} (분석 불가)`);
        return;
      }
      try {
        let consumePromise;
        if (info.resTopic) consumePromise = kafkaConsume(info.resTopic, timeout);
        await kafkaPublish(info.reqTopic, info.testMessage, info.testMessage.requestId);

        if (consumePromise) {
          const responses = await consumePromise;
          if (responses.length === 0) {
            failed++;
            report.push(`- **FAIL** ${name} — 응답 타임아웃 (${info.reqTopic})`);
          } else {
            const res = responses[0];
            if (res.result === "FAIL" || res.result === "ERROR") {
              failed++;
              report.push(`- **FAIL** ${name} — ${res.errorCode || res.message || res.result}`);
            } else {
              passed++;
              report.push(`- **PASS** ${name}`);
            }
          }
        } else {
          passed++;
          report.push(`- **PASS** ${name} (fire-and-forget)`);
        }
      } catch (e) {
        failed++;
        report.push(`- **FAIL** ${name} — ${e.message.slice(0, 80)}`);
      }
    }

    for (const name of affectedHandlers) {
      await runTest(name);
    }
    report.push(`\n**변경 기능: ${passed} passed, ${failed} failed**\n`);

    // 5. Regression (optional)
    if (testAll) {
      report.push(`### ${stepNum + 1}. 회귀 테스트 (전체)\n`);
      const allHandlers = listHandlers().filter((h) => !affectedHandlers.includes(h));
      let regPassed = 0, regFailed = 0;

      for (const name of allHandlers) {
        const prevPassed = passed;
        const prevFailed = failed;
        await runTest(name);
        if (passed > prevPassed) regPassed++;
        if (failed > prevFailed) regFailed++;
      }
      report.push(`\n**회귀 테스트: ${regPassed} passed, ${regFailed} failed**\n`);
    }

    // 6. Stop
    if (!keepAlive) {
      report.push(`### ${stepNum + (testAll ? 2 : 1)}. 서비스 중지\n`);
      exec(STOP_CMD, PROJECT_DIR, 15000);
      report.push("완료\n");
    }

    const pipelineOk = failed === 0;
    return {
      content: [{
        type: "text",
        text: `## ${branch} 테스트 ${pipelineOk ? "성공" : "실패"}\n\n${report.join("\n")}`,
      }],
    };
  },
);

server.tool(
  "qa_refactor_check",
  "현재 브랜치의 변경 파일과 diff를 반환 — Claude가 리팩토링 제안에 사용",
  {
    base: z.string().optional().describe("비교 기준 브랜치 (기본: BASE_BRANCH 환경변수)"),
  },
  async ({ base }) => {
    const baseBranch = base || detectParentBranch();
    const changedFiles = getChangedFiles(baseBranch);

    if (changedFiles.length === 0) {
      return { content: [{ type: "text", text: `변경된 파일이 없습니다. (기준: ${baseBranch})` }] };
    }

    const files = [];
    for (const file of changedFiles) {
      const absPath = resolve(PROJECT_DIR, file);
      if (!existsSync(absPath)) continue;

      const content = readFileSync(absPath, "utf-8");
      const diffResult = exec(`git diff ${baseBranch} -- ${file}`, PROJECT_DIR, 10000);
      files.push({
        path: file,
        content,
        diff: diffResult.ok ? diffResult.output : "",
      });
    }

    const lines = [
      `## 변경 파일 목록 (기준: ${baseBranch})\n`,
      `총 ${files.length}개 파일\n`,
    ];

    for (const f of files) {
      lines.push(`### ${f.path}\n`);
      lines.push("**diff:**");
      lines.push("```diff");
      lines.push(f.diff || "(diff 없음)");
      lines.push("```\n");
      lines.push("**전체 내용:**");
      lines.push("```typescript");
      lines.push(f.content);
      lines.push("```\n");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "qa_lint_fix",
  "eslint --fix 자동 수정 실행 후 tsc 타입 에러 반환",
  {},
  async () => {
    const lines = ["## 린트 & 타입 검사 결과\n"];

    // 1. eslint --fix
    const eslintResult = exec("npx eslint --fix src/", PROJECT_DIR, 60000);

    lines.push("### ESLint");
    if (eslintResult.ok || eslintResult.output) {
      if (eslintResult.output) {
        lines.push("```");
        lines.push(eslintResult.output.slice(-2000));
        lines.push("```\n");
      } else {
        lines.push("자동 수정 완료 (에러 없음)\n");
      }
    } else {
      lines.push("```");
      lines.push((eslintResult.error || "").slice(-2000));
      lines.push("```\n");
    }

    // 2. tsc --noEmit
    const tscResult = exec("npx tsc --noEmit", PROJECT_DIR, 120000);
    lines.push("### TypeScript 타입 검사");

    if (tscResult.ok) {
      lines.push("타입 에러 없음 ✅\n");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const rawOutput = (tscResult.output || "") + (tscResult.error || "");
    const errors = parseTscErrors(rawOutput);

    if (errors.length === 0) {
      lines.push("```");
      lines.push(rawOutput.slice(-3000));
      lines.push("```\n");
    } else {
      lines.push(`\n총 ${errors.length}개 타입 에러:\n`);
      lines.push("| 파일 | 라인 | 코드 | 메시지 |");
      lines.push("| --- | ---: | --- | --- |");
      for (const e of errors) {
        lines.push(`| ${e.file} | ${e.line} | ${e.code} | ${e.message} |`);
      }

      lines.push("\n### 에러 상세\n");
      lines.push("```");
      lines.push(rawOutput.slice(-4000));
      lines.push("```");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
