import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JsonRpcProvider, formatEther, formatUnits, Contract, FetchRequest } from "ethers";
import { z } from "zod";

const rpcUrl = process.env.EVM_RPC_URL || "http://localhost:8545";
const timeout = parseInt(process.env.RPC_TIMEOUT_MS || "10000", 10);

function getProvider(url) {
  const req = new FetchRequest(url || rpcUrl);
  req.timeout = timeout;
  return new JsonRpcProvider(req);
}

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const server = new McpServer({ name: "evm-mcp", version: "1.0.0" });

// 네이티브 잔액 조회
server.tool(
  "evm_balance",
  "주소의 네이티브 토큰 잔액 조회",
  {
    address: z.string().describe("지갑 주소"),
    rpc_url: z.string().optional().describe("RPC URL (기본: 환경변수)"),
  },
  async ({ address, rpc_url }) => {
    try {
      const provider = getProvider(rpc_url);
      const balance = await provider.getBalance(address);
      const network = await provider.getNetwork();
      return {
        content: [{ type: "text", text: `## ${address}\n- **잔액**: ${formatEther(balance)} ETH\n- **chain**: ${network.name} (chainId: ${network.chainId})` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// ERC20 토큰 잔액 조회
server.tool(
  "evm_token_balance",
  "ERC20 토큰 잔액 조회",
  {
    address: z.string().describe("지갑 주소"),
    token: z.string().describe("토큰 컨트랙트 주소"),
    rpc_url: z.string().optional().describe("RPC URL (기본: 환경변수)"),
  },
  async ({ address, token, rpc_url }) => {
    try {
      const provider = getProvider(rpc_url);
      const contract = new Contract(token, ERC20_ABI, provider);
      const [balance, decimals, symbol, name] = await Promise.all([
        contract.balanceOf(address),
        contract.decimals(),
        contract.symbol(),
        contract.name(),
      ]);
      return {
        content: [{
          type: "text",
          text: `## ${address}\n- **토큰**: ${name} (${symbol})\n- **잔액**: ${formatUnits(balance, decimals)} ${symbol}\n- **컨트랙트**: ${token}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// 트랜잭션 조회
server.tool(
  "evm_tx",
  "트랜잭션 해시로 트랜잭션 정보 및 영수증 조회",
  {
    tx_hash: z.string().describe("트랜잭션 해시"),
    rpc_url: z.string().optional().describe("RPC URL (기본: 환경변수)"),
  },
  async ({ tx_hash, rpc_url }) => {
    try {
      const provider = getProvider(rpc_url);
      const [tx, receipt] = await Promise.all([
        provider.getTransaction(tx_hash),
        provider.getTransactionReceipt(tx_hash),
      ]);

      if (!tx) {
        return { content: [{ type: "text", text: `트랜잭션 '${tx_hash}' 없음` }] };
      }

      const lines = [
        `## Transaction`,
        `- **hash**: ${tx.hash}`,
        `- **from**: ${tx.from}`,
        `- **to**: ${tx.to}`,
        `- **value**: ${formatEther(tx.value)} ETH`,
        `- **nonce**: ${tx.nonce}`,
        `- **gasLimit**: ${tx.gasLimit.toString()}`,
        `- **block**: ${tx.blockNumber ?? "pending"}`,
      ];

      if (receipt) {
        lines.push(
          `\n## Receipt`,
          `- **status**: ${receipt.status === 1 ? "SUCCESS" : "FAILED"}`,
          `- **gasUsed**: ${receipt.gasUsed.toString()}`,
          `- **logs**: ${receipt.logs.length}개`,
        );
      } else {
        lines.push(`\n## Receipt\n아직 confirm 되지 않음 (pending)`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// Nonce 조회
server.tool(
  "evm_nonce",
  "주소의 현재 nonce 조회 (pending 포함)",
  {
    address: z.string().describe("지갑 주소"),
    rpc_url: z.string().optional().describe("RPC URL (기본: 환경변수)"),
  },
  async ({ address, rpc_url }) => {
    try {
      const provider = getProvider(rpc_url);
      const [latest, pending] = await Promise.all([
        provider.getTransactionCount(address, "latest"),
        provider.getTransactionCount(address, "pending"),
      ]);
      return {
        content: [{
          type: "text",
          text: `## ${address}\n- **latest nonce**: ${latest}\n- **pending nonce**: ${pending}${pending > latest ? ` (${pending - latest}건 pending)` : ""}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// 블록 정보 조회
server.tool(
  "evm_block",
  "블록 번호 또는 'latest'로 블록 정보 조회",
  {
    block: z.string().default("latest").describe("블록 번호 또는 'latest'"),
    rpc_url: z.string().optional().describe("RPC URL (기본: 환경변수)"),
  },
  async ({ block, rpc_url }) => {
    try {
      const provider = getProvider(rpc_url);
      const blockTag = block === "latest" ? "latest" : parseInt(block, 10);
      const b = await provider.getBlock(blockTag);
      if (!b) {
        return { content: [{ type: "text", text: `블록 '${block}' 없음` }] };
      }
      const time = new Date(b.timestamp * 1000).toISOString();
      return {
        content: [{
          type: "text",
          text: `## Block #${b.number}\n- **hash**: ${b.hash}\n- **timestamp**: ${time}\n- **transactions**: ${b.transactions.length}건\n- **gasUsed**: ${b.gasUsed.toString()}\n- **gasLimit**: ${b.gasLimit.toString()}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

// 체인 정보
server.tool(
  "evm_chain_info",
  "연결된 체인 정보 및 최신 블록 번호 조회",
  {
    rpc_url: z.string().optional().describe("RPC URL (기본: 환경변수)"),
  },
  async ({ rpc_url }) => {
    try {
      const provider = getProvider(rpc_url);
      const [network, blockNumber] = await Promise.all([
        provider.getNetwork(),
        provider.getBlockNumber(),
      ]);
      return {
        content: [{
          type: "text",
          text: `## Chain Info\n- **name**: ${network.name}\n- **chainId**: ${network.chainId}\n- **latest block**: ${blockNumber}\n- **rpc**: ${rpc_url || rpcUrl}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
