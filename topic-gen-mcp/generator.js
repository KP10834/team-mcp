export function toPascalCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function toKebabCase(str) {
  return str.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}

export function toZodType(type) {
  if (type === 'number') return 'z.number()';
  if (type === 'boolean') return 'z.boolean()';
  return 'z.string()';
}

export function generatePortContent(pascal, kebab, reqFields, resFields) {
  const reqLines = Object.entries(reqFields).map(([k, t]) => `  ${k}: ${t};`).join('\n');
  const resLines = Object.entries(resFields).map(([k, t]) => `  ${k}: ${t};`).join('\n');
  return [
    `export interface ${pascal}Request {`,
    reqLines,
    `}`,
    ``,
    `export interface ${pascal}Result {`,
    resLines,
    `}`,
    ``,
    `export interface ${pascal}UseCase {`,
    `  handle(req: ${pascal}Request): Promise<${pascal}Result>;`,
    `}`,
    ``,
  ].join('\n');
}

export function generateServiceContent(pascal, kebab, topicKey) {
  return [
    `import { ${pascal}Request, ${pascal}Result, ${pascal}UseCase } from "@domain/port/in/${kebab}.port";`,
    `import { createLogger } from "@infra/logger/logger";`,
    ``,
    `const logger = createLogger("${pascal}Service");`,
    ``,
    `export class ${pascal}Service implements ${pascal}UseCase {`,
    `  async handle(req: ${pascal}Request): Promise<${pascal}Result> {`,
    `    logger.info({ requestId: req.requestId }, "${pascal} handle called");`,
    `    // TODO: 비즈니스 로직 구현`,
    `    return {} as ${pascal}Result;`,
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

export function generateHandlerContent(pascal, kebab, topicKey, reqFields) {
  const zodLines = Object.entries(reqFields).map(([k, t]) => `  ${k}: ${toZodType(t)},`).join('\n');
  return [
    `import { z } from "zod";`,
    ``,
    `import { ${pascal}Request, ${pascal}Result, ${pascal}UseCase } from "@domain/port/in/${kebab}.port";`,
    ``,
    `import { createHandlerConfig, HandlerConfig } from "./register";`,
    ``,
    `const schema = z.object({`,
    zodLines,
    `}) satisfies z.ZodType<${pascal}Request>;`,
    ``,
    `export function ${topicKey}Handler(`,
    `  service: ${pascal}UseCase,`,
    `  requestTopic: string,`,
    `  responseTopic: string,`,
    `): HandlerConfig<${pascal}Request, ${pascal}Result> {`,
    `  return createHandlerConfig({`,
    `    schema,`,
    `    service,`,
    `    requestTopic,`,
    `    responseTopic,`,
    `    label: "${pascal}Request",`,
    `  });`,
    `}`,
    ``,
  ].join('\n');
}

export function updateIndexTs(content, pascal, kebab, topicKey) {
  let result = content;

  const step1 = result.replace(
    `import { ContractUseCase } from "@domain/port/in/contract.port";`,
    `import { ContractUseCase } from "@domain/port/in/contract.port";\nimport { ${pascal}UseCase } from "@domain/port/in/${kebab}.port";`,
  );
  if (step1 === result) throw new Error(`updateIndexTs: ContractUseCase import 앵커를 찾지 못했습니다.`);
  result = step1;

  const step2 = result.replace(
    `import { contractHandler } from "./contract.handler";`,
    `import { contractHandler } from "./contract.handler";\nimport { ${topicKey}Handler } from "./${kebab}.handler";`,
  );
  if (step2 === result) throw new Error(`updateIndexTs: contractHandler import 앵커를 찾지 못했습니다.`);
  result = step2;

  const step3 = result.replace(
    `contractService: ContractUseCase;`,
    `contractService: ContractUseCase;\n  ${topicKey}Service: ${pascal}UseCase;`,
  );
  if (step3 === result) throw new Error(`updateIndexTs: Services 인터페이스 앵커를 찾지 못했습니다.`);
  result = step3;

  const step4 = result.replace(
    `contractHandler(services.contractService, RequestTopics.contractInquiry, ResponseTopics.contractResult)];`,
    `contractHandler(services.contractService, RequestTopics.contractInquiry, ResponseTopics.contractResult),\n    ${topicKey}Handler(services.${topicKey}Service, RequestTopics.${topicKey}, ResponseTopics.${topicKey}Result)];`,
  );
  if (step4 === result) throw new Error(`updateIndexTs: createHandlerConfigs 배열 앵커를 찾지 못했습니다.`);
  result = step4;

  return result;
}

export function solidityToTs(type) {
  if (type === 'bool') return 'boolean';
  if (type.includes('[]') || type === 'tuple') return 'unknown';
  if (
    type.startsWith('uint') || type.startsWith('int') ||
    type === 'address' || type.startsWith('bytes') || type === 'string'
  ) return 'string';
  return 'unknown';
}

export function extractPortMethods(portContent) {
  const methods = new Set();
  const regex = /^\s+(\w+)\s*\(/gm;
  let match;
  while ((match = regex.exec(portContent)) !== null) {
    methods.add(match[1]);
  }
  return methods;
}

export function diffAbiVsPort(abiFunctions, portMethods) {
  const missing = [];
  const present = [];
  for (const fn of abiFunctions) {
    if (portMethods.has(fn.name)) {
      present.push(fn);
    } else {
      missing.push(fn);
    }
  }
  return { missing, present };
}

export function generateMethodSnippet(fn) {
  const params = fn.inputs.map((i) => `${i.name || '_'}: ${solidityToTs(i.type)}`).join(', ');
  const retType = fn.outputs.length === 0
    ? 'void'
    : fn.outputs.length === 1
      ? solidityToTs(fn.outputs[0].type)
      : `[${fn.outputs.map((o) => solidityToTs(o.type)).join(', ')}]`;

  const portMethod = `  ${fn.name}(${params}): Promise<${retType}>;`;
  const adapterMethod = [
    `  async ${fn.name}(${params}): Promise<${retType}> {`,
    `    try {`,
    `      // TODO: RPC 메서드명을 확인하세요 (예: "eth_${fn.name}", "txpool_status" 등)`,
    `      const result = await this.provider.send("${fn.name}", [${fn.inputs.map((i) => i.name || '_').join(', ')}]);`,
    `      return result as ${retType};`,
    `    } catch (error) {`,
    `      const code = resolveRpcErrorCode(error);`,
    `      throw wrapInfraError(error, code);`,
    `    }`,
    `  }`,
  ].join('\n');

  return { portMethod, adapterMethod };
}

export function updateEnvTs(content, topicKey, kebab) {
  const topicName = kebab.replace(/-/g, '.');

  let result = content;

  const step1 = result.replace(
    `infraInquiry: "adapter.board.infra.request",`,
    `infraInquiry: "adapter.board.infra.request",\n        ${topicKey}: "adapter.board.${topicName}.request",`,
  );
  if (step1 === result) throw new Error(`updateEnvTs: request topics 앵커를 찾지 못했습니다.`);
  result = step1;

  const step2 = result.replace(
    `infraResult: "adapter.board.infra.result",`,
    `infraResult: "adapter.board.infra.result",\n        ${topicKey}Result: "adapter.board.${topicName}.result",`,
  );
  if (step2 === result) throw new Error(`updateEnvTs: response topics 앵커를 찾지 못했습니다.`);
  result = step2;

  return result;
}
