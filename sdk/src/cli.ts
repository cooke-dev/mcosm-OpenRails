#!/usr/bin/env node
import { ethers } from 'ethers';

import {
  type OpenRailsIntentV1,
  LeptonOpenRailsClient,
  inferEnvelopeModeFromIntent,
} from './client';
import type { OpenRailsEnvelopeMode } from './metadata';
import {
  createOpenRailsLinkUrl,
  parseOpenRailsLink,
  type OpenRailsLinkArtifactV1,
  type RailsFlowLinkPayloadV1,
} from './links';
import {
  approveOpenRailsSpend,
  assertOpenRailsNetwork,
  recoverPaycardsFromLogs,
  readPaycard,
  readNonce,
  readTokenAllowance,
  readTokenBalance,
  submitOpenPaycardWithSigner,
  submitFlushWithSigner,
  submitSettleWithSigner,
} from './wallet';

type FlagValue = string | boolean;
type FlagMap = Record<string, FlagValue>;

export interface ParsedOpenRailsCliArgs {
  command?: string;
  flags: FlagMap;
  positionals: string[];
}

export interface OpenRailsCliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

const COMMANDS = [
  'request-stream',
  'pay-stream',
  'stream-status',
  'recover',
  'settle',
  'close',
] as const;

const PRIVATE_KEY_ARG_NAMES = new Set([
  'private-key',
  'payer-private-key',
  'signer-private-key',
  'mnemonic',
  'seed',
  'seed-phrase',
]);

const DEFAULT_SIGNER_ENV = 'OPENRAILS_PAYER_PRIVATE_KEY';
const LEGACY_SIGNER_ENV = 'OPENRAILS_PRIVATE_KEY';
const DEFAULT_APP_BASE_URL = 'https://openrails.local';

export function parseOpenRailsCliArgs(argv: string[]): ParsedOpenRailsCliArgs {
  const flags: FlagMap = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const withoutPrefix = arg.slice(2);
      const equalsIndex = withoutPrefix.indexOf('=');
      const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
      if (!name) throw new Error('Empty flag name is not allowed');
      assertNoPrivateKeyArgName(name);

      if (equalsIndex >= 0) {
        flags[name] = withoutPrefix.slice(equalsIndex + 1);
      } else if (argv[index + 1] && !argv[index + 1].startsWith('-')) {
        flags[name] = argv[index + 1];
        index += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }

    if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, flags, positionals };
}

export async function runOpenRailsCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: OpenRailsCliIo = {},
): Promise<number> {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));

  try {
    const parsed = parseOpenRailsCliArgs(argv);
    if (!parsed.command || parsed.flags.help === true || parsed.flags.h === true) {
      writeOut(renderHelp(parsed.command));
      return 0;
    }

    if (!COMMANDS.includes(parsed.command as typeof COMMANDS[number])) {
      throw new Error(`Unknown OpenRails command: ${parsed.command}`);
    }

    const result = await runCommand(parsed, env);
    writeOut(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    writeErr(String((err as Error).message ?? err));
    return 1;
  }
}

async function runCommand(
  parsed: ParsedOpenRailsCliArgs,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  switch (parsed.command) {
    case 'request-stream':
      return handleRequestStream(parsed.flags, env);
    case 'pay-stream':
      return handlePayStream(parsed.flags, env);
    case 'stream-status':
      return handleStreamStatus(parsed.flags, env);
    case 'recover':
      return handleRecover(parsed.flags, env);
    case 'settle':
      return handleSettle(parsed.flags, env);
    case 'close':
      return handleClose(parsed.flags, env);
    default:
      throw new Error(`Unknown OpenRails command: ${parsed.command}`);
  }
}

function handleRequestStream(flags: FlagMap, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const chainId = readChainId(flags, env);
  const hub = readHubAddress(flags, env);
  const token = readTokenAddress(flags, env);
  const metadataHash = readBytes32Flag(flags, 'metadata-hash');
  const merchant = readAddressFlag(flags, 'merchant');
  const recipient = readAddressFlag(flags, 'recipient');
  const payload: RailsFlowLinkPayloadV1 = {
    mode: 'railsflow',
    merchant,
    recipient,
    amount: readStringFlag(flags, 'amount'),
    flowVelocityPerSecond: readStringFlag(flags, 'flow-velocity-per-second'),
    lifespanSeconds: readIntegerFlag(flags, 'lifespan-seconds'),
    workflowId: readOptionalStringFlag(flags, 'workflow-id'),
    metadataRef: readOptionalStringFlag(flags, 'metadata-ref'),
    descriptionHash: readOptionalBytes32Flag(flags, 'description-hash'),
    expiresAt: readOptionalIntegerFlag(flags, 'expires-at'),
  };
  const artifact: OpenRailsLinkArtifactV1 = {
    version: 'openrails-link-v1',
    kind: 'railsflow',
    chainId,
    vault: hub,
    token,
    metadataHash,
    payload,
  };
  const link = createOpenRailsLinkUrl(readAppBaseUrl(flags), artifact);
  const execute = hasExecute(flags);

  return {
    command: 'request-stream',
    dryRun: !execute,
    action: execute ? 'request_stream_link_created' : 'request_stream_link_preview',
    link,
    artifact,
  };
}

async function handlePayStream(
  flags: FlagMap,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const requestLink = readOptionalStringFlag(flags, 'request-link');
  const requestArtifact = requestLink ? parseRailsFlowRequestLink(requestLink) : undefined;
  const chainId = requestArtifact?.chainId ?? readChainId(flags, env);
  const hub = requestArtifact?.vault ?? readHubAddress(flags, env);
  const token = requestArtifact?.token ?? readTokenAddress(flags, env);
  const requestPayload = requestArtifact?.payload as RailsFlowLinkPayloadV1 | undefined;
  const execute = hasExecute(flags);
  const signOnly = flags['sign-only'] === true;
  const willSign = execute || signOnly;
  const mode = readOptionalModeFlag(flags, 'mode');

  // Fields the SDK/cockpit normally auto-compute — derived here when omitted so a bare
  // `pay-stream --request-link … --execute` just works. Explicit flags always take precedence.
  const paycardId =
    readOptionalBytes32Flag(flags, 'paycard-id') ?? ethers.hexlify(ethers.randomBytes(32));
  const metadataHash =
    requestArtifact?.metadataHash ??
    readOptionalBytes32Flag(flags, 'metadata-hash') ??
    ethers.keccak256(
      ethers.toUtf8Bytes(readOptionalStringFlag(flags, 'metadata-ref') ?? `openrails:${paycardId}`),
    );
  const recipient = readAddressFlag(flags, 'recipient', requestPayload?.recipient);
  const nonceChannel = readOptionalIntegerFlag(flags, 'nonce-channel') ?? 0;
  let nonceValue = readOptionalIntegerFlag(flags, 'nonce-value');
  let residual = readOptionalAddressFlag(flags, 'residual-delta-recipient');

  // When we'll sign, resolve the payer from the key; auto-read the on-chain nonce lane and
  // default the residual recipient to the payer if the caller omitted them.
  let provider: ethers.JsonRpcProvider | undefined;
  let signer: ethers.Wallet | undefined;
  let payerAddress: string | undefined;
  let currentNonce: number | undefined;
  if (willSign) {
    signer = makeSigner(flags, env);
    payerAddress = await signer.getAddress();
    if (residual === undefined) residual = payerAddress;
    if (nonceValue === undefined) {
      provider = makeProvider(flags, env);
      currentNonce = await readNonce(provider, hub, payerAddress, nonceChannel);
      nonceValue = currentNonce;
    }
  }

  const intent: OpenRailsIntentV1 = {
    paycardId,
    metadataHash,
    recipient,
    totalAllocationPool: readStringFlag(flags, 'total-allocation-pool', requestPayload?.amount),
    flowVelocityPerSecond: readStringFlag(
      flags,
      'flow-velocity-per-second',
      requestPayload?.flowVelocityPerSecond,
    ),
    genesisTimestamp: readOptionalIntegerFlag(flags, 'genesis-timestamp') ?? nowSeconds(),
    lifespanSeconds: readIntegerFlag(flags, 'lifespan-seconds', requestPayload?.lifespanSeconds),
    residualDeltaRecipient: residual ?? recipient,
    nonceChannel,
    nonceValue: nonceValue ?? 0,
  };
  const resolvedMode = mode ?? inferEnvelopeModeFromIntent(intent);

  const baseResult: Record<string, unknown> = {
    command: 'pay-stream',
    dryRun: !execute,
    action: execute ? 'signed_stream_permission' : 'sign_stream_permission_preview',
    chainId,
    hub,
    token,
    intent,
    mode: resolvedMode,
  };

  if (!execute && !signOnly) return baseResult;

  const privateKey = readPrivateKeyFromEnv(flags, env);
  const client = new LeptonOpenRailsClient(privateKey, hub, chainId);
  const envelopeToken = await client.signPermissionEnvelope(intent, { mode: resolvedMode });
  const signedKind = resolvedMode === 'railsflow' ? 'railsflow' : 'railscard';
  const artifact: OpenRailsLinkArtifactV1 = {
    version: 'openrails-link-v1',
    kind: signedKind,
    chainId,
    vault: hub,
    token,
    metadataHash: intent.metadataHash,
    payload: {
      mode: resolvedMode,
      envelopeToken,
    },
  };

  const signedResult = {
    ...baseResult,
    dryRun: !execute,
    action: execute ? 'submit_open_stream_transaction' : 'signed_stream_permission',
    payerAddress: client.getAddress(),
    envelopeToken,
    link: createOpenRailsLinkUrl(readAppBaseUrl(flags), artifact),
  };
  if (!execute) return signedResult;

  if (provider === undefined) provider = makeProvider(flags, env);
  await assertOpenRailsNetwork(provider, chainId);
  if (signer === undefined) signer = makeSigner(flags, env);
  if (payerAddress === undefined) payerAddress = await signer.getAddress();
  const allocation = BigInt(intent.totalAllocationPool);
  if (currentNonce === undefined) {
    currentNonce = await readNonce(provider, hub, payerAddress, intent.nonceChannel);
  }
  assertExactNonceBeforeApproval(intent.nonceValue, currentNonce);
  const balance = await readTokenBalance(provider, token, payerAddress);
  if (balance < allocation) {
    throw new Error(`Insufficient token balance: need ${allocation.toString()}, have ${balance.toString()}`);
  }
  let allowance = await readTokenAllowance(provider, token, payerAddress, hub);
  let approvalHash: string | undefined;
  if (allowance < allocation) {
    if (flags.approve !== true) {
      throw new Error(`Insufficient token allowance: need ${allocation.toString()}, have ${allowance.toString()}; rerun with --approve --execute to approve bounded spend`);
    }
    const approvalTx = await approveOpenRailsSpend(signer, token, hub, allocation);
    approvalHash = approvalTx.hash;
    await approvalTx.wait();
    allowance = await readTokenAllowance(provider, token, payerAddress, hub);
    if (allowance < allocation) {
      throw new Error(`Allowance still insufficient after approval: need ${allocation.toString()}, have ${allowance.toString()}`);
    }
  }
  const tx = await submitOpenPaycardWithSigner(
    signer,
    hub,
    envelopeToken,
    resolvedMode,
    readOptionalAddressFlag(flags, 'claim-recipient'),
  );
  return {
    ...signedResult,
    approvalHash,
    currentNonce,
    transactionHash: tx.hash,
  };
}

async function handleStreamStatus(
  flags: FlagMap,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const hub = readHubAddress(flags, env);
  const paycardId = readBytes32Flag(flags, 'paycard-id');
  const dryRun = flags['dry-run'] === true;
  const baseResult = {
    command: 'stream-status',
    dryRun,
    action: dryRun ? 'read_stream_status_preview' : 'read_stream_status',
    hub,
    paycardId,
  };
  if (dryRun) return baseResult;

  const provider = makeProvider(flags, env);
  const status = await readPaycard(provider, hub, paycardId);
  return { ...baseResult, status };
}

async function handleRecover(
  flags: FlagMap,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const hub = readHubAddress(flags, env);
  const payer = readOptionalAddressFlag(flags, 'payer');
  const recipient = readOptionalAddressFlag(flags, 'recipient');
  if (!payer && !recipient) throw new Error('recover requires --payer or --recipient');

  const dryRun = flags['dry-run'] === true;
  const options = {
    payer,
    recipient,
    metadataHash: readOptionalBytes32Flag(flags, 'metadata-hash'),
    fromBlock: readOptionalIntegerFlag(flags, 'from-block'),
    toBlock: readOptionalIntegerFlag(flags, 'to-block'),
    limit: readOptionalIntegerFlag(flags, 'limit'),
    chunkSize: readOptionalIntegerFlag(flags, 'chunk-size'),
  };
  const baseResult = {
    command: 'recover',
    dryRun,
    action: dryRun ? 'recover_streams_from_logs_preview' : 'recover_streams_from_logs',
    hub,
    options,
  };
  if (dryRun) return baseResult;

  const provider = makeProvider(flags, env);
  const recovered = await recoverPaycardsFromLogs(provider, hub, options);
  return { ...baseResult, recovered };
}

async function handleSettle(
  flags: FlagMap,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const hub = readHubAddress(flags, env);
  const paycardId = readBytes32Flag(flags, 'paycard-id');
  const execute = hasExecute(flags);
  const baseResult = {
    command: 'settle',
    dryRun: !execute,
    action: execute ? 'submit_settlement_transaction' : 'submit_settlement_transaction_preview',
    hub,
    paycardId,
  };
  if (!execute) return baseResult;

  const chainId = readChainId(flags, env);
  const provider = makeProvider(flags, env);
  await assertOpenRailsNetwork(provider, chainId);
  const signer = makeSigner(flags, env);
  const tx = await submitSettleWithSigner(signer, hub, paycardId);
  return { ...baseResult, transactionHash: tx.hash };
}

async function handleClose(
  flags: FlagMap,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const hub = readHubAddress(flags, env);
  const paycardId = readBytes32Flag(flags, 'paycard-id');
  const execute = hasExecute(flags);
  const confirmed = flags['ack-irrevocable-close'] === true || flags['confirm-close'] === true;
  const baseResult = {
    command: 'close',
    dryRun: !execute,
    action: execute ? 'submit_close_transaction' : 'submit_close_transaction_preview',
    hub,
    paycardId,
    closeGate: confirmed ? 'confirmed' : 'requires --ack-irrevocable-close with --execute',
  };
  if (!execute) return baseResult;
  if (!confirmed) {
    throw new Error('close requires --ack-irrevocable-close when --execute is set');
  }

  const chainId = readChainId(flags, env);
  const provider = makeProvider(flags, env);
  await assertOpenRailsNetwork(provider, chainId);
  const signer = makeSigner(flags, env);
  const signerAddress = ethers.getAddress(await signer.getAddress());
  const status = await readPaycard(provider, hub, paycardId);
  if (
    ethers.getAddress(status.payer) !== signerAddress &&
    ethers.getAddress(status.recipient) !== signerAddress
  ) {
    throw new Error('close signer must be the stream payer or recipient');
  }
  const tx = await submitFlushWithSigner(signer, hub, paycardId);
  return { ...baseResult, signerAddress, status, transactionHash: tx.hash };
}

function parseRailsFlowRequestLink(link: string): OpenRailsLinkArtifactV1 {
  const artifact = parseOpenRailsLink(link);
  if (artifact.kind !== 'railsflow' || 'envelopeToken' in artifact.payload) {
    throw new Error('--request-link must be an unsigned RailsFlow request link');
  }
  return artifact;
}

function hasExecute(flags: FlagMap): boolean {
  return flags.execute === true;
}

function makeProvider(flags: FlagMap, env: NodeJS.ProcessEnv): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(readRpcUrl(flags, env));
}

function makeSigner(flags: FlagMap, env: NodeJS.ProcessEnv): ethers.Wallet {
  return new ethers.Wallet(readPrivateKeyFromEnv(flags, env), makeProvider(flags, env));
}

function readPrivateKeyFromEnv(flags: FlagMap, env: NodeJS.ProcessEnv): string {
  const envName = readOptionalStringFlag(flags, 'signer-env') ?? DEFAULT_SIGNER_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error('--signer-env must be an environment variable name');
  }
  const value = env[envName] ?? (envName === DEFAULT_SIGNER_ENV ? env[LEGACY_SIGNER_ENV] : undefined);
  if (!value) {
    throw new Error(`Missing signer private key env var: ${envName}`);
  }
  return value;
}

// Arc testnet V2 defaults so the CLI works with just a signer key. Any of these is
// overridden by its flag or env var (precedence: flag > OPENRAILS_* env > ARC_* env > default).
const DEFAULT_RPC_URL = 'https://rpc.testnet.arc.network';
const DEFAULT_CHAIN_ID = '5042002';
const DEFAULT_HUB_ADDRESS = '0x941C8029F0f912df3fAb7423890ab2359b996D0b'; // V2 canonical hub
const DEFAULT_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';

function readRpcUrl(flags: FlagMap, env: NodeJS.ProcessEnv): string {
  return readOptionalStringFlag(flags, 'rpc-url') ??
    env.OPENRAILS_RPC_URL ??
    env.ARC_RPC_URL ??
    DEFAULT_RPC_URL;
}

function readChainId(flags: FlagMap, env: NodeJS.ProcessEnv): number {
  const value = readOptionalStringFlag(flags, 'chain-id') ?? env.OPENRAILS_CHAIN_ID ?? env.ARC_CHAIN_ID ?? DEFAULT_CHAIN_ID;
  return parseInteger(String(value), 'chain-id');
}

function readHubAddress(flags: FlagMap, env: NodeJS.ProcessEnv): string {
  return normalizeAddress(
    readOptionalStringFlag(flags, 'hub') ??
      readOptionalStringFlag(flags, 'vault') ??
      env.OPENRAILS_HUB_ADDRESS ??
      env.OPENRAILS_CLEARINGHOUSE_ADDRESS ??
      DEFAULT_HUB_ADDRESS,
    'hub',
  );
}

function readTokenAddress(flags: FlagMap, env: NodeJS.ProcessEnv): string {
  return normalizeAddress(
    readOptionalStringFlag(flags, 'token') ??
      readOptionalStringFlag(flags, 'usdc') ??
      env.OPENRAILS_USDC_ADDRESS ??
      env.ARC_USDC_ADDRESS ??
      DEFAULT_USDC_ADDRESS,
    'token',
  );
}

function readAppBaseUrl(flags: FlagMap): string {
  return readOptionalStringFlag(flags, 'app-base-url') ?? DEFAULT_APP_BASE_URL;
}

function readStringFlag(flags: FlagMap, name: string, fallback?: string | number): string {
  const value = readOptionalStringFlag(flags, name) ?? (fallback === undefined ? undefined : String(fallback));
  if (value === undefined || value.length === 0) missing(`--${name}`);
  return value;
}

function readOptionalStringFlag(flags: FlagMap, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} requires a value`);
  return String(value);
}

function readIntegerFlag(flags: FlagMap, name: string, fallback?: number): number {
  const value = readOptionalStringFlag(flags, name) ?? (fallback === undefined ? undefined : String(fallback));
  if (value === undefined) missing(`--${name}`);
  return parseInteger(value, name);
}

function readOptionalIntegerFlag(flags: FlagMap, name: string): number | undefined {
  const value = readOptionalStringFlag(flags, name);
  return value === undefined ? undefined : parseInteger(value, name);
}

function readAddressFlag(flags: FlagMap, name: string, fallback?: string): string {
  return normalizeAddress(readStringFlag(flags, name, fallback), name);
}

function readOptionalAddressFlag(flags: FlagMap, name: string): string | undefined {
  const value = readOptionalStringFlag(flags, name);
  return value === undefined ? undefined : normalizeAddress(value, name);
}

function readBytes32Flag(flags: FlagMap, name: string): string {
  return normalizeBytes32(readStringFlag(flags, name), name);
}

function readOptionalBytes32Flag(flags: FlagMap, name: string): string | undefined {
  const value = readOptionalStringFlag(flags, name);
  return value === undefined ? undefined : normalizeBytes32(value, name);
}

function readOptionalModeFlag(flags: FlagMap, name: string): OpenRailsEnvelopeMode | undefined {
  const value = readOptionalStringFlag(flags, name);
  if (value === undefined) return undefined;
  if (
    value !== 'railsflow' &&
    value !== 'railscard_bearer' &&
    value !== 'railscard_recipient_bound'
  ) {
    throw new Error(`--${name} must be railsflow, railscard_bearer, or railscard_recipient_bound`);
  }
  return value;
}

function normalizeAddress(value: string, name: string): string {
  if (!ethers.isAddress(value)) {
    throw new Error(`--${name} must be an EVM address`);
  }
  return ethers.getAddress(value);
}

function normalizeBytes32(value: string, name: string): string {
  if (!ethers.isHexString(value, 32)) {
    throw new Error(`--${name} must be a bytes32 hex string`);
  }
  return value;
}

function parseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function assertNoPrivateKeyArgName(name: string): void {
  const normalized = name.toLowerCase();
  if (
    PRIVATE_KEY_ARG_NAMES.has(normalized) ||
    normalized.includes('private-key') ||
    normalized.includes('mnemonic') ||
    normalized.includes('seed-phrase')
  ) {
    throw new Error('Private keys must not be passed on argv; use an env var and --signer-env instead');
  }
}

export function assertExactNonceBeforeApproval(intentNonce: number, currentNonce: number): void {
  if (intentNonce !== currentNonce) {
    throw new Error(`--nonce-value must equal current nonce ${currentNonce}, got ${intentNonce}`);
  }
}

function missing(name: string): never {
  throw new Error(`Missing required ${name}`);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const COMMAND_HELP: Record<typeof COMMANDS[number], string> = {
  'request-stream': [
    'openrails request-stream — build an unsigned RailsFlow request link (no transaction, no key needed).',
    '',
    'Required:',
    '  --merchant <address>              Who the request is billed as coming from',
    '  --recipient <address>             Who gets paid when the request is paid',
    '  --amount <base-units>             Total allocation pool, USDC 6dp base units',
    '  --flow-velocity-per-second <n>    Streaming rate, USDC 6dp base units per second',
    '  --lifespan-seconds <n>            Stream duration in seconds',
    '  --metadata-hash <bytes32>         keccak256 of your off-chain invoice/terms',
    '',
    'Optional:',
    '  --workflow-id <string>            Group requests under one workflow',
    '  --metadata-ref <string>           Free-form reference stored alongside the hash',
    '  --description-hash <bytes32>      Extra binding hash for a longer description',
    '  --expires-at <unix-seconds>       Link expiry',
    '  --app-base-url <url>              Base URL the link is built against (default https://openrails.local)',
    '  --hub / --token / --chain-id      Override network defaults (Arc testnet V2 by default)',
    '  --execute                         No-op here (request-stream never transacts) — present for symmetry',
  ].join('\n'),
  'pay-stream': [
    'openrails pay-stream — sign, and optionally open, a Paycard Stream. Dry-run by default.',
    '',
    'Either:',
    '  --request-link <link>             A RailsFlow link from request-stream (auto-fills recipient/amount/etc.)',
    'Or the raw terms:',
    '  --recipient <address>             Who gets paid',
    '  --total-allocation-pool <n>       Allocation pool, USDC 6dp base units',
    '  --flow-velocity-per-second <n>    Streaming rate (0 for one-time)',
    '  --lifespan-seconds <n>            Stream duration in seconds (0 = instant/one-time)',
    '',
    'Modes:',
    '  (no flag)                         Preview only — computes and prints the intent, signs nothing',
    '  --sign-only                       Sign the envelope, print the link/token, do not submit a tx',
    '  --execute                         Sign AND submit openPaycardChannel on-chain',
    '  --approve --execute               Also approve bounded USDC spend if allowance is short',
    '',
    'Optional overrides (auto-derived when omitted):',
    '  --paycard-id <bytes32>            Defaults to a random id',
    '  --metadata-hash <bytes32>         Defaults from --metadata-ref, else a stable default',
    '  --metadata-ref <string>',
    '  --nonce-channel <n>               Defaults to 0',
    '  --nonce-value <n>                 Defaults to the current on-chain nonce for the channel',
    '  --genesis-timestamp <unix-seconds> Defaults to now',
    '  --residual-delta-recipient <address> Defaults to the payer',
    '  --claim-recipient <address>       Fixed recipient for a RailsCard open (recipient-bound)',
    '  --mode <railsflow|railscard_bearer|railscard_recipient_bound>  Defaults to inferred from the intent',
    '',
    'Keys: OPENRAILS_PAYER_PRIVATE_KEY (or --signer-env <NAME>) — never on argv.',
  ].join('\n'),
  'stream-status': [
    'openrails stream-status — read a Paycard Stream\'s on-chain registry row. Read-only.',
    '',
    'Required:',
    '  --paycard-id <bytes32>            The stream to read',
    '',
    'Optional:',
    '  --dry-run                         Print the query without hitting the RPC',
    '  --hub / --chain-id / --rpc-url    Override network defaults (Arc testnet V2 by default)',
  ].join('\n'),
  recover: [
    'openrails recover — scan PaycardProvisioned logs to recover streams for a payer/recipient. Read-only.',
    '',
    'Required (at least one of):',
    '  --payer <address>',
    '  --recipient <address>',
    '',
    'Optional:',
    '  --metadata-hash <bytes32>         Filter by exact metadata hash',
    '  --from-block <n>  --to-block <n> Bound the log-scan window',
    '  --limit <n>                       Max results',
    '  --chunk-size <n>                  Log-scan chunk size per RPC call',
    '  --dry-run                         Print the query without hitting the RPC',
    '  --hub / --rpc-url                 Override network defaults (Arc testnet V2 by default)',
  ].join('\n'),
  settle: [
    'openrails settle — submit processDripSettle for a stream (pays out accrued value). Dry-run by default.',
    '',
    'Required:',
    '  --paycard-id <bytes32>            The stream to settle',
    '  --execute                         Actually submit the transaction (omit to preview only)',
    '',
    'Optional:',
    '  --hub / --chain-id / --rpc-url    Override network defaults (Arc testnet V2 by default)',
    '',
    'Keys: OPENRAILS_PAYER_PRIVATE_KEY (or --signer-env <NAME>) — never on argv. Settling is',
    'permissionless: any funded signer can pay the gas to settle any stream.',
  ].join('\n'),
  close: [
    'openrails close — submit flushResidualDelta (settles, then returns unspent residual). Irrevocable.',
    '',
    'Required:',
    '  --paycard-id <bytes32>            The stream to close',
    '  --execute                         Actually submit the transaction',
    '  --ack-irrevocable-close           Explicit acknowledgment gate; required alongside --execute',
    '',
    'Optional:',
    '  --hub / --chain-id / --rpc-url    Override network defaults (Arc testnet V2 by default)',
    '',
    'Keys: OPENRAILS_PAYER_PRIVATE_KEY (or --signer-env <NAME>) — never on argv. Signer must be the',
    'stream\'s payer or recipient.',
  ].join('\n'),
};

function renderHelp(command?: string): string {
  if (command && COMMANDS.includes(command as typeof COMMANDS[number])) {
    return COMMAND_HELP[command as typeof COMMANDS[number]];
  }
  return [
    'OpenRails CLI',
    '',
    'Usage:',
    '  openrails <command> [options]',
    '  openrails <command> --help        Show that command\'s full flag list',
    '',
    'Commands:',
    '  request-stream   Build a RailsFlow request link',
    '  pay-stream       Sign or open a stream from env-held key material',
    '  stream-status    Read stream registry state',
    '  recover          Recover streams from PaycardProvisioned logs',
    '  settle           Submit processDripSettle for a stream',
    '  close            Submit flushResidualDelta for a stream (requires --ack-irrevocable-close)',
    '',
    'Safety:',
    '  Asset-affecting commands default to dry-run. Add --execute for transactions.',
    '  Use pay-stream --sign-only to sign an envelope without opening a stream.',
    '  stream-status and recover are read-only; pass --dry-run to preview without RPC reads.',
    '  Do not pass private keys on argv. Set an env var and select it with --signer-env.',
  ].join('\n');
}

if (require.main === module) {
  runOpenRailsCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
