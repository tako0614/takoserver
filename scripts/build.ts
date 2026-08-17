import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = mkdtempSync(join(tmpdir(), "takoserver-build-"));
try {
  const result = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: output,
    target: "bun",
    sourcemap: "external",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
