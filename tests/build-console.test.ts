import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const outputs: string[] = [];

afterEach(() => {
  for (const output of outputs.splice(0)) {
    rmSync(output, { recursive: true, force: true });
  }
});

describe("Takoserver Console build", () => {
  test("ships a Japanese-ready operations Console without retired browse routes", () => {
    const output = mkdtempSync(join(tmpdir(), "takoserver-console-i18n-"));
    outputs.push(output);

    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "scripts/build-console.ts",
        "--out",
        output,
        "--api-origin",
        "https://api.takoserver.com",
      ],
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(build.exitCode).toBe(0);
    const html = readFileSync(join(output, "index.html"), "utf8");
    const script = readFileSync(join(output, "console.js"), "utf8");

    expect(html).toContain('<html lang="ja">');
    expect(script).toContain("使用量と請求");
    expect(script).toContain("リソース");
    expect(script).not.toContain('"/forms"');
    expect(script).not.toContain('"/catalog"');
  });
});
