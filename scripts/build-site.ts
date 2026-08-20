import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { landingHtml } from "../src/landing.ts";

/**
 * Builds the site served at the apex.
 *
 * The same page the API answers at its own root, as files a static host can
 * serve. One page rather than two written twice: a landing page that drifts
 * from the one the API serves is a landing page that describes a different
 * product.
 *
 *   bun scripts/build-site.ts [--out <dir>] [--console <origin>] [--api <origin>]
 */

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    process.stderr.write(`${flag} needs a value\n`);
    process.exit(2);
  }
  return next;
};

const outDir = value("--out") ?? "site/dist";
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await Bun.write(
  join(outDir, "index.html"),
  landingHtml({
    consoleOrigin: value("--console") ?? null,
    apiOrigin: value("--api") ?? null,
  }),
);
await Bun.write(
  join(outDir, "_headers"),
  "/*\n  Cache-Control: public, max-age=0, must-revalidate, no-transform\n",
);

process.stdout.write(`site built into ${outDir}\n`);
