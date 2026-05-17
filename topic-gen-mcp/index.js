import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { z } from 'zod';

import {
  toPascalCase,
  toKebabCase,
  generatePortContent,
  generateServiceContent,
  generateHandlerContent,
  updateIndexTs,
  updateEnvTs,
  extractPortMethods,
  diffAbiVsPort,
  generateMethodSnippet,
} from './generator.js';

const BOARD_DIR = process.env.BOARD_DIR || '';

const server = new McpServer({ name: 'topic-gen-mcp', version: '1.0.0' });

server.tool(
  'topic_gen',
  'Kafka 토픽 스켈레톤 생성 (port/service/handler + index.ts, env.ts 수정)',
  {
    topic_key: z.string().describe('camelCase 토픽 키 (예: networkInquiry)'),
    request_fields: z.string().describe('JSON — 요청 필드 (예: {"requestId":"string","chainId":"string"})'),
    response_fields: z.string().describe('JSON — 응답 필드 (예: {"networkId":"string","blockNumber":"number"})'),
    board_dir: z.string().optional().describe('StableCoinBC_Adapter_Board 절대 경로 (기본: BOARD_DIR env)'),
  },
  async ({ topic_key, request_fields, response_fields, board_dir }) => {
    const dir = board_dir || BOARD_DIR;
    if (!dir) {
      return { content: [{ type: 'text', text: 'ERROR: board_dir 또는 BOARD_DIR 환경변수가 필요합니다.' }] };
    }

    let reqFields, resFields;
    try {
      reqFields = JSON.parse(request_fields);
      resFields = JSON.parse(response_fields);
    } catch {
      return { content: [{ type: 'text', text: 'ERROR: request_fields, response_fields는 유효한 JSON이어야 합니다.' }] };
    }

    const pascal = toPascalCase(topic_key);
    const kebab = toKebabCase(topic_key);

    const portPath = resolve(dir, `src/domain/port/in/${kebab}.port.ts`);
    const servicePath = resolve(dir, `src/application/${topic_key}/${kebab}.service.ts`);
    const handlerPath = resolve(dir, `src/adapter/in/kafka/handlers/${kebab}.handler.ts`);
    const indexPath = resolve(dir, 'src/adapter/in/kafka/handlers/index.ts');
    const envPath = resolve(dir, 'src/infra/config/env.ts');

    if (existsSync(portPath)) {
      return { content: [{ type: 'text', text: `ERROR: ${portPath} 이미 존재합니다. topic_key를 확인하세요.` }] };
    }

    try {
      mkdirSync(dirname(portPath), { recursive: true });
      mkdirSync(dirname(servicePath), { recursive: true });

      writeFileSync(portPath, generatePortContent(pascal, kebab, reqFields, resFields), 'utf-8');
      writeFileSync(servicePath, generateServiceContent(pascal, kebab, topic_key), 'utf-8');
      writeFileSync(handlerPath, generateHandlerContent(pascal, kebab, topic_key, reqFields), 'utf-8');

      const indexContent = updateIndexTs(readFileSync(indexPath, 'utf-8'), pascal, kebab, topic_key);
      const envContent = updateEnvTs(readFileSync(envPath, 'utf-8'), topic_key, kebab);

      writeFileSync(indexPath, indexContent, 'utf-8');
      writeFileSync(envPath, envContent, 'utf-8');
    } catch (e) {
      return { content: [{ type: 'text', text: `ERROR: 파일 작업 실패 — ${e.message}` }] };
    }

    return {
      content: [{
        type: 'text',
        text: [
          '## 스켈레톤 생성 완료\n',
          `**토픽 키**: \`${topic_key}\`\n`,
          '### 생성된 파일',
          `- \`${portPath}\``,
          `- \`${servicePath}\``,
          `- \`${handlerPath}\`\n`,
          '### 수정된 파일',
          `- \`${indexPath}\``,
          `- \`${envPath}\`\n`,
          '### 다음 단계',
          `1. \`${servicePath}\` — 비즈니스 로직 구현 (\`throw new Error("Not implemented")\` 대체)`,
          `2. \`src/index.ts\` — \`${pascal}Service\` 인스턴스 생성 후 services에 추가`,
          `3. Kafka 토픽명: \`adapter.board.${kebab}.request\` / \`adapter.board.${kebab}.result\``,
        ].join('\n'),
      }],
    };
  },
);

server.tool(
  'topic_abi_check',
  'ABI JSON과 ChainReaderPort 비교 — 누락/변경된 메서드 및 구현 스니펫 제안',
  {
    abi_path: z.string().describe('ABI JSON 파일 절대 경로 (StableCoin_ERC4337 레포 내)'),
    board_dir: z.string().optional().describe('StableCoinBC_Adapter_Board 절대 경로 (기본: BOARD_DIR env)'),
  },
  async ({ abi_path, board_dir }) => {
    const dir = board_dir || BOARD_DIR;
    if (!dir) {
      return { content: [{ type: 'text', text: 'ERROR: board_dir 또는 BOARD_DIR 환경변수가 필요합니다.' }] };
    }

    let abiJson;
    try {
      abiJson = JSON.parse(readFileSync(abi_path, 'utf-8'));
    } catch (e) {
      return { content: [{ type: 'text', text: `ERROR: ABI 파일을 읽을 수 없습니다: ${e.message}` }] };
    }

    let portContent;
    try {
      const portPath = resolve(dir, 'src/domain/port/out/chain-reader.port.ts');
      portContent = readFileSync(portPath, 'utf-8');
    } catch (e) {
      return { content: [{ type: 'text', text: `ERROR: chain-reader.port.ts를 읽을 수 없습니다: ${e.message}` }] };
    }

    const abiFunctions = abiJson.filter((e) => e.type === 'function');
    const portMethods = extractPortMethods(portContent);
    const { missing, present } = diffAbiVsPort(abiFunctions, portMethods);

    const portMethodNames = new Set(abiFunctions.map((f) => f.name));
    const removed = [...portMethods].filter((m) => !portMethodNames.has(m));

    const lines = ['## ABI ↔ ChainReaderPort 분석 결과\n'];
    lines.push(`- ABI 함수: ${abiFunctions.length}개`);
    lines.push(`- 포트 메서드: ${portMethods.size}개\n`);

    if (missing.length === 0) {
      lines.push('### ✅ 누락된 메서드 없음');
    } else {
      lines.push(`### ❌ 누락된 메서드 (${missing.length}개) — 추가 필요\n`);
      for (const fn of missing) {
        const { portMethod, adapterMethod } = generateMethodSnippet(fn);
        lines.push(`#### \`${fn.name}\``);
        lines.push('\n**ChainReaderPort 추가:**\n```ts');
        lines.push(portMethod);
        lines.push('```\n');
        lines.push('**EthersChainReaderAdapter 구현:**\n```ts');
        lines.push(adapterMethod);
        lines.push('```\n');
      }
    }

    if (removed.length > 0) {
      lines.push(`\n### ⚠️ ABI에 없는 포트 메서드 (${removed.length}개) — 참고용`);
      removed.forEach((m) => lines.push(`- \`${m}\``));
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
