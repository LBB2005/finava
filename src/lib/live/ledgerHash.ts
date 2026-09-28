import { createHash } from "node:crypto";
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The chain step. Exported so an external verifier can recompute it. */
export function hashEntry(payload: unknown, prevHash: string): string {
  return createHash("sha256").update(canonicalJson(payload)).update(prevHash).digest("hex");
}

