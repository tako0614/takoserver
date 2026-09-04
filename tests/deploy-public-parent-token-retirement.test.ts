import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PublicParentTokenRetirementState,
  runPublicParentTokenRetirement,
} from "../scripts/deploy/public-parent-token-retirement.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WorkerProviderExecutorQualification } from "../scripts/deploy/worker.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import type { WranglerVersionPublicationLease } from "../scripts/deploy/wrangler-state.ts";
import {
  cloudflareProviderExecutorTarget,
  edgeSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

const COMMIT = "a".repeat(40);
const LEGACY_COMMIT = "b".repeat(40);
const DIGEST = "c".repeat(64);
const LEGACY_VERSION = "00000000-0000-4000-8000-000000000001";
const LEGACY_DEPLOYMENT = "00000000-0000-4000-8000-000000000011";
const EXECUTOR_VERSION = "00000000-0000-4000-8000-000000000021";
const EXECUTOR_DEPLOYMENT = "00000000-0000-4000-8000-000000000031";
const BOUND_VERSION = "00000000-0000-4000-8000-000000000002";
const BOUND_DEPLOYMENT = "00000000-0000-4000-8000-000000000012";
const RETIRED_VERSION = "00000000-0000-4000-8000-000000000003";
const RETIRED_DEPLOYMENT = "00000000-0000-4000-8000-000000000013";
const PARENT_TOKEN = "CLOUDFLARE_API_TOKEN";
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const BUNDLE_DIGEST = createHash("sha256").update(BUNDLE).digest("hex");
const PUBLIC_SECRETS = ["TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING", "TAKOSERVER_SIGNING_KEY"];
const LEGACY_SECRETS = [...PUBLIC_SECRETS, PARENT_TOKEN].sort();

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "1".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000041",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  edgeSupplies: edgeSuppliesFixture(),
  cloudflareProviderExecutor: cloudflareProviderExecutorTarget(),
  signing: { currentKeyId: "current-key" },
} satisfies DeployTarget;

describe("public Cloudflare parent-token retirement", () => {
  test("status reports the exact legacy unbound Worker without mutating it", async () => {
    const fixture = stateFixture("legacy");
    const result = await runPublicParentTokenRetirement(
      {
        surface: "takoserver-public-parent-token-retirement",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      {
        state: fixture.state,
        providerExecutorQualification: readyExecutorQualification(),
      },
    );

    expect(result).toEqual({
      kind: "takoserver.public-parent-token-retirement-status@v1",
      surface: "takoserver-public-parent-token-retirement",
      environment: "integration",
      selectedCommit: COMMIT,
      state: "legacy-unbound-parent-token",
      ready: false,
      canApply: true,
      deploymentId: LEGACY_DEPLOYMENT,
      versionId: LEGACY_VERSION,
      previousVersionId: null,
      deployedCommit: LEGACY_COMMIT,
      artifactDigest: `sha256:${DIGEST}`,
      bundleDigest: `sha256:${DIGEST}`,
      scriptContentIdentity: "public-worker-script-etag",
      executorBindingReady: false,
      parentTokenPresent: true,
      cloudflareProviderExecutor: {
        required: true,
        ready: true,
        status: "ready",
        routeLess: true,
        versionId: EXECUTOR_VERSION,
        deploymentId: EXECUTOR_DEPLOYMENT,
        commit: COMMIT,
        bundleDigest: `sha256:${"d".repeat(64)}`,
        schemaReady: true,
        dependencies: {
          ready: true,
          receiptAuthorityReady: true,
          receiptAuthorityVersionId: "00000000-0000-4000-8000-000000000051",
          managedWorkerGatewayReady: true,
          managedWorkerGatewayVersionId: "00000000-0000-4000-8000-000000000061",
        },
      },
    });
    expect(fixture.mutations).toEqual([]);
  });

  test("apply releases the exact executor binding before deleting only the public parent token", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-public-parent-retirement-"));
    try {
      const fixture = applyingFixture();
      const result = await runPublicParentTokenRetirement(
        {
          surface: "takoserver-public-parent-token-retirement",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: fixture.run,
          state: fixture.state,
          providerExecutorQualification: readyExecutorQualification(),
          outputDirectory: root,
          review: "reviewer@example.test",
          publicationLease: fixture.lease,
          executorPublicationLease: fixture.executorLease,
          cloudflareEnvironment: {
            CLOUDFLARE_API_TOKEN: "deploy-reader-token",
            TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH: "/must/not/be/read.json",
          },
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.public-parent-token-retirement-apply@v1",
        surface: "takoserver-public-parent-token-retirement",
        environment: "integration",
        state: "complete",
        ready: true,
        commit: COMMIT,
        changedPaths: [],
        reviewer: "reviewer@example.test",
        bundleDigest: `sha256:${BUNDLE_DIGEST}`,
        bindingRelease: {
          performed: true,
          previousVersionId: LEGACY_VERSION,
          versionId: BOUND_VERSION,
        },
        secretRetirement: {
          performed: true,
          previousVersionId: BOUND_VERSION,
          versionId: RETIRED_VERSION,
          secretRemoved: PARENT_TOKEN,
        },
        executorBindingReady: true,
        parentTokenPresent: false,
        scriptContentIdentity: "public-worker-script-etag",
      });
      expect(fixture.mutations.map((command) => command.join(" "))).toEqual([
        expect.stringContaining("wrangler deploy"),
        expect.stringContaining(
          `wrangler secret delete ${PARENT_TOKEN} --name ${target.workerName}`,
        ),
      ]);
      expect(fixture.mutations[0]).toContain("--no-bundle");
      expect(fixture.mutations[0]).toContain("--strict");
      expect(fixture.mutations[1]).not.toContain("TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING");
      expect(fixture.mutations[1]).not.toContain("TAKOSERVER_SIGNING_KEY");
      expect(JSON.stringify(result)).not.toContain("deploy-reader-token");
      expect(
        fixture.childEnvironments.every(
          (environment) =>
            environment.TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH === undefined,
        ),
      ).toBe(true);
      expect(fixture.leaseReleased()).toBe(true);
      expect(fixture.executorLeaseReleased()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("closes integration apply provenance with source paths and distinct identities", async () => {
    await withApplyingFixture(
      { changedPaths: ["README.md", "scripts/deploy/public-parent-token-retirement.ts"] },
      async ({ fixture, root }) => {
        const result = await applyFixture(fixture, root);
        expect(result).toEqual({
          kind: "takoserver.public-parent-token-retirement-apply@v1",
          surface: "takoserver-public-parent-token-retirement",
          environment: "integration",
          state: "complete",
          ready: true,
          commit: COMMIT,
          dirty: true,
          changedPaths: ["README.md", "scripts/deploy/public-parent-token-retirement.ts"],
          remoteRef: null,
          reviewer: "reviewer@example.test",
          artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          artifactBytes: expect.any(Number),
          artifactFiles: expect.any(Number),
          bundleDigest: `sha256:${BUNDLE_DIGEST}`,
          bindingRelease: {
            performed: true,
            previousVersionId: LEGACY_VERSION,
            versionId: BOUND_VERSION,
            bundleDigest: `sha256:${BUNDLE_DIGEST}`,
          },
          secretRetirement: {
            performed: true,
            previousVersionId: BOUND_VERSION,
            versionId: RETIRED_VERSION,
            secretRemoved: PARENT_TOKEN,
          },
          deploymentId: RETIRED_DEPLOYMENT,
          versionId: RETIRED_VERSION,
          executorBindingReady: true,
          parentTokenPresent: false,
          scriptContentIdentity: "public-worker-script-etag",
          cloudflareProviderExecutor: {
            required: true,
            ready: true,
            status: "ready",
            routeLess: true,
            versionId: EXECUTOR_VERSION,
            deploymentId: EXECUTOR_DEPLOYMENT,
            commit: COMMIT,
            bundleDigest: `sha256:${"d".repeat(64)}`,
            schemaReady: true,
            dependencies: {
              ready: true,
              receiptAuthorityReady: true,
              receiptAuthorityVersionId: "00000000-0000-4000-8000-000000000051",
              managedWorkerGatewayReady: true,
              managedWorkerGatewayVersionId: "00000000-0000-4000-8000-000000000061",
            },
          },
        });
        expect(result.artifactDigest).not.toBe(result.bundleDigest);
      },
    );
  });

  test("refuses wrong service, unrelated binding/secret/topology, or mismatched Version identity", async () => {
    for (const state of [
      staticStateFixture({
        executorBinding: true,
        parentToken: true,
        wrongExecutorService: true,
      }).state,
      staticStateFixture({ executorBinding: true, parentToken: true, extraBinding: true }).state,
      staticStateFixture({
        executorBinding: true,
        parentToken: true,
        extraSecret: "UNRELATED_SECRET",
      }).state,
      staticStateFixture({
        executorBinding: true,
        parentToken: true,
        returnedVersionId: "00000000-0000-4000-8000-000000000097",
      }).state,
      staticStateFixture({
        executorBinding: true,
        parentToken: true,
        domainService: "unrelated-public-worker",
      }).state,
    ]) {
      await expect(
        runPublicParentTokenRetirement(statusInvocation(), target, {
          state,
          providerExecutorQualification: readyExecutorQualification(),
        }),
      ).rejects.toMatchObject({ phase: "preflight" });
    }
  });

  test("refuses a parent token already absent before the exact executor binding", async () => {
    const fixture = staticStateFixture({ executorBinding: false, parentToken: false });
    await expect(
      runPublicParentTokenRetirement(statusInvocation(), target, {
        state: fixture.state,
        providerExecutorQualification: readyExecutorQualification(),
      }),
    ).rejects.toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("absent before the exact executor binding"),
    });
    expect(fixture.mutations).toEqual([]);
  });

  test("refuses an exposed or stale provider executor before source qualification or mutation", async () => {
    await withApplyingFixture({}, async ({ fixture, root }) => {
      const exposed = executorInspection({
        status: "drift",
        ready: false,
        routeLess: false,
        settingsExact: false,
      });
      await expect(
        applyFixture(fixture, root, readyExecutorQualification(exposed)),
      ).rejects.toMatchObject({
        phase: "preflight",
        message: expect.stringContaining("route-less provider executor"),
      });
      expect(fixture.mutations).toEqual([]);
    });

    await withApplyingFixture({}, async ({ fixture, root }) => {
      const stale = executorInspection({
        status: "stale",
        ready: false,
        commit: LEGACY_COMMIT,
      });
      await expect(
        applyFixture(fixture, root, readyExecutorQualification(stale)),
      ).rejects.toMatchObject({ phase: "preflight" });
      expect(fixture.mutations).toEqual([]);
    });
  });

  test("derives environment and target identity only from the fixed invocation and reviewed target", async () => {
    await expect(
      runPublicParentTokenRetirement(
        { ...statusInvocation(), environment: "rehearsal" },
        target,
        {},
      ),
    ).rejects.toMatchObject({ phase: "preflight", message: expect.stringContaining("differ") });

    const { cloudflareProviderExecutor: _executor, ...withoutExecutor } = target;
    await expect(
      runPublicParentTokenRetirement(statusInvocation(), withoutExecutor, {}),
    ).rejects.toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("exact provider-executor topology"),
    });

    for (const leaseCase of [
      {
        lane: "public" as const,
        identity: { accountId: "2".repeat(32), workerName: target.workerName },
      },
      {
        lane: "public" as const,
        identity: { accountId: target.accountId, workerName: "wrong-public-worker" },
      },
      {
        lane: "executor" as const,
        identity: {
          accountId: "2".repeat(32),
          workerName: target.cloudflareProviderExecutor.workerName,
        },
      },
      {
        lane: "executor" as const,
        identity: { accountId: target.accountId, workerName: "wrong-executor-worker" },
      },
    ]) {
      await withApplyingFixture({ initialStage: "bound" }, async ({ fixture, root }) => {
        let released = false;
        const wrongLease: WranglerVersionPublicationLease = {
          ...leaseCase.identity,
          async release() {
            released = true;
          },
        };
        await expect(
          applyFixture(
            fixture,
            root,
            readyExecutorQualification(),
            leaseCase.lane === "public" ? wrongLease : fixture.lease,
            leaseCase.lane === "executor" ? wrongLease : fixture.executorLease,
          ),
        ).rejects.toMatchObject({
          phase: "preflight",
          message: expect.stringContaining("lease does not match the exact target"),
        });
        expect(fixture.mutations).toEqual([]);
        expect(released).toBe(true);
      });
    }
  });

  test("status adopts only an exact completed successor and apply refuses replay", async () => {
    const canonical = staticStateFixture({ executorBinding: true, parentToken: false });
    await expect(
      runPublicParentTokenRetirement(statusInvocation(), target, {
        state: canonical.state,
        providerExecutorQualification: readyExecutorQualification(),
      }),
    ).resolves.toMatchObject({
      state: "retired-canonical",
      ready: true,
      canApply: false,
    });

    const fixture = staticStateFixture({
      executorBinding: true,
      parentToken: false,
      secretCreated: true,
    });
    const status = await runPublicParentTokenRetirement(statusInvocation(), target, {
      state: fixture.state,
      providerExecutorQualification: readyExecutorQualification(),
    });
    expect(status).toMatchObject({
      state: "retired-secret-successor",
      ready: true,
      canApply: false,
      executorBindingReady: true,
      parentTokenPresent: false,
    });

    const commands: string[][] = [];
    await expect(
      runPublicParentTokenRetirement(applyInvocation(), target, {
        state: fixture.state,
        providerExecutorQualification: readyExecutorQualification(),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "readback-only-token" },
        run: async (command) => {
          commands.push([...command]);
          return ok("");
        },
      }),
    ).rejects.toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("already complete"),
    });
    expect(commands).toEqual([]);
  });

  test("source, gate, and concurrent public-history failures touch nothing", async () => {
    await withApplyingFixture({ headCommit: LEGACY_COMMIT }, async ({ fixture, root }) => {
      await expect(applyFixture(fixture, root)).rejects.toMatchObject({
        phase: "preflight",
        message: expect.stringContaining("does not equal worktree HEAD"),
      });
      expect(fixture.mutations).toEqual([]);
    });

    await withApplyingFixture({ gateExitCode: 1 }, async ({ fixture, root }) => {
      await expect(applyFixture(fixture, root)).rejects.toMatchObject({
        phase: "preflight",
        message: expect.stringContaining("scoped owner gate"),
      });
      expect(fixture.mutations).toEqual([]);
    });

    const unstable = staticStateFixture({
      executorBinding: true,
      parentToken: true,
      unstableHistory: true,
    });
    await expect(
      runPublicParentTokenRetirement(statusInvocation(), target, {
        state: unstable.state,
        providerExecutorQualification: readyExecutorQualification(),
      }),
    ).rejects.toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("changed during"),
    });
    expect(unstable.mutations).toEqual([]);
  });

  test("post-release source or executor drift stops before secret deletion", async () => {
    await withApplyingFixture({ boundCommit: LEGACY_COMMIT }, async ({ fixture, root }) => {
      await expect(applyFixture(fixture, root)).rejects.toMatchObject({
        phase: "verification",
        message: expect.stringContaining("selected-commit direct successor"),
      });
      expect(fixture.stage()).toBe("bound");
      expect(fixture.mutations).toHaveLength(1);
      expect(fixture.mutations[0]).toContain("deploy");
    });

    await withApplyingFixture({}, async ({ fixture, root }) => {
      const changed = executorInspection({
        status: "stale",
        ready: false,
        commit: LEGACY_COMMIT,
      });
      await expect(
        applyFixture(
          fixture,
          root,
          readyExecutorQualification(executorInspection(), executorInspection(), changed),
        ),
      ).rejects.toMatchObject({
        phase: "verification",
        message: expect.stringContaining("qualification changed"),
      });
      expect(fixture.stage()).toBe("bound");
      expect(fixture.mutations).toHaveLength(1);
    });
  });

  test("settles binding-release acknowledgement loss only through value-free status", async () => {
    for (const releaseApplies of [false, true]) {
      await withApplyingFixture(
        { releaseExitCode: 1, releaseApplies },
        async ({ fixture, root }) => {
          await expect(applyFixture(fixture, root)).rejects.toMatchObject({
            phase: "mutation",
            message: expect.stringContaining("acknowledgement is indeterminate"),
          });
          expect(fixture.mutations).toHaveLength(1);
          const status = await runPublicParentTokenRetirement(statusInvocation(), target, {
            state: fixture.state,
            providerExecutorQualification: readyExecutorQualification(),
          });
          expect(status).toMatchObject({
            state: releaseApplies ? "bound-parent-token" : "legacy-unbound-parent-token",
            ready: false,
            canApply: true,
            parentTokenPresent: true,
          });
          expect(JSON.stringify(status)).not.toContain("deploy-reader-token");
          expect(fixture.mutations).toHaveLength(1);
        },
      );
    }
  });

  test("settles secret-deletion acknowledgement loss without retry or unrelated secret change", async () => {
    for (const deleteApplies of [false, true]) {
      await withApplyingFixture(
        { initialStage: "bound", deleteExitCode: 1, deleteApplies },
        async ({ fixture, root }) => {
          await expect(applyFixture(fixture, root)).rejects.toMatchObject({
            phase: "mutation",
            message: expect.stringContaining("acknowledgement is indeterminate"),
          });
          expect(fixture.mutations).toHaveLength(1);
          expect(fixture.mutations[0]).toEqual(
            expect.arrayContaining(["secret", "delete", PARENT_TOKEN]),
          );
          for (const retained of PUBLIC_SECRETS)
            expect(fixture.mutations[0]).not.toContain(retained);

          const status = await runPublicParentTokenRetirement(statusInvocation(), target, {
            state: fixture.state,
            providerExecutorQualification: readyExecutorQualification(),
          });
          expect(status).toMatchObject(
            deleteApplies
              ? { state: "retired-secret-successor", ready: true, canApply: false }
              : { state: "bound-parent-token", ready: false, canApply: true },
          );
          expect(fixture.mutations).toHaveLength(1);

          if (deleteApplies) {
            await expect(
              applyFixture(fixture, root, readyExecutorQualification()),
            ).rejects.toMatchObject({
              phase: "preflight",
              message: expect.stringContaining("already complete"),
            });
            expect(fixture.mutations).toHaveLength(1);
          }
        },
      );
    }
  });

  test("rejects a changed script after deletion as verification failure", async () => {
    await withApplyingFixture(
      { initialStage: "bound", retiredScriptEtag: "changed-script-etag" },
      async ({ fixture, root }) => {
        await expect(applyFixture(fixture, root)).rejects.toMatchObject({
          phase: "verification",
          message: expect.stringContaining("changed the public Worker script identity"),
        });
        expect(fixture.stage()).toBe("retired");
        expect(fixture.mutations).toHaveLength(1);
      },
    );
  });
});

function statusInvocation() {
  return {
    surface: "takoserver-public-parent-token-retirement",
    action: "status",
    environment: "integration",
    commit: COMMIT,
  } as const;
}

function applyInvocation() {
  return { ...statusInvocation(), action: "apply" } as const;
}

async function applyFixture(
  fixture: ReturnType<typeof applyingFixture>,
  root: string,
  qualification: WorkerProviderExecutorQualification = readyExecutorQualification(),
  lease: WranglerVersionPublicationLease = fixture.lease,
  executorLease: WranglerVersionPublicationLease = fixture.executorLease,
) {
  return await runPublicParentTokenRetirement(applyInvocation(), target, {
    run: fixture.run,
    state: fixture.state,
    providerExecutorQualification: qualification,
    outputDirectory: root,
    review: "reviewer@example.test",
    publicationLease: lease,
    executorPublicationLease: executorLease,
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "deploy-reader-token" },
  });
}

async function withApplyingFixture(
  options: ApplyingFixtureOptions,
  use: (input: {
    readonly fixture: ReturnType<typeof applyingFixture>;
    readonly root: string;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "takoserver-public-parent-retirement-"));
  try {
    await use({ fixture: applyingFixture(options), root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface ApplyingFixtureOptions {
  readonly initialStage?: "legacy" | "bound" | "retired";
  readonly changedPaths?: readonly string[];
  readonly gateExitCode?: number;
  readonly releaseExitCode?: number;
  readonly releaseApplies?: boolean;
  readonly deleteExitCode?: number;
  readonly deleteApplies?: boolean;
  readonly boundCommit?: string;
  readonly boundDigest?: string;
  readonly retiredScriptEtag?: string;
  readonly headCommit?: string;
}

function applyingFixture(options: ApplyingFixtureOptions = {}) {
  let stage: "legacy" | "bound" | "retired" = options.initialStage ?? "legacy";
  const mutations: string[][] = [];
  const childEnvironments: Readonly<Record<string, string>>[] = [];
  let released = false;
  let executorReleased = false;
  const run = async (
    command: readonly string[],
    commandOptions?: { readonly env?: Readonly<Record<string, string>> },
  ) => {
    childEnvironments.push(commandOptions?.env ?? {});
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${options.headCommit ?? COMMIT}\n`);
    if (key === "git branch --show-current") return ok("fix/public-parent-retirement\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") {
      return ok((options.changedPaths ?? []).map((path) => ` M ${path}\0`).join(""));
    }
    if (key === "bun run check") {
      return options.gateExitCode === undefined
        ? ok("green\n")
        : { exitCode: options.gateExitCode, stdout: "", stderr: "gate failed" };
    }
    if (command.includes("--dry-run")) {
      const outdir = command[command.indexOf("--outdir") + 1];
      if (outdir === undefined) throw new Error("missing dry-run output");
      writeFileSync(join(outdir, "index.js"), BUNDLE);
      return ok("built\n");
    }
    if (command.includes("deploy") && command.includes("--no-bundle")) {
      mutations.push([...command]);
      const configPath = command[command.indexOf("--config") + 1];
      if (configPath === undefined) throw new Error("missing config");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        services: { binding: string; service: string; entrypoint: string }[];
        secrets: { required: string[] };
      };
      expect(config.services).toContainEqual({
        binding: "CLOUDFLARE_PROVIDER_EXECUTOR",
        service: target.cloudflareProviderExecutor?.workerName,
        entrypoint: "CloudflareProviderExecutor",
      });
      expect(config.secrets.required.sort()).toEqual(LEGACY_SECRETS);
      if (options.releaseApplies !== false) stage = "bound";
      return options.releaseExitCode === undefined
        ? ok("released\n")
        : { exitCode: options.releaseExitCode, stdout: "", stderr: "lost acknowledgement" };
    }
    if (command.includes("secret") && command.includes("delete")) {
      mutations.push([...command]);
      if (options.deleteApplies !== false) stage = "retired";
      return options.deleteExitCode === undefined
        ? ok("deleted\n")
        : { exitCode: options.deleteExitCode, stdout: "", stderr: "lost acknowledgement" };
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const state: PublicParentTokenRetirementState = {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments(workerName) {
      expect(workerName).toBe(target.workerName);
      return stage === "legacy"
        ? [deployment(LEGACY_DEPLOYMENT, LEGACY_VERSION, "2026-09-04T00:00:00.000Z")]
        : stage === "bound"
          ? [
              deployment(BOUND_DEPLOYMENT, BOUND_VERSION, "2026-09-04T00:01:00.000Z"),
              deployment(LEGACY_DEPLOYMENT, LEGACY_VERSION, "2026-09-04T00:00:00.000Z"),
            ]
          : [
              deployment(RETIRED_DEPLOYMENT, RETIRED_VERSION, "2026-09-04T00:02:00.000Z"),
              deployment(BOUND_DEPLOYMENT, BOUND_VERSION, "2026-09-04T00:01:00.000Z"),
              deployment(LEGACY_DEPLOYMENT, LEGACY_VERSION, "2026-09-04T00:00:00.000Z"),
            ];
    },
    async workerVersion(workerName, versionId) {
      expect(workerName).toBe(target.workerName);
      if (versionId === LEGACY_VERSION) {
        return publicVersion({
          versionId,
          commit: LEGACY_COMMIT,
          digest: DIGEST,
          executorBinding: false,
          parentToken: true,
        });
      }
      if (versionId === BOUND_VERSION) {
        return publicVersion({
          versionId,
          commit: options.boundCommit ?? COMMIT,
          digest: options.boundDigest ?? BUNDLE_DIGEST,
          executorBinding: true,
          parentToken: true,
        });
      }
      return publicVersion({
        versionId,
        commit: COMMIT,
        digest: BUNDLE_DIGEST,
        executorBinding: true,
        parentToken: false,
        secretCreated: true,
        ...(options.retiredScriptEtag === undefined
          ? {}
          : { scriptEtag: options.retiredScriptEtag }),
      });
    },
    async workerSecrets(workerName) {
      expect(workerName).toBe(target.workerName);
      return (stage === "retired" ? PUBLIC_SECRETS : LEGACY_SECRETS).map((name) => ({
        name,
        type: "secret_text",
      }));
    },
  };
  const lease: WranglerVersionPublicationLease = {
    accountId: target.accountId,
    workerName: target.workerName,
    async release() {
      released = true;
    },
  };
  const executorLease: WranglerVersionPublicationLease = {
    accountId: target.accountId,
    workerName: target.cloudflareProviderExecutor.workerName,
    async release() {
      executorReleased = true;
    },
  };
  return {
    run,
    state,
    mutations,
    childEnvironments,
    lease,
    executorLease,
    leaseReleased: () => released,
    executorLeaseReleased: () => executorReleased,
    stage: () => stage,
  };
}

function stateFixture(stage: "legacy"): {
  readonly state: PublicParentTokenRetirementState;
  readonly mutations: readonly string[][];
} {
  const mutations: string[][] = [];
  const version = publicVersion({
    versionId: LEGACY_VERSION,
    commit: LEGACY_COMMIT,
    digest: DIGEST,
    executorBinding: false,
    parentToken: true,
  });
  void stage;
  return {
    mutations,
    state: {
      async workerDomains() {
        return [{ hostname: "api.integration.example.test", service: target.workerName }];
      },
      async workerDeployments(workerName) {
        expect(workerName).toBe(target.workerName);
        return [deployment(LEGACY_DEPLOYMENT, LEGACY_VERSION, "2026-09-04T00:00:00.000Z")];
      },
      async workerVersion(workerName, versionId) {
        expect(workerName).toBe(target.workerName);
        expect(versionId).toBe(LEGACY_VERSION);
        return version;
      },
      async workerSecrets(workerName) {
        expect(workerName).toBe(target.workerName);
        return LEGACY_SECRETS.map((name) => ({ name, type: "secret_text" }));
      },
    },
  };
}

function staticStateFixture(input: {
  readonly executorBinding: boolean;
  readonly parentToken: boolean;
  readonly commit?: string;
  readonly digest?: string;
  readonly secretCreated?: boolean;
  readonly wrongExecutorService?: boolean;
  readonly extraBinding?: boolean;
  readonly extraSecret?: string;
  readonly returnedVersionId?: string;
  readonly scriptEtag?: string;
  readonly predecessorScriptEtag?: string;
  readonly unstableHistory?: boolean;
  readonly domainService?: string;
}): {
  readonly state: PublicParentTokenRetirementState;
  readonly mutations: readonly string[][];
} {
  const currentVersion = input.secretCreated ? RETIRED_VERSION : BOUND_VERSION;
  const currentDeployment = input.secretCreated ? RETIRED_DEPLOYMENT : BOUND_DEPLOYMENT;
  const current = publicVersion({
    versionId: currentVersion,
    ...(input.returnedVersionId === undefined
      ? {}
      : { returnedVersionId: input.returnedVersionId }),
    commit: input.commit ?? COMMIT,
    digest: input.digest ?? BUNDLE_DIGEST,
    executorBinding: input.executorBinding,
    parentToken: input.parentToken,
    ...(input.secretCreated ? { secretCreated: true } : {}),
    ...(input.wrongExecutorService ? { wrongExecutorService: true } : {}),
    ...(input.extraBinding ? { extraBinding: true } : {}),
    ...(input.scriptEtag === undefined ? {} : { scriptEtag: input.scriptEtag }),
  });
  const predecessor = publicVersion({
    versionId: BOUND_VERSION,
    commit: input.commit ?? COMMIT,
    digest: input.digest ?? BUNDLE_DIGEST,
    executorBinding: true,
    parentToken: true,
    ...(input.predecessorScriptEtag === undefined
      ? {}
      : { scriptEtag: input.predecessorScriptEtag }),
  });
  const secretNames = [
    ...(input.parentToken ? LEGACY_SECRETS : PUBLIC_SECRETS),
    ...(input.extraSecret === undefined ? [] : [input.extraSecret]),
  ].sort();
  let deploymentReads = 0;
  const mutations: string[][] = [];
  return {
    mutations,
    state: {
      async workerDomains() {
        return [
          {
            hostname: "api.integration.example.test",
            service: input.domainService ?? target.workerName,
          },
        ];
      },
      async workerDeployments(workerName) {
        expect(workerName).toBe(target.workerName);
        deploymentReads += 1;
        if (input.unstableHistory && deploymentReads > 1) {
          return [
            deployment(
              "00000000-0000-4000-8000-000000000099",
              "00000000-0000-4000-8000-000000000098",
              "2026-09-04T00:03:00.000Z",
            ),
          ];
        }
        return input.secretCreated
          ? [
              deployment(currentDeployment, currentVersion, "2026-09-04T00:02:00.000Z"),
              deployment(BOUND_DEPLOYMENT, BOUND_VERSION, "2026-09-04T00:01:00.000Z"),
            ]
          : [deployment(currentDeployment, currentVersion, "2026-09-04T00:01:00.000Z")];
      },
      async workerVersion(workerName, versionId) {
        expect(workerName).toBe(target.workerName);
        if (input.secretCreated && versionId === BOUND_VERSION) return predecessor;
        expect(versionId).toBe(currentVersion);
        return current;
      },
      async workerSecrets(workerName) {
        expect(workerName).toBe(target.workerName);
        return secretNames.map((name) => ({ name, type: "secret_text" }));
      },
    },
  };
}

function publicVersion(input: {
  readonly versionId: string;
  readonly returnedVersionId?: string;
  readonly commit: string;
  readonly digest: string;
  readonly executorBinding: boolean;
  readonly parentToken: boolean;
  readonly secretCreated?: boolean;
  readonly wrongExecutorService?: boolean;
  readonly extraBinding?: boolean;
  readonly scriptEtag?: string;
}): Record<string, unknown> {
  const secrets = input.parentToken ? LEGACY_SECRETS : PUBLIC_SECRETS;
  const closure = expectedExactBindingClosure(target, {
    expectedSecrets: secrets,
    workerArtifactDigest: `sha256:${input.digest}`,
  });
  const bindings = Object.entries(closure).flatMap(([name, requirement]) => {
    if (
      requirement === null ||
      (!input.executorBinding && name === "CLOUDFLARE_PROVIDER_EXECUTOR")
    ) {
      return [];
    }
    const binding = { name, type: requirement.type, ...requirement.fields };
    return [
      input.wrongExecutorService && name === "CLOUDFLARE_PROVIDER_EXECUTOR"
        ? { ...binding, service: "wrong-provider-executor" }
        : binding,
    ];
  });
  if (input.extraBinding) {
    bindings.push({ name: "UNRELATED_SERVICE", type: "service", service: "unrelated-worker" });
  }
  return {
    id: input.returnedVersionId ?? input.versionId,
    annotations: input.secretCreated
      ? { "workers/triggered_by": "secret" }
      : {
          "workers/message": `takoserver-worker:${input.commit}:${input.digest}`,
          "workers/triggered_by": "version_upload",
        },
    resources: { bindings, script: { etag: input.scriptEtag ?? "public-worker-script-etag" } },
  };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function deployment(id: string, versionId: string, createdOn: string): Record<string, unknown> {
  return {
    id,
    created_on: createdOn,
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

type ExecutorInspection = Awaited<ReturnType<WorkerProviderExecutorQualification["read"]>>;

function executorInspection(overrides: Partial<ExecutorInspection> = {}): ExecutorInspection {
  return {
    status: "ready",
    ready: true,
    managedExact: true,
    routeLess: true,
    schemaReady: true,
    dependencies: {
      ready: true,
      receiptAuthorityReady: true,
      receiptAuthorityVersionId: "00000000-0000-4000-8000-000000000051",
      managedWorkerGatewayReady: true,
      managedWorkerGatewayVersionId: "00000000-0000-4000-8000-000000000061",
    },
    versionId: EXECUTOR_VERSION,
    deploymentId: EXECUTOR_DEPLOYMENT,
    previousVersionId: null,
    commit: COMMIT,
    bundleDigestHex: "d".repeat(64),
    moduleDigestHex: "d".repeat(64),
    moduleBytes: new Uint8Array([1]),
    bindingsExact: true,
    secretsExact: true,
    settingsExact: true,
    migrationExact: true,
    ...overrides,
  };
}

function readyExecutorQualification(
  ...sequence: readonly ExecutorInspection[]
): WorkerProviderExecutorQualification {
  let read = 0;
  return {
    async read() {
      const value = sequence[Math.min(read, sequence.length - 1)] ?? executorInspection();
      read += 1;
      return value;
    },
  };
}
