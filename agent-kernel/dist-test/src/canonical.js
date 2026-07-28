import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
function assertSerializable(value, path) {
    if (value === undefined)
        throw new Error(`undefined is not canonical at ${path}`);
    if (typeof value === "number" && !Number.isFinite(value))
        throw new Error(`non-finite number at ${path}`);
    if (typeof value === "bigint")
        throw new Error(`bigint must be encoded as a string at ${path}`);
    if (typeof value === "function" || typeof value === "symbol")
        throw new Error(`unsupported canonical value at ${path}`);
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertSerializable(entry, `${path}[${index}]`));
        return;
    }
    if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value))
            assertSerializable(entry, `${path}.${key}`);
    }
}
function normalize(value) {
    if (Array.isArray(value))
        return value.map(normalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, normalize(entry)]));
    }
    return value;
}
export function canonicalJson(value) {
    assertSerializable(value, "$root");
    return JSON.stringify(normalize(value));
}
export function sha256Hex(value) {
    const hash = createHash("sha256").update(value).digest("hex");
    return `0x${hash}`;
}
export function hashCanonical(value) {
    return sha256Hex(canonicalJson(value));
}
export function stableId(prefix, seed) {
    if (seed !== undefined)
        return `${prefix}_${hashCanonical(seed).slice(2, 18)}`;
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
export function nowIso(now = () => new Date()) {
    return now().toISOString();
}
export function clone(value) {
    return structuredClone(value);
}
export function safeStringEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
export function assertAddress(value, field) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value))
        throw new Error(`${field} must be an EVM address`);
}
export function assertHex32(value, field) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value))
        throw new Error(`${field} must be bytes32`);
}
export function parseBaseUnits(value, field, allowZero = true) {
    if (!/^[0-9]+$/.test(value))
        throw new Error(`${field} must be an unsigned base-unit integer`);
    const parsed = BigInt(value);
    if (!allowZero && parsed === 0n)
        throw new Error(`${field} must be greater than zero`);
    return parsed;
}
export function parseIso(value, field) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
        throw new Error(`${field} must be a valid ISO timestamp`);
    return timestamp;
}
