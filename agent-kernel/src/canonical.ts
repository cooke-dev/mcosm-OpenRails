import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Hex } from "./types.js";

function assertSerializable(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`undefined is not canonical at ${path}`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
  if (typeof value === "bigint") throw new Error(`bigint must be encoded as a string at ${path}`);
  if (typeof value === "function" || typeof value === "symbol") throw new Error(`unsupported canonical value at ${path}`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSerializable(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertSerializable(entry, `${path}.${key}`);
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  assertSerializable(value, "$root");
  return JSON.stringify(normalize(value));
}

export function sha256Hex(value: string | Uint8Array): Hex {
  const hash = createHash("sha256").update(value).digest("hex");
  return `0x${hash}`;
}

export function hashCanonical(value: unknown): Hex {
  return sha256Hex(canonicalJson(value));
}

export function stableId(prefix: string, seed?: unknown): string {
  if (seed !== undefined) return `${prefix}_${hashCanonical(seed).slice(2, 18)}`;
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function nowIso(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function safeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function assertAddress(value: string, field: string): asserts value is `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${field} must be an EVM address`);
}

export function assertHex32(value: string, field: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${field} must be bytes32`);
}

export function parseBaseUnits(value: string, field: string, allowZero = true): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${field} must be an unsigned base-unit integer`);
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) throw new Error(`${field} must be greater than zero`);
  return parsed;
}

export function parseIso(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid ISO timestamp`);
  return timestamp;
}
