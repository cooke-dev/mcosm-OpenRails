import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env },
});

const client = new Client({
  name: 'openrails-giwa-smoke',
  version: '0.2.0',
});

await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name).sort();

const expected = [
  'openrails_get_balance',
  'openrails_get_nonce',
  'openrails_get_paycard',
  'openrails_network_info',
  'openrails_prepare_railsflow',
].sort();

const legacy = [
  'pay_link',
  'issue_railscard',
  'create_request_link',
];

for (const name of expected) {
  if (!names.includes(name)) {
    throw new Error(`Missing expected tool: ${name}`);
  }
}

for (const name of legacy) {
  if (names.includes(name)) {
    throw new Error(`Unsafe legacy tool is still exposed: ${name}`);
  }
}

const info = await client.callTool({
  name: 'openrails_network_info',
  arguments: {},
});

if (info.isError) {
  throw new Error('openrails_network_info returned an MCP error');
}

const text = info.content
  .filter((entry) => entry.type === 'text')
  .map((entry) => entry.text)
  .join('\n');

const parsed = JSON.parse(text);

if (parsed.network.chainId !== 91342) {
  throw new Error(`Unexpected chain ID: ${parsed.network.chainId}`);
}

if (parsed.safety.acceptsPrivateKeys !== false) {
  throw new Error('MCP safety boundary does not reject private keys');
}

if (parsed.safety.submitsTransactions !== false) {
  throw new Error('MCP safety boundary permits transaction submission');
}

console.log('tools:', names.join(', '));
console.log('network:', parsed.network.chainName, parsed.network.chainId);
console.log('smoke ok');

await client.close();
