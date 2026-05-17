import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  toPascalCase,
  toKebabCase,
  toZodType,
  generatePortContent,
  generateServiceContent,
  generateHandlerContent,
  updateIndexTs,
  updateEnvTs,
  solidityToTs,
  extractPortMethods,
  diffAbiVsPort,
} from '../mcp/topic-gen-mcp/generator.js';

test('toPascalCase', () => {
  assert.equal(toPascalCase('networkInquiry'), 'NetworkInquiry');
  assert.equal(toPascalCase('contract'), 'Contract');
});

test('toKebabCase', () => {
  assert.equal(toKebabCase('networkInquiry'), 'network-inquiry');
  assert.equal(toKebabCase('contract'), 'contract');
});

test('toZodType', () => {
  assert.equal(toZodType('string'), 'z.string()');
  assert.equal(toZodType('number'), 'z.number()');
  assert.equal(toZodType('boolean'), 'z.boolean()');
});

test('generatePortContent - 필드 포함 확인', () => {
  const content = generatePortContent(
    'NetworkInquiry',
    'network-inquiry',
    { requestId: 'string', chainId: 'string' },
    { networkId: 'string', blockNumber: 'number' },
  );
  assert.ok(content.includes('export interface NetworkInquiryRequest'));
  assert.ok(content.includes('requestId: string;'));
  assert.ok(content.includes('chainId: string;'));
  assert.ok(content.includes('export interface NetworkInquiryResult'));
  assert.ok(content.includes('blockNumber: number;'));
  assert.ok(content.includes('export interface NetworkInquiryUseCase'));
});

test('generateServiceContent - 기본 구조 확인', () => {
  const content = generateServiceContent('NetworkInquiry', 'network-inquiry', 'networkInquiry');
  assert.ok(content.includes('import { NetworkInquiryRequest, NetworkInquiryResult, NetworkInquiryUseCase }'));
  assert.ok(content.includes('export class NetworkInquiryService implements NetworkInquiryUseCase'));
  assert.ok(content.includes('// TODO: 비즈니스 로직 구현'));
});

test('generateHandlerContent - zod schema 확인', () => {
  const content = generateHandlerContent(
    'NetworkInquiry',
    'network-inquiry',
    'networkInquiry',
    { requestId: 'string', chainId: 'string' },
  );
  assert.ok(content.includes('requestId: z.string()'));
  assert.ok(content.includes('chainId: z.string()'));
  assert.ok(content.includes('export function networkInquiryHandler('));
});

test('updateIndexTs - 4개 앵커 모두 치환됨', () => {
  const fakeIndexTs = `import { ContractUseCase } from "@domain/port/in/contract.port";
import { MessagePublisherPort } from "@domain/port/out/message-publisher.port";
import { contractHandler } from "./contract.handler";
import { HandlerConfig, registerHandler } from "./register";

export interface Services {
  contractService: ContractUseCase;
}

function createHandlerConfigs(services: Services): HandlerConfig<any, any>[] {
  return [contractHandler(services.contractService, RequestTopics.contractInquiry, ResponseTopics.contractResult)];
}`;

  const result = updateIndexTs(fakeIndexTs, 'NetworkInquiry', 'network-inquiry', 'networkInquiry');
  assert.ok(result.includes('import { NetworkInquiryUseCase }'));
  assert.ok(result.includes('import { networkInquiryHandler }'));
  assert.ok(result.includes('networkInquiryService: NetworkInquiryUseCase;'));
  assert.ok(result.includes('networkInquiryHandler(services.networkInquiryService'));
});

test('updateIndexTs - 앵커 없으면 throw', () => {
  assert.throws(() => updateIndexTs('bad content', 'NetworkInquiry', 'network-inquiry', 'networkInquiry'), /앵커/);
});

test('updateEnvTs - 토픽명 하이픈→점 변환', () => {
  const fakeEnvTs = `      request: {
        infraInquiry: "adapter.board.infra.request",
      },
      response: {
        infraResult: "adapter.board.infra.result",
      },`;

  const result = updateEnvTs(fakeEnvTs, 'networkInquiry', 'network-inquiry');
  assert.ok(result.includes('networkInquiry: "adapter.board.network.inquiry.request"'));
  assert.ok(result.includes('networkInquiryResult: "adapter.board.network.inquiry.result"'));
});

test('solidityToTs - 기본 타입 매핑', () => {
  assert.equal(solidityToTs('bool'), 'boolean');
  assert.equal(solidityToTs('uint256'), 'string');
  assert.equal(solidityToTs('address'), 'string');
  assert.equal(solidityToTs('bytes32'), 'string');
  assert.equal(solidityToTs('string'), 'string');
  assert.equal(solidityToTs('tuple'), 'unknown');
  assert.equal(solidityToTs('uint256[]'), 'unknown');
});

test('extractPortMethods - 메서드명 추출', () => {
  const portContent = `
export interface ChainReaderPort {
  getBlock(blockTag: string, includeTransactions?: boolean): Promise<Record<string, unknown> | null>;
  ethCall(to: string, data: string, blockTag?: string): Promise<string>;
  getBalance(address: string, blockTag?: string): Promise<string>;
}
  `;
  const methods = extractPortMethods(portContent);
  assert.ok(methods.has('getBlock'));
  assert.ok(methods.has('ethCall'));
  assert.ok(methods.has('getBalance'));
  assert.equal(methods.size, 3);
});

test('diffAbiVsPort - 누락 메서드 감지', () => {
  const abiFunctions = [
    { name: 'getBlock', inputs: [{ name: 'blockTag', type: 'string' }], outputs: [{ type: 'string' }] },
    { name: 'getCode', inputs: [{ name: 'address', type: 'address' }], outputs: [{ type: 'bytes' }] },
  ];
  const portMethods = new Set(['getBlock']);
  const result = diffAbiVsPort(abiFunctions, portMethods);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].name, 'getCode');
  assert.equal(result.present.length, 1);
});
