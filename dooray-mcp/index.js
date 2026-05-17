import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = (process.env.DOORAY_API_URL || "https://api.dooray.com").replace(/\/$/, "");
const TOKEN = process.env.DOORAY_TOKEN || "";
const DEFAULT_PROJECT_ID = process.env.DOORAY_DEFAULT_PROJECT_ID || "";
const DEFAULT_CHANNEL_ID = process.env.DOORAY_DEFAULT_CHANNEL_ID || "";

if (!TOKEN) {
  console.error("[dooray-mcp] DOORAY_TOKEN 필수 (두레이 My Page → API 인증 토큰)");
  process.exit(1);
}

async function dooray(path, opts = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `dooray-api ${TOKEN}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Dooray HTTP ${res.status} (${path}): ${text.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Dooray 응답 JSON 아님: ${text.slice(0, 200)}`);
  }
  if (data.header && data.header.isSuccessful === false) {
    throw new Error(`Dooray API ${data.header.resultCode}: ${data.header.resultMessage}`);
  }
  return data.result;
}

function resolveProjectId(id) {
  const v = id || DEFAULT_PROJECT_ID;
  if (!v) throw new Error("project_id 필요 (또는 DOORAY_DEFAULT_PROJECT_ID 설정)");
  return v;
}

function resolveChannelId(id) {
  const v = id || DEFAULT_CHANNEL_ID;
  if (!v) throw new Error("channel_id 필요 (또는 DOORAY_DEFAULT_CHANNEL_ID 설정)");
  return v;
}

function fmtTime(ts) {
  if (!ts) return "";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

const server = new McpServer({ name: "dooray-mcp", version: "1.0.0" });

// ════════════════════════════════════════════════════════════
// Project (업무)
// ════════════════════════════════════════════════════════════

// ─── 프로젝트 목록 ───────────────────────────────────────────
server.tool(
  "dooray_projects",
  "참여 중인 두레이 프로젝트 목록 (project ID 확인용)",
  {
    member_id: z.string().optional().describe("특정 멤버 ID로 필터 (생략 시 본인)"),
    size: z.number().default(50),
  },
  async ({ member_id, size }) => {
    const params = new URLSearchParams({ size: String(Math.min(size, 100)) });
    if (member_id) params.set("memberId", member_id);
    params.set("type", "private,public");
    params.set("state", "active");
    const data = await dooray(`/project/v1/projects?${params}`);
    if (!data?.length) return { content: [{ type: "text", text: "프로젝트 없음" }] };
    const body = data.map((p) =>
      `- **${p.description || p.code}** (id: \`${p.id}\`)\n  code: ${p.code} · state: ${p.state}`,
    ).join("\n\n");
    return { content: [{ type: "text", text: `## 프로젝트 (${data.length}개)\n\n${body}` }] };
  },
);

// ─── 프로젝트 멤버 ───────────────────────────────────────────
server.tool(
  "dooray_members",
  "프로젝트 멤버 목록 (담당자 ID 확인용)",
  {
    project_id: z.string().optional().describe(`프로젝트 ID (기본: ${DEFAULT_PROJECT_ID || "env"})`),
    name: z.string().optional().describe("이름 부분 매칭 필터"),
    size: z.number().default(50),
  },
  async ({ project_id, name, size }) => {
    const pid = resolveProjectId(project_id);
    const params = new URLSearchParams({ size: String(Math.min(size, 100)) });
    const data = await dooray(`/project/v1/projects/${pid}/members?${params}`);
    let members = data || [];
    if (name) {
      const q = name.toLowerCase();
      members = members.filter((m) => (m.name || "").toLowerCase().includes(q));
    }
    if (!members.length) return { content: [{ type: "text", text: "멤버 없음" }] };
    const body = members.map((m) =>
      `- **${m.name || "(no name)"}** (id: \`${m.organizationMemberId || m.id}\`)\n  role: ${m.role || "?"}`,
    ).join("\n\n");
    return { content: [{ type: "text", text: `## 프로젝트 멤버 (${members.length}개)\n\n${body}` }] };
  },
);

// ─── 워크플로우(상태) 목록 ──────────────────────────────────
server.tool(
  "dooray_workflows",
  "프로젝트 워크플로우(상태) 목록 — task_update의 workflow_id 확인용",
  {
    project_id: z.string().optional(),
  },
  async ({ project_id }) => {
    const pid = resolveProjectId(project_id);
    const data = await dooray(`/project/v1/projects/${pid}/workflows`);
    if (!data?.length) return { content: [{ type: "text", text: "워크플로우 없음" }] };
    const body = data.map((w) =>
      `- **${w.name}** [${w.class}] (id: \`${w.id}\`)${w.order != null ? ` · order: ${w.order}` : ""}`,
    ).join("\n");
    return { content: [{ type: "text", text: `## 워크플로우 (${data.length}개)\n\n${body}` }] };
  },
);

// ─── 업무 목록 ──────────────────────────────────────────────
server.tool(
  "dooray_tasks",
  "프로젝트 업무 목록 조회 (담당자/상태/검색어 필터)",
  {
    project_id: z.string().optional(),
    workflow_class: z.enum(["registered", "working", "closed"]).optional().describe("상태 분류"),
    to_member_ids: z.array(z.string()).optional().describe("담당자 (organizationMemberId 배열)"),
    subject: z.string().optional().describe("제목 검색어"),
    tag_ids: z.array(z.string()).optional(),
    milestone_ids: z.array(z.string()).optional(),
    page: z.number().default(0),
    size: z.number().default(20),
    order: z.string().default("-createdAt").describe("정렬 (예: -createdAt, dueDate)"),
  },
  async ({ project_id, workflow_class, to_member_ids, subject, tag_ids, milestone_ids, page, size, order }) => {
    const pid = resolveProjectId(project_id);
    const params = new URLSearchParams({
      page: String(page),
      size: String(Math.min(size, 100)),
      order,
    });
    if (workflow_class) params.set("postWorkflowClasses", workflow_class);
    if (to_member_ids?.length) params.set("toMemberIds", to_member_ids.join(","));
    if (subject) params.set("subjects", subject);
    if (tag_ids?.length) params.set("tagIds", tag_ids.join(","));
    if (milestone_ids?.length) params.set("milestoneIds", milestone_ids.join(","));

    const data = await dooray(`/project/v1/projects/${pid}/posts?${params}`);
    if (!data?.length) return { content: [{ type: "text", text: "업무 없음" }] };

    const body = data.map((t) => {
      const due = t.dueDate ? ` · due: ${fmtTime(t.dueDate)}` : "";
      const assignees = (t.users?.to || [])
        .map((u) => u.member?.name || u.member?.organizationMemberId)
        .filter(Boolean)
        .join(", ");
      return `- **#${t.number} ${t.subject}** [${t.workflowClass}/${t.workflow?.name || "?"}]${due}\n  id: \`${t.id}\` · 담당: ${assignees || "(없음)"}`;
    }).join("\n\n");
    return { content: [{ type: "text", text: `## 업무 (${data.length}개)\n\n${body}` }] };
  },
);

// ─── 업무 상세 + 댓글 ───────────────────────────────────────
server.tool(
  "dooray_task_get",
  "업무 상세 + 댓글 조회",
  {
    project_id: z.string().optional(),
    task_id: z.string().describe("업무 ID (dooray_tasks 결과의 id)"),
    include_comments: z.boolean().default(true),
  },
  async ({ project_id, task_id, include_comments }) => {
    const pid = resolveProjectId(project_id);
    const t = await dooray(`/project/v1/projects/${pid}/posts/${task_id}`);

    const assignees = (t.users?.to || [])
      .map((u) => u.member?.name || u.member?.organizationMemberId)
      .filter(Boolean).join(", ");
    const cc = (t.users?.cc || [])
      .map((u) => u.member?.name || u.member?.organizationMemberId)
      .filter(Boolean).join(", ");
    const tags = (t.tags || []).map((tag) => tag.name).join(", ");

    let out = `## #${t.number} ${t.subject}\n\n`;
    out += `- id: \`${t.id}\`\n`;
    out += `- 상태: ${t.workflowClass} / ${t.workflow?.name}\n`;
    out += `- 담당: ${assignees || "(없음)"}${cc ? ` · 참조: ${cc}` : ""}\n`;
    out += `- 우선순위: ${t.priority || "normal"}\n`;
    out += `- 생성: ${fmtTime(t.createdAt)} by ${t.users?.from?.member?.name || "?"}\n`;
    if (t.dueDate) out += `- 마감: ${fmtTime(t.dueDate)}\n`;
    if (t.milestone) out += `- 마일스톤: ${t.milestone.name}\n`;
    if (tags) out += `- 태그: ${tags}\n`;
    out += `\n### 본문\n${(t.body?.content || "").slice(0, 4000)}\n`;

    if (include_comments) {
      const logs = await dooray(`/project/v1/projects/${pid}/posts/${task_id}/logs?size=100&order=createdAt`);
      if (logs?.length) {
        out += `\n### 댓글 (${logs.length}개)\n\n`;
        out += logs.map((l) => {
          const author = l.creator?.member?.name || l.creator?.member?.organizationMemberId || "?";
          const content = (l.body?.content || "").slice(0, 500);
          return `- **${fmtTime(l.createdAt)}** ${author}\n  ${content.replace(/\n/g, "\n  ")}`;
        }).join("\n\n");
      }
    }

    return { content: [{ type: "text", text: out }] };
  },
);

// ─── 업무 생성 ──────────────────────────────────────────────
server.tool(
  "dooray_task_create",
  "업무 생성",
  {
    project_id: z.string().optional(),
    subject: z.string().describe("제목"),
    body: z.string().describe("본문 (markdown 또는 HTML)"),
    body_type: z.enum(["text/x-markdown", "text/html"]).default("text/x-markdown"),
    to_member_ids: z.array(z.string()).default([]).describe("담당자 organizationMemberId 배열"),
    cc_member_ids: z.array(z.string()).default([]).describe("참조자 ID 배열"),
    priority: z.enum(["lowest", "low", "normal", "high", "highest"]).default("normal"),
    due_date: z.string().optional().describe("마감일 ISO datetime (예: 2026-05-20T18:00:00+09:00)"),
    milestone_id: z.string().optional(),
    tag_ids: z.array(z.string()).optional(),
  },
  async ({ project_id, subject, body, body_type, to_member_ids, cc_member_ids, priority, due_date, milestone_id, tag_ids }) => {
    const pid = resolveProjectId(project_id);
    const payload = {
      users: {
        to: to_member_ids.map((id) => ({ type: "member", member: { organizationMemberId: id } })),
        cc: cc_member_ids.map((id) => ({ type: "member", member: { organizationMemberId: id } })),
      },
      subject,
      body: { mimeType: body_type, content: body },
      priority,
      ...(due_date && { dueDate: due_date, dueDateFlag: true }),
      ...(milestone_id && { milestoneId: milestone_id }),
      ...(tag_ids && { tagIds: tag_ids }),
    };
    const res = await dooray(`/project/v1/projects/${pid}/posts`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return {
      content: [{
        type: "text",
        text: `## 업무 생성 완료\n- id: \`${res.id}\`\n- subject: ${subject}\n- 담당: ${to_member_ids.length}명`,
      }],
    };
  },
);

// ─── 업무 수정 (필드 + 상태) ───────────────────────────────
server.tool(
  "dooray_task_update",
  "업무 수정 — 필드 변경 (subject/body/due_date/priority/담당자) 또는 워크플로우(상태) 변경",
  {
    project_id: z.string().optional(),
    task_id: z.string().describe("업무 ID"),
    subject: z.string().optional(),
    body: z.string().optional().describe("본문 (변경 시)"),
    body_type: z.enum(["text/x-markdown", "text/html"]).default("text/x-markdown"),
    to_member_ids: z.array(z.string()).optional().describe("담당자 변경 (전체 교체)"),
    priority: z.enum(["lowest", "low", "normal", "high", "highest"]).optional(),
    due_date: z.string().optional(),
    workflow_id: z.string().optional().describe("상태 변경 (dooray_workflows로 ID 확인)"),
  },
  async ({ project_id, task_id, subject, body, body_type, to_member_ids, priority, due_date, workflow_id }) => {
    const pid = resolveProjectId(project_id);
    const results = [];

    // 1. 필드 업데이트 (PUT)
    const fieldPayload = {};
    if (subject != null) fieldPayload.subject = subject;
    if (body != null) fieldPayload.body = { mimeType: body_type, content: body };
    if (priority != null) fieldPayload.priority = priority;
    if (due_date != null) { fieldPayload.dueDate = due_date; fieldPayload.dueDateFlag = true; }
    if (to_member_ids) {
      fieldPayload.users = {
        to: to_member_ids.map((id) => ({ type: "member", member: { organizationMemberId: id } })),
      };
    }
    if (Object.keys(fieldPayload).length) {
      await dooray(`/project/v1/projects/${pid}/posts/${task_id}`, {
        method: "PUT",
        body: JSON.stringify(fieldPayload),
      });
      results.push(`필드 갱신 (${Object.keys(fieldPayload).join(", ")})`);
    }

    // 2. 워크플로우 변경 (POST /workflow)
    if (workflow_id) {
      await dooray(`/project/v1/projects/${pid}/posts/${task_id}/workflow`, {
        method: "POST",
        body: JSON.stringify({ workflowId: workflow_id }),
      });
      results.push(`워크플로우 → ${workflow_id}`);
    }

    if (!results.length) {
      throw new Error("변경할 필드 없음. 최소 하나의 파라미터 필요");
    }

    return {
      content: [{
        type: "text",
        text: `## 업무 수정 완료\n- task_id: \`${task_id}\`\n- 변경: ${results.join(" / ")}`,
      }],
    };
  },
);

// ─── 업무 댓글 ──────────────────────────────────────────────
server.tool(
  "dooray_task_comment",
  "업무에 댓글 추가",
  {
    project_id: z.string().optional(),
    task_id: z.string(),
    content: z.string().describe("댓글 본문"),
    body_type: z.enum(["text/x-markdown", "text/html"]).default("text/x-markdown"),
  },
  async ({ project_id, task_id, content, body_type }) => {
    const pid = resolveProjectId(project_id);
    const res = await dooray(`/project/v1/projects/${pid}/posts/${task_id}/logs`, {
      method: "POST",
      body: JSON.stringify({ body: { mimeType: body_type, content } }),
    });
    return {
      content: [{ type: "text", text: `## 댓글 추가 완료\n- log_id: \`${res.id}\`\n- task: \`${task_id}\`` }],
    };
  },
);

// ════════════════════════════════════════════════════════════
// Messenger
// ════════════════════════════════════════════════════════════

// ─── 채널 목록 ──────────────────────────────────────────────
server.tool(
  "dooray_messenger_channels",
  "참여 중인 메신저 채널 목록 (channel ID 확인용)",
  {
    type: z.enum(["bot", "private", "direct", "group", "public", "all"]).default("all"),
    size: z.number().default(50),
  },
  async ({ type, size }) => {
    const params = new URLSearchParams({ size: String(Math.min(size, 100)) });
    if (type !== "all") params.set("type", type);
    const data = await dooray(`/messenger/v1/channels?${params}`);
    if (!data?.length) return { content: [{ type: "text", text: "채널 없음" }] };
    const body = data.map((c) => {
      const memberCount = c.members?.length || 0;
      return `- **${c.title || "(no title)"}** [${c.type}] (id: \`${c.id}\`)\n  members: ${memberCount}`;
    }).join("\n\n");
    return { content: [{ type: "text", text: `## 메신저 채널 (${data.length}개)\n\n${body}` }] };
  },
);

// ─── 메시지 발송 ────────────────────────────────────────────
server.tool(
  "dooray_messenger_send",
  "메신저 채널에 메시지 발송",
  {
    channel_id: z.string().optional().describe(`채널 ID (기본: ${DEFAULT_CHANNEL_ID || "env"})`),
    text: z.string().describe("메시지 본문"),
  },
  async ({ channel_id, text }) => {
    const cid = resolveChannelId(channel_id);
    await dooray(`/messenger/v1/channels/${cid}/logs`, {
      method: "POST",
      body: JSON.stringify({ text, type: "text" }),
    });
    return {
      content: [{ type: "text", text: `## 발송 완료\n- channel: \`${cid}\`\n- text: ${text.slice(0, 100)}` }],
    };
  },
);

// ─── 메시지 조회 ────────────────────────────────────────────
server.tool(
  "dooray_messenger_history",
  "메신저 채널 최근 메시지 조회",
  {
    channel_id: z.string().optional(),
    size: z.number().default(20).describe("조회 건수 (최대 100)"),
  },
  async ({ channel_id, size }) => {
    const cid = resolveChannelId(channel_id);
    const params = new URLSearchParams({ size: String(Math.min(size, 100)) });
    const data = await dooray(`/messenger/v1/channels/${cid}/logs?${params}`);
    if (!data?.length) return { content: [{ type: "text", text: "메시지 없음" }] };
    const body = data.map((m) => {
      const author = m.senderName || m.organizationMemberId || "?";
      const text = (m.text || "").replace(/\n/g, "\n  ");
      return `- **${fmtTime(m.sendAt || m.createdAt)}** \`${author}\`\n  ${text}`;
    }).join("\n\n");
    return { content: [{ type: "text", text: `## 메시지 (${data.length}건)\n\n${body}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
