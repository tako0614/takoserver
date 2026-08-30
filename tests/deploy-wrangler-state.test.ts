import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  runWorker,
  type WorkerMigrationReader,
  type WorkerProcess,
  type WorkerState,
} from "../scripts/deploy/worker.ts";
import {
  parseWranglerDeploymentOutput,
  parseWranglerSecretOutput,
  parseWranglerVersionDeployOutput,
  parseWranglerVersionOutput,
  parseWranglerVersionUploadOutput,
  WranglerWorkerState,
} from "../scripts/deploy/wrangler-state.ts";

const WORKER = "takoserver-api-integration";
const VERSION = "00000000-0000-4000-8000-000000000001";
const DEPLOYMENT = "00000000-0000-4000-8000-000000000002";

const VERSION_BODY = {
  id: VERSION,
  resources: {
    bindings: [
      { type: "d1", name: "STATE_DB", id: "00000000-0000-4000-8000-000000000003" },
      { type: "r2_bucket", name: "OBJECTS", bucket_name: "objects" },
    ],
  },
};

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: WORKER,
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000003",
  },
  r2: { bucketName: "objects" },
  publicOrigin: "https://worker.example.workers.dev",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

function result(stdout: string, exitCode = 0): CommandResult {
  return { exitCode, stdout, stderr: "" };
}

describe("Wrangler OAuth Worker reader", () => {
  test("uses only JSON Wrangler readers and never asks for credential metadata", async () => {
    const commands: string[][] = [];
    const environments: Readonly<Record<string, string>>[] = [];
    const state = new WranglerWorkerState({
      configPath: "/tmp/wrangler.jsonc",
      workerName: WORKER,
      run: async (command, options) => {
        commands.push([...command]);
        environments.push(options?.env ?? {});
        const joined = command.join(" ");
        if (joined.includes("deployments list")) {
          return result(
            JSON.stringify([
              {
                id: "deployment",
                created_on: "2026-08-30T00:00:00Z",
                versions: [{ version_id: VERSION, percentage: 100 }],
              },
            ]),
          );
        }
        if (joined.includes("versions view")) return result(JSON.stringify(VERSION_BODY));
        if (joined.includes("secret list")) {
          return result(JSON.stringify([{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }]));
        }
        throw new Error(`unexpected command: ${joined}`);
      },
      publicOrigin: "https://worker.example.workers.dev",
    });

    await expect(state.workerDeployments(WORKER)).resolves.toHaveLength(1);
    await expect(state.workerVersion(WORKER, VERSION)).resolves.toEqual(VERSION_BODY);
    await expect(state.workerSecrets(WORKER)).resolves.toEqual([
      { name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" },
    ]);
    expect(commands.some((command) => command.includes("auth"))).toBe(false);
    expect(commands.some((command) => command.includes("token"))).toBe(false);
    expect(environments.every((environment) => !("CLOUDFLARE_API_TOKEN" in environment))).toBe(
      true,
    );
  });

  test("does not turn an unobservable disabled workers.dev state into enabled topology", async () => {
    const state = new WranglerWorkerState({
      configPath: "/tmp/wrangler.jsonc",
      workerName: WORKER,
      publicOrigin: "https://worker.example.workers.dev",
      run: async () => {
        throw new Error("topology must fail before a synthetic read");
      },
    });
    await expect(state.workerDomains()).rejects.toThrow("workers.dev enabled state");
  });

  test("does not turn an unobservable undeclared custom-domain alias into absence", async () => {
    const state = new WranglerWorkerState({
      configPath: "/tmp/wrangler.jsonc",
      workerName: WORKER,
      publicOrigin: "https://worker.example.workers.dev",
      run: async () => {
        throw new Error("topology must fail before a synthetic read");
      },
    });
    await expect(state.workerDomains()).rejects.toThrow("custom-domain inventory");
  });

  test("rejects malformed or drifted JSON before the reader can prove state", async () => {
    expect(() => parseWranglerDeploymentOutput("{}", WORKER)).toThrow(DeployError);
    expect(() => parseWranglerVersionOutput(JSON.stringify({ id: "other" }), VERSION)).toThrow(
      "version id",
    );
    expect(() => parseWranglerSecretOutput(JSON.stringify([{ name: "bad" }]))).toThrow(
      "secret inventory",
    );
    await expect(
      new WranglerWorkerState({
        configPath: "/tmp/wrangler.jsonc",
        workerName: WORKER,
        publicOrigin: "https://api.example.test",
        run: async () => result("not-json"),
      }).workerDomains(),
    ).rejects.toThrow("custom-domain inventory");
    expect(
      () =>
        new WranglerWorkerState({
          configPath: "/tmp/wrangler.jsonc",
          workerName: WORKER,
          environment: { CLOUDFLARE_API_TOKEN: "must-not-cross" },
        }),
    ).toThrow("must not receive CLOUDFLARE_API_TOKEN");
    await expect(
      new WranglerWorkerState({
        configPath: "/tmp/wrangler.jsonc",
        workerName: WORKER,
        publicOrigin: "https://worker.example.workers.dev",
        run: async () => {
          throw new Error("spawn diagnostics must not escape");
        },
      }).workerDeployments(WORKER),
    ).rejects.toThrow("could not be started");
  });
});

describe("Wrangler version publication output", () => {
  test("parses one exact upload and deployment event", () => {
    expect(
      parseWranglerVersionUploadOutput(
        JSON.stringify({
          type: "version-upload",
          version: 1,
          worker_name: WORKER,
          worker_tag: null,
          version_id: VERSION,
          preview_url: null,
          preview_alias_url: null,
          worker_name_overridden: false,
          timestamp: "2026-08-30T00:00:00.000Z",
        }),
        WORKER,
      ),
    ).toEqual({ versionId: VERSION });
    expect(
      parseWranglerVersionDeployOutput(
        JSON.stringify({
          type: "version-deploy",
          version: 1,
          worker_name: WORKER,
          worker_tag: null,
          deployment_id: DEPLOYMENT,
          version_traffic: {},
          timestamp: "2026-08-30T00:00:00.000Z",
        }),
        WORKER,
      ),
    ).toEqual({ deploymentId: DEPLOYMENT });
    expect(() =>
      parseWranglerVersionDeployOutput(
        JSON.stringify({
          type: "version-deploy",
          version: 1,
          worker_name: WORKER,
          worker_tag: null,
          deployment_id: DEPLOYMENT,
          version_traffic: { [VERSION]: 99 },
        }),
        WORKER,
        VERSION,
      ),
    ).toThrow("100 percent");
  });

  test("rejects extra, duplicate, or wrong publication events", () => {
    const upload = {
      type: "version-upload",
      version: 1,
      worker_name: WORKER,
      worker_tag: null,
      version_id: VERSION,
      preview_url: null,
      preview_alias_url: null,
      worker_name_overridden: false,
    };
    expect(() =>
      parseWranglerVersionUploadOutput(JSON.stringify({ ...upload, extra: true }), WORKER),
    ).toThrow("unexpected");
    expect(() =>
      parseWranglerVersionUploadOutput(
        `${JSON.stringify(upload)}\n${JSON.stringify(upload)}`,
        WORKER,
      ),
    ).toThrow("exactly one");
    expect(() =>
      parseWranglerVersionDeployOutput(JSON.stringify({ type: "version-deploy" }), WORKER),
    ).toThrow("deployment");
    expect(() =>
      parseWranglerVersionDeployOutput(
        JSON.stringify({
          type: "version-deploy",
          version: 1,
          worker_name: WORKER,
          deployment_id: DEPLOYMENT,
        }),
        WORKER,
      ),
    ).toThrow("traffic");
  });
});

describe("routine Worker authentication and version publication boundary", () => {
  test("keeps production and authority surfaces on explicit-token direct REST", async () => {
    const commands: string[][] = [];
    for (const invocation of [
      {
        surface: "takoserver-worker" as const,
        action: "status" as const,
        environment: "production" as const,
      },
      {
        surface: "takoserver-worker-authority-cutover" as const,
        action: "status" as const,
        environment: "integration" as const,
      },
    ]) {
      const failure = await runWorker(
        { ...invocation, commit: "a".repeat(40) },
        { ...target, environment: invocation.environment },
        {
          run: async (command) => {
            commands.push([...command]);
            return result("");
          },
          cloudflareEnvironment: {},
          outputDirectory: `${process.env.TMPDIR ?? "/tmp"}/takoserver-oauth-token-${crypto.randomUUID()}`,
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("CLOUDFLARE_API_TOKEN");
    }
    expect(commands).toHaveLength(0);
  });

  test("keeps token-less publication disabled when Wrangler cannot prove live topology", async () => {
    const commands: string[][] = [];
    const failure = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: "a".repeat(40),
      },
      target,
      {
        run: async (command) => {
          commands.push([...command]);
          return result("");
        },
        cloudflareEnvironment: {},
        outputDirectory: `${process.env.TMPDIR ?? "/tmp"}/takoserver-oauth-alias-${crypto.randomUUID()}`,
      },
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(DeployError);
    expect(failure.message).toContain("CLOUDFLARE_API_TOKEN");
    expect(failure.message).toContain("authoritative live topology");
    expect(commands).toHaveLength(0);
  });

  test("uses explicit-token version publication and re-reads the predecessor before deploy", async () => {
    const fixture = await routineVersionPublication();
    expect(fixture.outcome).toMatchObject({
      publication: "versions-upload-and-deploy",
      versionId: VERSION,
    });
    expect(fixture.commands.some((command) => command.includes("auth"))).toBe(false);
    expect(
      fixture.commands.filter(
        (command) => command.includes("versions") && command.includes("upload"),
      ),
    ).toHaveLength(2);
    expect(
      fixture.commands.filter(
        (command) => command.includes("versions") && command.includes("deploy"),
      ),
    ).toHaveLength(1);
    expect(fixture.commands.some((command) => command.includes("--strict"))).toBe(true);
    const upload = fixture.trace.findIndex(
      (entry) => entry.includes(" versions upload ") && !entry.includes("--dry-run"),
    );
    const deploy = fixture.trace.findIndex((entry) => entry.includes(" versions deploy "));
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThan(upload);
    expect(fixture.trace.slice(upload + 1, deploy)).toContain("state:deployments");
    for (const key of ["routes", "triggers", "workers_dev", "workers_dev_subdomain"]) {
      expect(fixture.config).not.toHaveProperty(key);
    }
  });

  test("refuses a concurrent active deployment after upload before 100 percent traffic mutation", async () => {
    const fixture = await routineVersionPublication({ concurrentAfterUpload: true });
    expect(fixture.outcome).toBeInstanceOf(DeployError);
    expect((fixture.outcome as DeployError).phase).toBe("mutation");
    expect((fixture.outcome as DeployError).message).toContain(
      "predecessor re-fence failed after Version upload",
    );
    expect((fixture.outcome as DeployError).detail).toContain(
      "changed after Version upload and before traffic deployment",
    );
    expect(
      fixture.commands.filter(
        (command) => command.includes("versions") && command.includes("upload"),
      ),
    ).toHaveLength(2);
    expect(
      fixture.commands.filter(
        (command) => command.includes("versions") && command.includes("deploy"),
      ),
    ).toHaveLength(0);
  });
});

async function routineVersionPublication(
  options: { readonly concurrentAfterUpload?: boolean } = {},
): Promise<{
  readonly outcome: Record<string, unknown> | DeployError;
  readonly commands: readonly string[][];
  readonly trace: readonly string[];
  readonly config: Record<string, unknown>;
}> {
  const root = `${process.env.TMPDIR ?? "/tmp"}/takoserver-version-${crypto.randomUUID()}`;
  const commands: string[][] = [];
  const trace: string[] = [];
  let uploaded = false;
  let deployed = false;
  const beforeVersion = "00000000-0000-4000-8000-000000000005";
  const beforeDeployment = "00000000-0000-4000-8000-000000000004";
  const concurrentVersion = "00000000-0000-4000-8000-000000000006";
  const concurrentDeployment = "00000000-0000-4000-8000-000000000007";
  const run: WorkerProcess = async (command, commandOptions) => {
    commands.push([...command]);
    const joined = command.join(" ");
    trace.push(`command:${joined}`);
    if (joined === "git rev-parse HEAD") return result(`${"a".repeat(40)}\n`);
    if (joined === "git branch --show-current") return result("feature/version-publication\n");
    if (joined === "git status --porcelain=v1 -z --untracked-files=all") return result("");
    if (
      joined ===
      "git diff --name-only bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb..aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --"
    ) {
      return result("src/catalog.ts\n");
    }
    if (joined === "bun run check") return result("green\n");
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("missing build outdir");
      await Bun.write(`${out}/index.js`, "export default {fetch(){return new Response('ok')}};\n");
      await Bun.write(`${out}/index.js.map`, "{}\n");
      await Bun.write(`${out}/README.md`, "generated\n");
      return result("built\n");
    }
    if (command[1] === "versions" && command[2] === "upload") {
      uploaded = true;
      const path = commandOptions?.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (!path) throw new Error("missing Wrangler output path");
      await Bun.write(
        path,
        JSON.stringify({
          type: "version-upload",
          version: 1,
          worker_name: WORKER,
          worker_tag: null,
          version_id: VERSION,
          preview_url: null,
          preview_alias_url: null,
          worker_name_overridden: false,
        }),
      );
      return result("Uploaded\n");
    }
    if (command[1] === "versions" && command[2] === "deploy") {
      deployed = true;
      const path = commandOptions?.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (!path) throw new Error("missing Wrangler output path");
      await Bun.write(
        path,
        JSON.stringify({
          type: "version-deploy",
          version: 1,
          worker_name: WORKER,
          worker_tag: null,
          deployment_id: DEPLOYMENT,
          version_traffic: {},
        }),
      );
      return result("Deployed\n");
    }
    throw new Error(`unexpected command: ${joined}`);
  };
  const state: WorkerState = {
    async workerDomains() {
      return [];
    },
    async workerDeployments() {
      trace.push("state:deployments");
      if (deployed) {
        return [
          deployment(DEPLOYMENT, VERSION, "2026-08-30T00:02:00Z"),
          deployment(beforeDeployment, beforeVersion, "2026-08-29T00:00:00Z"),
        ];
      }
      if (uploaded && options.concurrentAfterUpload === true) {
        return [
          deployment(concurrentDeployment, concurrentVersion, "2026-08-30T00:01:00Z"),
          deployment(beforeDeployment, beforeVersion, "2026-08-29T00:00:00Z"),
        ];
      }
      return [deployment(beforeDeployment, beforeVersion, "2026-08-29T00:00:00Z")];
    },
    async workerVersion(_worker, versionId) {
      const digest =
        deployed && versionId === VERSION
          ? createHash("sha256")
              .update(readFileSync(`${root}/release/worker.js`))
              .digest("hex")
          : "b".repeat(64);
      return {
        id: versionId,
        annotations: {
          "workers/message": `takoserver-worker:${
            versionId === concurrentVersion ? "c".repeat(40) : "a".repeat(40)
          }:${digest}`,
          "workers/triggered_by": "version_upload",
        },
        resources: {
          bindings: [
            { type: "ai", name: "AI" },
            { type: "version_metadata", name: "WORKER_VERSION" },
            { type: "d1", name: "STATE_DB", id: target.d1.databaseId },
            { type: "r2_bucket", name: "OBJECTS", bucket_name: target.r2.bucketName },
            { type: "plain_text", name: "PUBLIC_ORIGIN", text: target.publicOrigin },
            {
              type: "plain_text",
              name: "TAKOSERVER_SIGNING_KEY_ID",
              text: target.signing.currentKeyId,
            },
            { type: "secret_text", name: "TAKOSERVER_SIGNING_KEY" },
          ],
        },
      };
    },
    async workerSecrets() {
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
  };
  const migrations: WorkerMigrationReader = {
    async read() {
      return { local: ["0001_first.sql"], applied: ["0001_first.sql"] };
    },
  };
  try {
    const outcome = await runWorker(
      {
        surface: "takoserver-worker",
        action: "apply",
        environment: "integration",
        commit: "a".repeat(40),
      },
      target,
      {
        run,
        state,
        migrations,
        outputDirectory: root,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        fetcher: async (input) =>
          input.endsWith("/openapi.json")
            ? Response.json({ servers: [{ url: target.publicOrigin }] })
            : Response.json({
                product: "takoserver",
                apiVersion: "v1",
                endpoints: {
                  api: target.publicOrigin,
                  openapi: `${target.publicOrigin}/openapi.json`,
                },
              }),
      },
    ).catch((error) => error as DeployError);
    const config = JSON.parse(await Bun.file(`${root}/release/wrangler.jsonc`).text()) as Record<
      string,
      unknown
    >;
    return { outcome, commands, trace, config };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function deployment(id: string, versionId: string, createdOn: string) {
  return {
    id,
    created_on: createdOn,
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}
