import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  digestDirectory,
  loadWebDeploymentDeclaration,
  readDeclaredWebRoute,
  readLive,
  runWebRelease,
  webReversalNotice,
  webSurfaceSpec,
} from "../scripts/deploy/web.ts";

const target = {
  accountId: "a".repeat(32),
  workerName: "takoserver-api",
  d1: { databaseName: "takoserver-runtime", databaseId: "00000000-0000-4000-8000-000000000000" },
  r2: { bucketName: "takoserver-objects" },
  publicOrigin: "https://api.takoserver.example",
  consoleOrigin: "https://console.takoserver.example",
  grantKeyId: "runtime-key",
} satisfies DeployTarget;

describe("Takoserver console web release", () => {
  test("keeps the Console on its own first-party Worker identity", () => {
    expect(webSurfaceSpec("console", target)).toEqual({
      workerName: "takoserver-console",
      origin: "https://console.takoserver.example",
      probePath: "/console.js",
    });
  });

  test("binds the console custom-domain declaration to the reviewed account", () => {
    expect(loadWebDeploymentDeclaration("console", target)).toEqual({
      accountIdentity: "sha256:3ba3f5f43b92602683c19aee62a20342b084dd5971ddd33808d81a328879a547",
      workerName: "takoserver-console",
      origin: "https://console.takoserver.example",
      probePath: "/console.js",
      route: { kind: "custom-domain", pattern: "console.takoserver.example" },
    });
  });

  test("retains console route reversal guidance", () => {
    const route = loadWebDeploymentDeclaration("console", target).route;
    expect(webReversalNotice("takoserver-console", route, null)).toContain(
      "remove the exact custom domain console.takoserver.example",
    );
    expect(webReversalNotice("takoserver-console", route, "previous-console")).toContain(
      "reattach custom domain console.takoserver.example to previous-console",
    );
  });

  test("binds every file and byte in a console release", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-console-digest-"));
    try {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "index.html"), "index");
      writeFileSync(join(root, "nested", "console.js"), "script");
      const first = digestDirectory(root);
      writeFileSync(join(root, "nested", "console.js"), "changed");
      const second = digestDirectory(root);
      expect(first.bytes).toBe(11);
      expect(second.bytes).toBe(12);
      expect(second.digest).not.toBe(first.digest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a missing or different account in the console route config", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-console-route-"));
    const path = join(root, "wrangler.jsonc");
    try {
      for (const account_id of [undefined, "b".repeat(32)]) {
        writeFileSync(
          path,
          JSON.stringify({
            name: "takoserver-console",
            workers_dev: false,
            ...(account_id === undefined ? {} : { account_id }),
            routes: [{ pattern: "console.takoserver.example", custom_domain: true }],
          }),
        );
        expect(() =>
          readDeclaredWebRoute("console", target.consoleOrigin ?? "", target.accountId, path),
        ).toThrow("exact reviewed account");
      }
      writeFileSync(
        path,
        JSON.stringify({
          account_id: target.accountId,
          name: "takoserver-console",
          workers_dev: false,
          routes: [{ pattern: "console.takoserver.example", custom_domain: true }],
        }),
      );
      expect(
        readDeclaredWebRoute("console", target.consoleOrigin ?? "", target.accountId, path),
      ).toEqual({ kind: "custom-domain", pattern: "console.takoserver.example" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies console readback timeout and transport failures", async () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const timedOut = await readLive(
      target.consoleOrigin ?? "",
      "/console.js",
      "preflight",
      async () => {
        throw timeout;
      },
    ).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(DeployError);
    expect(timedOut).toMatchObject({
      phase: "preflight",
      message: "public web readback timed out",
    });

    const transport = await readLive(
      target.consoleOrigin ?? "",
      "/console.js",
      "verification",
      async () => {
        throw new TypeError("fetch failed");
      },
    ).catch((error: unknown) => error);
    expect(transport).toBeInstanceOf(DeployError);
    expect(transport).toMatchObject({
      phase: "verification",
      message: "public web readback transport failed",
    });
  });

  test("continues to expose the console release entrypoint", () => {
    expect(runWebRelease).toBeFunction();
  });
});
