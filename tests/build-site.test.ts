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

describe("Takoserver site build", () => {
  test("emits the English default plus explicit English and Japanese routes", () => {
    const output = mkdtempSync(join(tmpdir(), "takoserver-site-i18n-"));
    outputs.push(output);

    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "scripts/build-site.ts",
        "--out",
        output,
        "--console",
        "https://console.takoserver.com",
        "--api",
        "https://api.takoserver.com",
      ],
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(build.exitCode).toBe(0);
    const root = readFileSync(join(output, "index.html"), "utf8");
    const english = readFileSync(join(output, "en", "index.html"), "utf8");
    const japanese = readFileSync(join(output, "ja", "index.html"), "utf8");

    expect(root).toBe(english);
    expect(root).toContain('<html lang="en">');
    expect(japanese).toContain('<html lang="ja">');
    expect(japanese).toContain("移行できるクラウドで、つくろう。");
  });
});
