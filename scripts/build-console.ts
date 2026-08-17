import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Builds the console into `console/dist`.
 *
 * The output is a plain directory of files with no server behind it: one HTML
 * entry, one script, one stylesheet, and an icon. That is the whole contract,
 * and it is what lets the console be deployed through Takoserver's own
 * StaticAssetBundle Form rather than needing a build step at the edge.
 *
 *   bun scripts/build-console.ts [--out <dir>] [--api-origin <origin>]
 *
 * `--api-origin` is stamped into the HTML. Without it the console works out
 * where the API is from its own hostname, which is right for the deployed case
 * and wrong for anyone serving the bundle from somewhere else.
 */

const args = process.argv.slice(2);
const outDir = value("--out") ?? "console/dist";
const apiOrigin = value("--api-origin");

function value(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    process.stderr.write(`${flag} needs a value\n`);
    process.exit(2);
  }
  return next;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const built = await Bun.build({
  entrypoints: ["console/src/main.ts"],
  target: "browser",
  minify: true,
  // A single file keeps the manifest small and the load one round trip; the
  // console is far too small for splitting to buy anything.
  splitting: false,
  naming: "console.js",
  outdir: outDir,
});

if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

cpSync("console/app.css", join(outDir, "app.css"));
cpSync("console/favicon.svg", join(outDir, "favicon.svg"));

let html = await Bun.file("console/index.html").text();
if (apiOrigin !== undefined) {
  // Stamped on the root element, where `state.ts` reads it before the first
  // request is made.
  html = html.replace(
    '<html lang="en">',
    `<html lang="en" data-api-origin="${escapeHtml(apiOrigin)}">`,
  );
}
await Bun.write(join(outDir, "index.html"), html);

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const bytes = (await Bun.file(join(outDir, "console.js")).arrayBuffer()).byteLength;
process.stdout.write(`console built into ${outDir} (${(bytes / 1024).toFixed(1)} kB of script)\n`);
