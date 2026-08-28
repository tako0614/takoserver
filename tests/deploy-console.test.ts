import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConsoleProcess,
  type ConsoleState,
  runConsole,
  writeConsoleConfig,
} from "../scripts/deploy/console.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

const COMMIT = "a".repeat(40);
const CONSOLE_JS = "console.log('takoserver');\n";
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  consoleOrigin: "https://console.integration.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

function fakeProcess(): { readonly run: ConsoleProcess; readonly calls: string[][] } {
  const calls: string[][] = [];
  const run: ConsoleProcess = async (command) => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("feature/console\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (command[0] === "bun" && command[1] === "scripts/build-console.ts") {
      const out = command[command.indexOf("--out") + 1];
      if (!out) throw new Error("console output missing");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "index.html"), "<!doctype html>\n");
      writeFileSync(join(out, "console.js"), CONSOLE_JS);
      return ok("");
    }
    if (command.includes("deploy") && command.includes("--strict")) return ok("uploaded\n");
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function stateSequence(owners: readonly (string | null)[]): ConsoleState {
  let ownerRead = 0;
  let historyRead = 0;
  return {
    async workerDomainOwner() {
      return owners[Math.min(ownerRead++, owners.length - 1)] ?? null;
    },
    async workerDeployments() {
      historyRead += 1;
      return historyRead === 1
        ? [
            {
              id: "deployment-previous",
              created_on: "2026-08-28T01:00:00Z",
              versions: [{ version_id: "version-previous", percentage: 100 }],
            },
          ]
        : [
            {
              id: "deployment-current",
              created_on: "2026-08-28T02:00:00Z",
              versions: [{ version_id: "version-current", percentage: 100 }],
            },
            {
              id: "deployment-previous",
              created_on: "2026-08-28T01:00:00Z",
              versions: [{ version_id: "version-previous", percentage: 100 }],
            },
          ];
    },
    async workerVersion(_worker, version) {
      return {
        id: version,
        annotations: { "workers/message": `takoserver-console ${COMMIT}` },
      };
    },
  };
}

describe("routine Takoserver Console surface", () => {
  test("writes no route or domain mutation into the upload config", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-console-config-"));
    try {
      const assets = join(root, "assets");
      mkdirSync(assets);
      const path = writeConsoleConfig(target, {
        path: join(root, "wrangler.jsonc"),
        assets,
        commit: COMMIT,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config.name).toBe("takoserver-console");
      expect(config).not.toHaveProperty("routes");
      expect(config).not.toHaveProperty("route");
      expect(config).not.toHaveProperty("domains");
      expect(config).not.toHaveProperty("$schema");
      expect(config).toHaveProperty("assets.directory", "assets");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a missing or different current owner before upload", async () => {
    for (const owner of [null, "some-other-worker"] as const) {
      const process = fakeProcess();
      const failure = await runConsole(
        { action: "apply", environment: "integration", commit: COMMIT },
        target,
        {
          run: process.run,
          state: stateSequence([owner]),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(process.calls.some((call) => call.includes("deploy"))).toBe(false);
    }
  });

  test("keeps the exhaustive domain owner unchanged around one sealed upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-console-apply-"));
    try {
      const process = fakeProcess();
      const requests: string[] = [];
      const result = await runConsole(
        { action: "apply", environment: "integration", commit: COMMIT },
        target,
        {
          run: process.run,
          state: stateSequence(["takoserver-console", "takoserver-console"]),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async (input) => {
            requests.push(input);
            return new Response(CONSOLE_JS, { status: 200 });
          },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.console-apply@v2",
        previousVersionId: "version-previous",
        versionId: "version-current",
        domainOwner: "takoserver-console",
      });
      expect(
        process.calls.filter((call) => call.includes("scripts/build-console.ts")),
      ).toHaveLength(1);
      expect(
        process.calls.filter((call) => call.includes("deploy") && call.includes("--strict")),
      ).toHaveLength(1);
      expect(requests).toEqual(["https://console.integration.example.test/console.js"]);
      expect(result.rollback).toContain("--yes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
