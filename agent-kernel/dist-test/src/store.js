import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clone } from "./canonical.js";
export function emptyKernelState() {
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
        idempotency: {},
    };
}
class SerializedStore {
    mutationTail = Promise.resolve();
    async transact(operation) {
        const previous = this.mutationTail;
        let release;
        this.mutationTail = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            const draft = clone(await this.load());
            const result = await operation(draft);
            await this.save(draft);
            return clone(result);
        }
        finally {
            release();
        }
    }
}
export class MemoryKernelStore extends SerializedStore {
    state;
    constructor(initial = emptyKernelState()) {
        super();
        this.state = clone(initial);
    }
    async load() { return clone(this.state); }
    async save(state) { this.state = clone(state); }
}
export class JsonFileKernelStore extends SerializedStore {
    filePath;
    constructor(filePath) {
        super();
        this.filePath = filePath;
    }
    async load() {
        try {
            const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
            if (parsed.version !== "openrails-agent-kernel-state-v1")
                throw new Error("unsupported kernel state version");
            return parsed;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return emptyKernelState();
            throw error;
        }
    }
    async save(state) {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.filePath);
    }
}
export class PostgresKernelStore {
    db;
    constructor(db) {
        this.db = db;
    }
    async load() {
        const result = await this.db.query('SELECT state_json FROM openrails_kernel_state WHERE singleton=true');
        const state = result.rows?.[0]?.state_json;
        return state ? clone(state) : emptyKernelState();
    }
    async save(state) {
        await this.db.query(`INSERT INTO openrails_kernel_state(singleton, state_json, updated_at)
       VALUES(true, $1::jsonb, now())
       ON CONFLICT(singleton) DO UPDATE SET state_json=EXCLUDED.state_json, updated_at=now()`, [JSON.stringify(state)]);
    }
    async transact(operation) {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO openrails_kernel_state(singleton, state_json)
         VALUES(true, $1::jsonb)
         ON CONFLICT(singleton) DO NOTHING`, [JSON.stringify(emptyKernelState())]);
            const current = await client.query('SELECT state_json FROM openrails_kernel_state WHERE singleton=true FOR UPDATE');
            const draft = clone(current.rows?.[0]?.state_json ?? emptyKernelState());
            const result = await operation(draft);
            await client.query('UPDATE openrails_kernel_state SET state_json=$1::jsonb, updated_at=now() WHERE singleton=true', [JSON.stringify(draft)]);
            await client.query('COMMIT');
            return clone(result);
        }
        catch (error) {
            try {
                await client.query('ROLLBACK');
            }
            catch { /* preserve original failure */ }
            throw error;
        }
        finally {
            client.release();
        }
    }
}
