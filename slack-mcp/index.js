import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebClient } from "@slack/web-api";
import { z } from "zod";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const USER_TOKEN = process.env.SLACK_USER_TOKEN || "";
const DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL || "";

if (!BOT_TOKEN && !USER_TOKEN) {
  console.error("[slack-mcp] SLACK_BOT_TOKEN 또는 SLACK_USER_TOKEN 중 하나는 반드시 설정해야 합니다.");
  process.exit(1);
}

const bot = BOT_TOKEN ? new WebClient(BOT_TOKEN) : null;
const user = USER_TOKEN ? new WebClient(USER_TOKEN) : null;

const server = new McpServer({ name: "slack-mcp", version: "1.0.0" });

// 채널명 → 채널ID 캐시
const channelIdCache = new Map();

async function resolveChannelId(channel) {
  if (!channel) return channel;
  // 이미 ID 형식이면 (C…, D…, G…) 그대로 사용
  if (/^[CDG][A-Z0-9]{6,}$/.test(channel)) return channel;

  const name = channel.replace(/^#/, "");
  if (channelIdCache.has(name)) return channelIdCache.get(name);

  const client = bot || user;
  let cursor;
  do {
    const res = await client.conversations.list({
      limit: 1000,
      cursor,
      types: "public_channel,private_channel",
      exclude_archived: true,
    });
    for (const c of res.channels || []) {
      channelIdCache.set(c.name, c.id);
      if (c.name === name) return c.id;
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  throw new Error(`채널을 찾을 수 없습니다: ${channel} (Bot이 채널에 참여했는지 확인)`);
}

function fmtTs(ts) {
  if (!ts) return "";
  const date = new Date(parseFloat(ts) * 1000);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function fmtMessage(m) {
  const ts = fmtTs(m.ts);
  const user = m.user || m.bot_id || m.username || "unknown";
  const text = (m.text || "").replace(/\n/g, "\n  ");
  const thread = m.thread_ts && m.thread_ts !== m.ts ? ` (thread: ${m.thread_ts})` : "";
  const replies = m.reply_count ? ` [${m.reply_count} replies]` : "";
  return `- **${ts}** \`${user}\`${thread}${replies}\n  ${text}\n  _ts: ${m.ts}_`;
}

// ─── 1. 메시지 발송 ─────────────────────────────────────────────
server.tool(
  "slack_post_message",
  "Slack 채널/DM/스레드에 메시지 발송 (Bot Token 우선)",
  {
    channel: z.string().optional().describe("채널 ID(C…) 또는 이름(#general). 생략 시 SLACK_DEFAULT_CHANNEL 사용"),
    text: z.string().describe("메시지 본문 (Slack mrkdwn 지원)"),
    thread_ts: z.string().optional().describe("답글로 달 스레드의 ts (예: 1700000000.123456)"),
    reply_broadcast: z.boolean().default(false).describe("스레드 답글을 채널에도 broadcast 할지 여부"),
  },
  async ({ channel, text, thread_ts, reply_broadcast }) => {
    const client = bot || user;
    if (!client) throw new Error("SLACK_BOT_TOKEN 또는 SLACK_USER_TOKEN 미설정");

    const target = channel || DEFAULT_CHANNEL;
    if (!target) throw new Error("channel 파라미터 또는 SLACK_DEFAULT_CHANNEL 필요");

    const channelId = await resolveChannelId(target);
    const res = await client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: thread_ts || undefined,
      reply_broadcast: thread_ts ? reply_broadcast : undefined,
    });

    return {
      content: [{
        type: "text",
        text: `## 메시지 발송 완료\n- channel: \`${res.channel}\`\n- ts: \`${res.ts}\`${thread_ts ? `\n- thread_ts: \`${thread_ts}\`` : ""}`,
      }],
    };
  },
);

// ─── 2. 채널 메시지 조회 ────────────────────────────────────────
server.tool(
  "slack_history",
  "채널 최근 메시지 조회 (conversations.history)",
  {
    channel: z.string().describe("채널 ID(C…) 또는 이름(#general)"),
    limit: z.number().default(20).describe("조회 건수 (기본: 20, 최대: 200)"),
    oldest: z.string().optional().describe("이 ts 이후 메시지만 (예: 1700000000.000000)"),
    latest: z.string().optional().describe("이 ts 이전 메시지만"),
  },
  async ({ channel, limit, oldest, latest }) => {
    const client = bot || user;
    const channelId = await resolveChannelId(channel);
    const res = await client.conversations.history({
      channel: channelId,
      limit: Math.min(limit, 200),
      oldest: oldest || undefined,
      latest: latest || undefined,
    });

    const messages = res.messages || [];
    if (messages.length === 0) {
      return { content: [{ type: "text", text: `메시지 없음 (channel: ${channel})` }] };
    }

    const body = messages.map(fmtMessage).join("\n\n");
    return {
      content: [{
        type: "text",
        text: `## ${channel} 최근 메시지 (${messages.length}개)\n\n${body}`,
      }],
    };
  },
);

// ─── 3. 스레드 답글 조회 ────────────────────────────────────────
server.tool(
  "slack_replies",
  "특정 스레드의 답글 조회 (conversations.replies)",
  {
    channel: z.string().describe("채널 ID(C…) 또는 이름(#general)"),
    thread_ts: z.string().describe("스레드 부모 메시지의 ts"),
    limit: z.number().default(50).describe("조회 건수 (기본: 50, 최대: 200)"),
  },
  async ({ channel, thread_ts, limit }) => {
    const client = bot || user;
    const channelId = await resolveChannelId(channel);
    const res = await client.conversations.replies({
      channel: channelId,
      ts: thread_ts,
      limit: Math.min(limit, 200),
    });

    const messages = res.messages || [];
    if (messages.length === 0) {
      return { content: [{ type: "text", text: `스레드 답글 없음 (thread_ts: ${thread_ts})` }] };
    }

    const [parent, ...replies] = messages;
    const parentText = `### 부모\n${fmtMessage(parent)}`;
    const repliesText = replies.length
      ? `\n\n### 답글 (${replies.length}개)\n${replies.map(fmtMessage).join("\n\n")}`
      : "\n\n(답글 없음)";

    return {
      content: [{ type: "text", text: `## ${channel} 스레드\n\n${parentText}${repliesText}` }],
    };
  },
);

// ─── 4. 메시지 검색 (User Token 필수) ──────────────────────────
server.tool(
  "slack_search",
  "메시지 키워드 검색 (search.messages, User Token 필요)",
  {
    query: z.string().describe("검색 쿼리. Slack 검색 문법 지원 (in:#channel, from:@user, before:YYYY-MM-DD 등)"),
    count: z.number().default(20).describe("결과 건수 (기본: 20, 최대: 100)"),
    sort: z.enum(["score", "timestamp"]).default("timestamp").describe("정렬 (score: 관련도, timestamp: 시간순)"),
  },
  async ({ query, count, sort }) => {
    if (!user) {
      throw new Error("search.messages는 SLACK_USER_TOKEN(xoxp-) 필요");
    }
    const res = await user.search.messages({
      query,
      count: Math.min(count, 100),
      sort,
      sort_dir: "desc",
    });

    const matches = res.messages?.matches || [];
    if (matches.length === 0) {
      return { content: [{ type: "text", text: `검색 결과 없음 (query: ${query})` }] };
    }

    const body = matches.map((m) => {
      const ch = m.channel?.name ? `#${m.channel.name}` : m.channel?.id || "?";
      const ts = fmtTs(m.ts);
      const text = (m.text || "").replace(/\n/g, "\n  ");
      const permalink = m.permalink ? `\n  ${m.permalink}` : "";
      return `- **${ts}** \`${m.username || m.user || "?"}\` in ${ch}\n  ${text}${permalink}`;
    }).join("\n\n");

    const total = res.messages?.total || matches.length;
    return {
      content: [{
        type: "text",
        text: `## 검색 결과 (${matches.length}/${total}건)\n_query: \`${query}\`_\n\n${body}`,
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
