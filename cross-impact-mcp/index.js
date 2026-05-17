import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "cross-impact-mcp", version: "4.0.0" });

// REPOS: 레포 목록만 등록. 연결 타입 분류 불필요.
//   단축: {"adapter": "org/repo"}
//   상세: {"adapter": {"repo": "org/repo", "base": "main"}}
const RAW_REPOS = JSON.parse(process.env.REPOS || "{}");
const REPOS = {};
for (const [name, val] of Object.entries(RAW_REPOS)) {
  if (typeof val === "string") {
    REPOS[name] = { repo: val, base: "main" };
  } else {
    REPOS[name] = { repo: val.repo, base: val.base || "main" };
  }
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

// --- GitHub API ---

async function ghFetch(path) {
  const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function getChangedFiles(repo, base, head) {
  const data = await ghFetch(
    `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  return (data.files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: f.patch || "",
    additions: f.additions || 0,
    deletions: f.deletions || 0,
  }));
}

async function getFileContent(repo, filePath, ref) {
  try {
    const data = await ghFetch(
      `/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    );
    if (data.encoding === "base64" && data.content) {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

async function searchCode(repo, query) {
  try {
    const q = encodeURIComponent(`${query} repo:${repo}`);
    const data = await ghFetch(`/search/code?q=${q}&per_page=10`);
    return (data.items || []).map((i) => ({ path: i.path, name: i.name }));
  } catch {
    return [];
  }
}

async function getRecentPRs(repo, base, count = 10) {
  try {
    return await ghFetch(
      `/repos/${repo}/pulls?state=all&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=${count}`,
    );
  } catch {
    return [];
  }
}

// --- 키워드 추출 ---

function extractKeywords(changedFiles) {
  const keywords = new Map(); // keyword → { files, risk }

  for (const file of changedFiles) {
    const parts = file.filename.split("/");
    const basename = parts.pop().replace(/\.(ts|js|go|java|py|kt|swift|dart)$/, "");

    // 파일명에서 리소스명 추출: payment.controller.ts → payment
    const resource = basename
      .replace(/\.(controller|handler|route|router|service|usecase|repository|model|schema|dto|entity|port|adapter|module|spec|test)$/, "")
      .replace(/[-_](controller|handler|route|router|service|usecase|repository|model|schema|dto|entity|port|adapter|module|spec|test)$/, "");

    if (resource && resource.length > 2) {
      const existing = keywords.get(resource);
      const risk = assessFileRisk(file);
      if (!existing || risk.level > existing.risk.level) {
        keywords.set(resource, {
          files: [...(existing?.files || []), file.filename],
          risk,
        });
      } else {
        existing.files.push(file.filename);
      }
    }

    // diff에서 추가 키워드 추출: 토픽명, API 경로, 타입명
    if (file.patch) {
      // Kafka 토픽명
      const topicMatches = file.patch.match(/["']adapter\.[a-z.]+["']/g);
      if (topicMatches) {
        for (const m of topicMatches) {
          const topic = m.replace(/['"]/g, "");
          const existing = keywords.get(topic);
          const risk = assessFileRisk(file);
          if (!existing) {
            keywords.set(topic, { files: [file.filename], risk });
          }
        }
      }

      // API 경로
      const routeMatches = file.patch.match(/["']\/api\/[a-z/-]+["']/g);
      if (routeMatches) {
        for (const m of routeMatches) {
          const route = m.replace(/['"]/g, "");
          const existing = keywords.get(route);
          const risk = assessFileRisk(file);
          if (!existing) {
            keywords.set(route, { files: [file.filename], risk });
          }
        }
      }

      // export된 타입/인터페이스명
      const exportMatches = file.patch.match(/export\s+(interface|type|class|enum)\s+(\w+)/g);
      if (exportMatches) {
        for (const m of exportMatches) {
          const typeName = m.split(/\s+/).pop();
          if (typeName && typeName.length > 3) {
            const existing = keywords.get(typeName);
            const risk = assessFileRisk(file);
            if (!existing) {
              keywords.set(typeName, { files: [file.filename], risk });
            }
          }
        }
      }
    }
  }

  return keywords;
}

function assessFileRisk(file) {
  // 파일 삭제/이름 변경
  if (file.status === "removed") {
    return { level: 3, label: "CRITICAL", reason: "파일 삭제됨" };
  }
  if (file.status === "renamed") {
    return { level: 3, label: "CRITICAL", reason: "파일명 변경됨" };
  }

  if (!file.patch) {
    return { level: 1, label: "INFO", reason: "변경 내용 확인 필요" };
  }

  const patch = file.patch;

  // 삭제된 라인에 export, interface, type 등이 있으면 위험
  const deletedLines = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  const addedLines = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  const hasDeletedExport = deletedLines.some((l) =>
    /export|interface|type |class |enum |function /.test(l),
  );
  const hasDeletedField = deletedLines.some((l) =>
    /^\-\s+\w+[\s:?]/.test(l),
  );

  if (hasDeletedExport) {
    return { level: 3, label: "CRITICAL", reason: "export/타입/인터페이스 삭제/변경" };
  }
  if (hasDeletedField && addedLines.length < deletedLines.length) {
    return { level: 2, label: "WARNING", reason: "필드 삭제 가능성" };
  }
  if (file.deletions > 0 && file.additions > 0) {
    return { level: 2, label: "WARNING", reason: "코드 수정 (시그니처 변경 가능)" };
  }
  if (file.additions > 0 && file.deletions === 0) {
    return { level: 1, label: "INFO", reason: "코드 추가만 (하위호환 가능성 높음)" };
  }

  return { level: 1, label: "INFO", reason: "경미한 변경" };
}

// --- Tools ---

server.tool(
  "cross_impact_changes",
  "변경 파일에서 키워드를 자동 추출하고, 다른 레포에서 해당 키워드를 사용하는 곳을 찾아 영향 범위와 버그 위험도를 리포트",
  {
    repo: z.string().describe("분석할 레포 이름"),
    head: z.string().describe("비교할 브랜치 또는 태그"),
    base: z.string().optional().describe("기준 브랜치 (생략 시 레포별 기본)"),
  },
  async ({ repo, head, base }) => {
    const entry = REPOS[repo];
    if (!entry) {
      const available = Object.keys(REPOS).join(", ");
      return { content: [{ type: "text", text: `레포 "${repo}" 없음. 사용 가능: ${available}` }] };
    }

    const baseBranch = base || entry.base;

    try {
      const changedFiles = await getChangedFiles(entry.repo, baseBranch, head);
      if (changedFiles.length === 0) {
        return { content: [{ type: "text", text: "변경 파일 없음" }] };
      }

      // 1. 키워드 추출
      const keywords = extractKeywords(changedFiles);

      // 2. 다른 레포에서 키워드 검색
      const impacts = [];

      for (const [repoName, repoEntry] of Object.entries(REPOS)) {
        if (repoName === repo || repoName === "docs") continue;

        const repoImpacts = [];
        for (const [keyword, info] of keywords) {
          // 너무 짧거나 일반적인 키워드 제외
          if (keyword.length < 3) continue;
          if (["index", "utils", "common", "config", "main", "app"].includes(keyword)) continue;

          const found = await searchCode(repoEntry.repo, keyword);
          if (found.length === 0) continue;

          repoImpacts.push({
            keyword,
            risk: info.risk,
            sourceFiles: info.files,
            targetFiles: found.map((f) => f.path),
          });
        }

        if (repoImpacts.length > 0) {
          impacts.push({ repo: repoName, impacts: repoImpacts });
        }
      }

      // 3. 리포트 생성
      const lines = [];
      lines.push(`## ${repo} (${head}) 영향 분석\n`);
      lines.push(`**변경 파일**: ${changedFiles.length}개`);
      lines.push(`**추출 키워드**: ${keywords.size}개`);
      lines.push(`**영향 레포**: ${impacts.length}개\n`);

      if (impacts.length === 0) {
        lines.push("다른 레포에서 관련 코드를 찾지 못했습니다.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // 위험도별 분류
      const critical = [];
      const warning = [];
      const info = [];

      for (const impact of impacts) {
        for (const item of impact.impacts) {
          const entry = {
            targetRepo: impact.repo,
            keyword: item.keyword,
            reason: item.risk.reason,
            sourceFiles: item.sourceFiles.slice(0, 3),
            targetFiles: item.targetFiles.slice(0, 3),
          };
          if (item.risk.level >= 3) critical.push(entry);
          else if (item.risk.level >= 2) warning.push(entry);
          else info.push(entry);
        }
      }

      function renderTable(items) {
        if (items.length === 0) return "없음\n";
        const rows = ["| 대상 | 키워드 | 위험 사유 | 내 파일 | 상대 파일 |", "| --- | --- | --- | --- | --- |"];
        for (const item of items) {
          rows.push(
            `| ${item.targetRepo} | \`${item.keyword}\` | ${item.reason} | ${item.sourceFiles.join(", ")} | ${item.targetFiles.join(", ")} |`,
          );
        }
        return rows.join("\n") + "\n";
      }

      lines.push("### CRITICAL (배포 시 버그 위험)\n");
      lines.push(renderTable(critical));
      lines.push("### WARNING (동작하지만 문제 가능)\n");
      lines.push(renderTable(warning));
      lines.push("### INFO (확인 권장)\n");
      lines.push(renderTable(info));

      lines.push("---");
      lines.push(`**요약**: CRITICAL ${critical.length}건, WARNING ${warning.length}건, INFO ${info.length}건`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

server.tool(
  "cross_impact_compare",
  "특정 키워드 기준으로 양쪽 레포의 관련 코드를 가져와 비교",
  {
    keyword: z.string().describe("비교할 키워드 (토픽명, 리소스명, 타입명 등)"),
    sourceRepo: z.string().describe("변경이 발생한 레포"),
    head: z.string().describe("변경 브랜치"),
    targetRepo: z.string().optional().describe("비교 대상 레포 (생략 시 나머지 전체)"),
    base: z.string().optional().describe("기준 브랜치"),
  },
  async ({ keyword, sourceRepo, head, targetRepo, base }) => {
    const sourceEntry = REPOS[sourceRepo];
    if (!sourceEntry) {
      return { content: [{ type: "text", text: `레포 "${sourceRepo}" 없음` }] };
    }

    const baseBranch = base || sourceEntry.base;

    try {
      const result = { keyword, source: {}, targets: {} };

      // source: 변경된 파일 중 키워드 관련
      const changedFiles = await getChangedFiles(sourceEntry.repo, baseBranch, head);
      const relevantChanges = changedFiles.filter((f) =>
        f.filename.toLowerCase().includes(keyword.toLowerCase()) ||
        (f.patch && f.patch.includes(keyword)),
      );

      result.source = {
        repo: sourceRepo,
        head,
        changedFiles: relevantChanges.map((f) => f.filename),
        diffs: {},
      };
      for (const file of relevantChanges.slice(0, 5)) {
        result.source.diffs[file.filename] = file.patch;
      }

      // targets: 상대 레포에서 키워드 검색
      const targetRepos = targetRepo
        ? [[targetRepo, REPOS[targetRepo]]]
        : Object.entries(REPOS).filter(([n]) => n !== sourceRepo);

      for (const [repoName, entry] of targetRepos) {
        if (!entry || repoName === "docs") continue;

        const found = await searchCode(entry.repo, keyword);
        if (found.length === 0) continue;

        result.targets[repoName] = {};
        for (const file of found.slice(0, 5)) {
          const content = await getFileContent(entry.repo, file.path, entry.base);
          if (!content) continue;

          const lines = content.split("\n");
          const relevantLines = [];
          lines.forEach((line, i) => {
            if (line.toLowerCase().includes(keyword.toLowerCase())) {
              const start = Math.max(0, i - 10);
              const end = Math.min(lines.length, i + 20);
              relevantLines.push({
                file: file.path,
                lineStart: start + 1,
                content: lines.slice(start, end).join("\n"),
              });
            }
          });
          result.targets[repoName][file.path] =
            relevantLines.length > 0
              ? relevantLines
              : [{ file: file.path, lineStart: 1, content: content.slice(0, 3000) }];
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

server.tool(
  "cross_impact_watch",
  "다른 레포들의 최근 PR 중 내 프로젝트에 영향을 줄 수 있는 변경을 탐지",
  {
    myRepo: z.string().describe("내 레포 이름 (이 레포에 영향 주는 변경을 찾음)"),
    days: z.number().default(7).describe("최근 N일 (기본: 7)"),
    count: z.number().default(10).describe("레포당 PR 수 (기본: 10)"),
  },
  async ({ myRepo, days, count }) => {
    if (!REPOS[myRepo]) {
      const available = Object.keys(REPOS).join(", ");
      return { content: [{ type: "text", text: `레포 "${myRepo}" 없음. 사용 가능: ${available}` }] };
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const results = [];

    for (const [repoName, entry] of Object.entries(REPOS)) {
      if (repoName === myRepo || repoName === "docs") continue;

      try {
        const prs = await getRecentPRs(entry.repo, entry.base, count);
        const recentPRs = (prs || []).filter((pr) => new Date(pr.updated_at) >= cutoff);

        for (const pr of recentPRs) {
          let changedFiles;
          try {
            changedFiles = await getChangedFiles(entry.repo, entry.base, pr.head.sha);
          } catch { continue; }

          const keywords = extractKeywords(changedFiles);

          // 내 레포에서 키워드 검색
          const myEntry = REPOS[myRepo];
          const affectedKeywords = [];

          for (const [keyword, info] of keywords) {
            if (keyword.length < 3) continue;
            if (["index", "utils", "common", "config", "main", "app"].includes(keyword)) continue;

            const found = await searchCode(myEntry.repo, keyword);
            if (found.length > 0) {
              affectedKeywords.push({
                keyword,
                risk: info.risk,
                myFiles: found.map((f) => f.path).slice(0, 3),
              });
            }
          }

          if (affectedKeywords.length === 0) continue;

          const maxRisk = Math.max(...affectedKeywords.map((k) => k.risk.level));
          results.push({
            repo: repoName,
            pr: {
              number: pr.number,
              title: pr.title,
              state: pr.state,
              merged: !!pr.merged_at,
              author: pr.user?.login,
              updated: pr.updated_at,
              url: pr.html_url,
            },
            affectedKeywords,
            maxRisk: maxRisk >= 3 ? "CRITICAL" : maxRisk >= 2 ? "WARNING" : "INFO",
          });
        }
      } catch (e) {
        results.push({ repo: repoName, error: e.message.slice(0, 100) });
      }
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: `최근 ${days}일 내 ${myRepo}에 영향 주는 변경 없음` }] };
    }

    // 위험도 순 정렬
    results.sort((a, b) => {
      if (a.error) return 1;
      if (b.error) return -1;
      const riskOrder = { CRITICAL: 0, WARNING: 1, INFO: 2 };
      return (riskOrder[a.maxRisk] || 3) - (riskOrder[b.maxRisk] || 3);
    });

    const lines = [`## ${myRepo}에 영향 가능한 최근 ${days}일 변경\n`];
    lines.push("| 위험 | 레포 | PR | 상태 | 영향 키워드 | 내 파일 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");

    for (const r of results) {
      if (r.error) {
        lines.push(`| - | ${r.repo} | ERROR | - | - | ${r.error} |`);
        continue;
      }
      const state = r.pr.merged ? "merged" : r.pr.state;
      const keywords = r.affectedKeywords.map((k) => k.keyword).join(", ");
      const files = r.affectedKeywords.flatMap((k) => k.myFiles);
      const uniqueFiles = [...new Set(files)].slice(0, 3).join(", ");
      lines.push(
        `| **${r.maxRisk}** | ${r.repo} | [#${r.pr.number}](${r.pr.url}) ${r.pr.title.slice(0, 30)} | ${state} | ${keywords} | ${uniqueFiles} |`,
      );
    }

    lines.push(`\n**총 ${results.filter((r) => !r.error).length}건**`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "cross_impact_repos",
  "등록된 레포 목록 조회",
  {},
  async () => {
    const lines = ["## 등록된 레포\n"];
    for (const [name, entry] of Object.entries(REPOS)) {
      lines.push(`- **${name}**: ${entry.repo} (base: ${entry.base})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.prompt(
  "cross-impact-analyze",
  "Cross-repo 영향 분석",
  {
    repo: z.string().describe("분석할 레포"),
    head: z.string().describe("비교할 브랜치"),
    base: z.string().optional().describe("기준 브랜치"),
  },
  ({ repo, head, base }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `${repo} 레포의 ${head} 브랜치 변경이 다른 프로젝트에 미치는 영향을 분석해줘.

## 절차

1. cross_impact_changes로 영향 범위를 조회해.
   - repo: "${repo}", head: "${head}"${base ? `, base: "${base}"` : ""}
   - 자동으로 변경 파일에서 키워드를 추출하고 다른 레포에서 검색함
2. CRITICAL/WARNING 항목이 있으면 cross_impact_compare로 양쪽 코드를 비교해.
3. 비교 결과를 바탕으로 아래 형식으로 리포트해:

## 위험도 기준
- **CRITICAL**: 배포 시 즉시 에러 — export/타입 삭제, 파일 삭제/이름변경, 필수 필드 누락
- **WARNING**: 동작하지만 문제 가능 — 필드 변경, 시그니처 수정, 스키마 변경
- **INFO**: 확인 권장 — 코드 추가, 문서 불일치

## 리포트 형식

### 영향 요약
| 대상 | 키워드 | 위험 | 내 파일 | 상대 파일 | 설명 |
|------|--------|------|--------|----------|------|

### 상세 분석
(CRITICAL/WARNING 항목에 대해 양쪽 코드 비교 후 구체적인 호환성 문제 설명)

### 조치 사항
- [ ] 구체적인 할 일 체크리스트`,
      },
    }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
