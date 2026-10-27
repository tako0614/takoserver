import { mock } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "node:worker_threads";

// Bun's built-in Undici shim ignores dispatchers. Load the installed package
// with its matching Request/Response classes and dispatchers: Miniflare uses them to retain
// the original URL, request.cf and redirect routing. Close each HTTP connection
// after the response instead of reusing it; failures are never retried.
const require = createRequire(import.meta.url);
const installedUndici = require("./preload-miniflare-undici.cjs") as typeof import("undici");
const threads = require("node:worker_threads") as typeof import("node:worker_threads");
const OriginalWorker = threads.Worker;
const miniflareEntry = require.resolve("miniflare");
const preload = fileURLToPath(new URL("./preload-miniflare-undici.cjs", import.meta.url));
type Options = WorkerOptions & { preload?: string | string[] };
// Test evidence for the SDK's own CJS construction, across real binding access.
export const miniflareHttpThreadStarts: string[] = [];
mock.module("undici", () => installedUndici);
class MiniflareHttpWorker extends OriginalWorker {
  constructor(filename: string | URL, options?: Options) {
    // Only Miniflare's eval thread uses this owning filename. Keep every
    // other Worker and its options unchanged; never rewrite the SDK script.
    const selected = options?.eval === true && options.workerData?.filename === miniflareEntry;
    const existing = options?.preload;
    super(
      filename,
      selected
        ? {
            ...options,
            preload: [...(typeof existing === "string" ? [existing] : (existing ?? [])), preload],
          }
        : options,
    );
    if (selected) miniflareHttpThreadStarts.push(miniflareEntry);
  }
}
// Bun's ESM mock does not replace the builtin object returned by CJS require.
// Miniflare uses that object, so install the same constructor in both paths.
Object.defineProperty(threads, "Worker", { value: MiniflareHttpWorker });
mock.module("node:worker_threads", () => threads);
