#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildContext } from './context.js';
import {
  getBalance,
  getNonce,
  getPaycard,
  networkInfo,
  prepareRailsFlow,
  type PrepareRailsFlowArgs,
} from './tools.js';

const ctx = buildContext();

const server = new McpServer(
  {
    name: 'openrails-giwa',
    version: '0.2.0',
  },
  {
    instructions:
      'Inspect the canonical OpenRails GIWA Sepolia deployment and prepare unsigned bounded RailsFlow intents. This server accepts no private keys, signs nothing, and submits no transactions.',
  },
);

type ToolResult = {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function fail(error: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          error instanceof Error
            ? error.message
            : String(error),
      },
    ],
    isError: true,
  };
}

async function run(
  operation: () => Promise<unknown>,
): Promise<ToolResult> {
  try {
    return ok(await operation());
  } catch (error) {
    return fail(error);
  }
}

const registerTool =
  server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      description?: string;
      inputSchema: Record<string, unknown>;
    },
    handler: (...args: any[]) => unknown,
  ) => unknown;

registerTool(
  'openrails_network_info',
  {
    description:
      'Return canonical OpenRails GIWA Sepolia network, deployment, RPC, token, explorer, and safety information.',
    inputSchema: {},
  },
  async () => run(() => networkInfo(ctx)),
);

registerTool(
  'openrails_get_balance',
  {
    description:
      'Read an address orUSD balance from the canonical GIWA Sepolia token contract.',
    inputSchema: {
      address: z.string().describe('EVM address to inspect.'),
    },
  },
  async (args: { address: string }) =>
    run(() => getBalance(ctx, args)),
);

registerTool(
  'openrails_get_nonce',
  {
    description:
      'Read the current OpenRails nonce for a payer and nonce channel.',
    inputSchema: {
      payerAddress: z.string().describe('Payer EVM address.'),
      nonceChannel: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Nonce channel. Defaults to 0.'),
    },
  },
  async (args: {
    payerAddress: string;
    nonceChannel?: number;
  }) => run(() => getNonce(ctx, args)),
);

registerTool(
  'openrails_get_paycard',
  {
    description:
      'Read canonical OpenRails paycard or stream state by bytes32 paycard ID.',
    inputSchema: {
      paycardId: z.string().describe('bytes32 OpenRails paycard ID.'),
    },
  },
  async (args: { paycardId: string }) =>
    run(() => getPaycard(ctx, args)),
);

registerTool(
  'openrails_prepare_railsflow',
  {
    description:
      'Prepare unsigned bounded RailsFlow metadata, paycard ID, intent, EIP-712 typed data, approval requirement, and projected economics. Never signs or submits.',
    inputSchema: {
      payerAddress: z.string().describe('External payer wallet address.'),
      recipientAddress: z.string().describe('Fixed payment recipient address.'),
      totalAllocationBaseUnits: z
        .string()
        .regex(/^[0-9]+$/)
        .describe('Total orUSD allocation in 6-decimal base units.'),
      flowVelocityBaseUnitsPerSecond: z
        .string()
        .regex(/^[0-9]+$/)
        .describe('orUSD base units streamed per second.'),
      lifespanSeconds: z
        .number()
        .int()
        .positive()
        .max(31_536_000)
        .describe('Stream duration in seconds, up to one year.'),
      nonceChannel: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Nonce channel. Defaults to 0.'),
      residualDeltaRecipient: z
        .string()
        .optional()
        .describe('Unused-funds recipient. Defaults to payer.'),
      workflowId: z
        .string()
        .max(128)
        .optional(),
      metadataRef: z
        .string()
        .max(256)
        .optional(),
      salt: z
        .string()
        .max(256)
        .optional(),
    },
  },
  async (args: PrepareRailsFlowArgs) =>
    run(() => prepareRailsFlow(ctx, args)),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    'openrails-giwa ready · read-and-prepare · no signer · no transaction submission',
  );
}

main().catch((error: unknown) => {
  console.error('openrails-giwa failed to start:', error);
  process.exit(1);
});
