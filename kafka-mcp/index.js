import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Kafka } from 'kafkajs';
import { z } from 'zod';

const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const kafka = new Kafka({ clientId: 'claude-mcp', brokers });

const server = new McpServer({ name: 'kafka-mcp', version: '1.0.0' });

// 토픽 목록 조회
server.tool('kafka_list_topics', '토픽 목록 조회', {}, async () => {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const topics = await admin.listTopics();
    const adapterTopics = topics.filter((t) => t.startsWith('adapter.'));
    const others = topics.filter((t) => !t.startsWith('adapter.'));
    let text = '## Adapter Topics\n';
    text += adapterTopics.sort().map((t) => `- ${t}`).join('\n');
    if (others.length) {
      text += '\n\n## Other Topics\n';
      text += others.sort().map((t) => `- ${t}`).join('\n');
    }
    return { content: [{ type: 'text', text }] };
  } finally {
    await admin.disconnect();
  }
});

// 메시지 발행
server.tool(
  'kafka_publish',
  'Kafka 토픽에 메시지 발행 (JSON, snake_case)',
  {
    topic: z.string().describe('토픽명 (예: adapter.payment.request)'),
    message: z.string().describe('JSON 메시지 문자열'),
    key: z.string().optional().describe('메시지 키 (선택)'),
  },
  async ({ topic, message, key }) => {
    try {
      JSON.parse(message);
    } catch {
      return { content: [{ type: 'text', text: 'ERROR: message는 유효한 JSON이어야 합니다' }] };
    }
    const producer = kafka.producer();
    await producer.connect();
    try {
      await producer.send({
        topic,
        messages: [{ key: key || undefined, value: message }],
      });
      return { content: [{ type: 'text', text: `Published to ${topic}\n\n${message}` }] };
    } finally {
      await producer.disconnect();
    }
  },
);

// 메시지 소비 (최근 N개)
server.tool(
  'kafka_consume',
  'Kafka 토픽에서 최근 메시지 읽기',
  {
    topic: z.string().describe('토픽명'),
    count: z.number().default(1).describe('읽을 메시지 수 (기본: 1)'),
    timeout: z.number().default(5000).describe('타임아웃 ms (기본: 5000)'),
  },
  async ({ topic, count, timeout }) => {
    const groupId = `claude-mcp-${Date.now()}`;
    const consumer = kafka.consumer({ groupId });
    await consumer.connect();
    try {
      await consumer.subscribe({ topic, fromBeginning: false });
      const messages = [];
      let timer;
      await new Promise((resolve) => {
        timer = setTimeout(resolve, timeout);
        consumer.run({
          eachMessage: async ({ message: msg }) => {
            messages.push({
              key: msg.key?.toString(),
              value: msg.value?.toString(),
              offset: msg.offset,
              timestamp: msg.timestamp,
            });
            if (messages.length >= count) {
              clearTimeout(timer);
              resolve();
            }
          },
        });
      });
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `${topic}: 새 메시지 없음 (${timeout}ms 대기)` }] };
      }
      const text = messages
        .map((m, i) => {
          let body = m.value;
          try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
          return `### [${i + 1}] offset=${m.offset}\n\`\`\`json\n${body}\n\`\`\``;
        })
        .join('\n\n');
      return { content: [{ type: 'text', text }] };
    } finally {
      await consumer.disconnect();
      const admin = kafka.admin();
      await admin.connect();
      await admin.deleteGroups([groupId]).catch(() => {});
      await admin.disconnect();
    }
  },
);

// 토픽 오프셋 조회
server.tool(
  'kafka_offsets',
  '토픽의 파티션별 오프셋(earliest/latest) 조회',
  {
    topic: z.string().describe('토픽명'),
  },
  async ({ topic }) => {
    const admin = kafka.admin();
    await admin.connect();
    try {
      const offsets = await admin.fetchTopicOffsets(topic);
      const text = offsets
        .map((o) => `partition=${o.partition} earliest=${o.low} latest=${o.high}`)
        .join('\n');
      return { content: [{ type: 'text', text: `## ${topic}\n${text}` }] };
    } finally {
      await admin.disconnect();
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
