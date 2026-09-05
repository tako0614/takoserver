import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExactArtifactRecoveryDeployRuntime,
  planExactArtifactRecoveryDeployment,
  runExactArtifactRecoveryDeployment,
  writeExactArtifactRecoveryGatewayConfig,
  writeExactArtifactRecoveryWorkerConfig,
} from "../scripts/deploy/exact-artifact-recovery.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  ARTIFACT_RECOVERY_REQUEST_FORMAT,
  ARTIFACT_RECOVERY_RETENTION_FORMAT,
  type ArtifactRecoveryRequest,
} from "../src/artifact-recovery.ts";
import { INTEGRATION_E2E_ORGANIZATION_ID } from "../src/integration-e2e-credential-authority.ts";

const COMMIT = "b".repeat(40);
const REQUEST_DIGEST = `sha256:${"1".repeat(64)}` as const;
const WORKER_VERSION = "10000000-0000-4000-8000-000000000046";
const GATEWAY_VERSION = "20000000-0000-4000-8000-000000000046";
const RETENTION = {
  kind: ARTIFACT_RECOVERY_RETENTION_FORMAT,
  evidenceDigest: `sha256:${"d".repeat(64)}` as const,
  detailRetentionMilliseconds: 7 * 24 * 60 * 60_000,
} as const;

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
  signing: { currentKeyId: "takoserver-integration-key" },
  cloudflareProviderExecutor: {
    workerName: "takoserver-provider-executor-integration",
    dispatchNamespace: "takoserver-customers-integration",
    gatewayWorkerName: "takoserver-managed-gateway-integration",
    managedBaseDomain: "managed.integration.example.test",
    providerInstallationId: "cloudflare.integration",
    receiptAuthorityWorkerName: "takoserver-receipt-authority-integration",
  },
  formAuthority: {
    workerName: "takoserver-form-authority-integration",
    identityProbeWorkerName: "takoserver-form-identity-integration",
    identityProbeOrigin: "https://takoserver-form-identity-integration.example.workers.dev",
    integrationWorkerName: "takoserver-form-fixture-integration",
    integrationOperatorWorkerName: "takoserver-form-operator-integration",
    integrationOperatorOrigin: "https://form-authority.integration.example.test",
    integrationOperatorScope: {
      tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
      space: "space-integration",
    },
    operatorPublicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
    hostId: "https://api.integration.example.test",
  },
  integrationE2eCredentialAuthority: {
    organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
  },
  exactArtifactRecovery: {
    workerName: "takoserver-exact-recovery-integration",
    retentionPolicy: RETENTION,
  },
} satisfies DeployTarget;

const request = {
  kind: ARTIFACT_RECOVERY_REQUEST_FORMAT,
  tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
  r2: {
    accountId: target.accountId,
    bucketName: target.r2.bucketName,
    identityDigest: `sha256:${"2".repeat(64)}`,
  },
  source: { repository: "takoserver", commit: COMMIT, version: "recovery-v1" },
  retentionPolicy: RETENTION,
} as ArtifactRecoveryRequest;

describe("exact artifact recovery deploy lifecycle", () => {
  test("plans publication, execution, binding-backed purge, then retirement in order", () => {
    const base = {
      executorReady: true,
      requestDigest: REQUEST_DIGEST,
      selectedCommit: COMMIT,
    } as const;
    expect(
      planExactArtifactRecoveryDeployment({
        ...base,
        worker: { state: "absent" },
        gateway: { state: "ordinary", versionId: GATEWAY_VERSION },
        receipt: null,
        recoveryStatus: null,
        now: 1,
      }).action,
    ).toBe("publish_worker");
    expect(
      planExactArtifactRecoveryDeployment({
        ...base,
        worker: {
          state: "ready",
          versionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
          commit: COMMIT,
          handoff: null,
        },
        gateway: { state: "ordinary", versionId: GATEWAY_VERSION },
        receipt: null,
        recoveryStatus: null,
        now: 1,
      }).action,
    ).toBe("publish_gateway");
    expect(
      planExactArtifactRecoveryDeployment({
        ...base,
        worker: {
          state: "ready",
          versionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
          commit: COMMIT,
          handoff: null,
        },
        gateway: {
          state: "recovery",
          versionId: GATEWAY_VERSION,
          recoveryWorkerVersionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
        },
        receipt: null,
        recoveryStatus: { phase: "eligible", action: "prepare" },
        now: 1,
      }).action,
    ).toBe("invoke");
    expect(
      planExactArtifactRecoveryDeployment({
        ...base,
        worker: {
          state: "ready",
          versionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
          commit: COMMIT,
          handoff: null,
        },
        gateway: {
          state: "recovery",
          versionId: GATEWAY_VERSION,
          recoveryWorkerVersionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
        },
        receipt: {
          phase: "complete",
          detailState: "active",
          activeWorkerVersionId: WORKER_VERSION,
          purgeAfter: 20,
          resultSetDigest: `sha256:${"3".repeat(64)}`,
        },
        recoveryStatus: { phase: "complete", action: "none" },
        now: 10,
      }).action,
    ).toBe("wait_retention");
    expect(
      planExactArtifactRecoveryDeployment({
        ...base,
        worker: {
          state: "ready",
          versionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
          commit: COMMIT,
          handoff: null,
        },
        gateway: {
          state: "recovery",
          versionId: GATEWAY_VERSION,
          recoveryWorkerVersionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
        },
        receipt: {
          phase: "complete",
          detailState: "active",
          activeWorkerVersionId: WORKER_VERSION,
          purgeAfter: 20,
          resultSetDigest: `sha256:${"3".repeat(64)}`,
        },
        recoveryStatus: { phase: "complete", action: "none" },
        now: 20,
      }).action,
    ).toBe("purge_details");
    expect(
      planExactArtifactRecoveryDeployment({
        ...base,
        worker: {
          state: "ready",
          versionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
          commit: COMMIT,
          handoff: null,
        },
        gateway: {
          state: "recovery",
          versionId: GATEWAY_VERSION,
          recoveryWorkerVersionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
        },
        receipt: {
          phase: "complete",
          detailState: "purged",
          activeWorkerVersionId: WORKER_VERSION,
          purgeAfter: 20,
          resultSetDigest: `sha256:${"3".repeat(64)}`,
        },
        recoveryStatus: { phase: "complete", action: "none" },
        now: 20,
      }).action,
    ).toBe("retire_gateway");
    expect(
      planExactArtifactRecoveryDeployment({
        ...base,
        worker: {
          state: "ready",
          versionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
          commit: COMMIT,
          handoff: null,
        },
        gateway: { state: "ordinary", versionId: GATEWAY_VERSION },
        receipt: {
          phase: "complete",
          detailState: "purged",
          activeWorkerVersionId: WORKER_VERSION,
          purgeAfter: 20,
          resultSetDigest: `sha256:${"3".repeat(64)}`,
        },
        recoveryStatus: null,
        now: 21,
      }).action,
    ).toBe("retire_worker");
  });

  test("dirty integration apply rejects before any recovery mutation", async () => {
    const before = {
      executorReady: true,
      requestDigest: REQUEST_DIGEST,
      selectedCommit: COMMIT,
      worker: { state: "absent" as const },
      gateway: { state: "ordinary" as const, versionId: GATEWAY_VERSION },
      receipt: null,
      recoveryStatus: null,
      now: 1,
    };
    const mutations: string[] = [];
    const commands: string[] = [];
    await expect(
      runExactArtifactRecoveryDeployment(
        {
          surface: "takoserver-exact-artifact-recovery",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          review: "reviewer@example.test",
          runtime: {
            async inspect() {
              return before;
            },
            async apply(action) {
              mutations.push(action);
              return {};
            },
          },
          async run(command) {
            const key = command.join(" ");
            commands.push(key);
            if (key === "git rev-parse HEAD") {
              return { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" };
            }
            if (key === "git branch --show-current") {
              return { exitCode: 0, stdout: "release/candidate\n", stderr: "" };
            }
            if (key === "git status --porcelain=v1 -z --untracked-files=all") {
              return {
                exitCode: 0,
                stdout: " M src/entry-exact-artifact-recovery-worker.ts\0",
                stderr: "",
              };
            }
            throw new Error(`unexpected command: ${key}`);
          },
        },
      ),
    ).rejects.toThrow("clean");
    expect(mutations).toEqual([]);
    expect(commands).not.toContain("bun run check");
  });

  test("plans gateway quiescence before a lost-ack successor can be published", () => {
    const receipt = {
      phase: "settling" as const,
      detailState: "active" as const,
      activeWorkerVersionId: WORKER_VERSION,
      purgeAfter: null,
      resultSetDigest: null,
    };
    const worker = {
      state: "ready" as const,
      versionId: WORKER_VERSION,
      requestDigest: REQUEST_DIGEST,
      commit: COMMIT,
      handoff: null,
    };
    expect(
      planExactArtifactRecoveryDeployment({
        executorReady: true,
        requestDigest: REQUEST_DIGEST,
        selectedCommit: COMMIT,
        worker,
        gateway: {
          state: "recovery",
          versionId: GATEWAY_VERSION,
          recoveryWorkerVersionId: WORKER_VERSION,
          requestDigest: REQUEST_DIGEST,
        },
        receipt,
        recoveryStatus: {
          phase: "blocked",
          action: "none",
          blocker: "recovery_version_not_retired",
        },
        now: 1,
      }).action,
    ).toBe("retire_gateway_for_handoff");
    expect(
      planExactArtifactRecoveryDeployment({
        executorReady: true,
        requestDigest: REQUEST_DIGEST,
        selectedCommit: COMMIT,
        worker,
        gateway: { state: "ordinary", versionId: GATEWAY_VERSION },
        receipt,
        recoveryStatus: null,
        now: 2,
      }).action,
    ).toBe("publish_handoff_worker");
  });

  test("realizes a route-less Worker and an exact temporary gateway overlay", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-recovery-config-"));
    try {
      const workerPath = writeExactArtifactRecoveryWorkerConfig({
        path: join(root, "worker.jsonc"),
        main: "worker.js",
        target,
        request,
        requestDigest: REQUEST_DIGEST,
      });
      const worker = JSON.parse(readFileSync(workerPath, "utf8"));
      expect(worker).not.toHaveProperty("routes");
      expect(worker).not.toHaveProperty("route");
      expect(worker).not.toHaveProperty("triggers");
      expect(worker).toMatchObject({
        name: target.exactArtifactRecovery.workerName,
        workers_dev: false,
        preview_urls: false,
        d1_databases: [{ binding: "STATE_DB", database_id: target.d1.databaseId }],
        r2_buckets: [{ binding: "OBJECTS", bucket_name: target.r2.bucketName }],
      });

      const gatewayPath = writeExactArtifactRecoveryGatewayConfig({
        path: join(root, "gateway.jsonc"),
        main: "gateway.js",
        target,
        commit: COMMIT,
        recovery: { requestDigest: REQUEST_DIGEST, workerVersionId: WORKER_VERSION },
      });
      const gateway = JSON.parse(readFileSync(gatewayPath, "utf8"));
      expect(gateway.services).toContainEqual({
        binding: "EXACT_ARTIFACT_RECOVERY",
        service: target.exactArtifactRecovery.workerName,
        entrypoint: "ExactArtifactRecoveryEntrypoint",
      });
      expect(gateway.vars).toMatchObject({
        TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: REQUEST_DIGEST,
        TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID: WORKER_VERSION,
      });
      expect(gateway.routes).toEqual([
        {
          pattern: new URL(target.formAuthority.integrationOperatorOrigin).hostname,
          custom_domain: true,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses provider, request, commit and topology drift", () => {
    const base = {
      executorReady: true,
      requestDigest: REQUEST_DIGEST,
      selectedCommit: COMMIT,
      worker: {
        state: "ready" as const,
        versionId: WORKER_VERSION,
        requestDigest: REQUEST_DIGEST,
        commit: COMMIT,
        handoff: null,
      },
      gateway: { state: "ordinary" as const, versionId: GATEWAY_VERSION },
      receipt: null,
      recoveryStatus: null,
      now: 1,
    };
    for (const drift of [
      { ...base, executorReady: false },
      { ...base, worker: { ...base.worker, requestDigest: `sha256:${"f".repeat(64)}` as const } },
      { ...base, worker: { ...base.worker, commit: "f".repeat(40) } },
      { ...base, gateway: { state: "drift" as const } },
    ]) {
      expect(planExactArtifactRecoveryDeployment(drift).action).toBe("refuse");
    }
  });

  test("the product deploy surface performs one transition and redacts its effect", async () => {
    const before = {
      executorReady: true,
      requestDigest: REQUEST_DIGEST,
      selectedCommit: COMMIT,
      worker: { state: "absent" as const },
      gateway: { state: "ordinary" as const, versionId: GATEWAY_VERSION },
      receipt: null,
      recoveryStatus: null,
      now: 1,
    };
    const after = {
      ...before,
      worker: {
        state: "ready" as const,
        versionId: WORKER_VERSION,
        requestDigest: REQUEST_DIGEST,
        commit: COMMIT,
        handoff: null,
      },
    };
    let inspection = 0;
    const applied: string[] = [];
    const runtime: ExactArtifactRecoveryDeployRuntime = {
      async inspect() {
        inspection += 1;
        return inspection === 1 ? before : after;
      },
      async apply(action) {
        applied.push(action);
        return {
          kind: "takoserver.exact-artifact-recovery-effect@v1",
          action,
          workerName: target.exactArtifactRecovery.workerName,
          versionId: WORKER_VERSION,
          credential: "must-never-leave-the-runtime",
          requestBody: request,
        };
      },
    };
    const result = await runExactArtifactRecoveryDeployment(
      {
        surface: "takoserver-exact-artifact-recovery",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      { runtime, review: "reviewer@example.test", run: cleanRemoteSourceRun },
    );
    expect(applied).toEqual(["publish_worker"]);
    expect(result).toMatchObject({
      mutation: "publish_worker",
      effect: {
        action: "publish_worker",
        workerName: target.exactArtifactRecovery.workerName,
        versionId: WORKER_VERSION,
      },
      next: { action: "publish_gateway" },
    });
    expect(JSON.stringify(result)).not.toContain("must-never-leave-the-runtime");
    expect(JSON.stringify(result)).not.toContain("memberDigests");
  });

  test("status exposes only the deterministic quiescence digest after gateway retirement", async () => {
    const snapshot = {
      executorReady: true,
      requestDigest: REQUEST_DIGEST,
      selectedCommit: COMMIT,
      worker: {
        state: "ready" as const,
        versionId: WORKER_VERSION,
        requestDigest: REQUEST_DIGEST,
        commit: COMMIT,
        handoff: null,
      },
      gateway: { state: "ordinary" as const, versionId: GATEWAY_VERSION },
      receipt: {
        phase: "settling" as const,
        detailState: "active" as const,
        activeWorkerVersionId: WORKER_VERSION,
        purgeAfter: null,
        resultSetDigest: null,
        nextCandidate: { ordinal: 3, fence: 7, state: "delete_started" as const },
      },
      recoveryStatus: null,
      now: 1,
    };
    const result = await runExactArtifactRecoveryDeployment(
      {
        surface: "takoserver-exact-artifact-recovery",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      {
        runtime: {
          async inspect() {
            return snapshot;
          },
          async apply() {
            throw new Error("status must be read-only");
          },
        },
      },
    );
    expect(result.plan).toEqual({
      action: "publish_handoff_worker",
      reason: "the old Version is quiesced; a reviewed successor may now be published",
    });
    expect(result.quiescenceEvidenceDigest).toEqual(expect.stringMatching(/^sha256:[0-9a-f]{64}$/));
    const repeated = await runExactArtifactRecoveryDeployment(
      {
        surface: "takoserver-exact-artifact-recovery",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      {
        runtime: {
          async inspect() {
            return snapshot;
          },
          async apply() {
            throw new Error("status must be read-only");
          },
        },
      },
    );
    expect(repeated.quiescenceEvidenceDigest).toBe(result.quiescenceEvidenceDigest);
  });
});

async function cleanRemoteSourceRun(command: readonly string[]) {
  const key = command.join(" ");
  if (key === "git rev-parse HEAD") {
    return { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" };
  }
  if (key === "git branch --show-current") {
    return { exitCode: 0, stdout: "release/candidate\n", stderr: "" };
  }
  if (key === "git status --porcelain=v1 -z --untracked-files=all") {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (key === "git fetch --quiet --all --prune") {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (key === `git branch -r --contains ${COMMIT}`) {
    return { exitCode: 0, stdout: "  origin/release-candidate\n", stderr: "" };
  }
  throw new Error(`unexpected command: ${key}`);
}
