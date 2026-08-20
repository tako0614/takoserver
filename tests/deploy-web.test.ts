import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { digestDirectory, webSurfaceSpec } from "../scripts/deploy/web.ts";

const target = {
  accountId: "a".repeat(32),
  workerName: "takoserver-api",
  d1: { databaseName: "takoserver-runtime", databaseId: "00000000-0000-4000-8000-000000000000" },
  r2: { bucketName: "takoserver-objects" },
  publicOrigin: "https://api.takoserver.example",
  consoleOrigin: "https://console.takoserver.example",
  siteOrigin: "https://takoserver.example",
  grantKeyId: "runtime-key",
} satisfies DeployTarget;

describe("Takoserver public web release", () => {
  test("gives the console and site independent first-party Worker identities", () => {
    expect(webSurfaceSpec("console", target)).toEqual({
      workerName: "takoserver-console",
      origin: "https://console.takoserver.example",
      probePath: "/console.js",
    });
    expect(webSurfaceSpec("site", target)).toEqual({
      workerName: "takoserver-site",
      origin: "https://takoserver.example",
      probePath: "/",
    });
  });

  test("binds the complete path and bytes of a static release", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-web-digest-"));
    try {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "index.html"), "index");
      writeFileSync(join(root, "nested", "app.js"), "script");
      const first = digestDirectory(root);
      writeFileSync(join(root, "nested", "app.js"), "changed");
      const second = digestDirectory(root);
      expect(first.bytes).toBe(11);
      expect(second.bytes).toBe(12);
      expect(second.digest).not.toBe(first.digest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
