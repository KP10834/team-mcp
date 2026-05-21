#!/usr/bin/env node

/**
 * team-mcp setup — Claude Code MCP 서버 자동 등록
 *
 * Usage:
 *   team-mcp setup              # 대화형: 등록할 서버 선택
 *   team-mcp setup --all        # 전체 서버 등록 (env는 플레이스홀더)
 *   team-mcp setup evm kibana   # 지정 서버만 등록
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_JSON = join(homedir(), ".claude", ".mcp.json");

const SERVER_DEFS = {
  evm: {
    entry: "evm-mcp/index.js",
    env: {
      EVM_RPC_URL: "http://localhost:8545",
      RPC_TIMEOUT_MS: "10000",
      CONTRACT_ERRORS_PATH: "",
    },
    required: [],
    desc: "EVM 블록체인 RPC",
  },
  kafka: {
    entry: "kafka-mcp/index.js",
    env: { KAFKA_BROKERS: "localhost:9092" },
    required: ["KAFKA_BROKERS"],
    desc: "Kafka 토픽 발행·조회",
  },
  redis: {
    entry: "redis-mcp/index.js",
    env: {
      REDIS_HOST: "localhost",
      REDIS_PORT: "6379",
      REDIS_DB: "0",
      REDIS_KEY_PREFIX: "",
    },
    required: [],
    desc: "Redis 키·값 조회",
  },
  slack: {
    entry: "slack-mcp/index.js",
    env: {
      SLACK_BOT_TOKEN: "<your-bot-token>",
      SLACK_USER_TOKEN: "<your-user-token>",
      SLACK_DEFAULT_CHANNEL: "",
    },
    required: ["SLACK_BOT_TOKEN"],
    desc: "Slack 메시지 발행·조회",
  },
  grafana: {
    entry: "grafana-mcp/index.js",
    env: {
      GRAFANA_URL: "<grafana-url>",
      GRAFANA_SA_TOKEN: "<service-account-token>",
      GRAFANA_PROM_DATASOURCE_UID: "",
      GRAFANA_LOKI_DATASOURCE_UID: "",
    },
    required: ["GRAFANA_URL", "GRAFANA_SA_TOKEN"],
    desc: "Grafana 대시보드·메트릭",
  },
  kibana: {
    entry: "kibana-mcp/index.js",
    env: {
      KIBANA_URL: "<kibana-url>",
      KIBANA_API_KEY: "<api-key>",
      KIBANA_COOKIE: "",
    },
    required: ["KIBANA_URL"],
    desc: "Kibana 대시보드·쿼리",
  },
  dooray: {
    entry: "dooray-mcp/index.js",
    env: {
      DOORAY_TOKEN: "<dooray-token>",
      DOORAY_DEFAULT_PROJECT_ID: "",
      DOORAY_DEFAULT_CHANNEL_ID: "",
    },
    required: ["DOORAY_TOKEN"],
    desc: "Dooray 메신저",
  },
  "github-wiki": {
    entry: "github-wiki-mcp/index.js",
    env: {
      GITHUB_TOKEN: "<github-token>",
      WIKI_REPOS: "org/repo1,org/repo2",
    },
    required: ["GITHUB_TOKEN", "WIKI_REPOS"],
    desc: "GitHub Wiki 페이지",
  },
  workflow: {
    entry: "workflow-mcp/index.js",
    env: {
      PROJECT_DIR: "",
      GITHUB_REPO: "",
    },
    required: [],
    desc: "git workflow 자동화",
  },
  rca: {
    entry: "rca-mcp/index.js",
    env: {
      KIBANA_URL: "<kibana-url>",
      KIBANA_API_KEY: "<api-key>",
      KIBANA_COOKIE: "",
      RPC_TIMEOUT_MS: "10000",
    },
    required: ["KIBANA_URL"],
    desc: "에러 근본 원인 분석",
  },
};

function loadMcpJson() {
  if (!existsSync(MCP_JSON)) return { mcpServers: {} };
  try {
    return JSON.parse(readFileSync(MCP_JSON, "utf-8"));
  } catch {
    return { mcpServers: {} };
  }
}

function saveMcpJson(data) {
  const dir = dirname(MCP_JSON);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MCP_JSON, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function buildServerEntry(name, def) {
  return {
    command: "node",
    args: [join(__dirname, def.entry)],
    env: { ...def.env },
  };
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function interactiveSelect() {
  const names = Object.keys(SERVER_DEFS);
  console.log("\n사용 가능한 MCP 서버:\n");
  names.forEach((name, i) => {
    console.log(`  ${i + 1}. ${name.padEnd(14)} — ${SERVER_DEFS[name].desc}`);
  });
  console.log(`  a. 전체 선택`);
  console.log();

  const answer = await prompt("등록할 서버 번호 (콤마 구분, a=전체): ");
  if (answer.toLowerCase() === "a") return names;

  return answer
    .split(/[,\s]+/)
    .map((s) => {
      const idx = parseInt(s, 10) - 1;
      return names[idx];
    })
    .filter(Boolean);
}

async function run() {
  const args = process.argv.slice(3); // argv[2] = "setup"
  let selected;

  if (args.includes("--all")) {
    selected = Object.keys(SERVER_DEFS);
  } else if (args.length > 0) {
    selected = args.filter((a) => SERVER_DEFS[a]);
    const unknown = args.filter((a) => !SERVER_DEFS[a]);
    if (unknown.length) {
      console.error(`알 수 없는 서버: ${unknown.join(", ")}`);
    }
  } else {
    selected = await interactiveSelect();
  }

  if (!selected.length) {
    console.log("등록할 서버가 없습니다.");
    return;
  }

  const data = loadMcpJson();
  const added = [];
  const skipped = [];

  for (const name of selected) {
    const key = `${name}-mcp`;
    if (data.mcpServers[key]) {
      skipped.push(name);
      continue;
    }
    data.mcpServers[key] = buildServerEntry(name, SERVER_DEFS[name]);
    added.push(name);
  }

  if (added.length) {
    saveMcpJson(data);
    console.log(`\n✓ ${MCP_JSON} 에 등록 완료:`);
    added.forEach((name) => {
      const def = SERVER_DEFS[name];
      console.log(`  + ${name}-mcp`);
      if (def.required.length) {
        console.log(`    → env 설정 필요: ${def.required.join(", ")}`);
      }
    });
  }

  if (skipped.length) {
    console.log(`\n⏭ 이미 등록됨 (건너뜀): ${skipped.map((n) => n + "-mcp").join(", ")}`);
  }

  if (added.length) {
    const needsEnv = added.filter((n) => SERVER_DEFS[n].required.length);
    if (needsEnv.length) {
      console.log(`\n📝 ${MCP_JSON} 을 열어서 <placeholder> 값을 실제 값으로 교체하세요.`);
    }
    console.log("\nClaude Code를 재시작하면 반영됩니다.");
  }
}

run();
