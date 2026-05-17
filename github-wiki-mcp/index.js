import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const execFileP = promisify(execFile);

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const WIKI_REPOS_RAW = process.env.WIKI_REPOS || "";
const CACHE_DIR = process.env.WIKI_CACHE_DIR || join(homedir(), ".cache", "github-wiki-mcp");
const PULL_TTL_SEC = parseInt(process.env.WIKI_PULL_TTL_SEC || "300", 10);

if (!TOKEN) {
  console.error("[github-wiki-mcp] GITHUB_TOKEN 필수");
  process.exit(1);
}

let WIKI_REPOS = {};
try {
  WIKI_REPOS = WIKI_REPOS_RAW ? JSON.parse(WIKI_REPOS_RAW) : {};
} catch (e) {
  console.error("[github-wiki-mcp] WIKI_REPOS JSON 파싱 실패:", e.message);
  process.exit(1);
}

if (!Object.keys(WIKI_REPOS).length) {
  console.error(
    '[github-wiki-mcp] WIKI_REPOS 필수. 예: WIKI_REPOS=\'{"adapter":"StableCoinTF/StableCoinBC_Adapter"}\'',
  );
  process.exit(1);
}

const lastPulled = new Map();
const repoNames = Object.keys(WIKI_REPOS).join(", ");

function resolveRepo(name) {
  const repo = WIKI_REPOS[name];
  if (!repo) throw new Error(`알 수 없는 wiki repo: '${name}'. 사용 가능: ${repoNames}`);
  return { repo, dir: join(CACHE_DIR, name) };
}

function pageToFilename(page) {
  if (page.endsWith(".md")) return page;
  // GitHub Wiki: 공백 → 대시 변환
  return `${page.replace(/\s+/g, "-")}.md`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureClone(name) {
  const { repo, dir } = resolveRepo(name);
  if (await exists(dir)) {
    const last = lastPulled.get(name) || 0;
    if (Date.now() - last > PULL_TTL_SEC * 1000) {
      try {
        await execFileP("git", ["-C", dir, "pull", "--ff-only"], { timeout: 30000 });
      } catch (e) {
        throw new Error(`wiki pull 실패 (${repo}.wiki): ${e.stderr || e.message}`);
      }
      lastPulled.set(name, Date.now());
    }
    return dir;
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const url = `https://x-access-token:${TOKEN}@github.com/${repo}.wiki.git`;
  try {
    await execFileP("git", ["clone", "--depth", "100", url, dir], { timeout: 60000 });
  } catch (e) {
    const msg = (e.stderr || e.message || "").replace(TOKEN, "***");
    throw new Error(`wiki clone 실패 (${repo}.wiki): ${msg}. Wiki가 활성화되어 있고 토큰에 write 권한이 있는지 확인하세요.`);
  }
  await execFileP("git", ["-C", dir, "config", "user.email", "claude-code@noreply.anthropic.com"]);
  await execFileP("git", ["-C", dir, "config", "user.name", "Claude Code via MCP"]);
  lastPulled.set(name, Date.now());
  return dir;
}

const server = new McpServer({ name: "github-wiki-mcp", version: "1.0.0" });

// ─── 1. 페이지 목록 ───────────────────────────────────────────
server.tool(
  "wiki_list",
  "Wiki 페이지 목록 조회",
  {
    repo: z.string().describe(`레포 이름 (사용 가능: ${repoNames})`),
  },
  async ({ repo }) => {
    const dir = await ensureClone(repo);
    const all = await readdir(dir, { withFileTypes: true });
    const pages = all
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
    if (!pages.length) return { content: [{ type: "text", text: `${repo} 위키 페이지 없음` }] };
    const body = pages.map((p) => `- \`${p}\``).join("\n");
    return {
      content: [{ type: "text", text: `## ${WIKI_REPOS[repo]} Wiki (${pages.length}개)\n\n${body}` }],
    };
  },
);

// ─── 2. 페이지 본문 조회 ──────────────────────────────────────
server.tool(
  "wiki_get",
  "Wiki 페이지 본문 조회 (markdown)",
  {
    repo: z.string().describe(`레포 이름 (사용 가능: ${repoNames})`),
    page: z.string().describe("페이지 이름 (예: 'Home', 'API Reference'). 공백→대시 자동 변환, .md 생략 가능"),
  },
  async ({ repo, page }) => {
    const dir = await ensureClone(repo);
    const filename = pageToFilename(page);
    const path = join(dir, filename);
    if (!(await exists(path))) {
      const all = await readdir(dir);
      const md = all.filter((f) => f.endsWith(".md"));
      throw new Error(`페이지 '${filename}' 없음. 사용 가능: ${md.slice(0, 20).join(", ")}${md.length > 20 ? "..." : ""}`);
    }
    const content = await readFile(path, "utf-8");
    return { content: [{ type: "text", text: `## ${filename}\n\n${content}` }] };
  },
);

// ─── 3. 키워드 검색 (git grep) ────────────────────────────────
server.tool(
  "wiki_search",
  "Wiki 전체 페이지 키워드 검색 (git grep)",
  {
    repo: z.string().describe(`레포 이름 (사용 가능: ${repoNames})`),
    query: z.string().describe("검색 키워드"),
    case_sensitive: z.boolean().default(false),
    max_results: z.number().default(100),
  },
  async ({ repo, query, case_sensitive, max_results }) => {
    const dir = await ensureClone(repo);
    const args = ["-C", dir, "grep", "-n", "--no-color"];
    if (!case_sensitive) args.push("-i");
    args.push(query, "--", "*.md");
    try {
      const { stdout } = await execFileP("git", args, { maxBuffer: 10 * 1024 * 1024 });
      const lines = stdout.trim().split("\n").slice(0, max_results);
      const body = lines.map((l) => `- ${l}`).join("\n");
      return {
        content: [{ type: "text", text: `## "${query}" 검색 결과 (${lines.length}건)\n\n${body}` }],
      };
    } catch (e) {
      if (e.code === 1) {
        return { content: [{ type: "text", text: `"${query}" 검색 결과 없음` }] };
      }
      throw e;
    }
  },
);

// ─── 4. 페이지 생성/갱신 + commit + push ─────────────────────
server.tool(
  "wiki_write",
  "Wiki 페이지 생성 또는 갱신 (자동 commit + push)",
  {
    repo: z.string().describe(`레포 이름 (사용 가능: ${repoNames})`),
    page: z.string().describe("페이지 이름 (.md 생략 가능, 공백→대시 자동 변환)"),
    content: z.string().describe("페이지 본문 (markdown)"),
    message: z.string().optional().describe("커밋 메시지 (기본: 'Create/Update {page}')"),
  },
  async ({ repo, page, content, message }) => {
    const dir = await ensureClone(repo);
    const filename = pageToFilename(page);
    const path = join(dir, filename);
    const existed = await exists(path);

    await writeFile(path, content, "utf-8");
    await execFileP("git", ["-C", dir, "add", filename]);

    try {
      await execFileP("git", ["-C", dir, "diff", "--cached", "--quiet"]);
      return { content: [{ type: "text", text: `## 변경 없음\n\`${filename}\` 내용이 동일합니다` }] };
    } catch {
      // diff returns non-zero ⇒ 변경 있음, 계속 진행
    }

    const commitMsg = message || `${existed ? "Update" : "Create"} ${filename}`;
    await execFileP("git", ["-C", dir, "commit", "-m", commitMsg]);
    try {
      await execFileP("git", ["-C", dir, "push"], { timeout: 30000 });
    } catch (e) {
      throw new Error(`push 실패: ${(e.stderr || e.message).replace(TOKEN, "***")}`);
    }

    return {
      content: [{
        type: "text",
        text: `## ${existed ? "갱신" : "생성"} 완료\n- file: \`${filename}\`\n- commit: ${commitMsg}\n- wiki: https://github.com/${WIKI_REPOS[repo]}/wiki/${encodeURIComponent(filename.replace(/\.md$/, ""))}`,
      }],
    };
  },
);

// ─── 5. 변경 이력 ───────────────────────────────────────────
server.tool(
  "wiki_history",
  "Wiki 최근 변경 이력 (git log)",
  {
    repo: z.string().describe(`레포 이름 (사용 가능: ${repoNames})`),
    page: z.string().optional().describe("특정 페이지만 (생략 시 전체)"),
    limit: z.number().default(20),
  },
  async ({ repo, page, limit }) => {
    const dir = await ensureClone(repo);
    const args = ["-C", dir, "log", `-n${limit}`, "--pretty=format:%h|%an|%ai|%s"];
    if (page) {
      const filename = pageToFilename(page);
      args.push("--", filename);
    }
    const { stdout } = await execFileP("git", args);
    if (!stdout.trim()) return { content: [{ type: "text", text: "히스토리 없음" }] };
    const rows = stdout.trim().split("\n");
    const body = rows.map((line) => {
      const [hash, author, date, ...subjectParts] = line.split("|");
      return `- \`${hash}\` ${date.slice(0, 19)} **${author}**\n  ${subjectParts.join("|")}`;
    }).join("\n\n");
    return {
      content: [{
        type: "text",
        text: `## ${page || "전체"} 변경 이력 (${rows.length}건)\n\n${body}`,
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
