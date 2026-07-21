#!/usr/bin/env node
/**
 * OpenRails MCP server (stdio).
 *
 * Exposes the Arc USDC rail to agents as tools: read config, pay a link (RailsFlow request or
 * RailsCard claim), create a request link, issue a RailsCard, and read paycard state. Opens and
 * claims are gasless by default (routed through the keeper relay); the server signs with its own
 * configured account and is non-custodial.
 *
 * Configure via env (see README): OPENRAILS_MCP_SIGNER_KEY (dev signer), OPENRAILS_RPC_URL,
 * OPENRAILS_HUB_ADDRESS, OPENRAILS_RELAY_URL, OPENRAILS_APP_BASE_URL, …
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildContext } from './context.js';
import {
  openrailsConfig,
  payLink,
  createRequestLink,
  issueRailscard,
  paycardStatus,
} from './tools.js';

const ctx = buildContext();
const server = new McpServer({ name: 'openrails-mcp', version: '0.1.1' });
server.server.onerror = (err) => {
  console.error('openrails-mcp protocol error:', err);
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Wrap a tool handler: JSON-stringify success, surface errors as MCP tool errors. */
function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function fail(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
}
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

server.registerTool(
  'openrails_config',
  {
    description: 'Show the OpenRails network config, the server signer address, and its USDC balance. No side effects.',
    inputSchema: {},
  },
  async () => run(() => openrailsConfig(ctx)),
);

server.registerTool(
  'pay_link',
  {
    description:
      'Pay an OpenRails link. A RailsFlow request → the server pays it (gasless open, signer becomes payer, subject to the MCP_MAX_AMOUNT_USDC per-call cap). A RailsCard link → the server claims it to the signer address (uncapped - claiming spends the original payer\'s pre-authorized funds, not the caller\'s). Identical retries within a few minutes replay the cached result instead of signing a second authorization. Returns the tx hash.',
    inputSchema: { link: z.string().describe('An OpenRails link URL or raw #or= token (RailsFlow request or RailsCard).') },
  },
  async ({ link }) => run(() => payLink(ctx, { link })),
);

server.registerTool(
  'create_request_link',
  {
    description: 'Create a RailsFlow request link to RECEIVE payment. Share the link; the payer opens and funds it. No signing/tx.',
    inputSchema: {
      amount: z.string().describe('Amount in USDC base units (6dp), e.g. "3000" = 0.003 USDC.'),
      recipient: z.string().optional().describe('Address to receive funds (defaults to the server signer).'),
      oneTime: z.boolean().optional().describe('true/omitted = paid in full once; false = streaming and requires velocity/lifespan.'),
      velocityPerSecond: z.string().optional().describe('Required when oneTime is false. USDC base units per second.'),
      lifespanSeconds: z.number().optional().describe('Required when oneTime is false. Duration in seconds.'),
    },
  },
  async (args) => run(() => createRequestLink(ctx, args)),
);

server.registerTool(
  'issue_railscard',
  {
    description:
      'Issue a claimable RailsCard link (the server is the payer, pre-signs the intent). Returns a claim link and paycardId. Escrow is pulled from the payer on claim. Amount is subject to the MCP_MAX_AMOUNT_USDC per-call cap. Identical retries within a few minutes replay the cached result instead of signing a second standing authorization. mode "bearer" (default) is a standing, anyone-with-the-link pull-authorization - first claimant wins, no recipient check - and REQUIRES acknowledgeBearerRisk: true; prefer recipient_bound when the claimant is known.',
    inputSchema: {
      amount: z.string().describe('Amount in USDC base units (6dp).'),
      mode: z.enum(['bearer', 'recipient_bound']).optional().describe('bearer = anyone with the link claims (default, requires acknowledgeBearerRisk: true); recipient_bound = fixed recipient.'),
      recipient: z.string().optional().describe('Required for recipient_bound.'),
      oneTime: z.boolean().optional().describe('true (default) = full amount once; false = streaming.'),
      velocityPerSecond: z.string().optional(),
      lifespanSeconds: z.number().optional(),
      acknowledgeBearerRisk: z.boolean().optional().describe('Required (true) when mode is "bearer" (or omitted): confirms you intend a standing, anyone-can-claim authorization.'),
    },
  },
  async (args) => run(() => issueRailscard(ctx, args)),
);

server.registerTool(
  'paycard_status',
  {
    description: 'Read a paycard (stream/card) state from chain by paycardId: payer, recipient, balance, status, type.',
    inputSchema: { paycardId: z.string().describe('bytes32 paycard id.') },
  },
  async ({ paycardId }) => run(() => paycardStatus(ctx, { paycardId })),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  process.stdin.resume();
  await server.connect(transport);
  setInterval(() => undefined, 60_000);
  // stderr is safe for logs (stdout is the MCP channel).
  console.error(`openrails-mcp ready · ${ctx.config.networkMode} · signer ${ctx.signerAddress ?? '(read-only)'}`);
}

main().catch((err) => {
  console.error('openrails-mcp failed to start:', err);
  process.exit(1);
});
