import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

const server = new McpServer({ name: "workflow-mcp", version: "1.0.0" });

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const GITHUB_REPO = process.env.GITHUB_REPO || "";

// ─── package.json에서 설정 로드 ─────────────────────────────────

function loadConfig() {
  const defaults = {
    branchFormat: "{type}/issue-{issueNumber}",
    commitFormat: "{type}: {message} #{issueNumber}",
    prTitleFormat: "{type}: {issueTitle} #{issueNumber}",
    defaultType: "feat",
    labels: { feat: "enhancement", fix: "bug" },
  };

  const pkgPath = resolve(PROJECT_DIR, "package.json");
  if (!existsSync(pkgPath)) return defaults;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return { ...defaults, ...(pkg.workflow || {}) };
  } catch {
    return defaults;
  }
}

const config = loadConfig();

function applyFormat(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

// ─── helpers ────────────────────────────────────────────────────

function exec(cmd, timeoutMs = 30000) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: "utf-8", cwd: PROJECT_DIR, timeout: timeoutMs }).trim() };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.trim() || e.message, output: e.stdout?.toString()?.trim() || "" };
  }
}

function detectRepo() {
  if (GITHUB_REPO) return GITHUB_REPO;
  const r = exec("gh repo view --json nameWithOwner --jq .nameWithOwner");
  return r.ok ? r.output : "";
}

function currentBranch() {
  const r = exec("git branch --show-current");
  return r.ok ? r.output : "";
}

function detectParentBranch() {
  const current = currentBranch();

  // reflog에서 생성 기록
  const reflog = exec(`git reflog show ${current} --format=%gs`);
  if (reflog.ok) {
    const lines = reflog.output.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(/branch: Created from (.+)/);
      if (match) return match[1].replace("refs/heads/", "").replace("refs/remotes/origin/", "");
    }
  }

  // 커밋 거리가 가장 가까운 브랜치
  const r = exec("git branch --format=%(refname:short)");
  if (!r.ok) return null;
  const branches = r.output.split("\n").filter((b) => b && b !== current);
  let best = null;
  let bestCount = Infinity;
  for (const branch of branches) {
    const count = exec(`git rev-list --count ${branch}..HEAD`);
    if (count.ok) {
      const n = parseInt(count.output);
      if (n < bestCount) { bestCount = n; best = branch; }
    }
  }
  return best;
}

function issueTypeToPrefix(labels) {
  const labelNames = labels.map((l) => (typeof l === "string" ? l : l.name || "").toLowerCase());
  if (labelNames.some((l) => l.includes("bug") || l.includes("fix"))) return "fix";
  if (labelNames.some((l) => l.includes("refactor"))) return "refactor";
  if (labelNames.some((l) => l.includes("docs"))) return "docs";
  if (labelNames.some((l) => l.includes("chore"))) return "chore";
  return config.defaultType;
}

function issueTypeToCommitPrefix(labels) {
  const prefix = issueTypeToPrefix(labels);
  return prefix === "feat" ? "feat" : prefix;
}

// --- base 브랜치 결정 (감지 + 확인 요청) ---
function resolveBase(base) {
  if (base) return { resolved: base, needsConfirm: false };
  const detected = detectParentBranch();
  if (detected) return { resolved: detected, needsConfirm: true };
  return { resolved: null, needsConfirm: true };
}

// --- 도구 0: 이슈 생성 + 브랜치 생성 + 체크아웃 ---
server.tool(
  "wf_create",
  "이슈 생성 → 브랜치 생성 → 체크아웃까지 한번에",
  {
    title: z.string().describe("이슈 제목"),
    body: z.string().optional().describe("이슈 본문"),
    type: z.enum(["feat", "fix", "refactor", "docs", "chore", "test"]).default("feat").describe("작업 유형 (기본: feat)"),
    labels: z.string().optional().describe("라벨 (콤마 구분, 예: bug,urgent)"),
    base: z.string().optional().describe("분기 기준 브랜치. 생략 시 현재 브랜치에서 자동 감지"),
    confirmed: z.boolean().default(false).describe("base 브랜치 확인 완료 여부"),
  },
  async ({ title, body, type, labels, base, confirmed }) => {
    const repo = detectRepo();
    if (!repo) {
      return { content: [{ type: "text", text: "ERROR: GitHub 레포를 감지할 수 없습니다." }] };
    }

    // base 브랜치 결정
    const { resolved: baseBranch, needsConfirm } = resolveBase(base);

    if (!baseBranch) {
      return {
        content: [{
          type: "text",
          text: "## base 브랜치를 지정해주세요\n\n자동 감지에 실패했습니다. `base` 파라미터에 분기할 브랜치를 지정해주세요.\n\n예: `dev`, `main`",
        }],
      };
    }

    if (needsConfirm && !confirmed) {
      return {
        content: [{
          type: "text",
          text: `## base 브랜치 확인\n\n감지된 브랜치: **${baseBranch}**\n\n\`${baseBranch}\`에서 분기하면 될까요? 맞으면 \`confirmed: true\`로 다시 호출하거나, 다른 브랜치를 \`base\`에 지정해주세요.`,
        }],
      };
    }

    // 변경사항 확인
    const status = exec("git status --porcelain");
    if (status.ok && status.output) {
      return {
        content: [{
          type: "text",
          text: `## 작업 중인 변경사항이 있습니다\n\n커밋하거나 stash한 후 다시 시도하세요.\n\n\`\`\`\n${status.output}\n\`\`\``,
        }],
      };
    }

    // 이슈 생성
    let labelFlag = "";
    if (labels) labelFlag = `--label "${labels}"`;
    else {
      const autoLabel = config.labels?.[type];
      if (autoLabel) labelFlag = `--label "${autoLabel}"`;
    }

    const bodyFlag = body ? `--body "${body.replace(/"/g, '\\"')}"` : '--body ""';
    const createResult = exec(`gh issue create --repo ${repo} --title "${title.replace(/"/g, '\\"')}" ${bodyFlag} ${labelFlag}`);

    if (!createResult.ok) {
      return { content: [{ type: "text", text: `ERROR: 이슈 생성 실패\n${createResult.error}` }] };
    }

    const urlMatch = createResult.output.match(/\/issues\/(\d+)/);
    if (!urlMatch) {
      return { content: [{ type: "text", text: `이슈 생성됨: ${createResult.output}\n\n이슈 번호 추출 실패.` }] };
    }
    const issueNumber = urlMatch[1];

    // 브랜치 생성
    const branchName = applyFormat(config.branchFormat, { type, issueNumber });

    exec(`git fetch origin ${baseBranch}`);
    const create = exec(`git checkout -b ${branchName} origin/${baseBranch}`);
    if (!create.ok) {
      return {
        content: [{
          type: "text",
          text: `## 이슈 생성 완료, 브랜치 생성 실패\n\n**이슈**: #${issueNumber} — ${title}\n**URL**: ${createResult.output}\n\nERROR: ${create.error}`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: `## 이슈 #${issueNumber} 생성 + 작업 시작\n\n**이슈**: ${title}\n**URL**: ${createResult.output}\n**브랜치**: \`${branchName}\` (from \`${baseBranch}\`)\n**타입**: ${type}`,
      }],
    };
  },
);

// --- 도구 1: 이슈 확인 후 브랜치 생성 + 체크아웃 ---
server.tool(
  "wf_start",
  "이슈 번호로 작업 시작: 이슈 읽기 → 브랜치 생성 → 체크아웃",
  {
    issue: z.number().describe("GitHub 이슈 번호"),
    type: z.enum(["feat", "fix", "refactor", "docs", "chore", "test"]).optional().describe("브랜치 타입. 생략 시 이슈 라벨에서 자동 판단"),
    base: z.string().optional().describe("분기 기준 브랜치. 생략 시 자동 감지 후 확인"),
    confirmed: z.boolean().default(false).describe("base 브랜치 확인 완료 여부"),
  },
  async ({ issue, type, base, confirmed }) => {
    const repo = detectRepo();
    if (!repo) {
      return { content: [{ type: "text", text: "ERROR: GitHub 레포를 감지할 수 없습니다." }] };
    }

    // base 브랜치 결정
    const { resolved: baseBranch, needsConfirm } = resolveBase(base);

    if (!baseBranch) {
      return {
        content: [{
          type: "text",
          text: "## base 브랜치를 지정해주세요\n\n자동 감지에 실패했습니다. `base` 파라미터에 분기할 브랜치를 지정해주세요.",
        }],
      };
    }

    // 이슈 읽기
    const issueResult = exec(`gh issue view ${issue} --repo ${repo} --json title,labels,body,state`);
    if (!issueResult.ok) {
      return { content: [{ type: "text", text: `ERROR: 이슈 #${issue} 조회 실패\n${issueResult.error}` }] };
    }

    const issueData = JSON.parse(issueResult.output);
    if (issueData.state === "CLOSED") {
      return { content: [{ type: "text", text: `이슈 #${issue}는 이미 닫혀 있습니다.` }] };
    }

    // 브랜치 타입 결정
    const branchType = type || issueTypeToPrefix(issueData.labels || []);
    const branchName = applyFormat(config.branchFormat, { type: branchType, issueNumber: issue });

    if (needsConfirm && !confirmed) {
      return {
        content: [{
          type: "text",
          text: `## base 브랜치 확인\n\n**이슈**: #${issue} — ${issueData.title}\n**브랜치**: \`${branchName}\`\n**base**: \`${baseBranch}\` (자동 감지)\n\n\`${baseBranch}\`에서 분기하면 될까요?`,
        }],
      };
    }

    // 현재 상태 확인
    const status = exec("git status --porcelain");
    if (status.ok && status.output) {
      return {
        content: [{
          type: "text",
          text: `## 작업 중인 변경사항이 있습니다\n\n커밋하거나 stash한 후 다시 시도하세요.\n\n\`\`\`\n${status.output}\n\`\`\``,
        }],
      };
    }

    // base 브랜치 최신화
    exec(`git fetch origin ${baseBranch}`);

    // 브랜치 이미 존재하는지 확인
    const branchExists = exec(`git rev-parse --verify ${branchName} 2>/dev/null`);
    if (branchExists.ok) {
      exec(`git checkout ${branchName}`);
      return {
        content: [{
          type: "text",
          text: `## 이슈 #${issue} 작업 재개\n\n**이슈**: ${issueData.title}\n**브랜치**: \`${branchName}\` (이미 존재, 체크아웃 완료)`,
        }],
      };
    }

    // 브랜치 생성
    const create = exec(`git checkout -b ${branchName} origin/${baseBranch}`);
    if (!create.ok) {
      return { content: [{ type: "text", text: `ERROR: 브랜치 생성 실패\n${create.error}` }] };
    }

    const lines = [];
    lines.push(`## 이슈 #${issue} 작업 시작\n`);
    lines.push(`**이슈**: ${issueData.title}`);
    lines.push(`**브랜치**: \`${branchName}\` (from \`${baseBranch}\`)`);
    lines.push(`**타입**: ${branchType}`);
    if (issueData.labels?.length > 0) {
      lines.push(`**라벨**: ${issueData.labels.map((l) => l.name).join(", ")}`);
    }
    if (issueData.body) {
      lines.push(`\n### 이슈 내용\n\n${issueData.body.slice(0, 2000)}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// --- 도구 2: 커밋 ---
server.tool(
  "wf_commit",
  "변경사항 분석 → Conventional Commits 형식으로 커밋",
  {
    message: z.string().optional().describe("커밋 메시지 (생략 시 diff 기반 자동 생성 데이터 제공)"),
    type: z.enum(["feat", "fix", "refactor", "docs", "chore", "test", "perf"]).optional().describe("커밋 타입. 생략 시 브랜치명에서 추출"),
  },
  async ({ message, type }) => {
    // 변경사항 확인
    const diff = exec("git diff --stat");
    const staged = exec("git diff --cached --stat");
    const status = exec("git status --porcelain");

    if (!status.ok || !status.output) {
      return { content: [{ type: "text", text: "커밋할 변경사항이 없습니다." }] };
    }

    // 브랜치에서 이슈 번호, 타입 추출
    const branch = currentBranch();
    const branchMatch = branch.match(/^(\w+)\/issue-(\d+)/);
    const issueNumber = branchMatch ? branchMatch[2] : null;
    const branchType = branchMatch ? branchMatch[1] : "feat";
    const commitType = type || branchType;

    // 스테이지되지 않은 파일이 있으면 목록만 표시
    if (diff.ok && diff.output && (!staged.ok || !staged.output)) {
      const unstaged = exec("git diff --name-only");
      const untracked = exec("git ls-files --others --exclude-standard");
      const lines = [];
      lines.push("## 스테이지되지 않은 파일\n");
      lines.push("커밋할 파일을 먼저 `git add`로 스테이지해주세요.\n");
      if (unstaged.ok && unstaged.output) {
        lines.push("### 변경됨 (unstaged)\n");
        lines.push("```");
        lines.push(unstaged.output);
        lines.push("```");
      }
      if (untracked.ok && untracked.output) {
        lines.push("\n### 새 파일 (untracked)\n");
        lines.push("```");
        lines.push(untracked.output);
        lines.push("```");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (message) {
      // 메시지가 주어진 경우 → 포맷 적용 후 커밋
      const fullMessage = applyFormat(config.commitFormat, { type: commitType, message, issueNumber: issueNumber || "" }).replace(/\s+#$/, "");

      const commitResult = exec(`git commit -m "${fullMessage.replace(/"/g, '\\"')}"`);
      if (!commitResult.ok) {
        return { content: [{ type: "text", text: `ERROR: 커밋 실패\n${commitResult.error}` }] };
      }

      return {
        content: [{
          type: "text",
          text: `## 커밋 완료\n\n\`${fullMessage}\`\n\n\`\`\`\n${commitResult.output}\n\`\`\``,
        }],
      };
    }

    // 메시지 없으면 → diff 정보 제공하여 AI가 생성하도록
    const diffContent = exec("git diff --cached --stat");
    const diffDetail = exec("git diff --cached --name-only");
    const files = diffDetail.ok ? diffDetail.output : "";

    const lines = [];
    lines.push("## 커밋 준비\n");
    lines.push(`**브랜치**: \`${branch}\``);
    lines.push(`**타입**: ${commitType}`);
    if (issueNumber) lines.push(`**이슈**: #${issueNumber}`);
    lines.push(`\n### 변경 파일\n\n\`\`\`\n${files}\n\`\`\``);
    lines.push(`\n### 변경 요약\n\n\`\`\`\n${diffContent.ok ? diffContent.output : status.output}\n\`\`\``);
    const exampleMsg = applyFormat(config.commitFormat, { type: commitType, message: "<설명>", issueNumber: issueNumber || "" }).replace(/\s+#$/, "");
    lines.push(`\n### 커밋 형식\n\n\`${exampleMsg}\``);
    lines.push("\n메시지를 지정해서 다시 호출하거나, 원하는 메시지를 알려주세요.");

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// --- 도구 3: PR 생성 ---
server.tool(
  "wf_pr",
  "push + PR 생성 (PR 템플릿 자동 적용, 이슈 연결)",
  {
    title: z.string().optional().describe("PR 제목. 생략 시 자동 생성"),
    draft: z.boolean().default(false).describe("Draft PR로 생성"),
    base: z.string().optional().describe("PR 대상 브랜치. 생략 시 부모 브랜치 자동 감지"),
  },
  async ({ title, draft, base }) => {
    const repo = detectRepo();
    const branch = currentBranch();
    const { resolved: baseBranch } = resolveBase(base);
    if (!baseBranch) {
      return { content: [{ type: "text", text: "ERROR: base 브랜치를 감지할 수 없습니다. `base` 파라미터를 지정해주세요." }] };
    }

    if (!branch || branch === baseBranch) {
      return { content: [{ type: "text", text: `ERROR: 현재 브랜치(${branch})에서는 PR을 생성할 수 없습니다.` }] };
    }

    // 이슈 번호 추출
    const branchMatch = branch.match(/^(\w+)\/issue-(\d+)/);
    const issueNumber = branchMatch ? branchMatch[2] : null;
    const branchType = branchMatch ? branchMatch[1] : "feat";

    // 커밋 목록 확인
    const commits = exec(`git log ${baseBranch}..HEAD --pretty=format:"%s" --no-merges`);
    if (!commits.ok || !commits.output) {
      return { content: [{ type: "text", text: "커밋이 없습니다. 먼저 커밋해주세요." }] };
    }

    // push
    const push = exec(`git push -u origin ${branch}`, 60000);
    if (!push.ok) {
      return { content: [{ type: "text", text: `ERROR: push 실패\n${push.error}` }] };
    }

    // PR 제목
    let prTitle = title;
    if (!prTitle) {
      if (issueNumber) {
        const issueResult = exec(`gh issue view ${issueNumber} --repo ${repo} --json title --jq .title`);
        const issueTitle = issueResult.ok ? issueResult.output : `issue-${issueNumber}`;
        prTitle = applyFormat(config.prTitleFormat, { type: branchType, issueTitle, issueNumber });
      } else {
        prTitle = commits.output.split("\n")[0];
      }
    }

    // PR 바디 생성
    const commitList = commits.output.split("\n");
    const changedFiles = exec(`git diff ${baseBranch}..HEAD --name-only`);
    const files = changedFiles.ok ? changedFiles.output.split("\n").filter(Boolean) : [];

    // 변경 유형 체크박스
    const typeChecks = {
      feat: branchType === "feat",
      fix: branchType === "fix",
      refactor: branchType === "refactor",
      docs: branchType === "docs",
      chore: branchType === "chore",
      test: branchType === "test",
    };

    // 변경 범위 체크박스
    const scopeChecks = {
      domain: files.some((f) => f.includes("domain/")),
      application: files.some((f) => f.includes("application/")),
      adapter: files.some((f) => f.includes("adapter/")),
      config: files.some((f) => f.includes("config/")),
      infra: files.some((f) => f.includes("infra/")),
    };

    const body = `## 개요

${issueNumber ? `이슈 #${issueNumber} 작업` : commitList[0]}

## 변경 사항

${commitList.map((c) => `- ${c}`).join("\n")}

## 변경 유형
- [${typeChecks.feat ? "x" : " "}] 새로운 기능 (feat)
- [${typeChecks.fix ? "x" : " "}] 버그 수정 (fix)
- [${typeChecks.refactor ? "x" : " "}] 리팩토링 (refactor)
- [${typeChecks.docs ? "x" : " "}] 문서 수정 (docs)
- [${typeChecks.chore ? "x" : " "}] 빌드/설정 변경 (chore)
- [${typeChecks.test ? "x" : " "}] 테스트 추가/수정 (test)

## 변경 범위 (Scope)
- [${scopeChecks.domain ? "x" : " "}] domain
- [${scopeChecks.application ? "x" : " "}] application
- [${scopeChecks.adapter ? "x" : " "}] adapter
- [${scopeChecks.config ? "x" : " "}] config
- [${scopeChecks.infra ? "x" : " "}] infra

## 테스트 방법

1. \`npm run build\` 정상 확인
2. 관련 Kafka 토픽 테스트

## 체크리스트
- [ ] 로컬에서 정상 동작을 확인했습니다
- [ ] \`npm run build\`가 성공합니다
- [ ] 기존 기능에 영향이 없는지 확인했습니다

## 관련 이슈

${issueNumber ? `closes #${issueNumber}` : ""}`;

    // PR 생성
    const draftFlag = draft ? "--draft" : "";
    const prResult = exec(`gh pr create --repo ${repo} --base ${baseBranch} --title "${prTitle.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" ${draftFlag}`, 30000);

    if (!prResult.ok) {
      return { content: [{ type: "text", text: `ERROR: PR 생성 실패\n${prResult.error}` }] };
    }

    const lines = [];
    lines.push("## PR 생성 완료\n");
    lines.push(`**제목**: ${prTitle}`);
    lines.push(`**브랜치**: \`${branch}\` → \`${baseBranch}\``);
    if (issueNumber) lines.push(`**이슈**: #${issueNumber} (자동 연결)`);
    lines.push(`**URL**: ${prResult.output}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// --- 도구 4: 현재 작업 상태 ---
server.tool(
  "wf_status",
  "현재 작업 상태 조회: 브랜치, 이슈, 변경사항, 커밋 이력",
  {},
  async () => {
    const branch = currentBranch();
    const branchMatch = branch.match(/^(\w+)\/issue-(\d+)/);
    const issueNumber = branchMatch ? branchMatch[2] : null;

    const lines = [];
    lines.push("## 작업 상태\n");
    lines.push(`**브랜치**: \`${branch}\``);

    // 이슈 정보
    if (issueNumber) {
      const repo = detectRepo();
      const issue = exec(`gh issue view ${issueNumber} --repo ${repo} --json title,state,labels`);
      if (issue.ok) {
        const data = JSON.parse(issue.output);
        lines.push(`**이슈**: #${issueNumber} — ${data.title} (${data.state})`);
      }
    }

    // 변경사항
    const status = exec("git status --short");
    if (status.ok && status.output) {
      const fileCount = status.output.split("\n").filter(Boolean).length;
      lines.push(`\n### 변경사항 (${fileCount}개 파일)\n`);
      lines.push(`\`\`\`\n${status.output}\n\`\`\``);
    } else {
      lines.push("\n변경사항 없음");
    }

    // 커밋 이력 (base 대비)
    const commits = exec(`git log ${BASE_BRANCH}..HEAD --pretty=format:"%h %s" --no-merges`);
    if (commits.ok && commits.output) {
      const commitLines = commits.output.split("\n").filter(Boolean);
      lines.push(`\n### 커밋 (${commitLines.length}개)\n`);
      commitLines.forEach((c) => lines.push(`- ${c}`));
    } else {
      lines.push("\n커밋 없음 (base와 동일)");
    }

    // PR 상태
    if (issueNumber) {
      const repo = detectRepo();
      const pr = exec(`gh pr list --repo ${repo} --head ${branch} --json number,title,state,url --jq '.[0]'`);
      if (pr.ok && pr.output && pr.output !== "null") {
        const prData = JSON.parse(pr.output);
        lines.push(`\n### PR\n\n**#${prData.number}** — ${prData.title} (${prData.state})\n${prData.url}`);
      } else {
        lines.push("\n### PR\n\n아직 없음");
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
