import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactBlobIoCompatibilityState,
  artifactBlobIoCompatibilityAllowsPending,
  artifactBlobIoSchemaAllowsPending,
  inspectArtifactBlobIoDeploymentCompatibility,
  probeArtifactBlobIoQuiescence,
} from "../scripts/deploy/artifact-blob-io-compatibility.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  expectedExactBindingClosure,
  LEGACY_HOSTED_SPONSORSHIP_SECRET,
  LEGACY_PUBLIC_PARENT_SECRET,
  workerSecretsForLegacyCustody,
} from "../scripts/deploy/worker-state.ts";

const COMMIT = "a".repeat(40);
const CURRENT_DEPLOYMENT = "10000000-0000-4000-8000-000000000043";
const ROLLBACK_DEPLOYMENT = "10000000-0000-4000-8000-000000000042";
const CURRENT = "00000000-0000-4000-8000-000000000043";
const ROLLBACK = "00000000-0000-4000-8000-000000000042";
const LEGACY_SECRET_PAIR = [LEGACY_PUBLIC_PARENT_SECRET, LEGACY_HOSTED_SPONSORSHIP_SECRET] as const;
const target = {
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
  artifactBlobIoMode: "pre-0043-quiesced",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

function targetWithoutCompatibilityMode(): DeployTarget {
  const { artifactBlobIoMode, ...unquiesced } = target;
  void artifactBlobIoMode;
  return unquiesced;
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function version(
  versionId: string,
  selected: DeployTarget = target,
  custody: "base" | "full" = "base",
) {
  const digest = versionId === CURRENT ? "c".repeat(64) : "b".repeat(64);
  const expectedSecrets = workerSecretsForLegacyCustody(selected, custody);
  return {
    id: versionId,
    annotations: {
      "workers/message": `takoserver-worker:${COMMIT}:${digest}`,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      bindings: Object.entries(expectedExactBindingClosure(selected, { expectedSecrets })).flatMap(
        ([name, requirement]) =>
          requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
      script: { etag: "script-etag-compatible" },
    },
  };
}

function state(
  selected: DeployTarget = target,
  custody: "base" | "full" = "base",
  storeSecrets: readonly string[] = workerSecretsForLegacyCustody(selected, custody),
): ArtifactBlobIoCompatibilityState {
  return {
    async workerSubdomain() {
      return { enabled: false, previewsEnabled: false };
    },
    async workerDeployments() {
      return [
        deployment(CURRENT_DEPLOYMENT, CURRENT, "2026-09-04T02:00:00.000Z"),
        deployment(ROLLBACK_DEPLOYMENT, ROLLBACK, "2026-09-04T01:00:00.000Z"),
      ];
    },
    async workerVersion(_workerName, versionId) {
      return version(versionId, selected, custody);
    },
    async workerSecrets() {
      return storeSecrets.map((name) => ({ name, type: "secret_text" }));
    },
  };
}

function receipt(path: string, overrides: Readonly<Record<string, unknown>> = {}): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        kind: "takoserver.artifact-blob-io-quiescence@v1",
        environment: target.environment,
        accountId: target.accountId,
        workerName: target.workerName,
        databaseId: target.d1.databaseId,
        bucketName: target.r2.bucketName,
        currentCompatibilityDeploymentId: CURRENT_DEPLOYMENT,
        rollbackCompatibilityDeploymentId: ROLLBACK_DEPLOYMENT,
        currentCompatibilityVersionId: CURRENT,
        rollbackCompatibilityVersionId: ROLLBACK,
        unsafePredecessorInvocations: "drained-or-cancelled",
        observedAt: "2026-09-04T03:00:00.000Z",
        operator: "operator@example.test",
        ...overrides,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

describe("0043 artifact blob I/O deployment compatibility", () => {
  test("allows only the exact 0037-0043 lineage and contiguous later pending migrations", () => {
    const suffix = [
      "0037_worker_runtime_input_preparation_v2.sql",
      "0038_selfhost_edge_kv.sql",
      "0039_takoform_live_native_claim_across_tenants.sql",
      "0040_selfhost_queues_and_schedules.sql",
      "0041_selfhost_object_buckets.sql",
      "0042_worker_endpoint_origin_reservation_space_id.sql",
      "0043_artifact_blob_io_fences.sql",
    ];
    expect(artifactBlobIoCompatibilityAllowsPending(target, suffix)).toBe(true);
    expect(artifactBlobIoCompatibilityAllowsPending(target, suffix.slice(5))).toBe(true);
    expect(artifactBlobIoCompatibilityAllowsPending(target, suffix.slice(0, -1))).toBe(false);
    expect(
      artifactBlobIoCompatibilityAllowsPending(target, [
        ...suffix,
        "0044_artifact_consumer_resolution_receipts.sql",
        "0045_cloudflare_provider_executor_operations.sql",
        "0046_exact_artifact_recovery_receipts.sql",
        "0047_sponsorship_cutover_consumption.sql",
        "0048_resource_execution_evidence.sql",
        "0049_artifact_consumer_active_resolution.sql",
      ]),
    ).toBe(true);
    expect(
      artifactBlobIoCompatibilityAllowsPending(target, [
        "0043_artifact_blob_io_fences.sql",
        "0044_artifact_consumer_resolution_receipts.sql",
      ]),
    ).toBe(true);
    expect(artifactBlobIoCompatibilityAllowsPending(target, [])).toBe(false);
    expect(
      artifactBlobIoCompatibilityAllowsPending(target, [
        "0044_artifact_consumer_resolution_receipts.sql",
      ]),
    ).toBe(false);
    expect(
      artifactBlobIoCompatibilityAllowsPending(target, [
        "0042_worker_endpoint_origin_reservation_space_id.sql",
        "0043_artifact_blob_io_fences.sql",
        "0045_cloudflare_provider_executor_operations.sql",
      ]),
    ).toBe(false);
    expect(
      artifactBlobIoCompatibilityAllowsPending(target, [
        "0042_worker_endpoint_origin_reservation_space_id.sql",
        "0043_artifact_blob_io_fences.sql",
        "0044_artifact_consumer_resolution_receipts.sql",
        "0044_artifact_consumer_resolution_receipts.sql",
      ]),
    ).toBe(false);
    expect(artifactBlobIoCompatibilityAllowsPending(targetWithoutCompatibilityMode(), suffix)).toBe(
      false,
    );
  });

  test("requires the quiesced schema predicate while normal Workers require no pending migrations", () => {
    expect(artifactBlobIoSchemaAllowsPending(target, [])).toBe(false);
    expect(artifactBlobIoSchemaAllowsPending(target, ["0043_artifact_blob_io_fences.sql"])).toBe(
      true,
    );
    expect(artifactBlobIoSchemaAllowsPending(targetWithoutCompatibilityMode(), [])).toBe(true);
    expect(
      artifactBlobIoSchemaAllowsPending(targetWithoutCompatibilityMode(), [
        "0043_artifact_blob_io_fences.sql",
      ]),
    ).toBe(false);
  });

  test("probes the dedicated all-traffic quiescence response instead of product health", async () => {
    expect(
      await probeArtifactBlobIoQuiescence(target.publicOrigin, async () =>
        Response.json(
          {
            error: {
              code: "backend_unavailable",
              message: "artifact blob I/O is quiesced for the 0043 compatibility cutover",
              details: { reason: "runtime-configuration" },
            },
          },
          {
            status: 503,
            headers: { "cache-control": "no-store", "retry-after": "60" },
          },
        ),
      ),
    ).toEqual({
      url: `${target.publicOrigin}/healthz`,
      status: 503,
      traffic: "quiesced",
    });
  });

  test("requires a private drain receipt after proving current and rollback versions are quiesced", async () => {
    const withoutReceipt = await inspectArtifactBlobIoDeploymentCompatibility({
      phase: "preflight",
      target,
      selectedCommit: COMMIT,
      state: state(),
    });
    expect(withoutReceipt).toEqual({
      status: "drain_receipt_required",
      currentCompatibilityDeploymentId: CURRENT_DEPLOYMENT,
      rollbackCompatibilityDeploymentId: ROLLBACK_DEPLOYMENT,
      currentCompatibilityVersionId: CURRENT,
      rollbackCompatibilityVersionId: ROLLBACK,
      unsafePredecessorInvocations: "unproven",
    });

    const root = mkdtempSync(join(tmpdir(), "takoserver-artifact-quiescence-"));
    try {
      const path = join(root, "receipt.json");
      receipt(path);
      expect(
        await inspectArtifactBlobIoDeploymentCompatibility({
          phase: "preflight",
          target,
          selectedCommit: COMMIT,
          state: state(),
          receiptPath: path,
        }),
      ).toEqual({
        status: "ready",
        currentCompatibilityDeploymentId: CURRENT_DEPLOYMENT,
        rollbackCompatibilityDeploymentId: ROLLBACK_DEPLOYMENT,
        currentCompatibilityVersionId: CURRENT,
        rollbackCompatibilityVersionId: ROLLBACK,
        unsafePredecessorInvocations: "drained-or-cancelled",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts one exact full legacy custody pair shared by current and rollback", async () => {
    const withoutReceipt = await inspectArtifactBlobIoDeploymentCompatibility({
      phase: "preflight",
      target,
      selectedCommit: COMMIT,
      state: state(target, "full"),
    });
    expect(withoutReceipt).toMatchObject({
      status: "drain_receipt_required",
      currentCompatibilityVersionId: CURRENT,
      rollbackCompatibilityVersionId: ROLLBACK,
    });

    const differingProfiles: ArtifactBlobIoCompatibilityState = {
      ...state(target, "full"),
      async workerVersion(_workerName, versionId) {
        return version(versionId, target, versionId === CURRENT ? "full" : "base");
      },
    };
    await expect(
      inspectArtifactBlobIoDeploymentCompatibility({
        phase: "preflight",
        target,
        selectedCommit: COMMIT,
        state: differingProfiles,
      }),
    ).rejects.toThrow("do not share the same legacy-secret custody");
  });

  test("refuses full compatibility Versions when the live secret store drops one or both legacy keys", async () => {
    const fullStore = workerSecretsForLegacyCustody(target, "full");
    for (const missing of [
      LEGACY_SECRET_PAIR,
      [LEGACY_SECRET_PAIR[0]],
      [LEGACY_SECRET_PAIR[1]],
    ] as const) {
      const missingNames = new Set<string>(missing);
      const retained = fullStore.filter((name) => !missingNames.has(name));
      await expect(
        inspectArtifactBlobIoDeploymentCompatibility({
          phase: "preflight",
          target,
          selectedCommit: COMMIT,
          state: state(target, "full", retained),
        }),
      ).rejects.toMatchObject({ phase: "preflight" });
    }
  });

  test("refuses 0043 when either served or one-step rollback code can still perform historical I/O", async () => {
    for (const missingModeFrom of ["current", "rollback"] as const) {
      const unquiesced = targetWithoutCompatibilityMode();
      const source = state();
      const selected: ArtifactBlobIoCompatibilityState = {
        ...source,
        async workerVersion(_workerName, versionId) {
          return version(
            versionId,
            versionId === (missingModeFrom === "current" ? CURRENT : ROLLBACK)
              ? unquiesced
              : target,
          );
        },
      };
      await expect(
        inspectArtifactBlobIoDeploymentCompatibility({
          phase: "preflight",
          target,
          selectedCommit: COMMIT,
          state: selected,
        }),
      ).rejects.toThrow("pre-0043-quiesced");
    }
  });

  test("requires the served and rollback Versions to carry the same strong executable identity", async () => {
    const source = state();
    const missingRollbackIdentity: ArtifactBlobIoCompatibilityState = {
      ...source,
      async workerVersion(_workerName, versionId) {
        const value = version(versionId);
        if (versionId === ROLLBACK) {
          const { script: _script, ...resources } = value.resources;
          void _script;
          return { ...value, resources };
        }
        return value;
      },
    };
    await expect(
      inspectArtifactBlobIoDeploymentCompatibility({
        phase: "preflight",
        target,
        selectedCommit: COMMIT,
        state: missingRollbackIdentity,
      }),
    ).rejects.toThrow("script content identity");

    const differentRollbackIdentity: ArtifactBlobIoCompatibilityState = {
      ...source,
      async workerVersion(_workerName, versionId) {
        const value = version(versionId);
        return {
          ...value,
          resources: {
            ...value.resources,
            script: {
              etag: versionId === CURRENT ? "script-etag-compatible" : "script-etag-different",
            },
          },
        };
      },
    };
    await expect(
      inspectArtifactBlobIoDeploymentCompatibility({
        phase: "preflight",
        target,
        selectedCommit: COMMIT,
        state: differentRollbackIdentity,
      }),
    ).rejects.toThrow("same strong script content identity");
  });

  test("refuses publicly reachable preview URLs for historical Worker Versions", async () => {
    const source = state();
    await expect(
      inspectArtifactBlobIoDeploymentCompatibility({
        phase: "preflight",
        target,
        selectedCommit: COMMIT,
        state: {
          ...source,
          async workerSubdomain() {
            return { enabled: false, previewsEnabled: true };
          },
        },
      }),
    ).rejects.toThrow("preview URLs remain enabled");
  });

  test("refuses preview URLs enabled while compatibility history is being inspected", async () => {
    const source = state();
    let reads = 0;
    await expect(
      inspectArtifactBlobIoDeploymentCompatibility({
        phase: "preflight",
        target,
        selectedCommit: COMMIT,
        state: {
          ...source,
          async workerSubdomain() {
            reads += 1;
            return { enabled: false, previewsEnabled: reads > 1 };
          },
        },
      }),
    ).rejects.toThrow("preview URLs remain enabled");
    expect(reads).toBe(2);
  });

  test("binds the drain assertion to both live compatibility version identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-artifact-quiescence-mismatch-"));
    try {
      const path = join(root, "receipt.json");
      receipt(path, { rollbackCompatibilityVersionId: "00000000-0000-4000-8000-000000000041" });
      await expect(
        inspectArtifactBlobIoDeploymentCompatibility({
          phase: "preflight",
          target,
          selectedCommit: COMMIT,
          state: state(),
          receiptPath: path,
        }),
      ).rejects.toThrow("does not match the authoritative compatibility versions");

      receipt(path, { observedAt: "2026-09-04T00:30:00.000Z" });
      await expect(
        inspectArtifactBlobIoDeploymentCompatibility({
          phase: "preflight",
          target,
          selectedCommit: COMMIT,
          state: state(),
          receiptPath: path,
        }),
      ).rejects.toThrow("predates the compatibility deployments");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not replay a drain receipt after the same Versions are redeployed", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-artifact-quiescence-replayed-"));
    try {
      const path = join(root, "receipt.json");
      receipt(path);
      const source = state();
      const redeployed: ArtifactBlobIoCompatibilityState = {
        ...source,
        async workerDeployments() {
          return [
            deployment("20000000-0000-4000-8000-000000000043", CURRENT, "2026-09-04T04:00:00.000Z"),
            deployment(
              "20000000-0000-4000-8000-000000000042",
              ROLLBACK,
              "2026-09-04T03:30:00.000Z",
            ),
          ];
        },
      };
      await expect(
        inspectArtifactBlobIoDeploymentCompatibility({
          phase: "preflight",
          target,
          selectedCommit: COMMIT,
          state: redeployed,
          receiptPath: path,
        }),
      ).rejects.toThrow("deployment identities");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
