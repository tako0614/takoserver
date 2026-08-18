import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const output = mkdtempSync(join(tmpdir(), "takoserver-worker-build-"));

try {
  const result = Bun.spawn(
    [
      resolve(repository, "node_modules/.bin/wrangler"),
      "deploy",
      "--dry-run",
      "--strict",
      "--config",
      resolve(repository, "wrangler.jsonc"),
      "--outdir",
      output,
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    result.exited,
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
  ]);
  if (exitCode !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = 1;
  } else {
    const bundles = files(output).filter((path) => path.endsWith(".js"));
    if (bundles.length === 0) throw new Error("Wrangler dry-run produced no JavaScript bundle");
    const source = bundles.map((path) => readFileSync(path, "utf8")).join("\n");
    // Long-lived S3 keys have no business in an edge bundle: nothing here
    // needs them, and unlike a Worker secret they cannot be rotated by the
    // platform that issued them. The Cloudflare REST origin and the name of a
    // secret are no longer refused — naming a secret is how a Worker reads
    // one, and a gate that forbids the name only teaches people to spell it
    // differently. See docs/adr/0001-provision-from-the-worker.md.
    for (const forbidden of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
      if (source.includes(forbidden)) {
        throw new Error(
          `Worker bundle contains forbidden REST or credential surface: ${forbidden}`,
        );
      }
    }
    for (const binding of ["STATE_DB", "OBJECTS", "AI"]) {
      if (!source.includes(binding)) throw new Error(`Worker bundle does not use ${binding}`);
    }
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
