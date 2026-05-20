#!/usr/bin/env node

const servers = {
  evm: "evm-mcp/index.js",
  kafka: "kafka-mcp/index.js",
  redis: "redis-mcp/index.js",
  slack: "slack-mcp/index.js",
  grafana: "grafana-mcp/index.js",
  kibana: "kibana-mcp/index.js",
  dooray: "dooray-mcp/index.js",
  "github-wiki": "github-wiki-mcp/index.js",
  workflow: "workflow-mcp/index.js",
  rca: "rca-mcp/index.js",
};

const name = process.argv[2];

if (!name || !servers[name]) {
  const list = Object.keys(servers).join(", ");
  console.error(`Usage: team-mcp <server>\n\nAvailable: ${list}`);
  process.exit(1);
}

await import(`./${servers[name]}`);
