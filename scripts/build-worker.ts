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
    // The public API Worker owns no parent-provider authority. A credential
    // name or parent REST origin in these bytes means a provider implementation
    // crossed the route-less executor boundary even if the target currently
    // leaves its binding unset.
    for (const forbidden of [
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "TAKOSERVER_WASABI_",
      "api.cloudflare.com/client/v4",
    ]) {
      if (source.includes(forbidden)) {
        throw new Error(
          `Worker bundle contains forbidden REST or credential surface: ${forbidden}`,
        );
      }
    }
    for (const binding of ["STATE_DB", "OBJECTS", "AI", "CLOUDFLARE_PROVIDER_EXECUTOR"]) {
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
