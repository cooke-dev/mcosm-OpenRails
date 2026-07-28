import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: {
    ...process.env,
    OPENRAILS_AGENT_KERNEL_STATE_PATH: process.env.OPENRAILS_AGENT_KERNEL_STATE_PATH ?? '/tmp/openrails-giwa-agent-kernel-smoke.json',
  },
});
const client = new Client({ name: 'openrails-giwa-smoke', version: '0.3.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name).sort();
const expected = [
  'openrails_network_info',
  'openrails_get_balance',
  'openrails_get_nonce',
  'openrails_get_paycard',
  'openrails_prepare_railsflow',
  'openrails_kernel_info',
  'openrails_prepare_workspace',
  'openrails_register_workspace',
  'openrails_prepare_workspace_command',
  'openrails_prepare_agent',
  'openrails_register_agent',
  'openrails_set_agent_status',
  'openrails_prepare_path',
  'openrails_activate_path',
  'openrails_submit_proposal',
  'openrails_run_next_job',
  'openrails_create_pact',
  'openrails_prepare_pact_signature',
  'openrails_sign_pact_record',
  'openrails_prepare_pact_railsflow',
  'openrails_bind_pact_payment',
  'openrails_record_pact_settlement',
  'openrails_install_verification_plugin',
  'openrails_submit_checkpoint',
  'openrails_verify_checkpoint',
  'openrails_open_gaia_case',
  'openrails_resolve_gaia_case',
  'openrails_list_blocked_actions',
  'openrails_export_audit_bundle',
];
for (const name of expected) if (!names.includes(name)) throw new Error(`Missing expected tool: ${name}`);
for (const name of ['pay_link', 'issue_railscard', 'create_request_link']) {
  if (names.includes(name)) throw new Error(`Unsafe legacy tool is still exposed: ${name}`);
}
const info = await client.callTool({ name: 'openrails_network_info', arguments: {} });
if (info.isError) throw new Error('openrails_network_info returned an MCP error');
const network = JSON.parse(info.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n'));
if (network.network.chainId !== 91342) throw new Error(`Unexpected chain ID: ${network.network.chainId}`);
if (network.safety.acceptsPrivateKeys !== false || network.safety.submitsTransactions !== false) throw new Error('MCP network safety boundary regressed');
const kernelInfo = await client.callTool({ name: 'openrails_kernel_info', arguments: {} });
if (kernelInfo.isError) throw new Error('openrails_kernel_info returned an MCP error');
const kernel = JSON.parse(kernelInfo.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n'));
if (kernel.safety.acceptsPrivateKeys !== false || kernel.safety.broadcasts !== false || kernel.safety.arbitraryCalldata !== false || kernel.safety.canonicalChainEvidenceRequiredForFinancialState !== true) {
  throw new Error('Agent Kernel safety boundary regressed');
}
console.log('tools:', names.length);
console.log('network:', network.network.chainName, network.network.chainId);
console.log('kernel:', kernel.mode);
console.log('smoke ok');
await client.close();
