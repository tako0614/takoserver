import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPOSITORY } from "../../scripts/deploy/process.ts";

/**
 * Resolve the Wrangler owned by the checkout under test.
 *
 * The public package is normally tested with its own `node_modules`, but the
 * same source is also walked from a private composition where Bun installs the
 * package's runtime copy without its dev dependencies.  In that layout the
 * composition's exact Wrangler is two levels above the vendored checkout.
 * Falling back to PATH keeps an ordinary standalone checkout usable while
 * still preferring a checkout-owned binary in both layouts.
 */
export function wranglerPathForTests(): string {
  const candidates = [
    resolve(REPOSITORY, "node_modules/.bin/wrangler"),
    resolve(REPOSITORY, "../..", "node_modules/.bin/wrangler"),
    Bun.which("wrangler"),
  ];
  const path = candidates.find(
    (candidate): candidate is string =>
      candidate !== null && candidate !== undefined && existsSync(candidate),
  );
  if (path === undefined) throw new Error("Wrangler is not installed in the test checkout");
  return path;
}
