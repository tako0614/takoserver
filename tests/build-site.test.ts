import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Takoserver public site build", () => {
  test("publishes stable Japanese and English entry paths", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-site-build-"));
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "scripts/build-site.ts",
          "--out",
          root,
          "--console",
          "https://console.takoserver.example",
          "--api",
          "https://api.takoserver.example",
        ],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const rootHtml = readFileSync(join(root, "index.html"), "utf8");
      expect(readFileSync(join(root, "ja", "index.html"), "utf8")).toBe(rootHtml);
      expect(readFileSync(join(root, "en", "index.html"), "utf8")).toBe(rootHtml);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
