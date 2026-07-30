import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbiParameters,
  stringToHex,
  verifyMessage,
} from 'viem';
import {
  EthersAuthoritySignatureVerifier,
  JsonFileKernelStore,
  OpenRailsAgentKernel,
  VerificationPluginRegistry,
  checkpointTypedData,
  verificationPluginTypedData,
} from '../../../agent-kernel/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');
const repoRoot = resolve(appRoot, '../..');
const distRoot = join(appRoot, 'dist');
const statePath = process.env.OPENRAILS_GASOK_STATE_PATH ?? join(repoRoot, 'artifacts/giwa-agent-kernel/gasok-web-state.json');
const apiOnly = process.argv.includes('--api-only');
const port = Number(process.env.OPENRAILS_GASOK_PORT ?? (apiOnly ? 4174 : 4173));
const host = process.env.OPENRAILS_GASOK_HOST ?? '0.0.0.0';
const maxBodyBytes = 262_144;
const sessionTtlMs = 60 * 60_000;
const challengeTtlMs = 5 * 60_000;
const sessionCookieName = 'openrails_gasok_session';

const GIWA = {
  chainId: 91342,
  rpcUrl: process.env.OPENRAILS_GIWA_RPC_URL ?? 'https://sepolia-rpc.giwa.io',
  explorerUrl: 'https://sepolia-explorer.giwa.io',
  token: '0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De',
  vault: '0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1',
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PLUGIN_ID = 'giwa_receipt_v1';
const PLUGIN_VERSION = '1.0.0';
const PLUGIN_DIGEST = keccak256(stringToHex('openrails:giwa-receipt-verifier:v1'));

const chain = defineChain({
  id: GIWA.chainId,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [GIWA.rpcUrl] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: GIWA.explorerUrl } },
  testnet: true,
});
const publicClient = createPublicClient({ chain, transport: http(GIWA.rpcUrl, { timeout: 15_000 }) });

const vaultAbi = [
  { type: 'function', name: 'accountNonceTracks', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }, { name: 'channel', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }], outputs: [
    { name: 'payer', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'metadataHash', type: 'bytes32' },
    { name: 'totalAllocationPool', type: 'uint256' }, { name: 'availableBalance', type: 'uint256' },
    { name: 'flowVelocityPerSecond', type: 'uint256' }, { name: 'genesisTimestamp', type: 'uint256' },
    { name: 'lifespanSeconds', type: 'uint256' }, { name: 'lastCheckpointEpoch', type: 'uint256' },
    { name: 'residualDeltaRecipient', type: 'address' }, { name: 'operationalStatus', type: 'uint8' },
  ] },
  { type: 'event', name: 'PaycardProvisioned', inputs: [
    { name: 'paycardId', type: 'bytes32', indexed: true }, { name: 'payer', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true },
    { name: 'metadataHash', type: 'bytes32', indexed: false }, { name: 'poolAllocation', type: 'uint256', indexed: false },
    { name: 'flowVelocityPerSecond', type: 'uint256', indexed: false }, { name: 'genesisTimestamp', type: 'uint256', indexed: false },
    { name: 'lifespanSeconds', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'SettlementFlushed', inputs: [
    { name: 'paycardId', type: 'bytes32', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'amountWithdrawn', type: 'uint256', indexed: false },
  ] },
];

const paycardProvisionedEvent = vaultAbi.find(
  (entry) =>
    entry.type === 'event' &&
    entry.name === 'PaycardProvisioned'
);

if (!paycardProvisionedEvent) {
  throw new Error('PaycardProvisioned ABI is missing');
}

const settlementFlushedEvent = vaultAbi.find(
  (entry) =>
    entry.type === 'event' &&
    entry.name === 'SettlementFlushed'
);

if (!settlementFlushedEvent) {
  throw new Error('SettlementFlushed ABI is missing');
}

function implementationManifest() {
  return {
    version: 'openrails-verification-plugin-v1',
    pluginId: PLUGIN_ID,
    pluginVersion: PLUGIN_VERSION,
    name: 'GIWA Paycard receipt verifier',
    publisher: ZERO_ADDRESS,
    pluginType: 'checkpoint',
    supportedEvidenceTypes: ['giwa_transaction_receipt'],
    deterministic: true,
    requiresNetworkAccess: true,
    externalDependencies: [GIWA.rpcUrl],
    codeDigest: PLUGIN_DIGEST,
    publisherSignature: '0x',
    status: 'active',
    installedWorkspaceIds: [],
    createdAt: new Date(0).toISOString(),
  };
}

const pluginRegistry = new VerificationPluginRegistry();
pluginRegistry.bind({
  manifest: implementationManifest(),
  async evaluate(checkpoint) {
    try {
      if (!checkpoint.paycardId) return { decision: 'rejected', reasonCodes: ['PAYCARD_BINDING_REQUIRED'] };
      const receipt = await publicClient.getTransactionReceipt({ hash: checkpoint.evidenceHash });
      if (receipt.status !== 'success') return { decision: 'rejected', reasonCodes: ['GIWA_RECEIPT_REVERTED'] };
      let boundProvisioning = false;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== GIWA.vault.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
          if (decoded.eventName === 'PaycardProvisioned' && decoded.args.paycardId.toLowerCase() === checkpoint.paycardId.toLowerCase()) {
            boundProvisioning = true;
            break;
          }
        } catch { /* unrelated vault log */ }
      }
      return {
        decision: boundProvisioning ? 'approved' : 'rejected',
        reasonCodes: boundProvisioning ? ['GIWA_PAYCARD_RECEIPT_CONFIRMED'] : ['GIWA_PAYCARD_EVENT_NOT_FOUND'],
        sourceCommitmentHash: checkpoint.evidenceHash,
      };
    } catch {
      return { decision: 'rejected', reasonCodes: ['GIWA_RECEIPT_NOT_FOUND'] };
    }
  },
});

async function readRegistry(paycardId, blockNumber) {
  const value = await publicClient.readContract({
    address: GIWA.vault,
    abi: vaultAbi,
    functionName: 'registry',
    args: [paycardId],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  });
  const [payer, recipient, metadataHash, totalAllocationPool, availableBalance, flowVelocityPerSecond, genesisTimestamp, lifespanSeconds, lastCheckpointEpoch, residualDeltaRecipient, operationalStatus] = value;
  return { payer, recipient, metadataHash, totalAllocationPool, availableBalance, flowVelocityPerSecond, genesisTimestamp, lifespanSeconds, lastCheckpointEpoch, residualDeltaRecipient, operationalStatus };
}

const rpcSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retryRpc(
  label,
  operation,
  attempts = 30,
  delayMilliseconds = 1_500,
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        await rpcSleep(delayMilliseconds);
      }
    }
  }

  const reason =
    lastError instanceof Error
      ? lastError.message
      : String(lastError);

  throw new Error(`${label} failed after ${attempts} attempts: ${reason}`);
}

const chainVerifier = {
  async verifyOpening({ metadataHash, paycardId, openingTxHash }) {
    const receipt = await retryRpc(
      'GIWA opening receipt',
      () => publicClient.getTransactionReceipt({
        hash: openingTxHash,
      }),
    );

    if (receipt.status !== 'success') {
      throw new Error('GIWA opening transaction reverted');
    }
    let event;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== GIWA.vault.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === 'PaycardProvisioned' && decoded.args.paycardId.toLowerCase() === paycardId.toLowerCase()) event = decoded.args;
      } catch { /* unrelated log */ }
    }
    if (!event) throw new Error('PaycardProvisioned event was not found in the GIWA receipt');
    const card = await retryRpc(
      'GIWA opening state',
      async () => {
        const value = await readRegistry(
          paycardId,
          receipt.blockNumber,
        );

        if (
          value.payer.toLowerCase() ===
          ZERO_ADDRESS.toLowerCase()
        ) {
          throw new Error(
            'Paycard state is not visible at the receipt block yet'
          );
        }

        if (
          value.metadataHash.toLowerCase() !==
          metadataHash.toLowerCase()
        ) {
          throw new Error(
            'Paycard metadata is not consistent yet'
          );
        }

        return value;
      },
    );

    const block = await retryRpc(
      'GIWA opening block',
      () => publicClient.getBlock({
        blockHash: receipt.blockHash,
      }),
    );
    return {
      version: 'openrails-opening-observation-v1',
      transactionHash: receipt.transactionHash,
      chainId: GIWA.chainId,
      vault: GIWA.vault,
      paycardId,
      metadataHash,
      payer: card.payer,
      recipient: card.recipient,
      residualRecipient: card.residualDeltaRecipient,
      poolAllocationBaseUnits: card.totalAllocationPool.toString(),
      flowVelocityBaseUnitsPerSecond: card.flowVelocityPerSecond.toString(),
      genesisTimestamp: Number(card.genesisTimestamp),
      lifespanSeconds: Number(card.lifespanSeconds),
      availableBalanceBaseUnits: card.availableBalance.toString(),
      operationalStatus: Number(card.operationalStatus),
      blockNumber: Number(receipt.blockNumber),
      observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
  },
  async verifySettlement({ pact, txHash, settledAmountBaseUnits }) {
    const receipt = await retryRpc(
      'GIWA settlement receipt',
      () => publicClient.getTransactionReceipt({
        hash: txHash,
      }),
    );

    if (receipt.status !== 'success') {
      throw new Error('GIWA settlement transaction reverted');
    }
    if (!pact.openRails?.paycardId) throw new Error('Pact has no Paycard binding');
    let amount = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== GIWA.vault.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === 'SettlementFlushed' && decoded.args.paycardId.toLowerCase() === pact.openRails.paycardId.toLowerCase()) amount += decoded.args.amountWithdrawn;
      } catch { /* unrelated log */ }
    }
    if (amount.toString() !== settledAmountBaseUnits) throw new Error('GIWA settlement event amount does not match the requested observation');
    const previouslySettled =
      (pact.openRails.settlements ?? []).reduce(
        (total, entry) =>
          total +
          BigInt(entry.settledAmountBaseUnits),
        0n,
      );

    const allocation = BigInt(
      pact.paymentTerms.maximumAllocationBaseUnits,
    );

    const cumulativeSettled =
      previouslySettled + amount;

    const eventFinal =
      cumulativeSettled >= allocation;

    const card = await retryRpc(
      'GIWA settlement state',
      async () => {
        const value = await readRegistry(
          pact.openRails.paycardId,
        );

        const chainFinal =
          Number(value.operationalStatus) === 1 ||
          value.availableBalance === 0n;

        if (eventFinal && !chainFinal) {
          throw new Error(
            'Final Paycard state has not propagated yet'
          );
        }

        return value;
      },
    );

    const block = await retryRpc(
      'GIWA settlement block',
      () => publicClient.getBlock({
        blockHash: receipt.blockHash,
      }),
    );
    return {
      version: 'openrails-settlement-observation-v1',
      transactionHash: receipt.transactionHash,
      chainId: GIWA.chainId,
      vault: GIWA.vault,
      paycardId: pact.openRails.paycardId,
      recipient: card.recipient,
      settledAmountBaseUnits: amount.toString(),
      final: eventFinal,
      blockNumber: Number(receipt.blockNumber),
      observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
  },
};

const kernel = new OpenRailsAgentKernel({
  store: new JsonFileKernelStore(statePath),
  signatureVerifier: new EthersAuthoritySignatureVerifier(),
  pluginRegistry,
  chainVerifier,
});

const rate = new Map();
const challenges = new Map();
const sessions = new Map();
const paymentDrafts = new Map();

function rateLimit(req) {
  const key = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const current = rate.get(key);
  if (!current || now - current.startedAt > 60_000) {
    rate.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 180;
}

async function body(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) throw new Error('request body exceeds 256 KiB');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(`${JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2)}\n`);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function cookies(req) {
  const output = {};
  const source = req.headers.cookie;
  if (!source) return output;
  for (const part of source.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    output[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return output;
}

function activeSession(req) {
  const token = cookies(req)[sessionCookieName];
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return undefined;
  }
  return session;
}

function sessionCookie(token) {
  const secure = process.env.OPENRAILS_GASOK_SECURE_COOKIES === 'true' ? '; Secure' : '';
  return `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`;
}

function challengeMessage(address, nonce, expiresAt) {
  return [
    'OpenRails GASOK live session',
    '',
    `Address: ${address}`,
    `Chain ID: ${GIWA.chainId}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    '',
    'This signature authenticates same-origin API requests. It does not authorize a transaction or transfer value.',
  ].join('\n');
}

function sameAddress(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

async function assertWorkspaceSession(workspaceId, sessionAddress, allowMissing = false) {
  const workspace = await kernel.getWorkspace(workspaceId);
  if (!workspace) {
    if (allowMissing) return undefined;
    throw new Error('Workspace not found');
  }
  if (!sameAddress(workspace.authorityAccount, sessionAddress)) throw new Error('Session is not the Workspace authority');
  return workspace;
}

async function assertPactSession(pactId, sessionAddress) {
  const pact = await kernel.getPact(pactId);
  if (!pact) throw new Error('Pact not found');
  await assertWorkspaceSession(pact.workspaceId, sessionAddress);
  return pact;
}

function normalizeCanonical(value) {
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) output[key] = normalizeCanonical(entry);
    }
    return output;
  }
  return value;
}

async function createPaymentDraft(pact, sessionAddress) {
  const binding = await kernel.openRailsMetadataBinding(pact.pactId);
  const nonceChannel = 0n;
  const nonceValue = await publicClient.readContract({ address: GIWA.vault, abi: vaultAbi, functionName: 'accountNonceTracks', args: [sessionAddress, nonceChannel] });
  const latestBlock = await publicClient.getBlock();
  const genesisTimestamp = latestBlock.timestamp + 15n;
  const lifespanSeconds = BigInt(pact.paymentTerms.lifespanSeconds);
  const metadata = {
    version: 'openrails-metadata-v1',
    mode: 'railsflow',
    originator: pact.paymentTerms.payer,
    recipient: pact.paymentTerms.recipient,
    token: pact.paymentTerms.token,
    amount: pact.paymentTerms.maximumAllocationBaseUnits,
    flowVelocityPerSecond: pact.paymentTerms.velocityBaseUnitsPerSecond,
    lifespanSeconds: pact.paymentTerms.lifespanSeconds,
    workflowId: binding.workflowId,
    metadataRef: binding.metadataRef,
    descriptionHash: binding.descriptionHash,
    expiresAt: Number(genesisTimestamp + lifespanSeconds),
  };
  const metadataHash = keccak256(stringToHex(JSON.stringify(normalizeCanonical(metadata))));
  const paycardId = keccak256(encodeAbiParameters(
    parseAbiParameters('address, uint256, uint256, bytes32, string'),
    [sessionAddress, nonceChannel, nonceValue, metadataHash, binding.salt],
  ));
  const intent = {
    paycardId,
    metadataHash,
    recipient: pact.paymentTerms.recipient,
    totalAllocationPool: pact.paymentTerms.maximumAllocationBaseUnits,
    flowVelocityPerSecond: pact.paymentTerms.velocityBaseUnitsPerSecond,
    genesisTimestamp: Number(genesisTimestamp),
    lifespanSeconds: pact.paymentTerms.lifespanSeconds,
    residualDeltaRecipient: pact.paymentTerms.residualRecipient,
    nonceChannel: Number(nonceChannel),
    nonceValue: Number(nonceValue),
  };
  const typedData = {
    domain: { name: 'OpenRails Network', version: '2.0.0', chainId: GIWA.chainId, verifyingContract: GIWA.vault },
    primaryType: 'SettlementIntent',
    types: { SettlementIntent: [
      { name: 'paycardId', type: 'bytes32' }, { name: 'metadataHash', type: 'bytes32' }, { name: 'recipient', type: 'address' },
      { name: 'totalAllocationPool', type: 'uint256' }, { name: 'flowVelocityPerSecond', type: 'uint256' },
      { name: 'genesisTimestamp', type: 'uint256' }, { name: 'lifespanSeconds', type: 'uint256' },
      { name: 'residualDeltaRecipient', type: 'address' }, { name: 'nonceChannel', type: 'uint256' }, { name: 'nonceValue', type: 'uint256' },
    ] },
    message: intent,
  };
  const draft = {
    pactId: pact.pactId,
    payer: sessionAddress,
    metadata,
    metadataHash,
    paycardId,
    intent,
    typedData,
    approval: { token: GIWA.token, spender: GIWA.vault, amountBaseUnits: pact.paymentTerms.maximumAllocationBaseUnits },
    issuedAt: new Date().toISOString(),
    validUntil: new Date(Number(genesisTimestamp + lifespanSeconds) * 1000).toISOString(),
  };
  paymentDrafts.set(paycardId.toLowerCase(), { ...draft, expiresAt: Number(genesisTimestamp + lifespanSeconds) * 1000 });
  return draft;
}

async function safeState(workspaceId) {
  const state = await kernel.state();
  return {
    workspace: state.workspaces[workspaceId],
    agents: Object.values(state.agents).filter((entry) => entry.workspaceId === workspaceId),
    paths: Object.values(state.paths).filter((entry) => entry.artifact.workspaceId === workspaceId),
    plugins: Object.values(state.plugins).filter((entry) => entry.installedWorkspaceIds.includes(workspaceId)),
    proposals: Object.values(state.proposals).filter((entry) => entry.workspaceId === workspaceId),
    decisions: Object.values(state.decisions).filter((entry) => entry.workspaceId === workspaceId),
    blockedActions: state.blockedActions.filter((entry) => entry.workspaceId === workspaceId),
    pacts: Object.values(state.pacts).filter((entry) => entry.workspaceId === workspaceId),
    checkpoints: Object.values(state.checkpoints).filter((entry) => entry.workspaceId === workspaceId),
    verificationDecisions: Object.values(state.verificationDecisions).filter((entry) => entry.workspaceId === workspaceId),
    events: state.events.filter((entry) => entry.workspaceId === workspaceId),
  };
}

async function api(req, res, requestUrl) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'cross_origin_request_rejected' });
  if (!rateLimit(req)) return send(res, 429, { error: 'rate_limit_exceeded' });
  const pathname = requestUrl.pathname;
  const method = req.method ?? 'GET';
  const input = method === 'POST' ? await body(req) : {};

  if (method === 'GET' && pathname === '/api/health') {
    const blockNumber = await publicClient.getBlockNumber();
    return send(res, 200, { ok: true, service: 'openrails-gasok-gateway', blockNumber, chainId: GIWA.chainId, walletBoundary: true, signing: false, broadcasting: false, plugin: `${PLUGIN_ID}@${PLUGIN_VERSION}` });
  }

  if (method === 'GET' && pathname === '/api/session/challenge') {
    const rawAddress = requestUrl.searchParams.get('address');
    if (!rawAddress) return send(res, 400, { error: 'address_required' });
    let address;
    try { address = getAddress(rawAddress); } catch { return send(res, 400, { error: 'invalid_address' }); }
    const nonce = randomBytes(24).toString('hex');
    const expiresAt = Date.now() + challengeTtlMs;
    const message = challengeMessage(address, nonce, expiresAt);
    challenges.set(address.toLowerCase(), { message, expiresAt });
    return send(res, 200, { address, message, expiresAt: new Date(expiresAt).toISOString() });
  }

  if (method === 'POST' && pathname === '/api/session/verify') {
    let address;
    try { address = getAddress(input.address); } catch { return send(res, 400, { error: 'invalid_address' }); }
    const challenge = challenges.get(address.toLowerCase());
    if (!challenge || challenge.expiresAt <= Date.now()) return send(res, 400, { error: 'session_challenge_expired' });
    const valid = await verifyMessage({ address, message: challenge.message, signature: input.signature });
    if (!valid) return send(res, 401, { error: 'session_signature_invalid' });
    challenges.delete(address.toLowerCase());
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { address, expiresAt: Date.now() + sessionTtlMs });
    return send(res, 200, { authenticated: true, address }, { 'set-cookie': sessionCookie(token) });
  }

  if (method === 'GET' && pathname === '/api/session') {
    const session = activeSession(req);
    return send(res, 200, session ? { authenticated: true, address: session.address } : { authenticated: false });
  }

  const session = activeSession(req);
  if (pathname.startsWith('/api/live/') && !session) return send(res, 401, { error: 'wallet_session_required' });
  const sessionAddress = session?.address;

  if (method === 'GET' && pathname.startsWith('/api/live/state/')) {
    const workspaceId = decodeURIComponent(pathname.slice('/api/live/state/'.length));
    await assertWorkspaceSession(workspaceId, sessionAddress, true);
    return send(res, 200, await safeState(workspaceId));
  }
  if (method === 'GET' && pathname.startsWith('/api/live/pacts/') && pathname.endsWith('/metadata')) {
    const pactId = decodeURIComponent(pathname.slice('/api/live/pacts/'.length, -'/metadata'.length));
    await assertPactSession(pactId, sessionAddress);
    return send(res, 200, await kernel.openRailsMetadataBinding(pactId));
  }
  if (method === 'GET' && pathname.startsWith('/api/live/pacts/')) {
    const pactId = decodeURIComponent(pathname.slice('/api/live/pacts/'.length));
    return send(res, 200, await assertPactSession(pactId, sessionAddress));
  }

  if (method === 'POST' && pathname === '/api/live/workspaces/prepare') {
    if (!sameAddress(input.authorityAccount, sessionAddress)) throw new Error('Workspace authority must match the authenticated wallet');
    return send(res, 200, kernel.prepareWorkspace(input));
  }
  if (method === 'POST' && pathname === '/api/live/workspaces/register') {
    if (!sameAddress(input.workspace?.authorityAccount, sessionAddress)) throw new Error('Workspace authority must match the authenticated wallet');
    return send(res, 200, await kernel.registerWorkspace(input));
  }
  if (method === 'POST' && pathname === '/api/live/agents/prepare') {
    await assertWorkspaceSession(input.workspaceId, sessionAddress);
    if (!sameAddress(input.operator, sessionAddress)) throw new Error('Agent operator must match the authenticated wallet for the live demonstration');
    return send(res, 200, kernel.prepareAgentRegistration(input));
  }
  if (method === 'POST' && pathname === '/api/live/agents/register') {
    await assertWorkspaceSession(input.agent?.workspaceId, sessionAddress);
    if (!sameAddress(input.authoritySigner, sessionAddress) || !sameAddress(input.agent?.operator, sessionAddress)) throw new Error('Agent registration is outside the authenticated wallet scope');
    return send(res, 200, await kernel.registerAgent(input));
  }
  if (method === 'POST' && pathname === '/api/live/paths/prepare') {
    await assertWorkspaceSession(input.workspaceId, sessionAddress);
    if (!sameAddress(input.owner, sessionAddress) || !sameAddress(input.authorityAccount, sessionAddress)) throw new Error('Path authority must match the authenticated wallet');
    return send(res, 200, kernel.preparePath(input));
  }
  if (method === 'POST' && pathname === '/api/live/paths/activate') {
    await assertWorkspaceSession(input.path?.workspaceId, sessionAddress);
    if (!sameAddress(input.path?.authorityAccount, sessionAddress)) throw new Error('Path authority must match the authenticated wallet');
    return send(res, 200, await kernel.activatePath(input));
  }

  if (method === 'POST' && pathname === '/api/live/plugins/prepare') {
    await assertWorkspaceSession(input.workspaceId, sessionAddress);
    if (!sameAddress(input.publisher, sessionAddress)) throw new Error('Plugin publisher must match the authenticated wallet');
    const now = new Date().toISOString();
    const manifest = { ...implementationManifest(), publisher: sessionAddress, publisherSignature: '0x', installedWorkspaceIds: [input.workspaceId], createdAt: now };
    return send(res, 200, { manifest, typedData: verificationPluginTypedData(manifest), codeDigest: PLUGIN_DIGEST });
  }
  if (method === 'POST' && pathname === '/api/live/plugins/prepare-command') {
    await assertWorkspaceSession(input.workspaceId, sessionAddress);
    const payload = { workspaceId: input.workspaceId, pluginId: PLUGIN_ID, pluginVersion: PLUGIN_VERSION, codeDigest: PLUGIN_DIGEST };
    return send(res, 200, { payload, ...(await kernel.prepareWorkspaceCommand({ workspaceId: input.workspaceId, operation: 'install_plugin', payload })) });
  }
  if (method === 'POST' && pathname === '/api/live/plugins/install') {
    const workspaceId = input.manifest?.installedWorkspaceIds?.[0];
    await assertWorkspaceSession(workspaceId, sessionAddress);
    if (!sameAddress(input.manifest?.publisher, sessionAddress)) throw new Error('Plugin publisher must match the authenticated wallet');
    return send(res, 200, await kernel.installPlugin(input));
  }

  if (method === 'POST' && pathname === '/api/live/proposals/evaluate') {
    await assertWorkspaceSession(input.workspaceId, sessionAddress);
    if (!sameAddress(input.counterparty, sessionAddress)) throw new Error('The safe live route is self-recipient only');
    if (!sameAddress(input.asset, GIWA.token)) throw new Error('The live route only supports orUSD');
    if (input.actionType !== 'open_payment') throw new Error('The live route only supports open_payment proposals');
    const requested = BigInt(input.requestedAllocationBaseUnits);
    if (requested <= 0n || requested > 2_000_000_000n) throw new Error('Requested allocation is outside the bounded live demonstration range');
    if (input.requestedDurationSeconds !== 30) throw new Error('The live demonstration duration must be 30 seconds');
    const submitted = await kernel.submitProposal(input);
    let job = submitted.job;
    for (let index = 0; index < 20 && ['queued', 'running'].includes(job.state); index += 1) {
      await kernel.runNextJob('gasok-web');
      job = (await kernel.getJob(submitted.job.jobId)) ?? job;
    }
    if (job.state === 'failed') {
      throw new Error(
        `Baphomet evaluation failed: ${job.error ?? 'unknown evaluator error'}`
      );
    }

    if (job.state === 'queued' || job.state === 'running') {
      throw new Error(
        `Baphomet evaluation did not complete. Job state: ${job.state}`
      );
    }

    const state = await kernel.state();
    const decisionId = job.result?.decisionId;
    const decision = typeof decisionId === 'string' ? state.decisions[decisionId] : undefined;
    const blockedAction = state.blockedActions.find((entry) => entry.proposalId === input.proposalId);
    const pactFormed = Object.values(state.pacts).some((entry) => entry.proposalId === input.proposalId);
    return send(res, 200, { proposal: submitted.proposal, job, decision, blockedAction, pactFormed, financialEffect: 'none' });
  }

  if (method === 'POST' && pathname === '/api/live/pacts/create') {
    const state = await kernel.state();
    const proposal = state.proposals[input.proposalId];
    if (!proposal) throw new Error('Proposal not found');
    await assertWorkspaceSession(proposal.workspaceId, sessionAddress);
    if (input.requiresCounterpartySignature !== false) throw new Error('The self-recipient test route uses one explicit Workspace signature');
    const pact = await kernel.createPactFromProposal(input);
    return send(res, 200, { pact, ...kernel.preparePactSignature(pact) });
  }
  if (method === 'POST' && pathname === '/api/live/pacts/sign') {
    await assertPactSession(input.pactId, sessionAddress);
    if (!sameAddress(input.signer, sessionAddress)) throw new Error('Pact signer must match the authenticated wallet');
    return send(res, 200, await kernel.signPact(input));
  }
  if (method === 'POST' && pathname === '/api/live/payments/draft') {
    const pact = await assertPactSession(input.pactId, sessionAddress);
    if (!['accepted', 'payment_prepared', 'awaiting_wallet'].includes(pact.status)) throw new Error(`Pact is not ready for a payment draft (${pact.status})`);
    const reusable = Array.from(paymentDrafts.values()).find((entry) => entry.pactId === pact.pactId && sameAddress(entry.payer, sessionAddress) && entry.expiresAt > Date.now());
    return send(res, 200, reusable ?? await createPaymentDraft(pact, sessionAddress));
  }
  if (method === 'POST' && pathname === '/api/live/payments/prepare') {
    await assertPactSession(input.pactId, sessionAddress);
    if (!sameAddress(input.actor, sessionAddress)) throw new Error('Payment actor must match the authenticated wallet');
    const draft = paymentDrafts.get(String(input.paycardId).toLowerCase());
    if (!draft || draft.expiresAt <= Date.now()) throw new Error('The server-issued payment draft is missing or expired');
    if (draft.pactId !== input.pactId || !sameAddress(draft.payer, sessionAddress) || draft.metadataHash !== input.metadataHash) throw new Error('Payment preparation does not match the server-issued draft');
    if (draft.intent.genesisTimestamp !== input.genesisTimestamp || draft.intent.nonceChannel !== input.nonceChannel || draft.intent.nonceValue !== input.nonceValue) throw new Error('Payment nonce or timing does not match the server-issued draft');
    return send(res, 200, await kernel.bindOpenRailsPayment(input));
  }
  if (
    method === 'POST' &&
    pathname === '/api/live/payments/recover-opening'
  ) {
    const pact = await assertPactSession(
      input.pactId,
      sessionAddress,
    );

    if (!pact.openRails?.paycardId) {
      throw new Error(
        'The Pact has no prepared Paycard to recover'
      );
    }

    if (
      pact.status === 'active' &&
      pact.openRails.openingTxHash
    ) {
      return send(res, 200, {
        pact,
        openingTxHash: pact.openRails.openingTxHash,
        paycardId: pact.openRails.paycardId,
        genesisTimestamp:
          pact.openRails.genesisTimestamp,
        recovered: true,
      });
    }

    const latestBlock = await retryRpc(
      'latest GIWA block',
      () => publicClient.getBlockNumber(),
    );

    const fromBlock =
      latestBlock > 10_000n
        ? latestBlock - 10_000n
        : 0n;

    const logs = await retryRpc(
      'PaycardProvisioned event search',
      () => publicClient.getLogs({
        address: GIWA.vault,
        event: paycardProvisionedEvent,
        args: {
          paycardId: pact.openRails.paycardId,
        },
        fromBlock,
        toBlock: 'latest',
      }),
    );

    const opening = logs.at(-1);

    if (!opening?.transactionHash) {
      throw new Error(
        'No canonical Paycard opening was found for the prepared Pact'
      );
    }

    const recoveredPact =
      await kernel.bindOpenRailsPayment({
        pactId: pact.pactId,
        metadataHash: pact.openRails.metadataHash,
        paycardId: pact.openRails.paycardId,
        actor: sessionAddress,
        openingTxHash: opening.transactionHash,
      });

    paymentDrafts.delete(
      pact.openRails.paycardId.toLowerCase()
    );

    return send(res, 200, {
      pact: recoveredPact,
      openingTxHash: opening.transactionHash,
      paycardId: pact.openRails.paycardId,
      genesisTimestamp:
        pact.openRails.genesisTimestamp,
      recovered: true,
    });
  }

  if (method === 'POST' && pathname === '/api/live/payments/confirm-opening') {
    await assertPactSession(input.pactId, sessionAddress);
    if (!sameAddress(input.actor, sessionAddress)) throw new Error('Opening observer actor must match the authenticated wallet');
    const draftKey = String(input.paycardId).toLowerCase();
    const draft = paymentDrafts.get(draftKey);
    if (!draft || draft.pactId !== input.pactId || draft.metadataHash !== input.metadataHash) throw new Error('Opening observation does not match the server-issued draft');
    const result = await kernel.bindOpenRailsPayment(input);
    paymentDrafts.delete(draftKey);
    return send(res, 200, result);
  }

  if (method === 'POST' && pathname === '/api/live/checkpoints/prepare') {
    await assertPactSession(input.pactId, sessionAddress);
    if (!sameAddress(input.actor, sessionAddress) || !sameAddress(input.submittedBy, sessionAddress)) throw new Error('Checkpoint signer must match the authenticated wallet');
    const checkpoint = { ...input, signature: '0x' };
    return send(res, 200, { checkpoint, typedData: checkpointTypedData(checkpoint) });
  }
  if (method === 'POST' && pathname === '/api/live/checkpoints/submit-and-verify') {
    await assertPactSession(input.checkpoint?.pactId, sessionAddress);
    if (!sameAddress(input.checkpoint?.submittedBy, sessionAddress)) throw new Error('Checkpoint signer must match the authenticated wallet');
    const checkpoint = await kernel.submitCheckpoint(input.checkpoint);
    const decision = await kernel.verifyCheckpoint({ checkpointId: checkpoint.checkpointId, pluginId: PLUGIN_ID, pluginVersion: PLUGIN_VERSION });
    return send(res, 200, { checkpoint, decision, pact: await kernel.getPact(checkpoint.pactId) });
  }
  if (
    method === 'POST' &&
    pathname === '/api/live/settlements/recover'
  ) {
    let pact = await assertPactSession(
      input.pactId,
      sessionAddress,
    );

    if (!pact.openRails?.paycardId) {
      throw new Error(
        'The Pact has no canonical Paycard binding'
      );
    }

    const existingSettlements =
      pact.openRails.settlements ?? [];

    if (
      pact.status === 'settled' &&
      existingSettlements.length > 0
    ) {
      const latest =
        existingSettlements.at(-1);

      return send(res, 200, {
        pact,
        recovered: latest
          ? [{
              transactionHash:
                latest.transactionHash,
              settledAmountBaseUnits:
                latest.settledAmountBaseUnits,
              final: latest.final,
              alreadyRecorded: true,
            }]
          : [],
      });
    }

    const latestBlock = await retryRpc(
      'latest GIWA settlement block',
      () => publicClient.getBlockNumber(),
    );

    const openingBlock =
      pact.openRails.openingObservation?.blockNumber;

    const fromBlock =
      openingBlock !== undefined
        ? BigInt(openingBlock)
        : latestBlock > 10_000n
          ? latestBlock - 10_000n
          : 0n;

    const settlementLogs = await retryRpc(
      'SettlementFlushed event search',
      () => publicClient.getLogs({
        address: GIWA.vault,
        event: settlementFlushedEvent,
        fromBlock,
        toBlock: 'latest',
      }),
    );

    const logs = settlementLogs.filter(
      (log) =>
        log.args?.paycardId?.toLowerCase() ===
        pact.openRails.paycardId.toLowerCase(),
    );

    logs.sort((left, right) => {
      const leftBlock = left.blockNumber ?? 0n;
      const rightBlock = right.blockNumber ?? 0n;

      if (leftBlock !== rightBlock) {
        return leftBlock < rightBlock ? -1 : 1;
      }

      return Number(left.logIndex ?? 0) -
        Number(right.logIndex ?? 0);
    });

    const recorded = new Set(
      existingSettlements.map((entry) =>
        entry.transactionHash.toLowerCase()
      )
    );

    const recovered = [];

    for (const log of logs) {
      const transactionHash =
        log.transactionHash;

      if (
        !transactionHash ||
        recorded.has(transactionHash.toLowerCase())
      ) {
        continue;
      }

      const receipt = await retryRpc(
        'recoverable settlement receipt',
        () => publicClient.getTransactionReceipt({
          hash: transactionHash,
        }),
      );

      if (receipt.status !== 'success') {
        continue;
      }

      let settledAmount = 0n;

      for (const receiptLog of receipt.logs) {
        if (
          receiptLog.address.toLowerCase() !==
          GIWA.vault.toLowerCase()
        ) {
          continue;
        }

        try {
          const decoded = decodeEventLog({
            abi: vaultAbi,
            data: receiptLog.data,
            topics: receiptLog.topics,
          });

          if (
            decoded.eventName ===
              'SettlementFlushed' &&
            decoded.args.paycardId.toLowerCase() ===
              pact.openRails.paycardId.toLowerCase()
          ) {
            settledAmount +=
              decoded.args.amountWithdrawn;
          }
        } catch {
          // Ignore unrelated Vault events.
        }
      }

      if (settledAmount === 0n) {
        continue;
      }

      pact = await kernel.recordPactSettlement({
        pactId: pact.pactId,
        actor: sessionAddress,
        txHash: transactionHash,
        settledAmountBaseUnits:
          settledAmount.toString(),
      });

      recorded.add(transactionHash.toLowerCase());

      recovered.push({
        transactionHash,
        settledAmountBaseUnits:
          settledAmount.toString(),
        final: pact.status === 'settled',
        alreadyRecorded: false,
      });
    }

    const latestCard = await retryRpc(
      'current GIWA Paycard state',
      () => readRegistry(
        pact.openRails.paycardId,
      ),
    );

    const chainFinal =
      Number(latestCard.operationalStatus) === 1 ||
      latestCard.availableBalance === 0n;

    return send(res, 200, {
      pact,
      recovered,
      chainFinal,
      broadcastAllowed:
        !chainFinal &&
        pact.status !== 'settled',
    });
  }

  if (method === 'POST' && pathname === '/api/live/settlements/record') {
    await assertPactSession(input.pactId, sessionAddress);
    if (!sameAddress(input.actor, sessionAddress)) throw new Error('Settlement actor must match the authenticated wallet');
    const state = await kernel.state();
    const proofApproved = Object.values(state.verificationDecisions).some((entry) => entry.pactId === input.pactId && entry.decision === 'approved');
    if (!proofApproved) throw new Error('An approved Proof checkpoint is required before settlement can be recorded');
    return send(
      res,
      200,
      await kernel.recordPactSettlement({
        pactId: input.pactId,
        actor: input.actor,
        txHash: input.txHash,
        settledAmountBaseUnits:
          input.settledAmountBaseUnits,
      }),
    );
  }

  return send(res, 404, { error: 'not_found' });
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

async function staticFile(res, pathname) {
  if (apiOnly) return send(res, 404, { error: 'not_found' });
  const candidate = normalize(pathname).replace(/^([.][.][/\\])+/, '');
  let file = join(distRoot, candidate === '/' ? 'index.html' : candidate);
  try {
    if (!(await stat(file)).isFile()) throw new Error('not file');
  } catch {
    file = join(distRoot, 'index.html');
  }
  const contents = await readFile(file);
  res.writeHead(200, {
    'content-type': mime[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  });
  res.end(contents);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (requestUrl.pathname.startsWith('/api/')) return await api(req, res, requestUrl);
    return await staticFile(res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(port, host, () => console.error(`openrails-gasok ${apiOnly ? 'API' : 'web + API'} listening on http://${host}:${port}`));
