import { mock } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Bun's built-in Undici shim ignores dispatchers. Load the installed package
// with its matching Request/Response classes and dispatchers: Miniflare uses them to retain
// the original URL, request.cf and redirect routing. Close each HTTP connection
// after the response instead of reusing it; failures are never retried.
const require = createRequire(import.meta.url);
const originalUndici = require(
  join(dirname(require.resolve("undici/package.json")), "index.js"),
) as typeof import("undici");
const originalFetch = originalUndici.fetch;
mock.module("undici", () => ({
  ...originalUndici,
  fetch: (
    input: Parameters<typeof originalFetch>[0],
    init?: Parameters<typeof originalFetch>[1],
  ) => {
    const headers = new originalUndici.Headers(
      init?.headers ?? (input instanceof originalUndici.Request ? input.headers : undefined),
    );
    headers.set("connection", "close");
    return originalFetch(input, { ...init, headers });
  },
}));
