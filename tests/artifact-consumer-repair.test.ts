import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT,
  type ArtifactConsumerProviderReader,
  createArtifactConsumerRepair,
} from "../src/artifact-consumer-repair.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const TENANT = "org_repair";
const MANIFEST_A = `sha256:${"a".repeat(64)}` as const;
const MANIFEST_B = `sha256:${"b".repeat(64)}` as const;

describe("artifact consumer repair", () => {
  test("status derives a retained historical plan without accepting an asserted outcome", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_historical");
    database
      .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, 'manifest')")
      .run(TENANT, MANIFEST_A);
    database
      .query(
        `INSERT INTO tf_artifact_manifests (digest, manifest_json, created_at)
         VALUES (?, ?, 100)`,
      )
      .run(
        MANIFEST_A,
        JSON.stringify({
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: "WorkerBundle",
          mainModule: "worker.mjs",
          modules: [],
        }),
      );
    const provider: ArtifactConsumerProviderReader = {
      async verifyArtifactConsumption() {
        throw new Error("status must not call the provider");
      },
      async verifyNativeAbsence() {
        throw new Error("status must not call the provider");
      },
    };
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider,
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_repair_0001",
    });

    const status = await repair.status(TENANT, "dep_historical");

    expect(status).toMatchObject({
      kind: "takoserver.artifact-consumer-repair-status@v1",
      deploymentId: "dep_historical",
      state: "actionable",
      action: "verify-artifact-consumption",
      path: "retained-historical",
      uncertaintyFence: 1,
      candidateManifestCount: 1,
    });
    expect(status.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.keys(status).sort()).not.toContain("outcome");
    expect(ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT).toBe(
      "takoserver.artifact-consumer-repair-apply@v1",
    );
  });

  test("a unique provider-backed historical manifest creates the deployment root and resolves", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_unique");
    seedManifest(database, MANIFEST_A);
    const calls: string[][] = [];
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: {
        async verifyNativeAbsence() {
          throw new Error("wrong readback path");
        },
        async verifyArtifactConsumption(input) {
          calls.push([...input.candidateManifestDigests]);
          return {
            outcome: "present",
            consumption: "identified",
            manifestDigests: [MANIFEST_A],
            evidence: { provider: "fixture", state: "present" },
          };
        },
      },
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_repair_unique",
    });
    const plan = await repair.status(TENANT, "dep_unique");

    const receipt = await repair.apply({
      tenantId: TENANT,
      deploymentId: "dep_unique",
      idempotencyKey: "repair:unique:0001",
      planDigest: plan.planDigest,
    });

    expect(calls).toEqual([[MANIFEST_A]]);
    expect(receipt).toMatchObject({
      resolution: "attributed_manifest",
      manifestDigest: MANIFEST_A,
      uncertaintyFence: 1,
    });
    expect(
      database
        .query(
          `SELECT state, fence FROM tf_artifact_consumer_uncertainties
           WHERE tenant_id = ? AND consumer_id = ?`,
        )
        .get(TENANT, "dep_unique"),
    ).toEqual({ state: "resolved", fence: 2 });
    expect(
      database
        .query(
          `SELECT state, digest FROM tf_artifact_roots
           WHERE tenant_id = ? AND root_kind = 'deployment' AND root_id = ?`,
        )
        .get(TENANT, "dep_unique"),
    ).toEqual({ state: "active", digest: MANIFEST_A });
    expect(
      database
        .query("SELECT state FROM tf_resource_deployments WHERE tenant_id = ? AND id = ?")
        .get(TENANT, "dep_unique"),
    ).toEqual({ state: "retained" });
  });

  test("historical absence terminalizes the retained deployment without fabricating an attestation", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_absent");
    seedManifest(database, MANIFEST_A);
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider({
        outcome: "absent",
        evidence: { provider: "fixture", state: "absent" },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_repair_absent",
    });
    const plan = await repair.status(TENANT, "dep_absent");

    const receipt = await repair.apply({
      tenantId: TENANT,
      deploymentId: "dep_absent",
      idempotencyKey: "repair:absent:0001",
      planDigest: plan.planDigest,
    });

    expect(receipt.resolution).toBe("terminalized_absent");
    expect(receipt).not.toHaveProperty("manifestDigest");
    expect(
      database
        .query("SELECT state FROM tf_resource_deployments WHERE tenant_id = ? AND id = ?")
        .get(TENANT, "dep_absent"),
    ).toEqual({ state: "deleted" });
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = 'uid_historical'",
        )
        .get(TENANT),
    ).toEqual({ count: 0 });
    expect((await repair.status(TENANT, "dep_absent")).state).toBe("resolved");
  });

  test("historical zero, multiple, and indeterminate readbacks remain unresolved", async () => {
    const readbacks = [
      {
        outcome: "present" as const,
        consumption: "none" as const,
        evidence: { provider: "fixture", matches: 0 },
      },
      {
        outcome: "present" as const,
        consumption: "identified" as const,
        manifestDigests: [MANIFEST_A, MANIFEST_B],
        evidence: { provider: "fixture", matches: 2 },
      },
      {
        outcome: "indeterminate" as const,
        reason: "unsupported" as const,
        retryable: false,
      },
    ] as const;
    for (const [index, readback] of readbacks.entries()) {
      const database = databaseWithRepairMigration();
      const deploymentId = `dep_blocked_${index}`;
      seedRetainedHistorical(database, deploymentId);
      seedManifest(database, MANIFEST_A);
      seedManifest(database, MANIFEST_B);
      const repair = createArtifactConsumerRepair({
        sql: createSqliteSql(database),
        provider: consumptionProvider(readback),
        clock: () => new Date("2026-09-03T20:00:00.000Z"),
        randomId: () => `guard_repair_blocked_${index}`,
      });
      const plan = await repair.status(TENANT, deploymentId);

      expect(
        repair.apply({
          tenantId: TENANT,
          deploymentId,
          idempotencyKey: `repair:blocked:${index}`,
          planDigest: plan.planDigest,
        }),
      ).rejects.toMatchObject({ code: "repair_blocked", status: 409 });
      expect(uncertainty(database, deploymentId)).toEqual({ state: "active", fence: 1 });
      expect(deploymentState(database, deploymentId)).toBe("retained");
    }
  });

  test("a stale or caller-invented plan digest is rejected before provider readback", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_wrong_plan");
    seedManifest(database, MANIFEST_A);
    let providerCalls = 0;
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider(
        { outcome: "absent", evidence: { provider: "fixture" } },
        () => providerCalls++,
      ),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_wrong_plan",
    });

    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_wrong_plan",
        idempotencyKey: "repair:wrong:plan",
        planDigest: MANIFEST_B,
      }),
    ).rejects.toMatchObject({ code: "plan_changed", status: 409 });
    expect(providerCalls).toBe(0);
    expect(deploymentState(database, "dep_wrong_plan")).toBe("retained");
    expect(uncertainty(database, "dep_wrong_plan")).toEqual({ state: "active", fence: 1 });
  });

  test("a failed durable receipt readback is reported as backend unavailable", async () => {
    const database = databaseWithRepairMigration();
    const backing = createSqliteSql(database);
    const sql: Sql = {
      query(statement, params) {
        if (statement.includes("tf_artifact_consumer_resolution_receipts")) {
          throw new Error("receipt store unavailable");
        }
        return backing.query(statement, params);
      },
      run: (statement, params) => backing.run(statement, params),
      batch: (statements) => backing.batch(statements),
    };
    const repair = createArtifactConsumerRepair({
      sql,
      provider: consumptionProvider({
        outcome: "absent",
        evidence: { provider: "fixture", state: "absent" },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_receipt_unavailable",
    });

    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_receipt_unavailable",
        idempotencyKey: "repair:receipt:unavailable",
        planDigest: MANIFEST_A,
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable", status: 503 });
  });

  test("a provider digest outside the fenced candidate set cannot be attributed", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_foreign_digest");
    seedManifest(database, MANIFEST_A);
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider({
        outcome: "present",
        consumption: "identified",
        manifestDigests: [MANIFEST_B],
        evidence: { provider: "fixture", authority: "wrong-candidate" },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_foreign_digest",
    });
    const plan = await repair.status(TENANT, "dep_foreign_digest");

    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_foreign_digest",
        idempotencyKey: "repair:foreign:digest",
        planDigest: plan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "repair_blocked", status: 409 });
    expect(deploymentState(database, "dep_foreign_digest")).toBe("retained");
    expect(activeDeploymentRoot(database, "dep_foreign_digest")).toBeUndefined();
    expect(uncertainty(database, "dep_foreign_digest")).toEqual({ state: "active", fence: 1 });
  });

  test("closed retained repair accepts only a fresh absent proof", async () => {
    for (const [index, readback] of [
      {
        outcome: "present" as const,
        evidence: { provider: "fixture", state: "present" },
      },
      {
        outcome: "indeterminate" as const,
        reason: "malformed" as const,
        retryable: false,
      },
    ].entries()) {
      const database = databaseWithRepairMigration();
      const deploymentId = `dep_closed_blocked_${index}`;
      seedRetainedClosed(database, deploymentId);
      const repair = createArtifactConsumerRepair({
        sql: createSqliteSql(database),
        provider: absenceProvider(readback),
        clock: () => new Date("2026-09-03T20:00:00.000Z"),
        randomId: () => `guard_closed_blocked_${index}`,
      });
      const plan = await repair.status(TENANT, deploymentId);
      expect(plan).toMatchObject({
        state: "actionable",
        path: "retained-closed",
        action: "verify-native-absence",
      });
      expect(
        repair.apply({
          tenantId: TENANT,
          deploymentId,
          idempotencyKey: `repair:closed:no:${index}`,
          planDigest: plan.planDigest,
        }),
      ).rejects.toMatchObject({ code: "repair_blocked", status: 409 });
      expect(deploymentState(database, deploymentId)).toBe("retained");
    }

    const database = databaseWithRepairMigration();
    seedRetainedClosed(database, "dep_closed_absent");
    let calls = 0;
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: absenceProvider(
        {
          outcome: "absent",
          evidence: { provider: "fixture", state: "absent", fresh: true },
        },
        () => calls++,
      ),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_closed_absent",
    });
    const plan = await repair.status(TENANT, "dep_closed_absent");
    const receipt = await repair.apply({
      tenantId: TENANT,
      deploymentId: "dep_closed_absent",
      idempotencyKey: "repair:closed:absent",
      planDigest: plan.planDigest,
    });
    expect(calls).toBe(1);
    expect(receipt.resolution).toBe("terminalized_absent");
    expect(deploymentState(database, "dep_closed_absent")).toBe("deleted");

    const historicalReasonDatabase = databaseWithRepairMigration();
    seedRetainedClosed(historicalReasonDatabase, "dep_closed_historical_reason");
    historicalReasonDatabase
      .query(
        `UPDATE tf_artifact_consumer_uncertainties
         SET reason = 'historical_deployment_digest_unknown'
         WHERE tenant_id = ? AND consumer_id = ?`,
      )
      .run(TENANT, "dep_closed_historical_reason");
    const historicalReasonRepair = createArtifactConsumerRepair({
      sql: createSqliteSql(historicalReasonDatabase),
      provider: absenceProvider({
        outcome: "absent",
        evidence: { provider: "fixture", state: "absent", fresh: true },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_closed_historical_reason",
    });
    const historicalReasonPlan = await historicalReasonRepair.status(
      TENANT,
      "dep_closed_historical_reason",
    );
    expect(historicalReasonPlan).toMatchObject({
      state: "actionable",
      path: "retained-closed",
    });
    await historicalReasonRepair.apply({
      tenantId: TENANT,
      deploymentId: "dep_closed_historical_reason",
      idempotencyKey: "repair:closed:historical-reason",
      planDigest: historicalReasonPlan.planDigest,
    });
    expect(deploymentState(historicalReasonDatabase, "dep_closed_historical_reason")).toBe(
      "deleted",
    );
  });

  test("an active current Resource is attributed without deleting it or its Deployment", async () => {
    const database = databaseWithRepairMigration();
    seedActiveCurrent(database, "dep_active", MANIFEST_A);
    let seenResource: unknown;
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: {
        async verifyNativeAbsence() {
          throw new Error("wrong readback path");
        },
        async verifyArtifactConsumption(input) {
          seenResource = input.resource;
          return {
            outcome: "present",
            consumption: "identified",
            manifestDigests: [MANIFEST_A],
            evidence: { provider: "fixture", native: "exact" },
          };
        },
      },
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_active_unique",
    });
    const plan = await repair.status(TENANT, "dep_active");
    expect(plan).toMatchObject({
      state: "actionable",
      path: "active-resource",
      candidateManifestCount: 1,
    });

    const receipt = await repair.apply({
      tenantId: TENANT,
      deploymentId: "dep_active",
      idempotencyKey: "repair:active:unique",
      planDigest: plan.planDigest,
    });

    expect(seenResource).toMatchObject({ uid: "uid_dep_active", revision: "revision-1" });
    expect(receipt).toMatchObject({
      resolution: "attributed_manifest",
      manifestDigest: MANIFEST_A,
    });
    expect(deploymentState(database, "dep_active")).toBe("active");
    expect(
      database.query("SELECT COUNT(*) AS count FROM tf_resources WHERE tenant_id = ?").get(TENANT),
    ).toEqual({ count: 2 });
    expect(activeDeploymentRoot(database, "dep_active")).toBe(MANIFEST_A);
    // The repair resolves uncertainty, but the attributed target remains a
    // live root and therefore continues to block exact artifact recovery.
    expect(activeUncertaintyCount(database)).toBe(0);
  });

  test("an active Resource with no manifest candidates verifies zero consumption without mutation", async () => {
    const database = databaseWithRepairMigration();
    seedActiveCurrent(database, "dep_active_zero");
    const resourceBefore = database
      .query(
        `SELECT resource_json, generation, revision, updated_at
         FROM tf_resources WHERE tenant_id = ? AND uid = ?`,
      )
      .get(TENANT, "uid_dep_active_zero");
    const deploymentBefore = database
      .query(
        `SELECT state, observed_json, outputs_json, updated_at
         FROM tf_resource_deployments WHERE tenant_id = ? AND id = ?`,
      )
      .get(TENANT, "dep_active_zero");
    let providerCalls = 0;
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider(
        {
          outcome: "present",
          consumption: "none",
          evidence: { provider: "fixture", native: "exact", consumption: "none" },
        },
        () => providerCalls++,
      ),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_active_zero",
    });

    const plan = await repair.status(TENANT, "dep_active_zero");
    expect(plan).toMatchObject({
      state: "actionable",
      path: "active-resource",
      action: "verify-artifact-consumption",
      candidateManifestCount: 0,
    });
    expect(providerCalls).toBe(0);

    const receipt = await repair.apply({
      tenantId: TENANT,
      deploymentId: "dep_active_zero",
      idempotencyKey: "repair:active:zero",
      planDigest: plan.planDigest,
    });

    expect(receipt).toMatchObject({
      resolution: "verified_zero_consumption",
      deploymentId: "dep_active_zero",
      uncertaintyFence: 1,
    });
    expect(receipt).not.toHaveProperty("manifestDigest");
    expect(providerCalls).toBe(1);
    expect(
      database
        .query(
          `SELECT resource_json, generation, revision, updated_at
           FROM tf_resources WHERE tenant_id = ? AND uid = ?`,
        )
        .get(TENANT, "uid_dep_active_zero"),
    ).toEqual(resourceBefore);
    expect(
      database
        .query(
          `SELECT state, observed_json, outputs_json, updated_at
           FROM tf_resource_deployments WHERE tenant_id = ? AND id = ?`,
        )
        .get(TENANT, "dep_active_zero"),
    ).toEqual(deploymentBefore);
    expect(activeDeploymentRoot(database, "dep_active_zero")).toBeUndefined();
    expect(uncertainty(database, "dep_active_zero")).toEqual({ state: "resolved", fence: 2 });
  });

  test("an active Resource with no spec candidate attributes one held provider manifest", async () => {
    const database = databaseWithRepairMigration();
    seedActiveCurrent(database, "dep_active_identified");
    seedManifest(database, MANIFEST_A);
    const resourceBefore = resourceIdentity(database, "uid_dep_active_identified");
    const deploymentBefore = deploymentIdentity(database, "dep_active_identified");
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider({
        outcome: "present",
        consumption: "identified",
        manifestDigests: [MANIFEST_A],
        evidence: { provider: "fixture", binding: "artifact_manifest" },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_active_identified",
    });
    const plan = await repair.status(TENANT, "dep_active_identified");
    expect(plan).toMatchObject({ state: "actionable", candidateManifestCount: 0 });

    const receipt = await repair.apply({
      tenantId: TENANT,
      deploymentId: "dep_active_identified",
      idempotencyKey: "repair:active:identified",
      planDigest: plan.planDigest,
    });

    expect(receipt).toMatchObject({
      resolution: "attributed_manifest",
      manifestDigest: MANIFEST_A,
    });
    expect(activeDeploymentRoot(database, "dep_active_identified")).toBe(MANIFEST_A);
    expect(resourceIdentity(database, "uid_dep_active_identified")).toEqual(resourceBefore);
    expect(deploymentIdentity(database, "dep_active_identified")).toEqual(deploymentBefore);
    expect(uncertainty(database, "dep_active_identified")).toEqual({
      state: "resolved",
      fence: 2,
    });
  });

  test("the final CAS refuses an identified digest removed after provider readback", async () => {
    const database = databaseWithRepairMigration();
    seedActiveCurrent(database, "dep_active_identified_race");
    seedManifest(database, MANIFEST_A);
    const base = createSqliteSql(database);
    let injected = false;
    const sql: Sql = {
      query: (statement, params) => base.query(statement, params),
      run: (statement, params) => base.run(statement, params),
      async batch(statements) {
        if (!injected) {
          injected = true;
          await base.run(
            "DELETE FROM tf_artifact_holds WHERE tenant_id = ? AND kind = 'manifest' AND digest = ?",
            [TENANT, MANIFEST_A],
          );
        }
        return await base.batch(statements);
      },
    };
    const repair = createArtifactConsumerRepair({
      sql,
      provider: consumptionProvider({
        outcome: "present",
        consumption: "identified",
        manifestDigests: [MANIFEST_A],
        evidence: { provider: "fixture", binding: "artifact_manifest" },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_active_identified_race",
    });
    const plan = await repair.status(TENANT, "dep_active_identified_race");

    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_active_identified_race",
        idempotencyKey: "repair:active:identified:race",
        planDigest: plan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "plan_changed", status: 409 });
    expect(activeDeploymentRoot(database, "dep_active_identified_race")).toBeUndefined();
    expect(uncertainty(database, "dep_active_identified_race")).toEqual({
      state: "active",
      fence: 1,
    });
    expect(resolutionReceiptCount(database, "dep_active_identified_race")).toBe(0);
  });

  test("active identified-empty, duplicate, multiple, and unheld readbacks refuse atomically", async () => {
    const cases = [
      {
        name: "empty",
        seed: (_database: Database) => {},
        readback: {
          outcome: "present",
          consumption: "identified",
          manifestDigests: [],
          evidence: { provider: "fixture", matches: 0 },
        },
      },
      {
        name: "multiple",
        seed: (database: Database) => {
          seedManifest(database, MANIFEST_A);
          seedManifest(database, MANIFEST_B);
        },
        readback: {
          outcome: "present",
          consumption: "identified",
          manifestDigests: [MANIFEST_A, MANIFEST_B],
          evidence: { provider: "fixture", matches: 2 },
        },
      },
      {
        name: "duplicate",
        seed: (database: Database) => {
          seedManifest(database, MANIFEST_A);
        },
        readback: {
          outcome: "present",
          consumption: "identified",
          manifestDigests: [MANIFEST_A, MANIFEST_A],
          evidence: { provider: "fixture", matches: 2 },
        },
      },
      {
        name: "unheld",
        seed: (_database: Database) => {},
        readback: {
          outcome: "present",
          consumption: "identified",
          manifestDigests: [MANIFEST_B],
          evidence: { provider: "fixture", matches: 1 },
        },
      },
    ] as const;
    for (const [index, scenario] of cases.entries()) {
      const database = databaseWithRepairMigration();
      const deploymentId = `dep_active_refuse_${scenario.name}`;
      seedActiveCurrent(database, deploymentId);
      scenario.seed(database);
      const repair = createArtifactConsumerRepair({
        sql: createSqliteSql(database),
        provider: consumptionProvider(scenario.readback as never),
        clock: () => new Date("2026-09-03T20:00:00.000Z"),
        randomId: () => `guard_active_refuse_${index}`,
      });
      const plan = await repair.status(TENANT, deploymentId);
      expect(plan).toMatchObject({ state: "actionable", candidateManifestCount: 0 });

      expect(
        repair.apply({
          tenantId: TENANT,
          deploymentId,
          idempotencyKey: `repair:active:refuse:${index}`,
          planDigest: plan.planDigest,
        }),
      ).rejects.toMatchObject({ code: "repair_blocked", status: 409 });
      expect(uncertainty(database, deploymentId)).toEqual({ state: "active", fence: 1 });
      expect(activeDeploymentRoot(database, deploymentId)).toBeUndefined();
      expect(resolutionReceiptCount(database, deploymentId)).toBe(0);
    }
  });

  test("active unknown provider evidence preserves retryable status codes", async () => {
    for (const [index, readback] of [
      { outcome: "indeterminate" as const, reason: "transport" as const, retryable: true },
      { outcome: "indeterminate" as const, reason: "unsupported" as const, retryable: false },
    ].entries()) {
      const database = databaseWithRepairMigration();
      const deploymentId = `dep_active_unknown_${index}`;
      seedActiveCurrent(database, deploymentId);
      const repair = createArtifactConsumerRepair({
        sql: createSqliteSql(database),
        provider: consumptionProvider(readback),
        clock: () => new Date("2026-09-03T20:00:00.000Z"),
        randomId: () => `guard_active_unknown_${index}`,
      });
      const plan = await repair.status(TENANT, deploymentId);

      expect(
        repair.apply({
          tenantId: TENANT,
          deploymentId,
          idempotencyKey: `repair:active:unknown:${index}`,
          planDigest: plan.planDigest,
        }),
      ).rejects.toMatchObject({
        code: readback.retryable ? "backend_unavailable" : "repair_blocked",
        status: readback.retryable ? 503 : 409,
      });
      expect(uncertainty(database, deploymentId)).toEqual({ state: "active", fence: 1 });
      expect(resolutionReceiptCount(database, deploymentId)).toBe(0);
    }
  });

  test("provider absence contradicts an active Resource and cannot terminalize it", async () => {
    const database = databaseWithRepairMigration();
    seedActiveCurrent(database, "dep_active_absent", MANIFEST_A);
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider({
        outcome: "absent",
        evidence: { provider: "fixture", state: "absent" },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_active_absent",
    });
    const plan = await repair.status(TENANT, "dep_active_absent");
    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_active_absent",
        idempotencyKey: "repair:active:absent",
        planDigest: plan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "repair_blocked", status: 409 });
    expect(deploymentState(database, "dep_active_absent")).toBe("active");
    expect(uncertainty(database, "dep_active_absent")).toEqual({ state: "active", fence: 1 });
  });

  test("an open provider effect blocks and a same-millisecond terminal event closes it", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_effect");
    seedManifest(database, MANIFEST_A);
    const insertEffect = database.query(
      `INSERT INTO tf_resource_provider_effects
         (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
          operation_mode, provider_pack_ref, provider_installation_ref,
          native_id, target_json, created_at)
       VALUES (?, 'uid_historical', ?, 'operation-effect', 'apply', ?, 'initial',
               'cloudflare', 'cloudflare.staging', 'version:script:version-id', NULL, 200)`,
    );
    insertEffect.run(TENANT, "operation-effect:planned", "planned");
    let called = false;
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider(
        { outcome: "absent", evidence: { provider: "fixture" } },
        () => (called = true),
      ),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_effect",
    });
    expect(await repair.status(TENANT, "dep_effect")).toMatchObject({
      state: "blocked",
      blocker: "open_provider_effect",
    });
    expect(called).toBe(false);

    insertEffect.run(TENANT, "operation-effect:cancelled", "cancelled");
    expect(await repair.status(TENANT, "dep_effect")).toMatchObject({ state: "actionable" });
  });

  test("a deleting artifact candidate blocks before provider readback", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_deleting");
    seedManifest(database, MANIFEST_A);
    seedDeletingCandidate(database, MANIFEST_A);
    let called = false;
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider(
        { outcome: "absent", evidence: { provider: "fixture" } },
        () => (called = true),
      ),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_deleting",
    });
    const plan = await repair.status(TENANT, "dep_deleting");
    expect(plan).toMatchObject({ state: "blocked", blocker: "artifact_delete_in_progress" });
    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_deleting",
        idempotencyKey: "repair:deleting:0001",
        planDigest: plan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "repair_blocked", status: 409 });
    expect(called).toBe(false);
  });

  test("every bound fence drift after provider evidence invalidates the plan", async () => {
    const cases: Array<{
      readonly name: string;
      readonly seed: (database: Database, deploymentId: string) => void;
      readonly mutate: (database: Database, deploymentId: string) => void;
      readonly provider: (mutate: () => void) => ArtifactConsumerProviderReader;
    }> = [
      {
        name: "deployment-updated-at",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database, id) => {
          database
            .query("UPDATE tf_resource_deployments SET updated_at = updated_at + 1 WHERE id = ?")
            .run(id);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "deployment-provider-identity",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database, id) => {
          database
            .query(
              `UPDATE tf_resource_deployments
               SET offering_id = 'cloudflare.edge.workerversion.drifted',
                   provider_pack_ref = 'cloudflare-drifted',
                   provider_installation_ref = 'cloudflare.drifted',
                   native_id = 'version:script:drifted', observed_json = '{"drifted":true}',
                   outputs_json = '{"drifted":true}'
               WHERE id = ?`,
            )
            .run(id);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "deployment-state-and-resource",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database, id) => {
          database
            .query(
              "UPDATE tf_resource_deployments SET state = 'active', resource_uid = 'uid_drifted' WHERE id = ?",
            )
            .run(id);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "deployment-native-claim",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database, id) => {
          database
            .query(
              "UPDATE tf_resource_deployments SET native_claimed = 1 - native_claimed WHERE id = ?",
            )
            .run(id);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "uncertainty-fence",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database, id) => {
          database
            .query(
              "UPDATE tf_artifact_consumer_uncertainties SET fence = fence + 1 WHERE consumer_id = ?",
            )
            .run(id);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "uncertainty-reason",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database, id) => {
          database
            .query(
              `UPDATE tf_artifact_consumer_uncertainties
               SET reason = 'resource_not_yet_observed' WHERE consumer_id = ?`,
            )
            .run(id);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "candidate-manifest-set",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database) => seedManifest(database, MANIFEST_B),
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "unrelated-tenant-blob-hold",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database) => {
          database
            .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, 'blob')")
            .run(TENANT, MANIFEST_B);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "resource-revision",
        seed: (database, id) => seedActiveCurrent(database, id, MANIFEST_A),
        mutate: (database, id) => {
          database
            .query("UPDATE tf_resources SET revision = 'revision-2' WHERE uid = ?")
            .run(`uid_${id}`);
        },
        provider: (mutate) =>
          consumptionProvider(
            {
              outcome: "present",
              consumption: "identified",
              manifestDigests: [MANIFEST_A],
              evidence: { provider: "fixture" },
            },
            mutate,
          ),
      },
      {
        name: "resource-form-ref",
        seed: (database, id) => seedActiveCurrent(database, id, MANIFEST_A),
        mutate: (database, id) => {
          database
            .query(
              `UPDATE tf_resources
               SET resource_json = json_set(
                 resource_json, '$.form.formRef.definitionVersion', '0.2.0'
               ) WHERE uid = ?`,
            )
            .run(`uid_${id}`);
        },
        provider: (mutate) =>
          consumptionProvider(
            {
              outcome: "present",
              consumption: "identified",
              manifestDigests: [MANIFEST_A],
              evidence: { provider: "fixture" },
            },
            mutate,
          ),
      },
      {
        name: "resource-relations",
        seed: (database, id) => seedActiveCurrent(database, id, MANIFEST_A),
        mutate: (database, id) => {
          database
            .query(
              `UPDATE tf_resources
               SET relations_json = json_set(relations_json, '$[0].pointer', '/bundle-drifted')
               WHERE uid = ?`,
            )
            .run(`uid_${id}`);
        },
        provider: (mutate) =>
          consumptionProvider(
            {
              outcome: "present",
              consumption: "identified",
              manifestDigests: [MANIFEST_A],
              evidence: { provider: "fixture" },
            },
            mutate,
          ),
      },
      {
        name: "closed-attestation-fence",
        seed: seedRetainedClosed,
        mutate: (database) => {
          database
            .query(
              "UPDATE tf_resource_deletion_attestations SET closure_fence = closure_fence + 1 WHERE tenant_id = ?",
            )
            .run(TENANT);
        },
        provider: (mutate) =>
          absenceProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "closed-attestation-address-form-and-effect-set",
        seed: seedRetainedClosed,
        mutate: (database) => {
          database
            .query(
              `UPDATE tf_resource_deletion_attestations
               SET space = 'drifted', name = 'drifted',
                   form_ref_json = json_set(form_ref_json, '$.definitionVersion', '0.2.0'),
                   effects_json = '[{"eventId":"drifted"}]'
               WHERE tenant_id = ?`,
            )
            .run(TENANT);
        },
        provider: (mutate) =>
          absenceProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "provider-effect-set",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database) => {
          database
            .query(
              `INSERT INTO tf_resource_provider_effects
                 (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
                  operation_mode, provider_pack_ref, provider_installation_ref,
                  native_id, target_json, created_at)
               VALUES (?, 'uid_historical', 'effect-drift:planned', 'effect-drift',
                       'apply', 'planned', 'initial', 'cloudflare', 'cloudflare.staging',
                       'version:script:version-id', NULL, 201)`,
            )
            .run(TENANT);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "resource-deployment-set",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database) => {
          database
            .query(
              `INSERT INTO tf_resource_deployments
                 (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
                  provider_installation_ref, native_id, native_claimed, state,
                  observed_json, outputs_json, created_at, updated_at)
               VALUES (?, 'dep_drift_shadow', 'uid_historical',
                       'cloudflare.edge.workerversion', 'cloudflare', 'cloudflare.staging',
                       'version:script:shadow', 0, 'deleted', '{}', '{}', 100, 201)`,
            )
            .run(TENANT);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "gc-candidate-fence",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database) => {
          database
            .query(
              `INSERT INTO tf_artifact_gc_candidates
                 (kind, digest, state, fence, not_before, expected_etag, attempts,
                  last_outcome, created_at, updated_at, deleted_at)
               VALUES ('manifest', ?, 'pending', 1, 0, NULL, 0, 'pending', 100, 100, NULL)`,
            )
            .run(MANIFEST_A);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
      {
        name: "deployment-root-fence",
        seed: (database, id) => {
          seedRetainedHistorical(database, id);
          seedManifest(database, MANIFEST_A);
        },
        mutate: (database, id) => {
          database
            .query(
              `INSERT INTO tf_artifact_roots
                 (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
                  expires_at, release_reason, created_at, released_at)
               VALUES (?, 'deployment', ?, 'manifest', ?, 'active', 1,
                       NULL, NULL, 100, NULL)`,
            )
            .run(TENANT, id, MANIFEST_A);
        },
        provider: (mutate) =>
          consumptionProvider({ outcome: "absent", evidence: { provider: "fixture" } }, mutate),
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const database = databaseWithRepairMigration();
      const deploymentId = `dep_drift_${index}`;
      scenario.seed(database, deploymentId);
      const repair = createArtifactConsumerRepair({
        sql: createSqliteSql(database),
        provider: scenario.provider(() => scenario.mutate(database, deploymentId)),
        clock: () => new Date("2026-09-03T20:00:00.000Z"),
        randomId: () => `guard_drift_${index}`,
      });
      const plan = await repair.status(TENANT, deploymentId);
      expect(
        repair.apply({
          tenantId: TENANT,
          deploymentId,
          idempotencyKey: `repair:drift:${index}`,
          planDigest: plan.planDigest,
        }),
        scenario.name,
      ).rejects.toMatchObject({ code: "plan_changed", status: 409 });
      expect(
        database
          .query(
            `SELECT COUNT(*) AS count FROM tf_artifact_consumer_resolution_receipts
             WHERE tenant_id = ? AND deployment_id = ?`,
          )
          .get(TENANT, deploymentId),
        scenario.name,
      ).toEqual({ count: 0 });
    }
  });

  test("the final SQL snapshot guard rejects a mutation concurrent with the commit", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_cas");
    seedManifest(database, MANIFEST_A);
    const base = createSqliteSql(database);
    let injected = false;
    const sql: Sql = {
      query: (statement, params) => base.query(statement, params),
      run: (statement, params) => base.run(statement, params),
      async batch(statements) {
        if (
          !injected &&
          statements.some((statement) => statement.sql.includes("resolution_receipts"))
        ) {
          injected = true;
          await base.run(
            "UPDATE tf_resource_deployments SET updated_at = updated_at + 1 WHERE tenant_id = ? AND id = ?",
            [TENANT, "dep_cas"],
          );
        }
        return await base.batch(statements);
      },
    };
    const repair = createArtifactConsumerRepair({
      sql,
      provider: consumptionProvider({
        outcome: "absent",
        evidence: { provider: "fixture", state: "absent" },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_concurrent_cas",
    });
    const plan = await repair.status(TENANT, "dep_cas");
    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_cas",
        idempotencyKey: "repair:concurrent:cas",
        planDigest: plan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "plan_changed", status: 409 });
    expect(deploymentState(database, "dep_cas")).toBe("retained");
    expect(uncertainty(database, "dep_cas")).toEqual({ state: "active", fence: 1 });
  });

  test("the receipt guard rolls back a lifecycle mutation that did not resolve its fence", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_missing_trigger");
    seedManifest(database, MANIFEST_A);
    // Simulate an incompatible lifecycle schema after the uncertainty has
    // already been created. The repair must never commit only the Deployment
    // mutation when its durable acknowledgement precondition is absent.
    database.exec("DROP TRIGGER tf_artifact_deployment_root_update");
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider({
        outcome: "absent",
        evidence: { provider: "fixture", state: "absent" },
      }),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_missing_trigger",
    });
    const plan = await repair.status(TENANT, "dep_missing_trigger");

    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_missing_trigger",
        idempotencyKey: "repair:missing:trigger",
        planDigest: plan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "plan_changed", status: 409 });
    expect(deploymentState(database, "dep_missing_trigger")).toBe("retained");
    expect(uncertainty(database, "dep_missing_trigger")).toEqual({ state: "active", fence: 1 });
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count FROM tf_artifact_consumer_resolution_receipts
           WHERE tenant_id = ? AND deployment_id = ?`,
        )
        .get(TENANT, "dep_missing_trigger"),
    ).toEqual({ count: 0 });
  });

  test("a committed receipt recovers a lost SQL acknowledgement and exact replay", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_lost_ack");
    seedManifest(database, MANIFEST_A);
    const base = createSqliteSql(database);
    let lose = true;
    let providerCalls = 0;
    const sql: Sql = {
      query: (statement, params) => base.query(statement, params),
      run: (statement, params) => base.run(statement, params),
      async batch(statements) {
        const result = await base.batch(statements);
        if (lose && statements.some((statement) => statement.sql.includes("resolution_receipts"))) {
          lose = false;
          throw new Error("simulated lost acknowledgement");
        }
        return result;
      },
    };
    const repair = createArtifactConsumerRepair({
      sql,
      provider: consumptionProvider(
        { outcome: "absent", evidence: { provider: "fixture", state: "absent" } },
        () => providerCalls++,
      ),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_lost_ack",
    });
    const plan = await repair.status(TENANT, "dep_lost_ack");
    const input = {
      tenantId: TENANT,
      deploymentId: "dep_lost_ack",
      idempotencyKey: "repair:lost:ack:0001",
      planDigest: plan.planDigest,
    } as const;

    const first = await repair.apply(input);
    const replay = await repair.apply(input);

    expect(first).toEqual(replay);
    expect(providerCalls).toBe(1);
    expect(deploymentState(database, "dep_lost_ack")).toBe("deleted");
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM tf_artifact_consumer_resolution_receipts WHERE tenant_id = ?",
        )
        .get(TENANT),
    ).toEqual({ count: 1 });
  });

  test("a zero-consumption receipt recovers a lost acknowledgement without a second read", async () => {
    const database = databaseWithRepairMigration();
    seedActiveCurrent(database, "dep_zero_lost_ack");
    const resourceBefore = resourceIdentity(database, "uid_dep_zero_lost_ack");
    const deploymentBefore = deploymentIdentity(database, "dep_zero_lost_ack");
    const base = createSqliteSql(database);
    let lose = true;
    let providerCalls = 0;
    const sql: Sql = {
      query: (statement, params) => base.query(statement, params),
      run: (statement, params) => base.run(statement, params),
      async batch(statements) {
        const result = await base.batch(statements);
        if (lose) {
          lose = false;
          throw new Error("simulated lost acknowledgement");
        }
        return result;
      },
    };
    const repair = createArtifactConsumerRepair({
      sql,
      provider: consumptionProvider(
        {
          outcome: "present",
          consumption: "none",
          evidence: { provider: "fixture", consumption: "none" },
        },
        () => providerCalls++,
      ),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => "guard_zero_lost_ack",
    });
    const plan = await repair.status(TENANT, "dep_zero_lost_ack");
    const input = {
      tenantId: TENANT,
      deploymentId: "dep_zero_lost_ack",
      idempotencyKey: "repair:zero:lost:ack",
      planDigest: plan.planDigest,
    } as const;

    const first = await repair.apply(input);
    const replay = await repair.apply(input);

    expect(first).toEqual(replay);
    expect(first.resolution).toBe("verified_zero_consumption");
    expect(providerCalls).toBe(1);
    expect(resourceIdentity(database, "uid_dep_zero_lost_ack")).toEqual(resourceBefore);
    expect(deploymentIdentity(database, "dep_zero_lost_ack")).toEqual(deploymentBefore);
    expect(activeDeploymentRoot(database, "dep_zero_lost_ack")).toBeUndefined();
    expect(uncertainty(database, "dep_zero_lost_ack")).toEqual({ state: "resolved", fence: 2 });
    expect(resolutionReceiptCount(database, "dep_zero_lost_ack")).toBe(1);
  });

  test("an idempotency key cannot be reused for a different deployment", async () => {
    const database = databaseWithRepairMigration();
    seedRetainedHistorical(database, "dep_idempotency_first", "uid_idempotency_first");
    seedRetainedHistorical(database, "dep_idempotency_second", "uid_idempotency_second");
    seedManifest(database, MANIFEST_A);
    let providerCalls = 0;
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: consumptionProvider(
        { outcome: "absent", evidence: { provider: "fixture" } },
        () => providerCalls++,
      ),
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => `guard_idempotency_${providerCalls}`,
    });
    const firstPlan = await repair.status(TENANT, "dep_idempotency_first");
    await repair.apply({
      tenantId: TENANT,
      deploymentId: "dep_idempotency_first",
      idempotencyKey: "repair:idempotency:shared",
      planDigest: firstPlan.planDigest,
    });
    const secondPlan = await repair.status(TENANT, "dep_idempotency_second");

    expect(
      repair.apply({
        tenantId: TENANT,
        deploymentId: "dep_idempotency_second",
        idempotencyKey: "repair:idempotency:shared",
        planDigest: secondPlan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(providerCalls).toBe(1);
    expect(deploymentState(database, "dep_idempotency_second")).toBe("retained");
    expect(uncertainty(database, "dep_idempotency_second")).toEqual({ state: "active", fence: 1 });
  });

  test("resolution receipts are append-only", () => {
    const database = databaseWithRepairMigration();
    database.exec(`
      INSERT INTO tf_artifact_consumer_resolution_receipts
        (receipt_id, tenant_id, deployment_id, uncertainty_fence, idempotency_key,
         plan_digest, snapshot_digest, resolution, manifest_digest,
         provider_evidence_digest, deployment_state_before,
         deployment_updated_at_before, created_at)
      VALUES
        ('acr_fixture', '${TENANT}', 'dep_receipt', 1, 'repair:receipt:0001',
         '${MANIFEST_A}', '${MANIFEST_A}', 'terminalized_absent', NULL,
         '${MANIFEST_B}', 'retained', 100, 100);
    `);
    expect(() =>
      database.query("UPDATE tf_artifact_consumer_resolution_receipts SET created_at = 101").run(),
    ).toThrow("artifact_consumer_resolution_receipt_immutable");
    expect(() =>
      database.query("DELETE FROM tf_artifact_consumer_resolution_receipts").run(),
    ).toThrow("artifact_consumer_resolution_receipt_durable");
  });

  test("migration 0044 preserves existing lifecycle data", () => {
    const database = new Database(":memory:");
    for (const migration of MIGRATIONS) {
      if (migration.name === "0044_artifact_consumer_resolution_receipts.sql") break;
      database.exec(migration.sql);
    }
    seedRetainedHistorical(database, "dep_preserved");
    seedManifest(database, MANIFEST_A);
    const before = database
      .query(
        `SELECT deployment.state AS deployment_state, uncertainty.state AS uncertainty_state,
                uncertainty.fence AS uncertainty_fence, hold.digest AS hold_digest
         FROM tf_resource_deployments AS deployment
         JOIN tf_artifact_consumer_uncertainties AS uncertainty
           ON uncertainty.tenant_id = deployment.tenant_id
          AND uncertainty.consumer_id = deployment.id
         JOIN tf_artifact_holds AS hold ON hold.tenant_id = deployment.tenant_id
         WHERE deployment.id = 'dep_preserved'`,
      )
      .get();

    database.exec(repairMigrationSql());

    expect(
      database
        .query(
          `SELECT deployment.state AS deployment_state, uncertainty.state AS uncertainty_state,
                  uncertainty.fence AS uncertainty_fence, hold.digest AS hold_digest
           FROM tf_resource_deployments AS deployment
           JOIN tf_artifact_consumer_uncertainties AS uncertainty
             ON uncertainty.tenant_id = deployment.tenant_id
            AND uncertainty.consumer_id = deployment.id
           JOIN tf_artifact_holds AS hold ON hold.tenant_id = deployment.tenant_id
           WHERE deployment.id = 'dep_preserved'`,
        )
        .get(),
    ).toEqual(before);
  });

  test("the nine-row integration corpus reaches the tenant-wide zero-uncertainty gate", async () => {
    const database = databaseWithRepairMigration();
    const active = Array.from({ length: 4 }, (_, index) => ({
      deploymentId: `dep_corpus_active_${index + 1}`,
      manifestDigest: `sha256:${String(index + 1).repeat(64)}`,
    }));
    const historical = Array.from(
      { length: 4 },
      (_, index) => `dep_corpus_historical_${index + 1}`,
    );
    for (const row of active) {
      seedActiveCurrent(database, row.deploymentId, row.manifestDigest);
    }
    for (const deploymentId of historical) {
      seedRetainedHistorical(database, deploymentId, `uid_${deploymentId}`);
    }
    const closed = "dep_corpus_closed_1";
    seedRetainedClosed(database, closed, `uid_${closed}`);

    let providerCalls = 0;
    const repair = createArtifactConsumerRepair({
      sql: createSqliteSql(database),
      provider: {
        async verifyNativeAbsence() {
          providerCalls += 1;
          return {
            outcome: "absent",
            evidence: { provider: "integration-fixture", fresh: true },
          };
        },
        async verifyArtifactConsumption(input) {
          providerCalls += 1;
          if (!input.resource) {
            return {
              outcome: "absent",
              evidence: { provider: "integration-fixture", state: "absent" },
            };
          }
          const [manifestDigest] = input.candidateManifestDigests;
          if (!manifestDigest || input.candidateManifestDigests.length !== 1) {
            return { outcome: "indeterminate", reason: "malformed", retryable: false };
          }
          return {
            outcome: "present",
            consumption: "identified",
            manifestDigests: [manifestDigest],
            evidence: { provider: "integration-fixture", authority: "exact-current" },
          };
        },
      },
      clock: () => new Date("2026-09-03T20:00:00.000Z"),
      randomId: () => `guard_corpus_${providerCalls}`,
    });

    const deploymentIds = [...active.map((row) => row.deploymentId), ...historical, closed];
    expect(activeUncertaintyCount(database)).toBe(9);
    for (const [index, deploymentId] of deploymentIds.entries()) {
      const plan = await repair.status(TENANT, deploymentId);
      expect(plan.state, deploymentId).toBe("actionable");
      await repair.apply({
        tenantId: TENANT,
        deploymentId,
        idempotencyKey: `repair:corpus:${index + 1}`,
        planDigest: plan.planDigest,
      });
    }

    expect(providerCalls).toBe(9);
    expect(activeUncertaintyCount(database)).toBe(0);
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM tf_artifact_consumer_resolution_receipts WHERE tenant_id = ?",
        )
        .get(TENANT),
    ).toEqual({ count: 9 });
    expect(
      database
        .query(
          "SELECT state, COUNT(*) AS count FROM tf_resource_deployments WHERE tenant_id = ? GROUP BY state ORDER BY state",
        )
        .all(TENANT),
    ).toEqual([
      { state: "active", count: 4 },
      { state: "deleted", count: 5 },
    ]);
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count FROM tf_artifact_roots
           WHERE tenant_id = ? AND root_kind = 'deployment' AND state = 'active'`,
        )
        .get(TENANT),
    ).toEqual({ count: 4 });
    expect(
      database.query("SELECT COUNT(*) AS count FROM tf_resources WHERE tenant_id = ?").get(TENANT),
    ).toEqual({ count: 8 });
  });
});

function databaseWithRepairMigration(): Database {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  return database;
}

function repairMigrationSql(): string {
  return readFileSync(
    new URL("../migrations/0044_artifact_consumer_resolution_receipts.sql", import.meta.url),
    "utf8",
  );
}

function seedRetainedHistorical(
  database: Database,
  deploymentId: string,
  resourceUid = "uid_historical",
): void {
  database
    .query(
      `INSERT INTO tf_resource_deployments
         (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
          provider_installation_ref, native_id, native_claimed, state,
          observed_json, outputs_json, created_at, updated_at)
       VALUES (?, ?, ?, 'cloudflare.edge.workerversion', 'cloudflare',
               'cloudflare.staging', 'version:script:version-id', 0, 'retained',
               '{}', '{}', 100, 200)`,
    )
    .run(TENANT, deploymentId, resourceUid);
  database
    .query(
      `UPDATE tf_artifact_consumer_uncertainties
       SET reason = 'historical_deployment_digest_unknown'
       WHERE tenant_id = ? AND consumer_id = ?`,
    )
    .run(TENANT, deploymentId);
}

function seedManifest(database: Database, digest: string): void {
  database
    .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, 'manifest')")
    .run(TENANT, digest);
  database
    .query(
      `INSERT INTO tf_artifact_manifests (digest, manifest_json, created_at)
       VALUES (?, ?, 100)`,
    )
    .run(
      digest,
      JSON.stringify({
        apiVersion: "artifacts.takoform.com/v1alpha1",
        kind: "WorkerBundle",
        mainModule: "worker.mjs",
        modules: [],
      }),
    );
}

function seedRetainedClosed(
  database: Database,
  deploymentId: string,
  resourceUid = "uid_historical",
): void {
  seedRetainedHistorical(database, deploymentId, resourceUid);
  database
    .query(
      `UPDATE tf_artifact_consumer_uncertainties
       SET reason = 'resource_not_yet_observed'
       WHERE tenant_id = ? AND consumer_id = ?`,
    )
    .run(TENANT, deploymentId);
  database
    .query(
      `INSERT INTO tf_resource_deletion_attestations
         (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
          state, closure_fence, effects_json, evidence_json, evidence_ref,
          evidence_effect_digest, evidence_checked_at, evidence_status,
          created_at, updated_at)
       VALUES (?, ?, 'default', 'edge.forms.takoform.com/v1beta1',
               'WorkerVersion', 'closed-worker', ?, 'closed', 3, '[]',
               NULL, NULL, NULL, NULL, NULL, 100, 200)`,
    )
    .run(TENANT, resourceUid, JSON.stringify(formRef("WorkerVersion")));
}

function seedActiveCurrent(
  database: Database,
  deploymentId: string,
  manifestDigest?: string,
): void {
  if (manifestDigest) seedManifest(database, manifestDigest);
  const bundleUid = `bundle_${deploymentId}`;
  const resourceUid = `uid_${deploymentId}`;
  database
    .query(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, relations_json, package_digest, implementation_digest, updated_at)
       VALUES (?, 'default', 'edge.forms.takoform.com/v1beta1', 'WorkerBundle', ?, ?,
               '1', 'bundle-revision-1', ?, '[]', NULL, NULL, 100)`,
    )
    .run(
      TENANT,
      `bundle-${deploymentId}`,
      bundleUid,
      JSON.stringify({
        apiVersion: "edge.forms.takoform.com/v1beta1",
        kind: "WorkerBundle",
        metadata: { space: "default", name: `bundle-${deploymentId}`, uid: bundleUid },
        form: { formRef: formRef("WorkerBundle") },
        spec: manifestDigest ? { manifestDigest } : {},
      }),
    );
  database
    .query(
      `INSERT INTO tf_resource_deployments
         (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
          provider_installation_ref, native_id, native_claimed, state,
          observed_json, outputs_json, created_at, updated_at)
       VALUES (?, ?, ?, 'cloudflare.edge.workerversion', 'cloudflare',
               'cloudflare.staging', ?, 0, 'active', '{}', '{}', 100, 200)`,
    )
    .run(TENANT, deploymentId, resourceUid, `version:script:${deploymentId}`);
  const relations = [
    {
      pointer: "/bundle",
      relation: "/bundle",
      targetApiVersion: "edge.forms.takoform.com/v1beta1",
      targetKind: "WorkerBundle",
      targetName: `bundle-${deploymentId}`,
      targetUid: bundleUid,
      targetFormRef: formRef("WorkerBundle"),
    },
  ];
  database
    .query(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, relations_json, package_digest, implementation_digest, updated_at)
       VALUES (?, 'default', 'edge.forms.takoform.com/v1beta1', 'WorkerVersion', ?, ?,
               '1', 'revision-1', ?, ?, NULL, NULL, 200)`,
    )
    .run(
      TENANT,
      `worker-${deploymentId}`,
      resourceUid,
      JSON.stringify({
        apiVersion: "edge.forms.takoform.com/v1beta1",
        kind: "WorkerVersion",
        metadata: { space: "default", name: `worker-${deploymentId}`, uid: resourceUid },
        form: { formRef: formRef("WorkerVersion") },
        spec: { handlers: ["fetch"] },
      }),
      JSON.stringify(relations),
    );
}

function seedDeletingCandidate(database: Database, digest: string): void {
  database
    .query(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('manifest', ?, 'deleting', 1, 0, NULL, 0, 'claimed', 100, 100, NULL)`,
    )
    .run(digest);
}

function consumptionProvider(
  readback: Awaited<ReturnType<ArtifactConsumerProviderReader["verifyArtifactConsumption"]>>,
  called?: () => void,
): ArtifactConsumerProviderReader {
  return {
    async verifyNativeAbsence() {
      throw new Error("wrong readback path");
    },
    async verifyArtifactConsumption() {
      called?.();
      return readback;
    },
  };
}

function absenceProvider(
  readback: Awaited<ReturnType<ArtifactConsumerProviderReader["verifyNativeAbsence"]>>,
  called?: () => void,
): ArtifactConsumerProviderReader {
  return {
    async verifyNativeAbsence() {
      called?.();
      return readback;
    },
    async verifyArtifactConsumption() {
      throw new Error("wrong readback path");
    },
  };
}

function formRef(kind: string) {
  return {
    apiVersion: "edge.forms.takoform.com",
    kind,
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"c".repeat(64)}`,
  };
}

function uncertainty(
  database: Database,
  deploymentId: string,
): { readonly state: string; readonly fence: number } {
  return database
    .query(
      `SELECT state, fence FROM tf_artifact_consumer_uncertainties
       WHERE tenant_id = ? AND consumer_id = ?`,
    )
    .get(TENANT, deploymentId) as { readonly state: string; readonly fence: number };
}

function deploymentState(database: Database, deploymentId: string): string | undefined {
  return (
    database
      .query("SELECT state FROM tf_resource_deployments WHERE tenant_id = ? AND id = ?")
      .get(TENANT, deploymentId) as { state?: string } | null
  )?.state;
}

function activeDeploymentRoot(database: Database, deploymentId: string): string | undefined {
  return (
    database
      .query(
        `SELECT digest FROM tf_artifact_roots
         WHERE tenant_id = ? AND root_kind = 'deployment' AND root_id = ? AND state = 'active'`,
      )
      .get(TENANT, deploymentId) as { digest?: string } | null
  )?.digest;
}

function activeUncertaintyCount(database: Database): number | undefined {
  return (
    database
      .query(
        "SELECT COUNT(*) AS count FROM tf_artifact_consumer_uncertainties WHERE tenant_id = ? AND state = 'active'",
      )
      .get(TENANT) as { count?: number } | null
  )?.count;
}

function resourceIdentity(database: Database, resourceUid: string): unknown {
  return database
    .query(
      `SELECT resource_json, generation, revision, updated_at
       FROM tf_resources WHERE tenant_id = ? AND uid = ?`,
    )
    .get(TENANT, resourceUid);
}

function deploymentIdentity(database: Database, deploymentId: string): unknown {
  return database
    .query(
      `SELECT state, observed_json, outputs_json, updated_at
       FROM tf_resource_deployments WHERE tenant_id = ? AND id = ?`,
    )
    .get(TENANT, deploymentId);
}

function resolutionReceiptCount(database: Database, deploymentId: string): number | undefined {
  return (
    database
      .query(
        `SELECT COUNT(*) AS count FROM tf_artifact_consumer_resolution_receipts
         WHERE tenant_id = ? AND deployment_id = ?`,
      )
      .get(TENANT, deploymentId) as { count?: number } | null
  )?.count;
}
