import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject, Row, Sql } from "../src/ports.ts";
import { ProviderMutationRecoveryError } from "../src/provider-driver.ts";
import { TAKOFORM_APPLY_SELECTION_VERSION } from "../src/takoform/apply-selection.ts";
import {
  createResourceDependencySet,
  decodeResourceDependencySet,
  resourceDependencyClaimKeys,
} from "../src/takoform/dependency-fence.ts";
import type { DeferredOperationsConfiguration } from "../src/takoform/operations.ts";
import type { TakoformStoredRelation } from "../src/takoform/relations.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type {
  InstalledTakoformForm,
  TakoformHost,
  TakoformResourceDriver,
  TakoformV1Alpha3FormRef,
} from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const LANE = "/apis/forms.takoform.com/v1";
const EDGE = "edge.forms.takoform.com";

const MODULE_WORKER = form("ModuleWorker", "1", "identity", {
  type: "object",
  additionalProperties: false,
  properties: {},
});
const WORKER_VERSION = form("WorkerVersion", "2", "revision", {
  type: "object",
  additionalProperties: false,
  properties: {
    worker: reference("ModuleWorker", MODULE_WORKER.identity.formRef),
    handlers: { type: "array", items: { type: "string" } },
  },
  required: ["worker", "handlers"],
});
const WORKER_DEPLOYMENT = form(
  "WorkerDeployment",
  "3",
  "deployment",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      worker: reference("ModuleWorker", MODULE_WORKER.identity.formRef),
      versions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            workerVersion: reference("WorkerVersion", WORKER_VERSION.identity.formRef),
            weight: { type: "integer" },
          },
          required: ["workerVersion", "weight"],
        },
      },
    },
    required: ["worker", "versions"],
  },
  [
    { kind: "exclusive", reference: "/worker" },
    { kind: "sum", list: "/versions", member: "weight", total: 10_000 },
  ],
);
const FORMS = [MODULE_WORKER, WORKER_VERSION, WORKER_DEPLOYMENT];

test("a WorkerVersion delete armed after deployment validation fences provider dispatch", async () => {
  const acceptance = pauseDeploymentSagaAcceptance(createEphemeralSql());
  let deploymentApplyCalls = 0;
  let releaseDelete = () => {};
  const deleteHeld = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let signalDeleteEntered = () => {};
  const deleteEntered = new Promise<void>((resolve) => {
    signalDeleteEntered = resolve;
  });
  const host = stableHost(acceptance.sql, {
    async selectApply() {
      return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
    },
    async apply(input) {
      if (input.form.identity.formRef.kind === "WorkerDeployment") deploymentApplyCalls += 1;
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete(input) {
      if (input.resource.kind === "WorkerVersion") {
        signalDeleteEntered();
        await deleteHeld;
      }
    },
  });
  await seedWorkerAndVersion(host);

  const deploying = apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec());
  await acceptance.entered;
  const deleting = remove(host, WORKER_VERSION, "version", "delete-version-race-a");
  await deleteEntered;

  acceptance.release();
  const refused = await deploying;
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({
    error: { code: "invalid_argument", hostCode: "cross_resource_precondition" },
  });
  expect(deploymentApplyCalls).toBe(0);

  releaseDelete();
  expect((await deleting).status).toBe(204);
});

test("a deployment dependency hold refuses a racing WorkerVersion delete until commit", async () => {
  let deploymentApplyCalls = 0;
  let versionDeleteCalls = 0;
  let releaseApply = () => {};
  const applyHeld = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  let signalApplyEntered = () => {};
  const applyEntered = new Promise<void>((resolve) => {
    signalApplyEntered = resolve;
  });
  const host = stableHost(createEphemeralSql(), {
    async selectApply() {
      return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
    },
    async apply(input) {
      if (input.form.identity.formRef.kind === "WorkerDeployment") {
        deploymentApplyCalls += 1;
        signalApplyEntered();
        await applyHeld;
      }
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete(input) {
      if (input.resource.kind === "WorkerVersion") versionDeleteCalls += 1;
    },
  });
  await seedWorkerAndVersion(host);

  const deploying = apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec());
  await applyEntered;
  const refused = await remove(host, WORKER_VERSION, "version", "delete-version-race-b");
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({
    error: { code: "invalid_argument", hostCode: "cross_resource_precondition" },
  });
  expect(versionDeleteCalls).toBe(0);

  releaseApply();
  expect((await deploying).status).toBe(201);
  expect(deploymentApplyCalls).toBe(1);
});

test("a same-UID readiness revision change after validation fences provider dispatch", async () => {
  const acceptance = pauseDeploymentSagaAcceptance(createEphemeralSql());
  let deploymentApplyCalls = 0;
  let reportVersionUnready = false;
  const host = stableHost(acceptance.sql, {
    async selectApply() {
      return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
    },
    async apply(input) {
      if (input.form.identity.formRef.kind === "WorkerDeployment") deploymentApplyCalls += 1;
      return { observed: input.spec };
    },
    async observe(input) {
      return reportVersionUnready && input.resource.kind === "WorkerVersion"
        ? {
            observed: input.resource.spec,
            conditions: [
              {
                type: "Ready",
                status: "False",
                reason: "Failed",
                lastTransitionTime: "2026-09-08T00:00:00.000Z",
              },
            ],
          }
        : { observed: input.resource.spec };
    },
    async delete() {},
  });
  await seedWorkerAndVersion(host);

  const deploying = apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec());
  await acceptance.entered;
  reportVersionUnready = true;
  expect((await observe(host, WORKER_VERSION, "version", "observe-version-unready")).status).toBe(
    200,
  );

  acceptance.release();
  const refused = await deploying;
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({
    error: { code: "invalid_argument", hostCode: "cross_resource_precondition" },
  });
  expect(deploymentApplyCalls).toBe(0);
});

test("dependency snapshots remain exact when their durable payload spans bounded claim keys", async () => {
  const relation: TakoformStoredRelation = {
    pointer: `/${"p".repeat(126)}`,
    relation: `/${"r".repeat(126)}`,
    targetApiVersion: `${"a".repeat(240)}.invalid`,
    targetKind: "K".repeat(128),
    targetName: `n${"a".repeat(61)}`,
    targetUid: `uid_${"u".repeat(124)}`,
    targetRevision: `sha256:${"a".repeat(64)}`,
    targetFormRef: {
      apiVersion: `${"f".repeat(240)}.invalid`,
      kind: "F".repeat(128),
      definitionVersion: "0.2.0",
      schemaDigest: `sha256:${"b".repeat(64)}`,
    },
    bindingRef: {
      apiVersion: "bindings.takoform.com/v1alpha2",
      name: "binding-name",
      version: "1",
      schemaDigest: `sha256:${"c".repeat(64)}`,
    },
  };
  const tenantId = `tenant-${"界".repeat(248)}`;
  const dependencies = await createResourceDependencySet({
    tenantId,
    space: "界".repeat(255),
    holderUid: `uid_${"h".repeat(124)}`,
    operationId: "op_long_dependency_snapshot",
    relations: [relation, { ...relation, pointer: "/second" }],
  });
  const keys = resourceDependencyClaimKeys(dependencies);
  expect(keys.every((key) => key.length <= 1_024)).toBe(true);
  expect(dependencies.dataKeys.length).toBeGreaterThan(1);
  expect(
    await decodeResourceDependencySet(
      keys,
      tenantId,
      `uid_${"h".repeat(124)}`,
      "op_long_dependency_snapshot",
    ),
  ).toEqual(dependencies);

  const withoutOneChunk = keys.filter((key) => key !== dependencies.dataKeys[0]);
  await expect(
    decodeResourceDependencySet(
      withoutOneChunk,
      tenantId,
      `uid_${"h".repeat(124)}`,
      "op_long_dependency_snapshot",
    ),
  ).rejects.toThrow("manifest");
  const otherTenant = await createResourceDependencySet({
    tenantId: "tenant-b",
    space: "界".repeat(255),
    holderUid: `uid_${"h".repeat(124)}`,
    operationId: "op_long_dependency_snapshot",
    relations: [relation],
  });
  expect(otherTenant.fences[0]?.key).not.toBe(dependencies.fences[0]?.key);
  const otherOperation = await createResourceDependencySet({
    tenantId,
    space: "界".repeat(255),
    holderUid: `uid_${"h".repeat(124)}`,
    operationId: "op_concurrent_dependency_snapshot",
    relations: [relation, { ...relation, pointer: "/second" }],
  });
  expect(otherOperation.fences[0]?.key).not.toBe(dependencies.fences[0]?.key);
});

test("dependency reservation and dispatch keep a constant D1 statement budget", async () => {
  const durable = createEphemeralSql();
  const reservationBatches: Array<{ readonly statements: number; readonly targets: number }> = [];
  const dispatchBatches: Array<{ readonly statements: number; readonly targets: number }> = [];
  const sql: Sql = {
    query: (statement, params) => durable.query(statement, params),
    run: (statement, params) => durable.run(statement, params),
    async batch(statements) {
      const reservation = statements.find(
        (statement) =>
          statement.sql.includes("INSERT OR IGNORE INTO tf_resource_deletion_attestations") &&
          statement.sql.includes("FROM json_each(?) AS fence"),
      );
      if (reservation) {
        reservationBatches.push({
          statements: statements.length,
          targets: jsonArrayLength(reservation.params?.[3]),
        });
      }
      const dispatch = statements.find(
        (statement) =>
          statement.sql.includes("INSERT INTO tf_operation_commit_guards") &&
          statement.sql.includes("dependency.claim_key = json_extract(fence.value, '$[0]')"),
      );
      if (dispatch) {
        dispatchBatches.push({
          statements: statements.length,
          targets: jsonArrayLength(dispatch.params?.[1]),
        });
      }
      return await durable.batch(statements);
    },
  };
  const host = stableHost(sql, {
    async selectApply() {
      return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
    },
    async apply(input) {
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete() {},
  });

  await seedWorkerAndVersion(host);
  expect((await apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec())).status).toBe(201);
  expect(reservationBatches).toEqual([
    { statements: 6, targets: 0 },
    { statements: 6, targets: 1 },
    { statements: 6, targets: 2 },
  ]);
  expect(dispatchBatches).toEqual([
    { statements: 6, targets: 0 },
    { statements: 6, targets: 1 },
    { statements: 6, targets: 2 },
  ]);
});

test("replacement keeps old and new WorkerVersions fenced until the source commit swaps edges", async () => {
  let holdDeploymentUpdate = false;
  let releaseUpdate = () => {};
  const updateHeld = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  let signalUpdateEntered = () => {};
  const updateEntered = new Promise<void>((resolve) => {
    signalUpdateEntered = resolve;
  });
  const host = stableHost(createEphemeralSql(), {
    async selectApply() {
      return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
    },
    async apply(input) {
      if (holdDeploymentUpdate && input.form.identity.formRef.kind === "WorkerDeployment") {
        signalUpdateEntered();
        await updateHeld;
      }
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete() {},
  });
  await seedWorkerAndVersion(host, "version-a");
  await seedVersion(host, "version-b");
  expect(
    (await apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec("version-a"))).status,
  ).toBe(201);

  holdDeploymentUpdate = true;
  const updating = apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec("version-b"), {
    idempotencyKey: "update-deployment-to-version-b",
    expectedGeneration: "1",
  });
  const updateStart = await Promise.race([
    updateEntered.then(() => ({ kind: "entered" as const })),
    updating.then((response) => ({ kind: "settled" as const, response })),
  ]);
  if (updateStart.kind === "settled") {
    throw new Error(
      `deployment update settled before provider entry: ${JSON.stringify(updateStart.response)}`,
    );
  }
  expect((await remove(host, WORKER_VERSION, "version-a", "delete-old-during-swap")).status).toBe(
    409,
  );
  expect((await remove(host, WORKER_VERSION, "version-b", "delete-new-during-swap")).status).toBe(
    400,
  );

  releaseUpdate();
  expect((await updating).status).toBe(200);
  expect((await remove(host, WORKER_VERSION, "version-a", "delete-old-after-swap")).status).toBe(
    204,
  );
  expect((await remove(host, WORKER_VERSION, "version-b", "delete-new-after-swap")).status).toBe(
    409,
  );
  expect(
    (await remove(host, WORKER_DEPLOYMENT, "deployment", "delete-deployment", "2")).status,
  ).toBe(204);
  expect((await remove(host, WORKER_VERSION, "version-b", "delete-new-after-source")).status).toBe(
    204,
  );
});

test("a proven-idle dispatch callback failure releases only new dependency holds", async () => {
  const durable = createEphemeralSql();
  let refuseDispatchEffect = false;
  const sql: Sql = {
    query: (statement, params) => durable.query(statement, params),
    async run(statement, params) {
      if (
        refuseDispatchEffect &&
        statement.includes("INSERT OR IGNORE INTO tf_resource_provider_effects") &&
        params?.[4] === "apply" &&
        params[5] === "dispatched"
      ) {
        refuseDispatchEffect = false;
        return { rows: [], changes: 0 };
      }
      return await durable.run(statement, params);
    },
    batch: (statements) => durable.batch(statements),
  };
  let deploymentProviderCalls = 0;
  const host = stableHost(sql, {
    async selectApply() {
      return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
    },
    async apply(input) {
      if (input.form.identity.formRef.kind === "WorkerDeployment") {
        deploymentProviderCalls += 1;
      }
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete() {},
  });
  await seedWorkerAndVersion(host, "version-a");
  await seedVersion(host, "version-b");
  expect(
    (await apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec("version-a"))).status,
  ).toBe(201);

  refuseDispatchEffect = true;
  const refused = await apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec("version-b"), {
    idempotencyKey: "update-dispatch-ledger-refused",
    expectedGeneration: "1",
  });
  expect(refused.status).toBe(409);
  expect(deploymentProviderCalls).toBe(1);
  expect((await remove(host, WORKER_VERSION, "version-a", "delete-old-after-refusal")).status).toBe(
    409,
  );
  expect((await remove(host, WORKER_VERSION, "version-b", "delete-new-after-refusal")).status).toBe(
    204,
  );

  await seedVersion(host, "version-b");
  expect(
    (
      await apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec("version-b"), {
        idempotencyKey: "update-after-dispatch-ledger-repair",
        expectedGeneration: "1",
      })
    ).status,
  ).toBe(200);
  expect(deploymentProviderCalls).toBe(2);
  expect((await remove(host, WORKER_VERSION, "version-a", "delete-old-after-retry")).status).toBe(
    204,
  );
});

test("a dispatched dependency set survives ordinary TTL and deferred recovery commits that exact set", async () => {
  const sql = createEphemeralSql();
  let now = Date.parse("2026-09-08T00:00:00.000Z");
  const seen: Array<{
    readonly mode: "initial" | "recovery" | undefined;
    readonly targetUid: string;
    readonly targetRevision: string;
  }> = [];
  let deploymentAttempts = 0;
  const host = stableHost(
    sql,
    {
      async selectApply() {
        return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
      },
      async apply(input) {
        if (input.form.identity.formRef.kind === "WorkerDeployment") {
          deploymentAttempts += 1;
          const version = input.relations.find(
            (relation) => relation.resource.kind === "WorkerVersion",
          );
          if (!version) throw new Error("deployment recovery lost its WorkerVersion relation");
          seen.push({
            mode: input.operationMode,
            targetUid: version.targetUid,
            targetRevision: version.resource.metadata.revision,
          });
          if (deploymentAttempts === 1) {
            throw new ProviderMutationRecoveryError("running", "deployment-provider-handle");
          }
        }
        return { observed: input.spec };
      },
      async observe(input) {
        return { observed: input.resource.spec };
      },
      async delete() {},
    },
    {
      clock: () => new Date(now),
      deferredOperations: deferredOnProbe(),
    },
  );
  await seedWorkerAndVersion(host);

  const initial = await apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec(), {
    idempotencyKey: "deferred-deployment-recovery",
    deferred: true,
  });
  expect(initial.status).toBe(202);
  const operationRow = onlyRow(
    await sql.query(
      `SELECT id, resource_uid FROM tf_deferred_operations
       WHERE target_kind = 'WorkerDeployment'`,
    ),
  );
  const operationId = String(operationRow.id);
  const resourceUid = String(operationRow.resource_uid);
  expect(initial.body).toMatchObject({ operation: { id: operationId, done: false } });
  const heldRows = await sql.query(
    `SELECT claim_key, owner_operation_id, state, expires_at
     FROM tf_resource_claims WHERE owner_operation_id = ? ORDER BY claim_key`,
    [operationId],
  );
  expect(heldRows.length).toBeGreaterThan(0);
  expect(
    heldRows.every(
      (row) =>
        row.owner_operation_id === operationId &&
        row.state === "reserved" &&
        row.expires_at === 253_402_300_799_999,
    ),
  ).toBe(true);
  const store = createTakoformStore(sql, () => new Date(now));
  const accepted = await store.readProviderMutationDependencies({
    tenantId: "tenant-a",
    resourceUid,
    operationId,
  });
  expect(
    accepted?.relations.find((relation) => relation.targetKind === "WorkerVersion"),
  ).toMatchObject({
    targetUid: seen[0]?.targetUid,
    targetRevision: seen[0]?.targetRevision,
  });
  const privateKey = String(heldRows[0]?.claim_key);
  expect(await store.resourceClaimHolder(privateKey)).toBeNull();
  expect(await store.committedResourceClaimHolder(privateKey)).toBeNull();
  await expect(
    store.reserveResourceClaims(
      [
        {
          key: privateKey,
          tenantId: "tenant-a",
          holderSpace: "main",
          holderApiVersion: EDGE,
          holderKind: "WorkerDeployment",
          holderName: "collision",
          holderUid: "uid_public_collision",
          operationId: "op_public_collision",
        },
      ],
      now + 1_000,
    ),
  ).rejects.toThrow("Host dependency namespace");

  now += 8 * 24 * 60 * 60_000;
  expect(await host.maintenance?.drainProviderRepairs(8)).toEqual({
    candidates: 1,
    acquired: 1,
    settled: 1,
    pending: 0,
  });
  expect(seen).toHaveLength(2);
  const initialSeen = seen[0];
  if (!initialSeen) throw new Error("initial dependency projection was not observed");
  expect(seen[1]).toEqual({ ...initialSeen, mode: "recovery" });
  const committed = await sql.query(
    `SELECT state, expires_at FROM tf_resource_claims
     WHERE owner_operation_id = ? ORDER BY claim_key`,
    [operationId],
  );
  expect(committed.length).toBe(heldRows.length);
  expect(committed.every((row) => row.state === "committed" && row.expires_at === null)).toBe(true);
  expect(
    (await remove(host, WORKER_VERSION, "version", "delete-version-after-recovery")).status,
  ).toBe(409);
});

test("receipted recovery commits the accepted dependency set after target revision drift", async () => {
  const durable = createEphemeralSql();
  let now = Date.parse("2026-09-08T00:00:00.000Z");
  let failDeploymentCommit = false;
  const sql: Sql = {
    query: (statement, params) => durable.query(statement, params),
    run: (statement, params) => durable.run(statement, params),
    async batch(statements) {
      if (
        failDeploymentCommit &&
        statements.some(
          (statement) =>
            statement.sql.includes("INSERT INTO tf_resources") &&
            statement.params?.[3] === "WorkerDeployment",
        )
      ) {
        failDeploymentCommit = false;
        throw new Error("synthetic post-receipt commit interruption");
      }
      return await durable.batch(statements);
    },
  };
  let providerCalls = 0;
  let observationEpoch = 0;
  const host = stableHost(
    sql,
    {
      async selectApply() {
        return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
      },
      async apply(input) {
        if (input.form.identity.formRef.kind === "WorkerDeployment") providerCalls += 1;
        return { observed: input.spec };
      },
      async observe(input) {
        return input.resource.kind === "WorkerVersion"
          ? {
              observed: input.resource.spec,
              conditions: [
                {
                  type: "Ready",
                  status: "True",
                  reason: "Available",
                  lastTransitionTime: new Date(now + observationEpoch).toISOString(),
                },
              ],
            }
          : { observed: input.resource.spec };
      },
      async delete() {},
    },
    {
      clock: () => new Date(now),
      deferredOperations: deferredOnProbe(),
    },
  );
  await seedWorkerAndVersion(host);
  const beforeDrift = onlyRow(
    await sql.query(
      `SELECT revision FROM tf_resources
       WHERE tenant_id = 'tenant-a' AND kind = 'WorkerVersion' AND name = 'version'`,
    ),
  );
  const acceptedVersionRevision = String(beforeDrift.revision);

  failDeploymentCommit = true;
  const initial = await apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec(), {
    idempotencyKey: "deferred-receipted-deployment-recovery",
    deferred: true,
  });
  expect(initial.status).toBe(202);
  expect(providerCalls).toBe(1);
  const operationRow = onlyRow(
    await sql.query(
      `SELECT id, resource_uid FROM tf_deferred_operations
       WHERE target_kind = 'WorkerDeployment'`,
    ),
  );
  const operationId = String(operationRow.id);
  const resourceUid = String(operationRow.resource_uid);
  expect(initial.body).toMatchObject({ operation: { id: operationId, done: false } });
  const accepted = await createTakoformStore(
    sql,
    () => new Date(now),
  ).readProviderMutationDependencies({ tenantId: "tenant-a", resourceUid, operationId });
  expect(accepted).not.toBeNull();
  expect(
    accepted?.relations.find((relation) => relation.targetKind === "WorkerVersion")?.targetRevision,
  ).toBe(acceptedVersionRevision);

  observationEpoch = 1;
  expect((await observe(host, WORKER_VERSION, "version", "advance-version-revision")).status).toBe(
    200,
  );
  const afterDrift = onlyRow(
    await sql.query(
      `SELECT revision FROM tf_resources
       WHERE tenant_id = 'tenant-a' AND kind = 'WorkerVersion' AND name = 'version'`,
    ),
  );
  expect(afterDrift.revision).not.toBe(beforeDrift.revision);

  now += 1;
  const repaired = await host.handle(request(`${LANE}/operations/${operationId}`));
  expect(repaired?.status).toBe(200);
  expect(await repaired?.json()).toMatchObject({
    id: operationId,
    done: true,
    result: { resource: { metadata: { name: "deployment" } } },
  });
  expect(providerCalls).toBe(1);
  const deployment = onlyRow(
    await sql.query(
      `SELECT relations_json FROM tf_resources
       WHERE tenant_id = 'tenant-a' AND kind = 'WorkerDeployment' AND name = 'deployment'`,
    ),
  );
  const committedRelations = JSON.parse(
    String(deployment.relations_json),
  ) as TakoformStoredRelation[];
  expect(
    committedRelations.find((relation) => relation.targetKind === "WorkerVersion")?.targetRevision,
  ).toBe(acceptedVersionRevision);
});

test("post-dispatch recovery never rebinds the accepted dependency to a recreated UID", async () => {
  const sql = createEphemeralSql();
  let now = Date.parse("2026-09-08T00:00:00.000Z");
  const seenTargetUids: string[] = [];
  const host = stableHost(
    sql,
    {
      async selectApply() {
        return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
      },
      async apply(input) {
        if (input.form.identity.formRef.kind === "WorkerDeployment") {
          const version = input.relations.find(
            (relation) => relation.resource.kind === "WorkerVersion",
          );
          if (!version) throw new Error("deployment lost its WorkerVersion relation");
          seenTargetUids.push(version.targetUid);
          throw new ProviderMutationRecoveryError("indeterminate");
        }
        return { observed: input.spec };
      },
      async observe(input) {
        return { observed: input.resource.spec };
      },
      async delete() {},
    },
    {
      clock: () => new Date(now),
      deferredOperations: deferredOnProbe(),
    },
  );
  await seedWorkerAndVersion(host);
  const initial = await apply(host, WORKER_DEPLOYMENT, "deployment", deploymentSpec(), {
    idempotencyKey: "deferred-deployment-aba",
    deferred: true,
  });
  expect(initial.status).toBe(202);
  const operationRow = onlyRow(
    await sql.query(
      `SELECT id, resource_uid FROM tf_deferred_operations
       WHERE target_kind = 'WorkerDeployment'`,
    ),
  );
  const operationId = String(operationRow.id);
  const resourceUid = String(operationRow.resource_uid);
  expect(initial.body).toMatchObject({ operation: { id: operationId, done: false } });
  const originalVersion = onlyRow(
    await sql.query(
      `SELECT uid FROM tf_resources
       WHERE tenant_id = 'tenant-a' AND kind = 'WorkerVersion' AND name = 'version'`,
    ),
  );
  expect(seenTargetUids).toEqual([String(originalVersion.uid)]);

  // Synthesize an ABA below the public deletion fence. Recovery must retain
  // the durable pre-dispatch UID, even if resolving the stored desired body by
  // name would now find another healthy incarnation.
  await sql.run(
    `DELETE FROM tf_resources
     WHERE tenant_id = 'tenant-a' AND kind = 'WorkerVersion' AND name = 'version'`,
  );
  await seedVersion(host, "version");
  const replacementVersion = onlyRow(
    await sql.query(
      `SELECT uid FROM tf_resources
       WHERE tenant_id = 'tenant-a' AND kind = 'WorkerVersion' AND name = 'version'`,
    ),
  );
  expect(replacementVersion.uid).not.toBe(originalVersion.uid);

  now += 1;
  expect(await host.maintenance?.drainProviderRepairs(8)).toEqual({
    candidates: 1,
    acquired: 1,
    settled: 0,
    pending: 1,
  });
  expect(seenTargetUids).toEqual([String(originalVersion.uid)]);
  const accepted = await createTakoformStore(
    sql,
    () => new Date(now),
  ).readProviderMutationDependencies({ tenantId: "tenant-a", resourceUid, operationId });
  expect(
    accepted?.relations.some((relation) => relation.targetUid === String(originalVersion.uid)),
  ).toBe(true);
  expect(
    accepted?.relations.some((relation) => relation.targetUid === String(replacementVersion.uid)),
  ).toBe(false);
});

function stableHost(
  sql: Sql,
  driver: TakoformResourceDriver,
  options: {
    readonly clock?: () => Date;
    readonly deferredOperations?: DeferredOperationsConfiguration;
  } = {},
): TakoformHost {
  return createStaticStableTestTakoformHost({
    sql,
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: FORMS,
    driver,
    ...options,
  });
}

async function seedWorkerAndVersion(host: TakoformHost, versionName = "version"): Promise<void> {
  expect((await apply(host, MODULE_WORKER, "worker", {})).status).toBe(201);
  await seedVersion(host, versionName);
}

async function seedVersion(host: TakoformHost, versionName: string): Promise<void> {
  const version = await apply(host, WORKER_VERSION, versionName, {
    worker: named("ModuleWorker", "worker"),
    handlers: ["fetch"],
  });
  expect(version.status).toBe(201);
}

function deploymentSpec(versionName = "version"): JsonObject {
  return {
    worker: named("ModuleWorker", "worker"),
    versions: [{ workerVersion: named("WorkerVersion", versionName), weight: 10_000 }],
  };
}

async function apply(
  host: TakoformHost,
  installed: InstalledTakoformForm,
  name: string,
  spec: JsonObject,
  options: {
    readonly idempotencyKey?: string;
    readonly expectedGeneration?: string;
    readonly deferred?: boolean;
  } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const desired = {
    apiVersion: installed.identity.formRef.apiVersion,
    kind: installed.identity.formRef.kind,
    form: { formRef: installed.identity.formRef },
    metadata: { name, space: "main" },
    spec,
  };
  const prepared = await host.handle(
    request(`${LANE}/resources/prepare`, {
      method: "POST",
      ...(options.expectedGeneration
        ? { headers: { "takoform-expected-generation": options.expectedGeneration } }
        : {}),
      body: JSON.stringify(desired),
    }),
  );
  if (prepared?.status !== 200) {
    return { status: prepared?.status ?? 0, body: await prepared?.json() };
  }
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;
  const applied = await host.handle(
    request(`${LANE}/resources/${EDGE}/${installed.identity.formRef.kind}/${name}`, {
      method: "PUT",
      headers: {
        "idempotency-key": options.idempotencyKey ?? `create-${name}`,
        ...(options.expectedGeneration
          ? { "takoform-expected-generation": options.expectedGeneration }
          : { "if-none-match": "*" }),
        ...(options.deferred ? { "takoform-conformance-probe": "async" } : {}),
      },
      body: JSON.stringify({
        ...desired,
        ...(options.expectedGeneration ? { expectedGeneration: options.expectedGeneration } : {}),
        review,
      }),
    }),
  );
  return { status: applied?.status ?? 0, body: await applied?.json() };
}

async function remove(
  host: TakoformHost,
  installed: InstalledTakoformForm,
  name: string,
  idempotencyKey: string,
  expectedGeneration = "1",
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await host.handle(
    request(resourceUrl(installed, name), {
      method: "DELETE",
      headers: {
        "idempotency-key": idempotencyKey,
        "takoform-expected-generation": expectedGeneration,
      },
    }),
  );
  return {
    status: response?.status ?? 0,
    body: response?.status === 204 ? undefined : await response?.json(),
  };
}

async function observe(
  host: TakoformHost,
  installed: InstalledTakoformForm,
  name: string,
  idempotencyKey: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await host.handle(
    request(resourceUrl(installed, name, "observe"), {
      method: "POST",
      headers: {
        "idempotency-key": idempotencyKey,
        "takoform-expected-generation": "1",
      },
    }),
  );
  return { status: response?.status ?? 0, body: await response?.json() };
}

function resourceUrl(installed: InstalledTakoformForm, name: string, action?: string): string {
  const query = new URLSearchParams({
    space: "main",
    definitionVersion: installed.identity.formRef.definitionVersion,
    schemaDigest: installed.identity.formRef.schemaDigest,
  });
  return `${LANE}/resources/${EDGE}/${installed.identity.formRef.kind}/${name}${action ? `/${action}` : ""}?${query}`;
}

function pauseDeploymentSagaAcceptance(durable: Sql): {
  readonly sql: Sql;
  readonly entered: Promise<void>;
  readonly release: () => void;
} {
  let signalEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  return {
    sql: {
      query: (statement, params) => durable.query(statement, params),
      async run(statement, params) {
        if (
          !paused &&
          statement.includes("INSERT OR IGNORE INTO tf_provider_mutation_sagas") &&
          params?.[7] === "WorkerDeployment"
        ) {
          paused = true;
          signalEntered();
          await held;
        }
        return durable.run(statement, params);
      },
      batch: (statements) => durable.batch(statements),
    },
    entered,
    release,
  };
}

function deferredOnProbe(): DeferredOperationsConfiguration {
  return {
    shouldDefer: ({ request: incoming }) =>
      incoming.headers.get("takoform-conformance-probe") === "async",
    pollsBeforeCommit: 1,
    retryAfterSeconds: 0,
    leaseMilliseconds: 1_000,
    executeOnAccept: true,
  };
}

function onlyRow(rows: readonly Row[]): Row {
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error(`expected one row, received ${rows.length}`);
  return row;
}

function jsonArrayLength(value: unknown): number {
  if (typeof value !== "string") throw new Error("expected a JSON dependency parameter");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("expected a JSON dependency array");
  return parsed.length;
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer test");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://api.takoserver.com${path}`, { ...init, headers });
}

function named(kind: string, name: string): JsonObject {
  return { apiVersion: EDGE, kind, name };
}

function reference(kind: string, formRef: TakoformV1Alpha3FormRef): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      apiVersion: { const: EDGE },
      kind: { const: kind },
      name: { type: "string" },
    },
    required: ["apiVersion", "kind", "name"],
    "x-takoform-target-formrefs": [
      {
        apiVersion: formRef.apiVersion,
        kind: formRef.kind,
        definitionVersion: formRef.definitionVersion,
        schemaDigest: formRef.schemaDigest,
      },
    ],
  };
}

function form(
  kind: string,
  digit: string,
  role: NonNullable<InstalledTakoformForm["role"]>,
  desiredSchema: JsonObject,
  constraints?: InstalledTakoformForm["constraints"],
): InstalledTakoformForm {
  return {
    identity: {
      formRef: {
        apiVersion: EDGE,
        kind,
        definitionVersion: "0.2.0",
        schemaDigest: `sha256:${digit.repeat(64)}`,
      },
    },
    role,
    desiredSchema,
    ...(constraints ? { constraints } : {}),
    operations:
      role === "revision"
        ? ["create", "read", "observe", "delete"]
        : role === "deployment"
          ? ["create", "read", "update", "delete"]
          : ["create", "read", "delete"],
  };
}
