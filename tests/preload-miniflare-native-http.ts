import { mock } from "bun:test";
import { createRequire } from "node:module";

// Keep Miniflare's native Request/Response types and other Undici exports.
// Only its HTTP requests use the native client without connection reuse.
// Status/schema reads still cross the actual local Workerd HTTP routes;
// failures are never retried.
const originalUndici = createRequire(import.meta.url)("undici");
const nativeFetch = globalThis.fetch;
mock.module("undici", () => ({
  ...originalUndici,
  fetch: (input: Parameters<typeof nativeFetch>[0], init?: Parameters<typeof nativeFetch>[1]) =>
    nativeFetch(input, { ...init, keepalive: false }),
}));
