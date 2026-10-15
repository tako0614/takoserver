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
      const japaneseHtml = readFileSync(join(root, "ja", "index.html"), "utf8");
      expect(readFileSync(join(root, "en", "index.html"), "utf8")).toBe(rootHtml);
      expect(japaneseHtml).not.toBe(rootHtml);
      for (const asset of [
        "og.png",
        "fonts/bricolage-grotesque-latin.woff2",
        "fonts/OFL.txt",
        ...["desktop", "mobile"].flatMap((shape) =>
          ["light", "dark"].flatMap((theme) =>
            ["en", "ja"].map((lang) => `screens/console-${shape}-${theme}-${lang}.webp`),
          ),
        ),
      ]) {
        expect(readFileSync(join(root, asset))).toEqual(
          readFileSync(join(import.meta.dir, "..", "site", asset)),
        );
      }
      expect(japaneseHtml).toContain('<html lang="ja">');
      expect(japaneseHtml).toContain("Takoformを、\n自分のクラウドへ。");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
