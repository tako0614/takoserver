import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSOLE_WORKER,
  type ConsoleProcess,
  type ConsoleState,
  consolePlacement,
  runConsole,
  writeConsoleConfig,
} from "../scripts/deploy/console.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

const COMMIT = "a".repeat(40);
const CONSOLE_JS = "console.log('takoserver');\n";
const ACCOUNT_SUBDOMAIN = "example-account";
const INTEGRATION_CONSOLE = "takoserver-console-integration";
const INTEGRATION_ORIGIN = `https://${INTEGRATION_CONSOLE}.${ACCOUNT_SUBDOMAIN}.workers.dev`;

/** Production and rehearsal: the one Console on its custom domain. */
const rehearsal = {
  kind: "takoserver.deploy-target@v2",
  environment: "rehearsal",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-rehearsal",
  d1: {
    databaseName: "takoserver-runtime-rehearsal",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-rehearsal" },
  publicOrigin: "https://api.rehearsal.example.test",
  consoleOrigin: "https://console.rehearsal.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

/** Integration: its own Console Worker on its own workers.dev origin. */
const integration = {
  ...rehearsal,
  environment: "integration",
  workerName: "takoserver-api-integration-stripe-0091",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000001",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: `https://takoserver-api-integration-stripe-0091.${ACCOUNT_SUBDOMAIN}.workers.dev`,
  consoleOrigin: INTEGRATION_ORIGIN,
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

function deployment(id: string, version: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: version, percentage: 100 }] };
}

/**
 * Records every name and hostname the surface reads, so a test can prove which
 * Cloudflare objects an invocation touched.
 */
function recordingState(
  options: {
    readonly workerName?: string;
    readonly owners?: readonly (string | null)[];
    readonly existing?: boolean;
    readonly previousMessage?: string;
    readonly accountSubdomain?: string;
    readonly served?: { readonly enabled: boolean; readonly previewsEnabled: boolean };
  } = {},
) {
  const workerName = options.workerName ?? CONSOLE_WORKER;
  const owners = options.owners ?? [CONSOLE_WORKER, CONSOLE_WORKER];
  const workerNames: string[] = [];
  const hostnames: string[] = [];
  let ownerRead = 0;
  let historyRead = 0;
  const state: ConsoleState = {
    async workerDomainOwner(hostname) {
      hostnames.push(hostname);
      return owners[Math.min(ownerRead++, owners.length - 1)] ?? null;
    },
    async workerDeployments(name) {
      workerNames.push(name);
      historyRead += 1;
      const previous = deployment(
        "deployment-previous",
        "version-previous",
        "2026-08-28T01:00:00Z",
      );
      if (historyRead === 1) return options.existing === false ? [] : [previous];
      const current = deployment("deployment-current", "version-current", "2026-08-28T02:00:00Z");
      return options.existing === false ? [current] : [current, previous];
    },
    async workerVersion(name, version) {
      workerNames.push(name);
      return {
        id: version,
        annotations: {
          "workers/message":
            version === "version-previous"
              ? (options.previousMessage ?? `${workerName} ${"b".repeat(40)}`)
              : `${workerName} ${COMMIT}`,
        },
      };
    },
    async workerAccountSubdomain() {
      return options.accountSubdomain ?? ACCOUNT_SUBDOMAIN;
    },
    async workerSubdomain(name) {
      workerNames.push(name);
      return options.served ?? { enabled: true, previewsEnabled: false };
    },
  };
  return { state, workerNames, hostnames };
}

function config(target: DeployTarget): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "takoserver-console-config-"));
  try {
    const assets = join(root, "assets");
    mkdirSync(assets);
    const path = writeConsoleConfig(target, {
      path: join(root, "wrangler.jsonc"),
      assets,
      commit: COMMIT,
    });
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("routine Takoserver Console surface: custom-domain Console", () => {
  test("writes no route or domain mutation into the upload config", () => {
    const written = config(rehearsal);
    expect(written.name).toBe(CONSOLE_WORKER);
    expect(written.workers_dev).toBe(false);
    expect(written).not.toHaveProperty("routes");
    expect(written).not.toHaveProperty("route");
    expect(written).not.toHaveProperty("domains");
    expect(written).not.toHaveProperty("$schema");
    expect(written).toHaveProperty("assets.directory", "assets");
  });

  test("refuses a missing or different current owner before upload", async () => {
    for (const owner of [null, "some-other-worker"] as const) {
      const process = fakeProcess();
      const failure = await runConsole(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        rehearsal,
        {
          run: process.run,
          state: recordingState({ owners: [owner] }).state,
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
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        rehearsal,
        {
          run: process.run,
          state: recordingState().state,
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
        workerName: CONSOLE_WORKER,
        topology: "custom-domain",
        previousVersionId: "version-previous",
        versionId: "version-current",
        domainOwner: CONSOLE_WORKER,
      });
      expect(
        process.calls.filter((call) => call.includes("scripts/build-console.ts")),
      ).toHaveLength(1);
      expect(
        process.calls.filter((call) => call.includes("deploy") && call.includes("--strict")),
      ).toHaveLength(1);
      expect(requests).toEqual(["https://console.rehearsal.example.test/console.js"]);
      expect(result.rollback).toContain("--yes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("routine Takoserver Console surface: integration Console", () => {
  test("derives its own Worker and workers.dev origin from the target", () => {
    expect(consolePlacement(integration, "integration")).toEqual({
      topology: "workers-dev",
      workerName: INTEGRATION_CONSOLE,
      hostname: `${INTEGRATION_CONSOLE}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      accountSubdomain: ACCOUNT_SUBDOMAIN,
    });
    // Production and rehearsal keep the one custom-domain Console.
    for (const environment of ["production", "rehearsal"] as const) {
      expect(consolePlacement(rehearsal, environment)).toMatchObject({
        topology: "custom-domain",
        workerName: CONSOLE_WORKER,
      });
    }
  });

  test("never names the production Console, a custom domain, or another Worker", () => {
    const refused = [
      // a custom domain, like production's
      "https://console.integration.example.test",
      // the production Console Worker on workers.dev
      `https://${CONSOLE_WORKER}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      // not a Console Worker
      `https://evil.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      `https://takoserver-console-.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      // the API Worker itself
      `https://takoserver-api-integration-stripe-0091.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      // not exactly an origin on workers.dev
      `http://${INTEGRATION_CONSOLE}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      `https://${INTEGRATION_CONSOLE}.${ACCOUNT_SUBDOMAIN}.workers.dev:8443`,
      `https://${INTEGRATION_CONSOLE}.${ACCOUNT_SUBDOMAIN}.workers.dev/app`,
      `https://${INTEGRATION_CONSOLE}.workers.dev`,
      `https://${INTEGRATION_CONSOLE}.${ACCOUNT_SUBDOMAIN}.workers.dev.example.test`,
    ];
    for (const consoleOrigin of refused) {
      expect(() => consolePlacement({ ...integration, consoleOrigin }, "integration")).toThrow(
        DeployError,
      );
    }
    const { consoleOrigin: _origin, ...withoutConsole } = integration;
    expect(() => consolePlacement(withoutConsole, "integration")).toThrow("no consoleOrigin");
  });

  test("writes its own Worker on workers.dev with previews off and no route or domain", () => {
    const written = config(integration);
    expect(written.name).toBe(INTEGRATION_CONSOLE);
    expect(written.workers_dev).toBe(true);
    expect(written.preview_urls).toBe(false);
    expect(written).not.toHaveProperty("routes");
    expect(written).not.toHaveProperty("route");
    expect(written).not.toHaveProperty("domains");
  });

  test("refuses a production-named target before any credential, provider or process call", async () => {
    let stateCalls = 0;
    const trap = async (): Promise<never> => {
      stateCalls += 1;
      throw new Error("no provider read is allowed");
    };
    const process = fakeProcess();
    for (const consoleOrigin of [
      `https://${CONSOLE_WORKER}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      "https://console.takoserver.example.test",
    ]) {
      const failure = await runConsole(
        { action: "apply", environment: "integration", commit: COMMIT },
        { ...integration, consoleOrigin },
        {
          run: process.run,
          state: {
            workerDomainOwner: trap,
            workerDeployments: trap,
            workerVersion: trap,
            workerAccountSubdomain: trap,
            workerSubdomain: trap,
          },
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
    }
    expect(stateCalls).toBe(0);
    expect(process.calls).toEqual([]);
  });

  test("uploads once to its own Worker and never reads the production Console or a custom domain", async () => {
    for (const existing of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), "takoserver-console-integration-"));
      try {
        const process = fakeProcess();
        const recorded = recordingState({ workerName: INTEGRATION_CONSOLE, existing });
        const requests: string[] = [];
        const result = await runConsole(
          { action: "apply", environment: "integration", commit: COMMIT },
          integration,
          {
            run: process.run,
            state: recorded.state,
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
          workerName: INTEGRATION_CONSOLE,
          topology: "workers-dev",
          origin: INTEGRATION_ORIGIN,
          previousVersionId: existing ? "version-previous" : null,
          versionId: "version-current",
        });
        expect(result).not.toHaveProperty("domainOwner");
        expect(result.rollback).toBe(
          existing
            ? `wrangler rollback version-previous --name ${INTEGRATION_CONSOLE} --yes --message "rollback ${COMMIT}"`
            : "forward repair only: no previous Console version exists",
        );
        // The production Console and every custom domain stay untouched.
        expect(recorded.hostnames).toEqual([]);
        expect(new Set(recorded.workerNames)).toEqual(new Set([INTEGRATION_CONSOLE]));
        const uploads = process.calls.filter(
          (call) => call.includes("deploy") && call.includes("--strict"),
        );
        expect(uploads).toHaveLength(1);
        expect(uploads[0]).toContain(`${INTEGRATION_CONSOLE} ${COMMIT}`);
        expect(uploads[0]?.join(" ")).not.toContain(`${CONSOLE_WORKER} `);
        expect(requests).toEqual([`${INTEGRATION_ORIGIN}/console.js`]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("refuses another account's subdomain and a foreign Worker of the same name before upload", async () => {
    for (const recorded of [
      recordingState({ workerName: INTEGRATION_CONSOLE, accountSubdomain: "someone-else" }),
      recordingState({ workerName: INTEGRATION_CONSOLE, previousMessage: "hand-deployed worker" }),
    ]) {
      const process = fakeProcess();
      const failure = await runConsole(
        { action: "apply", environment: "integration", commit: COMMIT },
        integration,
        {
          run: process.run,
          state: recorded.state,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).phase).toBe("preflight");
      expect(process.calls.some((call) => call.includes("deploy"))).toBe(false);
      expect(recorded.hostnames).toEqual([]);
    }
  });

  test("fails verification when the uploaded Console is not served on workers.dev", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-console-served-"));
    try {
      const failure = await runConsole(
        { action: "apply", environment: "integration", commit: COMMIT },
        integration,
        {
          run: fakeProcess().run,
          state: recordingState({
            workerName: INTEGRATION_CONSOLE,
            served: { enabled: false, previewsEnabled: false },
          }).state,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async () => new Response(CONSOLE_JS, { status: 200 }),
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).phase).toBe("verification");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status reports the integration Console without reading any domain", async () => {
    const recorded = recordingState({ workerName: INTEGRATION_CONSOLE });
    const status = await runConsole(
      { action: "status", environment: "integration", commit: COMMIT },
      integration,
      { run: fakeProcess().run, state: recorded.state },
    );
    expect(status).toMatchObject({
      workerName: INTEGRATION_CONSOLE,
      topology: "workers-dev",
      origin: INTEGRATION_ORIGIN,
      versionId: "version-previous",
      commitMatches: false,
    });
    expect(status).not.toHaveProperty("domainOwner");
    expect(recorded.hostnames).toEqual([]);
  });

  test("refuses an invocation whose environment differs from the target's", async () => {
    await expect(
      runConsole({ action: "status", environment: "production", commit: COMMIT }, integration, {
        run: fakeProcess().run,
        state: recordingState().state,
      }),
    ).rejects.toThrow("environments differ");
  });
});
