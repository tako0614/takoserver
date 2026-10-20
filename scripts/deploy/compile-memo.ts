import { createHash } from "node:crypto";

// Deterministic schema compilations keyed by the exact bytes they read. Every
// caller still reads (and verifies) its inputs; only the derived result is
// reused, so a changed byte is a different key. Failures are never remembered.
const results = new Map<string, unknown>();
const LIMIT = 32;

export function memoByContent<T>(
  scope: string,
  contents: readonly (string | Uint8Array)[],
  compute: () => T,
): T {
  const hash = createHash("sha256").update(scope).update("\0");
  for (const content of contents) {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    hash.update(String(bytes.byteLength)).update("\0").update(bytes);
  }
  const key = hash.digest("hex");
  if (results.has(key)) return results.get(key) as T;
  const value = compute();
  if (results.size >= LIMIT) results.clear();
  results.set(key, value);
  return value;
}
