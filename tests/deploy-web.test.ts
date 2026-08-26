import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  digestDirectory,
  inspectSiteReleaseState,
  loadWebDeploymentDeclaration,
  readDeclaredWebRoute,
  readLive,
  readSiteRouteOwner,
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

  test("binds one value-free reviewed account identity to the site deployment declaration", () => {
    expect(loadWebDeploymentDeclaration("site", target)).toEqual({
      accountIdentity: "sha256:3ba3f5f43b92602683c19aee62a20342b084dd5971ddd33808d81a328879a547",
      workerName: "takoserver-site",
      origin: "https://takoserver.example",
      probePath: "/",
      route: {
        kind: "zone-route",
        pattern: "takoserver.example/*",
        zoneName: "takoserver.example",
      },
    });
  });

  test("restores an absent previous route owner by removing the exact route", () => {
    const route = loadWebDeploymentDeclaration("site", target).route;
    const noOwner = webReversalNotice("takoserver-site", route, null);
    expect(noOwner).toContain("remove the exact Worker route takoserver.example/*");
    expect(noOwner).toContain("restore no owner");
    expect(noOwner).not.toContain("reattach");

    const previousOwner = webReversalNotice("takoserver-site", route, "previous-site");
    expect(previousOwner).toContain("reattach Worker route takoserver.example/* to previous-site");
    expect(previousOwner).not.toContain("restore no owner");
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

  test("reads the exact site route through Wrangler-managed authority without an env token", async () => {
    const requests: string[] = [];
    const bearer = "wrangler-managed-route-token";
    const owner = await readSiteRouteOwner(target.accountId, "takoserver.example", {
      env: {},
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ type: "oauth", token: bearer }),
        stderr: "",
      }),
      fetcher: async (input, init) => {
        requests.push(input);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${bearer}`);
        if (input.includes("/zones?")) {
          return Response.json({
            success: true,
            result: [
              {
                id: "zone-id",
                name: "takoserver.example",
                account: { id: target.accountId },
              },
            ],
          });
        }
        return Response.json({
          success: true,
          result: [{ pattern: "takoserver.example/*", script: "takoserver-site" }],
        });
      },
    });

    expect(owner).toBe("takoserver-site");
    expect(requests).toEqual([
      `https://api.cloudflare.com/client/v4/zones?name=takoserver.example&account.id=${target.accountId}`,
      "https://api.cloudflare.com/client/v4/zones/zone-id/workers/routes",
    ]);
    expect(JSON.stringify({ owner, requests })).not.toContain(bearer);
  });

  test("rejects malformed Cloudflare inventory envelopes with fixed preflight diagnostics", async () => {
    const validZone = {
      success: true,
      result: [
        {
          id: "zone-id",
          name: "takoserver.example",
          account: { id: target.accountId },
        },
      ],
    };
    for (const fixture of [
      {
        zones: { success: false, result: validZone.result },
        routes: { success: true, result: [] },
        message: "Cloudflare zone inventory returned malformed response",
      },
      {
        zones: validZone,
        routes: { success: true, result: {} },
        message: "Cloudflare Worker route inventory returned malformed response",
      },
    ]) {
      const failure = await readSiteRouteOwner(target.accountId, "takoserver.example", {
        env: { CLOUDFLARE_API_TOKEN: "existing-route-inventory-token" },
        fetcher: async (input) =>
          Response.json(input.includes("/zones?") ? fixture.zones : fixture.routes),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DeployError);
      expect(failure).toMatchObject({ phase: "preflight", message: fixture.message });
    }
  });

  test("refuses a missing or wrong site route before Wrangler can publish", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-web-route-"));
    const path = join(root, "wrangler.jsonc");
    try {
      for (const routes of [
        [],
        [{ pattern: "other.example/*", zone_name: "takoserver.example" }],
        [{ pattern: "takoserver.example/*", zone_name: "other.example" }],
        [{ pattern: "takoserver.example", custom_domain: true }],
      ]) {
        writeFileSync(
          path,
          JSON.stringify({
            account_id: target.accountId,
            name: "takoserver-site",
            workers_dev: false,
            routes,
          }),
        );
        expect(() =>
          readDeclaredWebRoute("site", "https://takoserver.example", target.accountId, path),
        ).toThrow("exact zone route");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a missing or different account in the exact site deploy config", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-web-account-"));
    const path = join(root, "wrangler.jsonc");
    const route = { pattern: "takoserver.example/*", zone_name: "takoserver.example" };
    try {
      for (const account_id of [undefined, "b".repeat(32)]) {
        writeFileSync(
          path,
          JSON.stringify({
            name: "takoserver-site",
            workers_dev: false,
            ...(account_id === undefined ? {} : { account_id }),
            routes: [route],
          }),
        );
        expect(() =>
          readDeclaredWebRoute("site", "https://takoserver.example", target.accountId, path),
        ).toThrow("exact reviewed account");
      }
      writeFileSync(
        path,
        JSON.stringify({
          account_id: target.accountId,
          name: "takoserver-site",
          workers_dev: false,
          routes: [route],
        }),
      );
      expect(
        readDeclaredWebRoute("site", "https://takoserver.example", target.accountId, path),
      ).toEqual({
        kind: "zone-route",
        pattern: "takoserver.example/*",
        zoneName: "takoserver.example",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("collects route and public state for a repair plan even when the apex is 522", async () => {
    const evidence = await inspectSiteReleaseState(
      target.accountId,
      "https://takoserver.example",
      "/",
      {
        env: {},
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ type: "oauth", token: "wrangler-managed-route-token" }),
          stderr: "",
        }),
        routeFetcher: async (input) => {
          if (input.includes("/zones?")) {
            return Response.json({
              success: true,
              result: [
                {
                  id: "zone-id",
                  name: "takoserver.example",
                  account: { id: target.accountId },
                },
              ],
            });
          }
          return Response.json({ success: true, result: [] });
        },
        publicFetcher: async () => new Response("upstream timeout", { status: 522 }),
      },
    );

    expect(evidence).toEqual({
      routeOwner: null,
      publicState: {
        outcome: "response",
        status: 522,
        digest: "sha256:0bfc357562b94773cdcaebc29cb8870640b64f9aed0515abb053b42f01924058",
        bytes: 16,
      },
    });
  });

  test("records a bounded public timeout as plan evidence instead of hiding the route state", async () => {
    const evidence = await inspectSiteReleaseState(
      target.accountId,
      "https://takoserver.example",
      "/",
      {
        env: { CLOUDFLARE_API_TOKEN: "existing-route-inventory-token" },
        routeFetcher: async (input) => {
          if (input.includes("/zones?")) {
            return Response.json({
              success: true,
              result: [
                {
                  id: "zone-id",
                  name: "takoserver.example",
                  account: { id: target.accountId },
                },
              ],
            });
          }
          return Response.json({ success: true, result: [] });
        },
        publicFetcher: async () => {
          throw new DOMException("The operation timed out", "TimeoutError");
        },
      },
    );

    expect(evidence).toEqual({
      routeOwner: null,
      publicState: {
        outcome: "timeout",
        status: null,
        digest: null,
        bytes: null,
      },
    });
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

  test("site status reports route ownership and an upstream error for recovery", async () => {
    const fetchHost = globalThis as unknown as {
      fetch: (input: string, init?: RequestInit) => Promise<Response>;
    };
    const originalFetch = fetchHost.fetch;
    const originalToken = process.env.CLOUDFLARE_API_TOKEN;
    const originalWrite = process.stdout.write;
    let requests = 0;
    let output = "";
    process.env.CLOUDFLARE_API_TOKEN = "existing-route-inventory-token";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    fetchHost.fetch = async (input) => {
      requests += 1;
      if (input.includes("/zones?")) {
        return Response.json({
          success: true,
          result: [
            {
              id: "zone-id",
              name: "takoserver.example",
              account: { id: target.accountId },
            },
          ],
        });
      }
      if (input.includes("/workers/routes")) {
        return Response.json({ success: true, result: [] });
      }
      return new Response("upstream unavailable", { status: 522 });
    };
    try {
      await runWebRelease("site", "status", target);
      expect(JSON.parse(output)).toMatchObject({
        surface: "site",
        accountIdentity: "sha256:3ba3f5f43b92602683c19aee62a20342b084dd5971ddd33808d81a328879a547",
        workerName: "takoserver-site",
        route: {
          kind: "zone-route",
          pattern: "takoserver.example/*",
          zoneName: "takoserver.example",
        },
        routeOwner: null,
        publicState: { outcome: "response", status: 522 },
      });
      expect(output).not.toContain("existing-route-inventory-token");
      expect(output).not.toContain(target.accountId);
      expect(requests).toBe(3);
    } finally {
      fetchHost.fetch = originalFetch;
      process.stdout.write = originalWrite;
      if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = originalToken;
    }
  });
});
