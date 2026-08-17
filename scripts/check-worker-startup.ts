import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const output = mkdtempSync(join(tmpdir(), "takoserver-worker-startup-"));

try {
  const child = Bun.spawn(
    [
      resolve(repository, "node_modules/.bin/wrangler"),
      "check",
      "startup",
      "--config",
      resolve(repository, "wrangler.jsonc"),
      "--outfile",
      join(output, "startup.cpuprofile"),
    ],
    { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
