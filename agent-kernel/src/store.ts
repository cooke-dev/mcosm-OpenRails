import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KernelStateV1 } from "./types.js";
import { clone } from "./canonical.js";

export function emptyKernelState(): KernelStateV1 {
  return {
    version: "openrails-agent-kernel-state-v1",
    workspaces: {},
    workspaceArtifacts: {},
    agents: {},
    agentArtifacts: {},
    paths: {},
    pacts: {},
    pactSignatures: {},
    pactEvents: [],
    proposals: {},
    decisions: {},
    blockedActions: [],
    plugins: {},
    checkpoints: {},
    verificationDecisions: {},
    gaiaCases: {},
    rectifications: {},
    jobs: {},
    events: [],
    workspaceCommandNonces: {},
    idempotency: {},
  };
}

export function normalizeKernelState(state: KernelStateV1): KernelStateV1 {
  if (state.version !== "openrails-agent-kernel-state-v1") throw new Error("unsupported kernel state version");
  return {
    ...emptyKernelState(),
    ...state,
    workspaceCommandNonces: state.workspaceCommandNonces ?? {},
  };
}

export interface KernelStore {
  load(): Promise<KernelStateV1>;
  save(state: KernelStateV1): Promise<void>;
  transact<T>(operation: (draft: KernelStateV1) => Promise<T> | T): Promise<T>;
}

abstract class SerializedStore implements KernelStore {
  private mutationTail: Promise<void> = Promise.resolve();

  abstract load(): Promise<KernelStateV1>;
  abstract save(state: KernelStateV1): Promise<void>;

  async transact<T>(operation: (draft: KernelStateV1) => Promise<T> | T): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const draft = clone(await this.load());
      const result = await operation(draft);
      await this.save(draft);
      return clone(result);
    } finally {
      release();
    }
  }
}

export class MemoryKernelStore extends SerializedStore {
  private state: KernelStateV1;

  constructor(initial: KernelStateV1 = emptyKernelState()) {
    super();
    this.state = normalizeKernelState(clone(initial));
  }

  async load(): Promise<KernelStateV1> { return clone(this.state); }
  async save(state: KernelStateV1): Promise<void> { this.state = clone(state); }
}

export class JsonFileKernelStore extends SerializedStore {
  constructor(private readonly filePath: string) { super(); }

  async load(): Promise<KernelStateV1> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as KernelStateV1;
      return normalizeKernelState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyKernelState();
      throw error;
    }
  }

  async save(state: KernelStateV1): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export interface PostgresKernelTransactionClient {
  query(text: string, values?: unknown[]): Promise<{ rows?: Array<Record<string, any>>; rowCount?: number }>;
  release(): void;
}

export interface PostgresKernelExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows?: Array<Record<string, any>>; rowCount?: number }>;
  connect(): Promise<PostgresKernelTransactionClient>;
}

export class PostgresKernelStore implements KernelStore {
  constructor(private readonly db: PostgresKernelExecutor) {}

  async load(): Promise<KernelStateV1> {
    const result = await this.db.query('SELECT state_json FROM openrails_kernel_state WHERE singleton=true');
    const state = result.rows?.[0]?.state_json as KernelStateV1 | undefined;
    return state ? normalizeKernelState(clone(state)) : emptyKernelState();
  }

  async save(state: KernelStateV1): Promise<void> {
    await this.db.query(
      `INSERT INTO openrails_kernel_state(singleton, state_json, updated_at)
       VALUES(true, $1::jsonb, now())
       ON CONFLICT(singleton) DO UPDATE SET state_json=EXCLUDED.state_json, updated_at=now()`,
      [JSON.stringify(state)],
    );
  }

  async transact<T>(operation: (draft: KernelStateV1) => Promise<T> | T): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO openrails_kernel_state(singleton, state_json)
         VALUES(true, $1::jsonb)
         ON CONFLICT(singleton) DO NOTHING`,
        [JSON.stringify(emptyKernelState())],
      );
      const current = await client.query('SELECT state_json FROM openrails_kernel_state WHERE singleton=true FOR UPDATE');
      const draft = normalizeKernelState(clone((current.rows?.[0]?.state_json as KernelStateV1 | undefined) ?? emptyKernelState()));
      const result = await operation(draft);
      await client.query('UPDATE openrails_kernel_state SET state_json=$1::jsonb, updated_at=now() WHERE singleton=true', [JSON.stringify(draft)]);
      await client.query('COMMIT');
      return clone(result);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }
}
