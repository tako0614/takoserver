import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { digestDirectory, readLive, runWebRelease, webSurfaceSpec } from "../scripts/deploy/web.ts";

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

  test("classifies a timed out readback instead of leaking TimeoutError", async () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const failure = await readLive(target.siteOrigin, "/", "preflight", async () => {
      throw timeout;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DeployError);
    expect(failure).not.toBe(timeout);
    expect(failure).toMatchObject({
      phase: "preflight",
      message: "public web readback timed out",
    });
    expect((failure as DeployError).detail).toContain("timeout");
  });

  test("classifies a transport readback failure without changing its phase", async () => {
    const failure = await readLive(target.siteOrigin, "/", "verification", async () => {
      throw new TypeError("fetch failed");
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DeployError);
    expect(failure).toMatchObject({
      phase: "verification",
      message: "public web readback transport failed",
    });
    expect((failure as DeployError).detail).toContain("transport");
  });

  test("fails closed when the public site answers with an upstream error", async () => {
    const fetchHost = globalThis as unknown as {
      fetch: (input: string, init?: RequestInit) => Promise<Response>;
    };
    const originalFetch = fetchHost.fetch;
    let requests = 0;
    fetchHost.fetch = async () => {
      requests += 1;
      return new Response("upstream unavailable", { status: 522 });
    };
    try {
      const failure = await runWebRelease("site", "status", target).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure).toMatchObject({
        phase: "preflight",
        message: "public site readback returned HTTP 522",
      });
      expect(requests).toBe(1);
    } finally {
      fetchHost.fetch = originalFetch;
    }
  });
});
