import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as exactArtifactRecoveryDeploy from "../scripts/deploy/exact-artifact-recovery.ts";
import {
  type ExactArtifactRecoveryDeploymentSnapshot,
  type ExactArtifactRecoveryDeployRuntime,
  planExactArtifactRecoveryDeployment,
  runExactArtifactRecoveryDeployment,
  writeExactArtifactRecoveryGatewayConfig,
  writeExactArtifactRecoveryWorkerConfig,
} from "../scripts/deploy/exact-artifact-recovery.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WorkerProviderExecutorQualification } from "../scripts/deploy/worker.ts";
import {
  ARTIFACT_RECOVERY_LINEAGE_DIGEST,
  ARTIFACT_RECOVERY_LINEAGE_MIGRATION,
  ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
  ARTIFACT_RECOVERY_REQUEST_FORMAT,
  ARTIFACT_RECOVERY_RETENTION_FORMAT,
  type ArtifactRecoveryRequest,
  canonicalArtifactRecoveryRequest,
} from "../src/artifact-recovery.ts";
import { normalizeGeneratedEd25519PrivateJwk } from "../src/ed25519-private-jwk.ts";
import {
  deterministicIntegrationE2eApiKeyIds,
  INTEGRATION_E2E_ORGANIZATION_ID,
} from "../src/integration-e2e-credential-authority.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";

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
  test("fails closed without owner-injected live executor qualification", async () => {
    await expect(
      runExactArtifactRecoveryDeployment(
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
              throw new Error("runtime must not be inspected");
            },
            async apply() {
              throw new Error("status must be read-only");
            },
          },
        },
      ),
    ).rejects.toThrow("owner-injected live qualification");
  });

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
          providerExecutorQualification: readyExecutorQualification(),
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
      {
        runtime,
        review: "reviewer@example.test",
        run: cleanRemoteSourceRun,
        providerExecutorQualification: readyExecutorQualification(),
      },
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
        providerExecutorQualification: readyExecutorQualification(),
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
        providerExecutorQualification: readyExecutorQualification(),
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

describe("exact artifact recovery owned runtime around the owner gate", () => {
  test("re-resolves the OAuth bearer for every Cloudflare and D1 read after the gate", async () => {
    const fixture = await ownedRecoveryFixture();
    const tokens = { current: "oauth-access-before-gate" };
    const observed: { readonly url: string; readonly authorization: string | null }[] = [];
    await withoutNetwork(async (network) => {
      const runtime = await createOwnedRuntime(fixture, {
        cloudflareEnvironment: {},
        run: oauthRun(tokens, fixture.commands),
        fetcher: recordingFetcher(observed),
      });
      try {
        await runtime.inspect().catch(() => undefined);
        await settle();
        const beforeGate = observed.splice(0);
        expectCloudflareAndD1Reads(beforeGate);
        expect(bearers(beforeGate)).toEqual(["Bearer oauth-access-before-gate"]);

        // The access token expires while the long owner gate runs.
        tokens.current = "oauth-access-after-gate";
        await runtime.refreshCredential();
        await runtime.inspect().catch(() => undefined);
        await settle();
        const afterGate = observed.splice(0);
        expectCloudflareAndD1Reads(afterGate);
        expect(bearers(afterGate)).toEqual(["Bearer oauth-access-after-gate"]);
        expect(
          fixture.commands.filter((command) => command.endsWith("auth token --json")),
        ).toHaveLength(2);
      } finally {
        await runtime.dispose?.();
      }
      expect(network).toEqual([]);
    }).finally(() => rmSync(fixture.root, { recursive: true, force: true }));
  });

  test("refuses an unusable lost-ack successor authority before the owner gate", async () => {
    const fixture = await ownedRecoveryFixture();
    const before = quiescedHandoffSnapshot(fixture.requestDigest);
    const status = await runExactArtifactRecoveryDeployment(
      {
        surface: "takoserver-exact-artifact-recovery",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      {
        providerExecutorQualification: readyExecutorQualification(),
        runtime: {
          async inspect() {
            return before;
          },
          async apply() {
            throw new Error("status must be read-only");
          },
        },
      },
    );
    const lostAck = {
      kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
      candidateOrdinal: 3,
      predecessorWorkerVersionId: WORKER_VERSION,
      quiescenceEvidenceDigest: status.quiescenceEvidenceDigest,
      resolution: { kind: "confirm-head-absent" },
    };
    const lostAckPath = join(fixture.root, "lost-ack.json");
    const observed: { readonly url: string; readonly authorization: string | null }[] = [];
    await withoutNetwork(async (network) => {
      const runtime = await createOwnedRuntime(fixture, {
        cloudflareEnvironment: {},
        run: oauthRun({ current: "oauth-access-before-gate" }, fixture.commands),
        fetcher: recordingFetcher(observed),
        lostAckPath,
      });
      try {
        writeFileSync(lostAckPath, JSON.stringify(lostAck, null, 2), { mode: 0o600 });
        await expect(
          runtime.assertBeforeOwnerGate("publish_handoff_worker", before),
        ).rejects.toThrow("not canonical JSON");
        writeFileSync(
          lostAckPath,
          canonicalJson({ ...lostAck, quiescenceEvidenceDigest: `sha256:${"0".repeat(64)}` }),
        );
        await expect(
          runtime.assertBeforeOwnerGate("publish_handoff_worker", before),
        ).rejects.toThrow("does not match quiesced state");
        writeFileSync(lostAckPath, canonicalJson(lostAck));
        await runtime.assertBeforeOwnerGate("publish_handoff_worker", before);
        // Only the successor publication consumes the lost-ack authority.
        rmSync(lostAckPath);
        await runtime.assertBeforeOwnerGate("publish_worker", {
          ...before,
          worker: { state: "absent" },
          receipt: null,
        });
      } finally {
        await runtime.dispose?.();
      }
      expect(fixture.commands.some((command) => command === "bun run check")).toBe(false);
      expect(observed).toEqual([]);
      expect(network).toEqual([]);
    }).finally(() => rmSync(fixture.root, { recursive: true, force: true }));
  });

  test("refuses an unusable operator key before a gate whose readback signs with it", async () => {
    const fixture = await ownedRecoveryFixture();
    const before = {
      ...quiescedHandoffSnapshot(fixture.requestDigest),
      receipt: null,
    } satisfies ExactArtifactRecoveryDeploymentSnapshot;
    expect(planExactArtifactRecoveryDeployment(before).action).toBe("publish_gateway");
    const observed: { readonly url: string; readonly authorization: string | null }[] = [];
    await withoutNetwork(async (network) => {
      const runtime = await createOwnedRuntime(fixture, {
        cloudflareEnvironment: {},
        run: oauthRun({ current: "oauth-access-before-gate" }, fixture.commands),
        fetcher: recordingFetcher(observed),
      });
      try {
        writeFileSync(fixture.operatorPrivateJwkPath, "{}\n", { mode: 0o600 });
        await expect(runtime.assertBeforeOwnerGate("publish_gateway", before)).rejects.toThrow(
          "operator private JWK must be one exact Ed25519 signing key",
        );
        const pair = (await crypto.subtle.generateKey("Ed25519", true, [
          "sign",
          "verify",
        ])) as CryptoKeyPair;
        writeFileSync(
          fixture.operatorPrivateJwkPath,
          JSON.stringify(
            normalizeGeneratedEd25519PrivateJwk(
              await crypto.subtle.exportKey("jwk", pair.privateKey),
            ),
          ),
        );
        await runtime.assertBeforeOwnerGate("publish_gateway", before);
        // A first route-less publication never signs with the operator key.
        rmSync(fixture.operatorPrivateJwkPath);
        await runtime.assertBeforeOwnerGate("publish_worker", {
          ...before,
          worker: { state: "absent" },
        });
      } finally {
        await runtime.dispose?.();
      }
      expect(observed).toEqual([]);
      expect(network).toEqual([]);
    }).finally(() => rmSync(fixture.root, { recursive: true, force: true }));
  });
});

interface OwnedRecoveryFixture {
  readonly root: string;
  readonly requestPath: string;
  readonly requestDigest: `sha256:${string}`;
  readonly operatorPrivateJwkPath: string;
  readonly commands: string[];
}

async function ownedRecoveryFixture(): Promise<OwnedRecoveryFixture> {
  const root = mkdtempSync(join(tmpdir(), "takoserver-recovery-owned-"));
  chmodSync(root, 0o700);
  const canonical = await canonicalArtifactRecoveryRequest(await exactRecoveryRequest());
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, canonical.canonicalJson, { mode: 0o600 });
  return {
    root,
    requestPath,
    requestDigest: canonical.requestDigest,
    operatorPrivateJwkPath: join(root, "operator-private.jwk"),
    commands: [],
  };
}

async function createOwnedRuntime(
  fixture: OwnedRecoveryFixture,
  options: Pick<
    exactArtifactRecoveryDeploy.ExactArtifactRecoveryDeployOptions,
    "cloudflareEnvironment" | "run" | "fetcher" | "lostAckPath"
  >,
) {
  const inspection = await readyExecutorQualification().read("preflight");
  return await exactArtifactRecoveryDeploy.createExactArtifactRecoveryDeployRuntime(
    {
      surface: "takoserver-exact-artifact-recovery",
      action: "apply",
      environment: "integration",
      commit: COMMIT,
    },
    target,
    {
      ...options,
      requestPath: fixture.requestPath,
      operatorPrivateJwkPath: fixture.operatorPrivateJwkPath,
      outputDirectory: join(fixture.root, "work"),
    },
    inspection,
  );
}

function quiescedHandoffSnapshot(
  requestDigest: `sha256:${string}`,
): ExactArtifactRecoveryDeploymentSnapshot {
  return {
    executorReady: true,
    requestDigest,
    selectedCommit: COMMIT,
    worker: {
      state: "ready",
      versionId: WORKER_VERSION,
      requestDigest,
      commit: COMMIT,
      handoff: null,
    },
    gateway: { state: "ordinary", versionId: GATEWAY_VERSION },
    receipt: {
      phase: "settling",
      detailState: "active",
      activeWorkerVersionId: WORKER_VERSION,
      purgeAfter: null,
      resultSetDigest: null,
      nextCandidate: { ordinal: 3, fence: 7, state: "delete_started" },
    },
    recoveryStatus: null,
    now: 1,
  };
}

function oauthRun(
  tokens: { current: string },
  commands: string[],
): NonNullable<exactArtifactRecoveryDeploy.ExactArtifactRecoveryDeployOptions["run"]> {
  return async (command) => {
    const key = command.join(" ");
    commands.push(key);
    if (command.slice(-3).join(" ") === "auth token --json") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ type: "oauth", token: tokens.current })}\n`,
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${key}`);
  };
}

function unauthorized(): Response {
  return Response.json(
    { success: false, result: null, errors: [{ code: 10000, message: "Authentication error" }] },
    { status: 401 },
  );
}

/** Every injected request is recorded and refused; nothing here can reach a network. */
function recordingFetcher(
  observed: { readonly url: string; readonly authorization: string | null }[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    observed.push({ url: request.url, authorization: request.headers.get("authorization") });
    return unauthorized();
  }) as typeof fetch;
}

/** Replaces the global fetch for the whole body so no client the source builds can escape. */
async function withoutNetwork(body: (network: string[]) => Promise<void>): Promise<void> {
  const network: string[] = [];
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    network.push(input instanceof Request ? input.url : String(input));
    return unauthorized();
  }) as typeof fetch;
  try {
    await body(network);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
}

async function settle(): Promise<void> {
  // Promise.all rejects on the first refusal; let its sibling reads record too.
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function bearers(
  observed: readonly { readonly authorization: string | null }[],
): readonly string[] {
  return [
    ...new Set(
      observed.flatMap(({ authorization }) => (authorization === null ? [] : [authorization])),
    ),
  ];
}

function expectCloudflareAndD1Reads(observed: readonly { readonly url: string }[]): void {
  expect(
    observed.some(({ url }) => url.endsWith(`/d1/database/${target.d1.databaseId}/query`)),
  ).toBe(true);
  expect(observed.some(({ url }) => url.includes(`/accounts/${target.accountId}/workers/`))).toBe(
    true,
  );
}

async function exactRecoveryRequest(): Promise<ArtifactRecoveryRequest> {
  const operationIds = [
    "operation-artifact-a",
    "operation-artifact-b",
    "operation-artifact-c",
    "operation-artifact-d",
  ];
  const owners = await Promise.all(
    operationIds.map(async (operationId) => ({
      operationId,
      principalId: `api-key:${(await deterministicIntegrationE2eApiKeyIds(operationId)).writer}`,
    })),
  );
  owners.sort((left, right) => left.principalId.localeCompare(right.principalId));
  const uploads = owners
    .flatMap((owner, index) => [
      {
        principalId: owner.principalId,
        uploadId: `up_exact_${index}_a`,
        uploadFence: 2,
        rootFence: 2,
      },
      ...(index === 0
        ? [
            {
              principalId: owner.principalId,
              uploadId: `up_exact_${index}_b`,
              uploadFence: 2,
              rootFence: 2,
            },
          ]
        : []),
    ])
    .sort((left, right) =>
      `${left.principalId}\u0000${left.uploadId}`.localeCompare(
        `${right.principalId}\u0000${right.uploadId}`,
      ),
    );
  const memberDigests = Array.from(
    { length: 28 },
    (_, index) => `sha256:${index.toString(16).padStart(64, "0")}` as const,
  );
  const manifestDigest = `sha256:${"f".repeat(64)}` as const;
  const holds = [
    { kind: "manifest" as const, digest: manifestDigest },
    ...memberDigests.map((memberDigest) => ({ kind: "blob" as const, digest: memberDigest })),
  ];
  const replayKeys = [
    `${INTEGRATION_E2E_ORGANIZATION_ID}\u0000${owners[0]?.principalId}\u0000commit-a`,
    `${INTEGRATION_E2E_ORGANIZATION_ID}\u0000${owners[1]?.principalId}\u0000commit-b`,
  ].sort();
  return {
    kind: ARTIFACT_RECOVERY_REQUEST_FORMAT,
    tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
    logicalTargetDigest: await canonicalDigest({
      kind: "takoserver.exact-artifact-logical-target@v1",
      tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
      manifestDigest,
      memberSetDigest: await canonicalDigest(memberDigests),
    }),
    owners,
    ownerSetDigest: await canonicalDigest(owners),
    uploads,
    uploadSetDigest: await canonicalDigest(uploads),
    manifestDigest,
    memberDigests,
    memberSetDigest: await canonicalDigest(memberDigests),
    expectedHolds: { entries: holds, count: holds.length, setDigest: await canonicalDigest(holds) },
    expectedReplays: {
      keys: replayKeys,
      count: replayKeys.length,
      setDigest: await canonicalDigest(replayKeys),
    },
    settlementEvidence: {
      kind: "takosumi.apply-run-failure@v1",
      digest: `sha256:${"e".repeat(64)}`,
    },
    lineage: {
      migration: ARTIFACT_RECOVERY_LINEAGE_MIGRATION,
      digest: ARTIFACT_RECOVERY_LINEAGE_DIGEST,
    },
    r2: {
      accountId: target.accountId,
      bucketName: target.r2.bucketName,
      identityDigest: await canonicalDigest({
        kind: "takoserver.r2-artifact-target@v1",
        accountId: target.accountId,
        bucketName: target.r2.bucketName,
      }),
    },
    source: { repository: "takoserver", commit: COMMIT, version: "exact-recovery-test-v1" },
    retentionPolicy: RETENTION,
  };
}

function readyExecutorQualification(): WorkerProviderExecutorQualification {
  return {
    async read() {
      return {
        status: "ready",
        ready: true,
        managedExact: true,
        routeLess: true,
        schemaReady: true,
        dependencies: {
          ready: true,
          receiptAuthorityReady: true,
          receiptAuthorityVersionId: "30000000-0000-4000-8000-000000000046",
          managedWorkerGatewayReady: true,
          managedWorkerGatewayVersionId: GATEWAY_VERSION,
        },
        versionId: "40000000-0000-4000-8000-000000000046",
        deploymentId: "50000000-0000-4000-8000-000000000046",
        previousVersionId: null,
        commit: COMMIT,
        bundleDigestHex: "6".repeat(64),
        moduleDigestHex: "7".repeat(64),
      };
    },
  };
}

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
