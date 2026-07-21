import { ethers } from "ethers";
import { authorized } from "../../shared/auth";

export interface Env {
  STREAM_DB: D1Database;
  ARC_RPC_URL: string;
  ARC_CHAIN_ID: string;
  OPENRAILS_HUB_ADDRESS: string;      // V2 canonical hub — always watched
  OPENRAILS_FACTORY_ADDRESS: string;  // ArcOpenRailsFactoryV1
  SCAN_WINDOW_BLOCKS?: string;
  MAX_CHUNKS_PER_TICK?: string;
  INITIAL_BACKFILL_BLOCKS?: string;
  INDEXER_ADMIN_TOKEN?: string;
}

// Identical ABI across the canonical V2 hub and every factory clone (same master logic contract).
const HUB_EVENTS_ABI = [
  "event PaycardProvisioned(bytes32 indexed paycardId, address indexed payer, address indexed recipient, bytes32 metadataHash, uint256 poolAllocation, uint256 flowVelocityPerSecond, uint256 genesisTimestamp, uint256 lifespanSeconds)",
  "event SettlementFlushed(bytes32 indexed paycardId, address indexed recipient, uint256 amountWithdrawn)",
  "event ResidualDeltaReclaimed(bytes32 indexed paycardId, address indexed recoveryVault, uint256 varianceSwept)",
];

const FACTORY_EVENTS_ABI = [
  "event CorporateVaultDeployed(address indexed vaultAddress, address indexed owner, address token)",
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-OpenRails-Admin-Token",
};

const DISCLAIMER =
  "Non-authoritative projection from the OpenRails indexer worker. The onchain Vault is the source of truth.";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isBytes32Hex(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function lower(value: string): string {
  return value.toLowerCase();
}

// Ethers v6 LogDescription.args (a Result) only exposes numeric indices via Object.keys() — the
// named accessors are non-enumerable. args.toObject() is the documented way to get a plain
// { name: value } map instead.
function serializeArgs(args: ethers.Result): Record<string, string> {
  const obj = args.toObject() as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = typeof value === "bigint" ? value.toString() : String(value);
  }
  return out;
}

function mapStreamRow(r: Record<string, unknown>) {
  return {
    vaultAddress: r.vault_address,
    paycardId: r.paycard_id,
    payer: r.payer,
    recipient: r.recipient,
    metadataHash: r.metadata_hash,
    totalAllocation: r.total_allocation,
    availableBalance: r.available_balance,
    velocity: r.velocity,
    genesis: r.genesis,
    lifespan: r.lifespan,
    lastCheckpoint: r.last_checkpoint,
    status: r.status,
    updatedAt: r.updated_at,
  };
}

function mapEventRow(r: Record<string, unknown>) {
  return {
    eventName: r.event_name,
    blockNumber: r.block_number,
    blockTimestamp: r.block_timestamp,
    transactionHash: r.transaction_hash,
    logIndex: r.log_index,
    args: JSON.parse(r.args_json as string),
  };
}

async function getCursor(db: D1Database, scanKey: string, defaultBlock: number): Promise<number> {
  const row = await db
    .prepare("SELECT last_scanned_block FROM idx_scan_cursors WHERE scan_key = ?")
    .bind(scanKey)
    .first<{ last_scanned_block: number }>();
  return row ? Number(row.last_scanned_block) : defaultBlock;
}

async function setCursor(db: D1Database, scanKey: string, block: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO idx_scan_cursors (scan_key, last_scanned_block, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(scan_key) DO UPDATE SET last_scanned_block = excluded.last_scanned_block, updated_at = excluded.updated_at"
    )
    .bind(scanKey, block, Date.now())
    .run();
}

// Runs one discovery + ingestion pass: factory-clone discovery, then a chunked per-vault event
// scan. Chunk budget (MAX_CHUNKS_PER_TICK) is shared across both phases so one invocation's wall
// time stays bounded; cursors advance after every completed chunk so a mid-tick failure or the
// next scheduled tick simply continues from where this one left off. No reorg rollback — last-
// write-wins on state, append-only on events, same policy docs/stream_indexing.md already
// documents for stream-gateway.
async function runTick(env: Env): Promise<{ vaultsDiscovered: number; eventsIngested: number; chunksUsed: number; head: number }> {
  const db = env.STREAM_DB;
  const provider = new ethers.JsonRpcProvider(env.ARC_RPC_URL);
  const windowBlocks = readPositiveInt(env.SCAN_WINDOW_BLOCKS, 9000);
  const maxChunks = readPositiveInt(env.MAX_CHUNKS_PER_TICK, 20);
  const initialBackfill = readPositiveInt(env.INITIAL_BACKFILL_BLOCKS, 50000);

  const head = await provider.getBlockNumber();
  let chunksUsed = 0;
  let vaultsDiscovered = 0;
  let eventsIngested = 0;

  const canonicalHub = lower(env.OPENRAILS_HUB_ADDRESS);
  await db
    .prepare(
      "INSERT OR IGNORE INTO idx_watched_vaults (vault_address, discovery_source, owner_address, token_address, discovered_at_block, created_at) VALUES (?, 'canonical', NULL, NULL, 0, ?)"
    )
    .bind(canonicalHub, Date.now())
    .run();

  // --- Phase 1: factory discovery ---
  const factoryAddress = lower(env.OPENRAILS_FACTORY_ADDRESS);
  const factoryIface = new ethers.Interface(FACTORY_EVENTS_ABI);
  const factoryEvent = factoryIface.getEvent("CorporateVaultDeployed")!;
  const factoryScanKey = `factory:${factoryAddress}`;

  {
    let from = await getCursor(db, factoryScanKey, Math.max(0, head - initialBackfill));
    while (from <= head && chunksUsed < maxChunks) {
      const to = Math.min(from + windowBlocks - 1, head);
      const logs = await provider.getLogs({
        address: factoryAddress,
        topics: [factoryEvent.topicHash],
        fromBlock: from,
        toBlock: to,
      });
      chunksUsed++;
      for (const log of logs) {
        const parsed = factoryIface.parseLog(log);
        if (!parsed) continue;
        const vaultAddress = lower(parsed.args.vaultAddress as string);
        const owner = lower(parsed.args.owner as string);
        const token = lower(parsed.args.token as string);
        const result = await db
          .prepare(
            "INSERT OR IGNORE INTO idx_watched_vaults (vault_address, discovery_source, owner_address, token_address, discovered_at_block, created_at) VALUES (?, 'factory', ?, ?, ?, ?)"
          )
          .bind(vaultAddress, owner, token, log.blockNumber, Date.now())
          .run();
        if (result.meta.changes) vaultsDiscovered++;
      }
      await setCursor(db, factoryScanKey, to);
      from = to + 1;
    }
  }

  // --- Phase 2: per-vault event scan ---
  const hubIface = new ethers.Interface(HUB_EVENTS_ABI);
  const hubTopics = [
    [
      hubIface.getEvent("PaycardProvisioned")!.topicHash,
      hubIface.getEvent("SettlementFlushed")!.topicHash,
      hubIface.getEvent("ResidualDeltaReclaimed")!.topicHash,
    ],
  ];

  const blockTimestampCache = new Map<number, number>();
  async function blockTimestamp(blockNumber: number): Promise<number> {
    const cached = blockTimestampCache.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await provider.getBlock(blockNumber);
    const ts = block ? Number(block.timestamp) : Math.floor(Date.now() / 1000);
    blockTimestampCache.set(blockNumber, ts);
    return ts;
  }

  const { results: vaults } = await db
    .prepare("SELECT vault_address, discovered_at_block FROM idx_watched_vaults")
    .all<{ vault_address: string; discovered_at_block: number }>();

  for (const v of vaults ?? []) {
    if (chunksUsed >= maxChunks) break;
    const vaultAddress = v.vault_address;
    const defaultStart = v.discovered_at_block > 0 ? v.discovered_at_block : Math.max(0, head - initialBackfill);
    let from = await getCursor(db, vaultAddress, defaultStart);

    while (from <= head && chunksUsed < maxChunks) {
      const to = Math.min(from + windowBlocks - 1, head);
      const logs = await provider.getLogs({ address: vaultAddress, topics: hubTopics, fromBlock: from, toBlock: to });
      chunksUsed++;
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

      for (const log of logs) {
        const parsed = hubIface.parseLog(log);
        if (!parsed) continue;
        const paycardId = lower(parsed.args.paycardId as string);
        const txHash = lower(log.transactionHash);
        const ts = await blockTimestamp(log.blockNumber);
        const metadataHash = parsed.name === "PaycardProvisioned" ? lower(parsed.args.metadataHash as string) : null;

        const insert = await db
          .prepare(
            "INSERT OR IGNORE INTO idx_stream_events (vault_address, paycard_id, event_name, metadata_hash, block_number, block_timestamp, transaction_hash, log_index, args_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(vaultAddress, paycardId, parsed.name, metadataHash, log.blockNumber, ts, txHash, log.index, JSON.stringify(serializeArgs(parsed.args)), Date.now())
          .run();

        if (!insert.meta.changes) continue; // already recorded — idempotent skip, no state mutation
        eventsIngested++;

        if (parsed.name === "PaycardProvisioned") {
          await db
            .prepare(
              `INSERT INTO idx_paycard_state
                 (vault_address, paycard_id, payer, recipient, metadata_hash, total_allocation, available_balance, velocity, genesis, lifespan, last_checkpoint, status, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)
               ON CONFLICT(vault_address, paycard_id) DO UPDATE SET
                 payer = excluded.payer, recipient = excluded.recipient, metadata_hash = excluded.metadata_hash,
                 total_allocation = excluded.total_allocation, available_balance = excluded.available_balance,
                 velocity = excluded.velocity, genesis = excluded.genesis, lifespan = excluded.lifespan,
                 last_checkpoint = excluded.last_checkpoint, status = 'Active', updated_at = excluded.updated_at`
            )
            .bind(
              vaultAddress,
              paycardId,
              lower(parsed.args.payer as string),
              lower(parsed.args.recipient as string),
              lower(parsed.args.metadataHash as string),
              (parsed.args.poolAllocation as bigint).toString(),
              (parsed.args.poolAllocation as bigint).toString(),
              (parsed.args.flowVelocityPerSecond as bigint).toString(),
              Number(parsed.args.genesisTimestamp),
              Number(parsed.args.lifespanSeconds),
              Number(parsed.args.genesisTimestamp),
              Date.now()
            )
            .run();
        } else if (parsed.name === "SettlementFlushed") {
          const existing = await db
            .prepare("SELECT available_balance FROM idx_paycard_state WHERE vault_address = ? AND paycard_id = ?")
            .bind(vaultAddress, paycardId)
            .first<{ available_balance: string }>();
          if (existing) {
            const remaining = BigInt(existing.available_balance) - (parsed.args.amountWithdrawn as bigint);
            const clamped = remaining > 0n ? remaining : 0n;
            await db
              .prepare(
                "UPDATE idx_paycard_state SET available_balance = ?, last_checkpoint = ?, status = ?, updated_at = ? WHERE vault_address = ? AND paycard_id = ?"
              )
              .bind(clamped.toString(), ts, clamped === 0n ? "Terminated" : "Active", Date.now(), vaultAddress, paycardId)
              .run();
          }
          // else: settlement for a paycard this indexer hasn't seen provisioned yet (backfill gap
          // or cross-vault paycardId collision on an unwatched vault) — event is recorded above,
          // state mutation is safely skipped, mirroring the `if (!existing) return;` guard in
          // stream-gateway/index.ts's onSettlementFlushed handler.
        } else if (parsed.name === "ResidualDeltaReclaimed") {
          await db
            .prepare(
              "UPDATE idx_paycard_state SET available_balance = '0', status = 'Terminated', updated_at = ? WHERE vault_address = ? AND paycard_id = ?"
            )
            .bind(Date.now(), vaultAddress, paycardId)
            .run();
        }
      }
      await setCursor(db, vaultAddress, to);
      from = to + 1;
    }
  }

  console.log(
    `[indexer] tick done — head=${head} vaultsDiscovered=${vaultsDiscovered} eventsIngested=${eventsIngested} chunksUsed=${chunksUsed}`
  );
  return { vaultsDiscovered, eventsIngested, chunksUsed, head };
}

async function handleVaults(env: Env): Promise<Response> {
  const { results } = await env.STREAM_DB.prepare(
    "SELECT vault_address, discovery_source, owner_address, token_address, discovered_at_block, created_at FROM idx_watched_vaults ORDER BY created_at ASC"
  ).all<Record<string, unknown>>();
  return jsonResponse({
    authoritative: false,
    disclaimer: DISCLAIMER,
    count: results?.length ?? 0,
    vaults: (results ?? []).map((r) => ({
      vaultAddress: r.vault_address,
      discoverySource: r.discovery_source,
      ownerAddress: r.owner_address,
      tokenAddress: r.token_address,
      discoveredAtBlock: r.discovered_at_block,
    })),
  });
}

async function handleStreams(url: URL, env: Env): Promise<Response> {
  const vaultAddress = url.searchParams.get("vaultAddress");
  const paycardId = url.searchParams.get("paycardId");
  const payer = url.searchParams.get("payer");
  const recipient = url.searchParams.get("recipient");
  const workflowId = url.searchParams.get("workflowId");
  const metadataHash = url.searchParams.get("metadataHash");
  const status = url.searchParams.get("status");

  if (vaultAddress && !isEvmAddress(vaultAddress)) return jsonResponse({ error: "Invalid vaultAddress" }, 400);
  if (paycardId && !isBytes32Hex(paycardId)) return jsonResponse({ error: "Invalid paycardId" }, 400);
  if (metadataHash && !isBytes32Hex(metadataHash)) return jsonResponse({ error: "Invalid metadataHash" }, 400);
  if (status && !["Active", "Terminated"].includes(status)) return jsonResponse({ error: "Invalid status" }, 400);

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (vaultAddress) {
    clauses.push("vault_address = ?");
    binds.push(lower(vaultAddress));
  }
  // Search across every watched vault when vaultAddress is omitted — this is exactly what
  // Explorer's paycardId-collision disambiguation needs (paycardId alone isn't globally unique).
  if (paycardId) {
    clauses.push("paycard_id = ?");
    binds.push(lower(paycardId));
  }
  if (payer) {
    clauses.push("payer = ?");
    binds.push(lower(payer));
  }
  if (recipient) {
    clauses.push("recipient = ?");
    binds.push(lower(recipient));
  }
  if (metadataHash) {
    clauses.push("metadata_hash = ?");
    binds.push(lower(metadataHash));
  }
  if (status) {
    clauses.push("status = ?");
    binds.push(status);
  }
  // workflowId is not derivable from on-chain events alone (see /workflows/:id) — a query asking
  // for one always returns an empty set rather than silently ignoring the filter.
  if (workflowId) clauses.push("1 = 0");

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const stmt = env.STREAM_DB.prepare(`SELECT * FROM idx_paycard_state ${where} ORDER BY updated_at DESC LIMIT 200`);
  const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all<Record<string, unknown>>();

  return jsonResponse({
    authoritative: false,
    disclaimer: DISCLAIMER,
    count: results?.length ?? 0,
    streams: (results ?? []).map(mapStreamRow),
  });
}

async function handleStreamHistory(vaultAddress: string, paycardId: string, env: Env): Promise<Response> {
  if (!isEvmAddress(vaultAddress)) return jsonResponse({ error: "Invalid vaultAddress" }, 400);
  if (!isBytes32Hex(paycardId)) return jsonResponse({ error: "Invalid paycardId" }, 400);
  const va = lower(vaultAddress);
  const pid = lower(paycardId);

  const state = await env.STREAM_DB.prepare("SELECT * FROM idx_paycard_state WHERE vault_address = ? AND paycard_id = ?")
    .bind(va, pid)
    .first<Record<string, unknown>>();
  const { results: events } = await env.STREAM_DB.prepare(
    "SELECT * FROM idx_stream_events WHERE vault_address = ? AND paycard_id = ? ORDER BY block_number ASC, log_index ASC"
  )
    .bind(va, pid)
    .all<Record<string, unknown>>();

  if (!state && (!events || events.length === 0)) {
    return jsonResponse(
      { authoritative: false, disclaimer: DISCLAIMER, vaultAddress: va, paycardId: pid, state: null, events: [] },
      404
    );
  }

  return jsonResponse({
    authoritative: false,
    disclaimer: DISCLAIMER,
    vaultAddress: va,
    paycardId: pid,
    state: state ? mapStreamRow(state) : null,
    events: (events ?? []).map(mapEventRow),
  });
}

function handleWorkflowNotSupported(workflowId: string): Response {
  return jsonResponse(
    {
      authoritative: false,
      disclaimer: DISCLAIMER,
      workflowId,
      streams: [],
      events: [],
      note: "workflowId binding is not available from on-chain events alone (it requires the off-chain bindVerifiedMetadata step stream-gateway uses); not yet implemented in this indexer.",
    },
    501
  );
}

async function handleTransaction(hash: string, env: Env): Promise<Response> {
  if (!isBytes32Hex(hash)) return jsonResponse({ error: "Invalid transaction hash" }, 400);
  const h = lower(hash);

  const { results: events } = await env.STREAM_DB.prepare(
    "SELECT * FROM idx_stream_events WHERE transaction_hash = ? ORDER BY log_index ASC"
  )
    .bind(h)
    .all<Record<string, unknown>>();

  if (!events || events.length === 0) {
    return jsonResponse({ authoritative: false, disclaimer: DISCLAIMER, transactionHash: h, events: [], streams: [] }, 404);
  }

  const pairs = [...new Set(events.map((e) => `${e.vault_address}:${e.paycard_id}`))];
  const streams = [];
  for (const pair of pairs) {
    const [va, pid] = pair.split(":");
    const state = await env.STREAM_DB.prepare("SELECT * FROM idx_paycard_state WHERE vault_address = ? AND paycard_id = ?")
      .bind(va, pid)
      .first<Record<string, unknown>>();
    if (state) streams.push(mapStreamRow(state));
  }

  return jsonResponse({
    authoritative: false,
    disclaimer: DISCLAIMER,
    transactionHash: h,
    events: events.map(mapEventRow),
    streams,
  });
}

export default {
  async scheduled(_event: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil(runTick(env).then(() => undefined));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === "/tick") {
        if (request.method !== "POST") return jsonResponse({ error: "Only POST requests allowed" }, 405);
        if (!env.INDEXER_ADMIN_TOKEN) return jsonResponse({ error: "Indexer admin token is not configured" }, 503);
        if (!authorized(request, env.INDEXER_ADMIN_TOKEN, "X-OpenRails-Admin-Token")) return jsonResponse({ error: "Unauthorized" }, 401);
        const result = await runTick(env);
        return jsonResponse({ success: true, ...result });
      }

      if (request.method !== "GET") return jsonResponse({ error: "Only GET requests allowed" }, 405);

      if (url.pathname === "/vaults") return handleVaults(env);
      if (url.pathname === "/streams") return handleStreams(url, env);

      const historyMatch = url.pathname.match(/^\/streams\/(0x[a-fA-F0-9]{40})\/(0x[a-fA-F0-9]{64})\/history$/);
      if (historyMatch) return handleStreamHistory(historyMatch[1], historyMatch[2], env);

      const workflowMatch = url.pathname.match(/^\/workflows\/(.+)$/);
      if (workflowMatch) return handleWorkflowNotSupported(decodeURIComponent(workflowMatch[1]));

      const txMatch = url.pathname.match(/^\/transactions\/(0x[a-fA-F0-9]{64})$/);
      if (txMatch) return handleTransaction(txMatch[1], env);

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ error: (err as Error).message }, 500);
    }
  },
};
