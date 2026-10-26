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
mock.module("undici", () => installedUndici);
mock.module("node:worker_threads", () => ({
  ...threads,
  Worker: class extends OriginalWorker {
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
    }
  },
}));
