// Smoke test: spawn the built server over stdio, list tools, call read/link tools (no tx).
//
//   npm run build && OPENRAILS_MCP_SIGNER_KEY=0x... node smoke.mjs [paycardId]
//
// Signer key is optional: without it, read-only tools still work (balance shows null and
// create_request_link needs an explicit recipient).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: { ...process.env } });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n== ${name} ${JSON.stringify(args)} ==\n${r.content.map((c) => c.text).join('\n')}${r.isError ? '  [isError]' : ''}`);
}

const hasSigner = Boolean(process.env.OPENRAILS_MCP_SIGNER_KEY);
await call('openrails_config');

// Create the request link
const requestLinkResult = await client.callTool({
  name: 'create_request_link',
  arguments: hasSigner 
    ? { amount: '1000', oneTime: true } 
    : { amount: '1000', oneTime: true, recipient: '0x0000000000000000000000000000000000000001' }
});

const requestLinkText = requestLinkResult.content[0].text;
console.log('\n== Generated Request Link ==\n' + requestLinkText);

// Extract the link JSON/URL. The tool returns JSON as string.
let linkUrl = '';
try {
  const parsed = JSON.parse(requestLinkText);
  linkUrl = parsed.link;
} catch {
  // Fallback: extract link using regex if it is not formatted as pure JSON
  const match = requestLinkText.match(/https?:\/\/[^\s]+/);
  if (match) linkUrl = match[0];
}

if (hasSigner && linkUrl) {
  console.log(`\nPaying link: ${linkUrl}`);
  await call('pay_link', { link: linkUrl });
}

if (process.argv[2]) await call('paycard_status', { paycardId: process.argv[2] });

// --- issue_railscard guardrails (M2) ---------------------------------------
// These validations run before any signer is required, so they're exercised unconditionally.
async function expectError(name, args, mustInclude) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join('\n');
  console.log(`\n== ${name} ${JSON.stringify(args)} (expect error) ==\n${text}${r.isError ? '  [isError]' : ''}`);
  if (!r.isError) throw new Error(`expected ${name} to error for ${JSON.stringify(args)}`);
  if (!text.includes(mustInclude)) throw new Error(`expected error to mention "${mustInclude}", got: ${text}`);
}

// Negative: bearer mode without acknowledging the standing pull-authorization risk.
await expectError('issue_railscard', { amount: '1000' }, 'acknowledgeBearerRisk');

// Negative: amount over the MCP_MAX_AMOUNT_USDC cap (default 5 USDC = 5000000 base units).
await expectError(
  'issue_railscard',
  { amount: '10000000', acknowledgeBearerRisk: true },
  'exceeds the configured per-call cap',
);

// Negative: streaming request links must not silently encode zero velocity or zero lifespan.
await expectError(
  'create_request_link',
  {
    amount: '1000',
    oneTime: false,
    recipient: '0x0000000000000000000000000000000000000001',
  },
  'velocityPerSecond',
);

// Positive: issue_railscard actually mints a claim link (only when a signer is configured).
if (hasSigner) {
  await call('issue_railscard', {
    amount: '1000',
    mode: 'recipient_bound',
    recipient: '0x0000000000000000000000000000000000000001',
  });
}

await client.close();
console.log('\nsmoke ok');
process.exit(0);
