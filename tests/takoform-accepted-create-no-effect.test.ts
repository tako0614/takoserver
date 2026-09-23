import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createLedger } from "../src/ledger.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql } from "../src/ports.ts";
import {
  ProviderApplyNoEffectUnsupportedError,
  ProviderMutationCompensatedFailureError,
  ProviderMutationRecoveryError,
  ProviderMutationWholeOperationRefusalError,
} from "../src/provider-driver.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { TAKOFORM_APPLY_SELECTION_VERSION } from "../src/takoform/apply-selection.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type {
  InstalledTakoformForm,
  TakoformResourceDriver,
  TakoformStoredResource,
} from "../src/takoform/types.ts";
import { createConfiguredHistoricalTakoformHost } from "./helpers/historical-takoform-host.ts";

const lane = "/apis/forms.takoform.com/v1beta4";
const edgeApiVersion = "edge.forms.takoform.com/v1beta1";
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const workerForm = installedForm("ModuleWorker", "1", "identity", {
  type: "object",
  properties: {},
  additionalProperties: false,
});
const versionForm = installedForm("WorkerVersion", "2", "revision", {
  type: "object",
  required: ["worker", "handlers"],
  additionalProperties: false,
  properties: {
    worker: referenceSchema(workerForm),
    handlers: { type: "array", items: { type: "string" } },
  },
});
const deploymentForm = installedForm("WorkerDeployment", "3", "deployment", {
  type: "object",
  required: ["worker", "versions"],
  additionalProperties: false,
  properties: {
    worker: referenceSchema(workerForm),
    versions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["workerVersion", "weight"],
        additionalProperties: false,
        properties: {
          workerVersion: referenceSchema(versionForm),
          weight: { type: "integer", minimum: 1, maximum: 10_000 },
        },
      },
    },
  },
});
const cronForm: InstalledTakoformForm = {
  ...installedForm("WorkerCronTrigger", "4", "attachment", {
    type: "object",
    required: ["worker", "cron"],
    additionalProperties: false,
    properties: {
      worker: referenceSchema(workerForm),
      cron: { type: "string" },
    },
  }),
  constraints: [{ kind: "claim", property: "/cron" }],
};
const endpointForm = installedForm("WorkerEndpoint", "5", "attachment", {
  type: "object",
  required: ["worker"],
  additionalProperties: false,
  properties: { worker: referenceSchema(workerForm) },
});
const forms = [workerForm, versionForm, deploymentForm, cronForm, endpointForm] as const;
const runtimeBindingRef = {
  apiVersion: "bindings.takoform.com/v1alpha2" as const,
  name: "accepted-create.test-binding",
  version: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}` as const,
};

test("concludes an accepted create before live worker and dependency revisions are revalidated", async () => {
  const database = new Database(":memory:");
  databases.push(database);
  migrateSqlite(database);
  const memory = new InMemoryTakoformResourceDriver();
  const conclusionInputs: Array<
    Parameters<NonNullable<TakoformResourceDriver["concludeApplyNoEffect"]>>[0]
  > = [];
  let cronApplyCalls = 0;
  const driver: TakoformResourceDriver = {
    ...memory,
    selectApply: async (input) => ({
      version: TAKOFORM_APPLY_SELECTION_VERSION,
      kind: "provider",
      providerPackRef: "accepted-provider",
      providerInstallationRef: "accepted-provider.primary",
      technicalOffering: {
        id: `accepted-${input.form.identity.formRef.kind}`,
        kind: `takoform.${input.form.identity.formRef.kind}`,
        displayName: input.form.identity.formRef.kind,
        form: structuredClone(input.form.identity.formRef),
        capabilities: ["create", "update", "delete", "observe"],
        providedInterfaces: [],
        bindingRefs: [],
      },
      relations: input.relations.map((relation) => ({
        pointer: relation.pointer,
        relation: relation.relation,
        targetUid: relation.targetUid,
        resource: {
          apiVersion: relation.resource.apiVersion,
          kind: relation.resource.kind,
          formRef: structuredClone(relation.resource.form.formRef),
          name: relation.resource.metadata.name,
          space: relation.resource.metadata.space,
          uid: relation.resource.metadata.uid,
          generation: relation.resource.metadata.generation,
          revision: relation.resource.metadata.revision,
        },
      })),
    }),
    apply: async (input) => {
      if (input.form.identity.formRef.kind === "WorkerCronTrigger") {
        cronApplyCalls += 1;
        throw new ProviderMutationRecoveryError("indeterminate");
      }
      return await memory.apply(input);
    },
    async concludeApplyNoEffect(input) {
      conclusionInputs.push(structuredClone(input));
      throw new ProviderMutationWholeOperationRefusalError(
        "conflict",
        409,
        "the accepted create was durably fenced before effects",
        { action: "concludeApplyNoEffect" },
      );
    },
    observe: (input) => memory.observe(input),
    delete: (input) => memory.delete(input),
  };
  let ids = 0;
  const host = createConfiguredHistoricalTakoformHost({
    sql: createSqliteSql(database),
    objects: createMemoryObjectStore(),
    forms,
    driver,
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    routes: {
      hostApiVersion: "forms.takoform.com/v1beta4",
      apiPath: lane,
      supportProfileApiVersion: "support.takoform.com/v1alpha2",
      reviewSpecDigest: true,
    },
    deferredOperations: {
      shouldDefer: ({ request }) => request.headers.get("takoform-conformance-probe") === "async",
      pollsBeforeCommit: 1,
      executeOnAccept: true,
      retryAfterSeconds: 0,
      leaseMilliseconds: 1_000,
    },
    randomId: () => `no-effect-${++ids}`,
  });

  const worker = await create(host, workerForm, "worker", {});
  await create(host, versionForm, "version", {
    worker: reference(workerForm, "worker"),
    handlers: ["fetch", "scheduled"],
  });
  const deployment = await create(host, deploymentForm, "deployment", {
    worker: reference(workerForm, "worker"),
    versions: [{ workerVersion: reference(versionForm, "version"), weight: 10_000 }],
  });
  expect(worker.metadata.revision).toBe("1");

  const desired = desiredResource(cronForm, "schedule", {
    worker: reference(workerForm, "worker"),
    cron: "*/5 * * * *",
  });
  const review = await prepare(host, desired);
  const accepted = await host.handle(
    request(resourcePath(cronForm, "schedule"), {
      method: "PUT",
      headers: {
        "idempotency-key": "accepted-cron-no-effect-0001",
        "if-none-match": "*",
        "takoform-conformance-probe": "async",
      },
      body: JSON.stringify({ ...desired, review }),
    }),
  );
  expect(accepted?.status).toBe(202);
  if (!accepted) throw new Error("accepted create returned no response");
  const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
  expect(cronApplyCalls).toBe(1);
  const saga = database
    .query(
      `SELECT resource_uid, selection_json, provider_handle, provider_outcome, receipt_json
       FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
    )
    .get(operationId) as {
    resource_uid: string;
    selection_json: string;
    provider_handle: string | null;
    provider_outcome: string;
    receipt_json: string | null;
  };
  expect(saga).toMatchObject({
    provider_handle: null,
    provider_outcome: "indeterminate",
    receipt_json: null,
  });
  expect(JSON.parse(saga.selection_json)).toMatchObject({
    kind: "provider",
    relations: [{ resource: { uid: worker.metadata.uid, revision: "1" } }],
  });
  const originalNonDependencyClaims = database
    .query(
      `SELECT claim_key, owner_operation_id
       FROM tf_resource_claims
       WHERE tenant_id = ? AND holder_uid = ? AND owner_operation_id <> ?
       ORDER BY claim_key`,
    )
    .all("tenant-a", saga.resource_uid, operationId) as Array<{
    claim_key: string;
    owner_operation_id: string;
  }>;
  expect(originalNonDependencyClaims).toHaveLength(1);
  const originalClaimOwner = originalNonDependencyClaims[0]?.owner_operation_id;
  if (!originalClaimOwner) throw new Error("accepted create retained no original claim owner");
  expect(originalClaimOwner).not.toBe(operationId);
  database
    .query(
      `INSERT INTO tf_resource_claims
         (claim_key, tenant_id, holder_space, holder_api_version, holder_kind,
          holder_name, holder_uid, owner_operation_id, state, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
    )
    .run(
      "claim:unrelated:same-old-owner",
      "tenant-a",
      "main",
      cronForm.identity.formRef.apiVersion,
      cronForm.identity.formRef.kind,
      "unrelated-schedule",
      "uid_unrelated_schedule",
      originalClaimOwner,
      Date.parse("2099-01-01T00:00:00.000Z"),
      Date.parse("2026-09-23T00:00:00.000Z"),
    );

  database
    .query("DELETE FROM tf_resource_claims WHERE holder_uid = ?")
    .run(deployment.metadata.uid);
  database
    .query("DELETE FROM tf_resources WHERE tenant_id = ? AND uid = ?")
    .run("tenant-a", deployment.metadata.uid);
  const liveWorker: TakoformStoredResource = {
    ...worker,
    metadata: { ...worker.metadata, revision: "3" },
    status: {
      ...worker.status,
      conditions: [
        {
          type: "Ready",
          status: "False",
          reason: "Provisioning",
          hostReason: "ModuleWorker worker has no active WorkerDeployment",
          lastTransitionTime:
            worker.status.conditions[0]?.lastTransitionTime ?? "2026-09-23T00:00:00.000Z",
        },
      ],
    },
  };
  database
    .query(
      `UPDATE tf_resources SET revision = '3', resource_json = ?
       WHERE tenant_id = ? AND uid = ?`,
    )
    .run(JSON.stringify(liveWorker), "tenant-a", worker.metadata.uid);
  expect(
    database
      .query("SELECT revision FROM tf_resources WHERE tenant_id = ? AND uid = ?")
      .get("tenant-a", worker.metadata.uid),
  ).toEqual({ revision: "3" });
  expect(
    database
      .query("SELECT COUNT(*) AS rows FROM tf_resources WHERE kind = 'WorkerDeployment'")
      .get(),
  ).toEqual({ rows: 0 });

  const terminal = await host.handle(request(`${lane}/operations/${operationId}`));
  expect(await terminal?.json()).toMatchObject({
    id: operationId,
    done: true,
    error: { code: "conflict", message: "the accepted create was durably fenced before effects" },
  });
  expect(cronApplyCalls).toBe(1);
  expect(conclusionInputs).toHaveLength(1);
  expect(conclusionInputs[0]).toMatchObject({
    operationId,
    resourceUid: saga.resource_uid,
    selection: {
      providerPackRef: "accepted-provider",
      providerInstallationRef: "accepted-provider.primary",
      relations: [{ resource: { uid: worker.metadata.uid, revision: "1" } }],
    },
    executionAuthority: {
      tenantId: "tenant-a",
      resourceUid: saga.resource_uid,
      fingerprint: expect.any(String),
      leaseToken: expect.any(String),
    },
  });
  expect(conclusionInputs[0]?.executionAuthority.leaseToken).not.toBe(originalClaimOwner);
  expect(
    database
      .query("SELECT phase FROM tf_deferred_operations_selection_v1 WHERE id = ?")
      .get(operationId),
  ).toEqual({ phase: "failed" });
  expect(
    database
      .query(
        "SELECT COUNT(*) AS rows FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
      )
      .get(operationId),
  ).toEqual({ rows: 0 });
  expect(
    database
      .query("SELECT COUNT(*) AS rows FROM tf_resource_claims WHERE holder_uid = ?")
      .get(saga.resource_uid),
  ).toEqual({ rows: 0 });
  expect(
    database
      .query(
        `SELECT claim_key, owner_operation_id, state
         FROM tf_resource_claims WHERE claim_key = ?`,
      )
      .get("claim:unrelated:same-old-owner"),
  ).toEqual({
    claim_key: "claim:unrelated:same-old-owner",
    owner_operation_id: originalClaimOwner,
    state: "reserved",
  });
  expect(
    database
      .query("SELECT COUNT(*) AS rows FROM tf_resource_provider_effects WHERE resource_uid = ?")
      .get(saga.resource_uid),
  ).toEqual({ rows: 0 });
  expect(
    database
      .query(
        "SELECT COUNT(*) AS rows FROM tf_resource_deletion_attestations WHERE resource_uid = ?",
      )
      .get(saga.resource_uid),
  ).toEqual({ rows: 0 });
  expect(
    database
      .query("SELECT revision FROM tf_resources WHERE tenant_id = ? AND uid = ?")
      .get("tenant-a", worker.metadata.uid),
  ).toEqual({ revision: "3" });
});

test("compensates a drifted accepted create atomically and replays after a lost acknowledgement", async () => {
  const fixture = await acceptedCompensationFixture({ loseFirstAcknowledgement: true });
  const {
    database,
    host,
    worker,
    deployment,
    operationId,
    resourceUid,
    applyModes,
    recoverySequence,
    compensationInputs,
  } = fixture;
  const originalClaim = database
    .query(
      `SELECT owner_operation_id FROM tf_resource_claims
       WHERE tenant_id = ? AND holder_uid = ? AND owner_operation_id <> ?
       ORDER BY claim_key LIMIT 1`,
    )
    .get("tenant-a", resourceUid, operationId) as { owner_operation_id: string } | null;
  if (!originalClaim) throw new Error("accepted create retained no declaration claim");
  database
    .query(
      `INSERT INTO tf_resource_claims
         (claim_key, tenant_id, holder_space, holder_api_version, holder_kind,
          holder_name, holder_uid, owner_operation_id, state, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
    )
    .run(
      "claim:compensation-unrelated",
      "tenant-a",
      "main",
      cronForm.identity.formRef.apiVersion,
      cronForm.identity.formRef.kind,
      "unrelated-schedule",
      "uid_unrelated_compensation",
      originalClaim.owner_operation_id,
      Date.parse("2099-01-01T00:00:00.000Z"),
      Date.parse("2026-09-23T00:00:00.000Z"),
    );

  database
    .query("DELETE FROM tf_resource_claims WHERE holder_uid = ?")
    .run(deployment.metadata.uid);
  database
    .query("DELETE FROM tf_resources WHERE tenant_id = ? AND uid = ?")
    .run("tenant-a", deployment.metadata.uid);
  const liveWorker: TakoformStoredResource = {
    ...worker,
    metadata: { ...worker.metadata, revision: "3" },
    status: {
      ...worker.status,
      conditions: [
        {
          type: "Ready",
          status: "False",
          reason: "Provisioning",
          hostReason: "ModuleWorker worker has no active WorkerDeployment",
          lastTransitionTime:
            worker.status.conditions[0]?.lastTransitionTime ?? "2026-09-23T00:00:00.000Z",
        },
      ],
    },
  };
  database
    .query(
      "UPDATE tf_resources SET revision = '3', resource_json = ? WHERE tenant_id = ? AND uid = ?",
    )
    .run(JSON.stringify(liveWorker), "tenant-a", worker.metadata.uid);

  const held = await host.handle(request(`${lane}/operations/${operationId}`));
  expect(await held?.json()).toMatchObject({ id: operationId, done: false });
  expect(recoverySequence).toEqual(["no-effect:open", "compensate:first"]);
  expect(applyModes).toEqual(["initial"]);
  expect(
    database
      .query("SELECT phase FROM tf_deferred_operations_selection_v1 WHERE id = ?")
      .get(operationId),
  ).toEqual({ phase: "committing" });

  const terminal = await host.handle(request(`${lane}/operations/${operationId}`));
  expect(await terminal?.json()).toMatchObject({
    id: operationId,
    done: true,
    error: { code: "conflict", message: "the accepted create was durably compensated" },
  });
  expect(recoverySequence).toEqual([
    "no-effect:open",
    "compensate:first",
    "no-effect:compensated",
    "compensate:replay",
  ]);
  expect(applyModes).toEqual(["initial"]);
  expect(compensationInputs).toHaveLength(2);
  expect(compensationInputs[1]).toMatchObject({
    operationId,
    resourceUid,
    selection: {
      providerPackRef: "accepted-provider",
      providerInstallationRef: "accepted-provider.primary",
      relations: [{ resource: { uid: worker.metadata.uid, revision: "1" } }],
    },
    executionAuthority: {
      tenantId: "tenant-a",
      resourceUid,
      leaseToken: expect.any(String),
      fingerprint: expect.any(String),
    },
  });
  expect(compensationInputs[0]?.executionAuthority.leaseToken).not.toBe(
    compensationInputs[1]?.executionAuthority.leaseToken,
  );

  expect(
    database
      .query("SELECT phase FROM tf_deferred_operations_selection_v1 WHERE id = ?")
      .get(operationId),
  ).toEqual({ phase: "failed" });
  expect(
    database
      .query(
        "SELECT COUNT(*) AS rows FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
      )
      .get(operationId),
  ).toEqual({ rows: 0 });
  expect(
    database
      .query(
        "SELECT COUNT(*) AS rows FROM tf_resource_claims WHERE tenant_id = ? AND holder_uid = ?",
      )
      .get("tenant-a", resourceUid),
  ).toEqual({ rows: 0 });
  expect(
    database
      .query("SELECT owner_operation_id, state FROM tf_resource_claims WHERE claim_key = ?")
      .get("claim:compensation-unrelated"),
  ).toEqual({ owner_operation_id: originalClaim.owner_operation_id, state: "reserved" });
  const effects = database
    .query(
      `SELECT phase, target_json FROM tf_resource_provider_effects
       WHERE tenant_id = ? AND resource_uid = ?
       ORDER BY CASE phase WHEN 'planned' THEN 1 WHEN 'dispatched' THEN 2 ELSE 3 END`,
    )
    .all("tenant-a", resourceUid) as Array<{ phase: string; target_json: string | null }>;
  expect(effects).toEqual([
    { phase: "planned", target_json: null },
    { phase: "dispatched", target_json: null },
    {
      phase: "cancelled",
      target_json: JSON.stringify({
        disposition: "compensated",
        schema: "takoserver.provider-apply-compensation@v1",
      }),
    },
  ]);
  const attestation = database
    .query(
      `SELECT state, closure_fence, effects_json
       FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?`,
    )
    .get("tenant-a", resourceUid) as {
    state: string;
    closure_fence: number;
    effects_json: string;
  };
  expect(attestation).toMatchObject({ state: "cancelled", closure_fence: 4 });
  expect(JSON.parse(attestation.effects_json)).toEqual([
    {
      eventId: `${operationId}:planned`,
      operationId,
      kind: "apply",
      phase: "planned",
      operationMode: "initial",
    },
    {
      eventId: `${operationId}:dispatched`,
      operationId,
      kind: "apply",
      phase: "dispatched",
      operationMode: "initial",
    },
    {
      eventId: `${operationId}:cancelled`,
      operationId,
      kind: "apply",
      phase: "cancelled",
      operationMode: "initial",
      target: {
        disposition: "compensated",
        schema: "takoserver.provider-apply-compensation@v1",
      },
    },
  ]);
  expect(
    database
      .query("SELECT COUNT(*) AS rows FROM tf_resources WHERE tenant_id = ? AND uid = ?")
      .get("tenant-a", resourceUid),
  ).toEqual({ rows: 0 });
  expect(
    database
      .query("SELECT revision FROM tf_resources WHERE tenant_id = ? AND uid = ?")
      .get("tenant-a", worker.metadata.uid),
  ).toEqual({ revision: "3" });
});

test("keeps current accepted dependencies on ordinary apply recovery", async () => {
  const fixture = await acceptedCompensationFixture();
  const terminal = await fixture.host.handle(request(`${lane}/operations/${fixture.operationId}`));
  expect(await terminal?.json()).toMatchObject({ id: fixture.operationId, done: true });
  expect(fixture.applyModes).toEqual(["initial", "recovery"]);
  expect(fixture.recoverySequence).toEqual(["no-effect:open"]);
  expect(fixture.compensationInputs).toHaveLength(0);
});

test("holds instead of compensating when accepted dependency claims are incomplete", async () => {
  const fixture = await acceptedCompensationFixture();
  fixture.database
    .query(
      `DELETE FROM tf_resource_claims WHERE claim_key = (
         SELECT claim_key FROM tf_resource_claims
         WHERE tenant_id = ? AND holder_uid = ? AND owner_operation_id = ?
           AND claim_key >= 'host-dependency:v1:' AND claim_key < 'host-dependency:v1;'
         ORDER BY claim_key LIMIT 1
       )`,
    )
    .run("tenant-a", fixture.resourceUid, fixture.operationId);

  const held = await fixture.host.handle(request(`${lane}/operations/${fixture.operationId}`));
  expect(await held?.json()).toMatchObject({ id: fixture.operationId, done: false });
  expect(fixture.applyModes).toEqual(["initial"]);
  expect(fixture.recoverySequence).toEqual(["no-effect:open"]);
  expect(fixture.compensationInputs).toHaveLength(0);
  expect(
    fixture.database
      .query("SELECT phase FROM tf_deferred_operations_selection_v1 WHERE id = ?")
      .get(fixture.operationId),
  ).toEqual({ phase: "committing" });
});

test("holds when the accepted selection is not verified by the current provider lease", async () => {
  const fixture = await acceptedCompensationFixture({ invalidateSelectionVerification: true });
  fixture.database
    .query("UPDATE tf_resources SET revision = '3' WHERE tenant_id = ? AND uid = ?")
    .run("tenant-a", fixture.worker.metadata.uid);

  const held = await fixture.host.handle(request(`${lane}/operations/${fixture.operationId}`));
  expect(await held?.json()).toMatchObject({ id: fixture.operationId, done: false });
  expect(fixture.dependencyObservation.invalidations).toBe(1);
  expect(fixture.applyModes).toEqual(["initial"]);
  expect(fixture.recoverySequence).toEqual(["no-effect:open"]);
  expect(fixture.compensationInputs).toHaveLength(0);
});

test("enters changed-dependency compensation without requiring a no-effect capability", async () => {
  const fixture = await acceptedCompensationFixture({ compensationOnly: true });
  fixture.database
    .query("UPDATE tf_resources SET revision = '3' WHERE tenant_id = ? AND uid = ?")
    .run("tenant-a", fixture.worker.metadata.uid);

  const terminal = await fixture.host.handle(request(`${lane}/operations/${fixture.operationId}`));
  expect(await terminal?.json()).toMatchObject({
    id: fixture.operationId,
    done: true,
    error: { code: "conflict", message: "the accepted create was durably compensated" },
  });
  expect(fixture.recoverySequence).toEqual(["compensate:first"]);
  expect(fixture.compensationInputs).toHaveLength(1);
  expect(fixture.applyModes).toEqual(["initial"]);
});

test("recognizes an atomically committed compensation after its Host acknowledgement is lost", async () => {
  const fixture = await acceptedCompensationFixture({
    compensationChargeMinor: 500,
    settlementFault: "lost-acknowledgement",
  });
  await fixture.ledger.fund({
    organizationId: "tenant-a",
    fundingRef: "funding:compensation-readback",
    amountMinor: 1_000,
  });
  expect(
    await fixture.ledger.hold({
      organizationId: "tenant-a",
      reference: fixture.operationId,
      amountMinor: 500,
    }),
  ).toBe(true);
  fixture.database
    .query("UPDATE tf_resources SET revision = '3' WHERE tenant_id = ? AND uid = ?")
    .run("tenant-a", fixture.worker.metadata.uid);

  const terminal = await fixture.host.handle(request(`${lane}/operations/${fixture.operationId}`));
  expect(await terminal?.json()).toMatchObject({
    id: fixture.operationId,
    done: true,
    error: { code: "conflict" },
  });
  expect(fixture.settlementObservation.faults).toBe(1);
  const wallet = await fixture.ledger.wallet("tenant-a");
  expect(wallet).toMatchObject({ settledMinor: 1_000, heldMinor: 0, availableMinor: 1_000 });
  expect(wallet.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "release",
        reference: fixture.operationId,
        heldDeltaMinor: -500,
      }),
    ]),
  );
});

test("rolls back compensation history and wallet release when its exact lease fence is lost", async () => {
  const fixture = await acceptedCompensationFixture({
    compensationChargeMinor: 500,
    settlementFault: "invalidate-lease",
  });
  await fixture.ledger.fund({
    organizationId: "tenant-a",
    fundingRef: "funding:compensation-rollback",
    amountMinor: 1_000,
  });
  expect(
    await fixture.ledger.hold({
      organizationId: "tenant-a",
      reference: fixture.operationId,
      amountMinor: 500,
    }),
  ).toBe(true);
  fixture.database
    .query("UPDATE tf_resources SET revision = '3' WHERE tenant_id = ? AND uid = ?")
    .run("tenant-a", fixture.worker.metadata.uid);

  const held = await fixture.host.handle(request(`${lane}/operations/${fixture.operationId}`));
  expect(await held?.json()).toMatchObject({ id: fixture.operationId, done: false });
  expect(fixture.settlementObservation.faults).toBe(1);
  const wallet = await fixture.ledger.wallet("tenant-a");
  expect(wallet).toMatchObject({ settledMinor: 1_000, heldMinor: 500, availableMinor: 500 });
  expect(wallet.entries).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "release", reference: fixture.operationId }),
    ]),
  );
  expect(
    fixture.database
      .query(
        `SELECT phase FROM tf_resource_provider_effects
         WHERE tenant_id = ? AND resource_uid = ? ORDER BY phase`,
      )
      .all("tenant-a", fixture.resourceUid),
  ).toEqual([{ phase: "dispatched" }, { phase: "planned" }]);
  expect(
    fixture.database
      .query(
        "SELECT state FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
      )
      .get("tenant-a", fixture.resourceUid),
  ).toEqual({ state: "live" });
  expect(
    fixture.database
      .query("SELECT phase FROM tf_deferred_operations_selection_v1 WHERE id = ?")
      .get(fixture.operationId),
  ).toEqual({ phase: "committing" });
});

test("holds a compensated create when any target ResourceDeployment appears before commit", async () => {
  const fixture = await acceptedCompensationFixture({ settlementFault: "insert-deployment" });
  fixture.database
    .query("UPDATE tf_resources SET revision = '3' WHERE tenant_id = ? AND uid = ?")
    .run("tenant-a", fixture.worker.metadata.uid);

  const held = await fixture.host.handle(request(`${lane}/operations/${fixture.operationId}`));
  expect(await held?.json()).toMatchObject({ id: fixture.operationId, done: false });
  expect(fixture.settlementObservation.faults).toBe(1);
  expect(
    fixture.database
      .query("SELECT state FROM tf_resource_deployments WHERE tenant_id = ? AND resource_uid = ?")
      .all("tenant-a", fixture.resourceUid),
  ).toEqual([{ state: "failed" }]);
  expect(
    fixture.database
      .query(
        "SELECT phase FROM tf_resource_provider_effects WHERE tenant_id = ? AND resource_uid = ? ORDER BY phase",
      )
      .all("tenant-a", fixture.resourceUid),
  ).toEqual([{ phase: "dispatched" }, { phase: "planned" }]);
  expect(
    fixture.database
      .query(
        "SELECT state FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
      )
      .get("tenant-a", fixture.resourceUid),
  ).toEqual({ state: "live" });
});

test.each([
  {
    label: "accepted runtime Binding",
    subject: cronForm,
    spec: { worker: reference(workerForm, "worker"), cron: "*/10 * * * *" },
    bindingRef: runtimeBindingRef,
  },
  {
    label: "WorkerEndpoint without a supplied reservation",
    subject: endpointForm,
    spec: { worker: reference(workerForm, "worker") },
  },
  {
    label: "a provider handle recorded after candidate routing",
    subject: cronForm,
    spec: { worker: reference(workerForm, "worker"), cron: "*/15 * * * *" },
    raceHandle: true,
  },
])(
  "falls back to ordinary recovery for $label",
  async ({ subject, spec, bindingRef, raceHandle }) => {
    const database = new Database(":memory:");
    databases.push(database);
    migrateSqlite(database);
    const durableSql = createSqliteSql(database);
    let racedOperationId: string | undefined;
    let handleRaceInjected = false;
    const sql: Sql = {
      ...durableSql,
      async query(statement, params) {
        const rows = await durableSql.query(statement, params);
        if (
          raceHandle &&
          !handleRaceInjected &&
          racedOperationId !== undefined &&
          params?.[0] === racedOperationId &&
          statement.includes("SELECT 1 AS candidate") &&
          rows.length === 1
        ) {
          await durableSql.run(
            `UPDATE tf_provider_mutation_sagas_selection_v1
           SET provider_handle = 'late-provider-handle', provider_outcome = 'running'
           WHERE operation_id = ?`,
            [racedOperationId],
          );
          handleRaceInjected = true;
        }
        return rows;
      },
    };
    const memory = new InMemoryTakoformResourceDriver();
    const applyModes: Array<"initial" | "recovery" | undefined> = [];
    const providerHandles: Array<string | undefined> = [];
    let conclusionCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: async (input) => ({
        version: TAKOFORM_APPLY_SELECTION_VERSION,
        kind: "provider",
        providerPackRef: "accepted-provider",
        providerInstallationRef: "accepted-provider.primary",
        technicalOffering: {
          id: `accepted-${input.form.identity.formRef.kind}`,
          kind: `takoform.${input.form.identity.formRef.kind}`,
          displayName: input.form.identity.formRef.kind,
          form: structuredClone(input.form.identity.formRef),
          capabilities: ["create", "update", "delete", "observe"],
          providedInterfaces: [],
          bindingRefs: bindingRef ? [bindingRef] : [],
        },
        relations: input.relations.map((relation) => ({
          pointer: relation.pointer,
          relation: relation.relation,
          targetUid: relation.targetUid,
          resource: {
            apiVersion: relation.resource.apiVersion,
            kind: relation.resource.kind,
            formRef: structuredClone(relation.resource.form.formRef),
            name: relation.resource.metadata.name,
            space: relation.resource.metadata.space,
            uid: relation.resource.metadata.uid,
            generation: relation.resource.metadata.generation,
            revision: relation.resource.metadata.revision,
          },
          ...(bindingRef ? { bindingRef } : {}),
        })),
      }),
      async apply(input) {
        if (input.form.identity.formRef.kind === subject.identity.formRef.kind) {
          applyModes.push(input.operationMode);
          providerHandles.push(input.providerHandle);
          if (input.operationMode !== "recovery") {
            throw new ProviderMutationRecoveryError("indeterminate");
          }
          return { observed: {} };
        }
        return await memory.apply(input);
      },
      async concludeApplyNoEffect() {
        conclusionCalls += 1;
        throw new ProviderMutationWholeOperationRefusalError(
          "conflict",
          409,
          "provider-only no-effect proof",
          { action: "concludeApplyNoEffect" },
        );
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    let ids = 0;
    const host = createConfiguredHistoricalTakoformHost({
      sql,
      objects: createMemoryObjectStore(),
      forms,
      driver,
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
      routes: {
        hostApiVersion: "forms.takoform.com/v1beta4",
        apiPath: lane,
        supportProfileApiVersion: "support.takoform.com/v1alpha2",
        reviewSpecDigest: true,
      },
      deferredOperations: {
        shouldDefer: ({ request }) => request.headers.get("takoform-conformance-probe") === "async",
        pollsBeforeCommit: 1,
        executeOnAccept: true,
        retryAfterSeconds: 0,
        leaseMilliseconds: 1_000,
      },
      randomId: () => `fallback-${++ids}`,
    });

    await create(host, workerForm, "worker", {});
    await create(host, versionForm, "version", {
      worker: reference(workerForm, "worker"),
      handlers: ["fetch", "scheduled"],
    });
    await create(host, deploymentForm, "deployment", {
      worker: reference(workerForm, "worker"),
      versions: [{ workerVersion: reference(versionForm, "version"), weight: 10_000 }],
    });
    const desired = desiredResource(subject, "subject", spec);
    const review = await prepare(host, desired);
    const accepted = await host.handle(
      request(resourcePath(subject, "subject"), {
        method: "PUT",
        headers: {
          "idempotency-key": `fallback-${kindKey(subject)}-0001`,
          "if-none-match": "*",
          "takoform-conformance-probe": "async",
        },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("fallback create returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    racedOperationId = operationId;

    const terminal = await host.handle(request(`${lane}/operations/${operationId}`));
    expect(await terminal?.json()).toMatchObject({ id: operationId, done: true });
    expect(applyModes).toEqual(["initial", "recovery"]);
    expect(providerHandles).toEqual([undefined, raceHandle ? "late-provider-handle" : undefined]);
    expect(handleRaceInjected).toBe(Boolean(raceHandle));
    expect(conclusionCalls).toBe(0);
  },
);

async function acceptedCompensationFixture(
  options: {
    readonly compensationChargeMinor?: number;
    readonly compensationOnly?: boolean;
    readonly invalidateSelectionVerification?: boolean;
    readonly loseFirstAcknowledgement?: boolean;
    readonly settlementFault?: "insert-deployment" | "invalidate-lease" | "lost-acknowledgement";
  } = {},
) {
  const database = new Database(":memory:");
  databases.push(database);
  migrateSqlite(database);
  const durableSql = createSqliteSql(database);
  const settlementObservation = { faults: 0 };
  const dependencyObservation = { invalidations: 0 };
  const sql: Sql = {
    ...durableSql,
    async query(statement, params) {
      if (
        options.invalidateSelectionVerification &&
        dependencyObservation.invalidations === 0 &&
        statement.includes("SELECT selection_json, target_space")
      ) {
        dependencyObservation.invalidations += 1;
        await durableSql.run(
          `UPDATE tf_provider_mutation_sagas_selection_v1
           SET selection_verified_lease_token = 'stale-selection-verification'
           WHERE provider_outcome = 'indeterminate' AND execution_lease_token IS NOT NULL`,
        );
      }
      return await durableSql.query(statement, params);
    },
    async batch(statements) {
      const compensationCommit = statements.some((statement) =>
        statement.sql.includes("SET state = 'cancelled'"),
      );
      if (
        compensationCommit &&
        settlementObservation.faults === 0 &&
        options.settlementFault === "invalidate-lease"
      ) {
        settlementObservation.faults += 1;
        await durableSql.run(
          `UPDATE tf_provider_mutation_sagas_selection_v1
           SET execution_lease_token = 'invalidated-compensation-lease'
          WHERE provider_outcome = 'indeterminate' AND execution_lease_token IS NOT NULL`,
        );
      }
      if (
        compensationCommit &&
        settlementObservation.faults === 0 &&
        options.settlementFault === "insert-deployment"
      ) {
        settlementObservation.faults += 1;
        await durableSql.run(
          `INSERT INTO tf_resource_deployments
             (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
              provider_installation_ref, native_id, native_claimed, state,
              observed_json, outputs_json, created_at, updated_at)
           SELECT tenant_id, 'dep_compensation_race', resource_uid, 'offering.compensation-race',
                  'provider-race', 'provider-race.primary', 'native:compensation-race', 0,
                  'failed', '{}', '{}', 1, 1
           FROM tf_provider_mutation_sagas_selection_v1
           WHERE provider_outcome = 'indeterminate' AND execution_lease_token IS NOT NULL`,
        );
      }
      const result = await durableSql.batch(statements);
      if (
        compensationCommit &&
        settlementObservation.faults === 0 &&
        options.settlementFault === "lost-acknowledgement"
      ) {
        settlementObservation.faults += 1;
        throw new Error("compensation commit acknowledgement lost");
      }
      return result;
    },
  };
  const ledger = createLedger(durableSql, () => new Date("2026-09-23T00:00:00.000Z"));
  const memory = new InMemoryTakoformResourceDriver();
  const applyModes: Array<"initial" | "recovery" | undefined> = [];
  const recoverySequence: string[] = [];
  const compensationInputs: Array<
    Parameters<NonNullable<TakoformResourceDriver["compensateApply"]>>[0]
  > = [];
  let compensationPersisted = false;
  const driver: TakoformResourceDriver = {
    ...memory,
    selectApply: async (input) => ({
      version: TAKOFORM_APPLY_SELECTION_VERSION,
      kind: "provider",
      providerPackRef: "accepted-provider",
      providerInstallationRef: "accepted-provider.primary",
      technicalOffering: {
        id: `accepted-${input.form.identity.formRef.kind}`,
        kind: `takoform.${input.form.identity.formRef.kind}`,
        displayName: input.form.identity.formRef.kind,
        form: structuredClone(input.form.identity.formRef),
        capabilities: ["create", "update", "delete", "observe"],
        providedInterfaces: [],
        bindingRefs: [],
      },
      relations: input.relations.map((relation) => ({
        pointer: relation.pointer,
        relation: relation.relation,
        targetUid: relation.targetUid,
        resource: {
          apiVersion: relation.resource.apiVersion,
          kind: relation.resource.kind,
          formRef: structuredClone(relation.resource.form.formRef),
          name: relation.resource.metadata.name,
          space: relation.resource.metadata.space,
          uid: relation.resource.metadata.uid,
          generation: relation.resource.metadata.generation,
          revision: relation.resource.metadata.revision,
        },
      })),
    }),
    async apply(input) {
      if (input.form.identity.formRef.kind === "WorkerCronTrigger") {
        applyModes.push(input.operationMode);
        if (input.operationMode !== "recovery") {
          throw new ProviderMutationRecoveryError("indeterminate");
        }
        return { observed: {} };
      }
      return await memory.apply(input);
    },
    ...(options.compensationOnly
      ? {}
      : {
          async concludeApplyNoEffect() {
            recoverySequence.push(`no-effect:${compensationPersisted ? "compensated" : "open"}`);
            throw new ProviderApplyNoEffectUnsupportedError();
          },
        }),
    async compensateApply(input) {
      compensationInputs.push(structuredClone(input));
      if (options.loseFirstAcknowledgement && !compensationPersisted) {
        compensationPersisted = true;
        recoverySequence.push("compensate:first");
        throw new ProviderMutationRecoveryError("indeterminate");
      }
      recoverySequence.push(compensationPersisted ? "compensate:replay" : "compensate:first");
      compensationPersisted = true;
      throw new ProviderMutationCompensatedFailureError(
        "conflict",
        409,
        "the accepted create was durably compensated",
        options.compensationChargeMinor
          ? {
              heldCharge: {
                reference: input.operationId,
                amountMinor: options.compensationChargeMinor,
              },
            }
          : undefined,
      );
    },
    observe: (input) => memory.observe(input),
    delete: (input) => memory.delete(input),
  };
  let ids = 0;
  const host = createConfiguredHistoricalTakoformHost({
    sql,
    objects: createMemoryObjectStore(),
    forms,
    driver,
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    routes: {
      hostApiVersion: "forms.takoform.com/v1beta4",
      apiPath: lane,
      supportProfileApiVersion: "support.takoform.com/v1alpha2",
      reviewSpecDigest: true,
    },
    deferredOperations: {
      shouldDefer: ({ request }) => request.headers.get("takoform-conformance-probe") === "async",
      pollsBeforeCommit: 1,
      executeOnAccept: true,
      retryAfterSeconds: 0,
      leaseMilliseconds: 1_000,
    },
    randomId: () => `compensation-${++ids}`,
  });

  const worker = await create(host, workerForm, "worker", {});
  await create(host, versionForm, "version", {
    worker: reference(workerForm, "worker"),
    handlers: ["fetch", "scheduled"],
  });
  const deployment = await create(host, deploymentForm, "deployment", {
    worker: reference(workerForm, "worker"),
    versions: [{ workerVersion: reference(versionForm, "version"), weight: 10_000 }],
  });
  const desired = desiredResource(cronForm, "compensated-schedule", {
    worker: reference(workerForm, "worker"),
    cron: "*/20 * * * *",
  });
  const review = await prepare(host, desired);
  const accepted = await host.handle(
    request(resourcePath(cronForm, "compensated-schedule"), {
      method: "PUT",
      headers: {
        "idempotency-key": `accepted-cron-compensation-${ids}`,
        "if-none-match": "*",
        "takoform-conformance-probe": "async",
      },
      body: JSON.stringify({ ...desired, review }),
    }),
  );
  expect(accepted?.status).toBe(202);
  if (!accepted) throw new Error("accepted compensation create returned no response");
  const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
  const saga = database
    .query(
      `SELECT resource_uid, provider_handle, provider_outcome, receipt_json
       FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
    )
    .get(operationId) as {
    resource_uid: string;
    provider_handle: string | null;
    provider_outcome: string;
    receipt_json: string | null;
  };
  expect(saga).toMatchObject({
    provider_handle: null,
    provider_outcome: "indeterminate",
    receipt_json: null,
  });
  return {
    database,
    host,
    worker,
    deployment,
    operationId,
    resourceUid: saga.resource_uid,
    applyModes,
    recoverySequence,
    compensationInputs,
    ledger,
    dependencyObservation,
    settlementObservation,
  };
}

function installedForm(
  kind: string,
  digestCharacter: string,
  role: NonNullable<InstalledTakoformForm["role"]>,
  desiredSchema: InstalledTakoformForm["desiredSchema"],
): InstalledTakoformForm {
  return {
    identity: {
      formRef: {
        apiVersion: edgeApiVersion,
        kind,
        definitionVersion: "0.1.0",
        schemaDigest: `sha256:${digestCharacter.repeat(64)}`,
      },
      implementationDigest: `sha256:${digestCharacter.repeat(64)}`,
    },
    role,
    desiredSchema,
    operations:
      role === "revision" || role === "attachment"
        ? ["create", "read", "delete"]
        : ["create", "read", "update", "delete"],
  };
}

function referenceSchema(target: InstalledTakoformForm): InstalledTakoformForm["desiredSchema"] {
  return {
    type: "object",
    required: ["apiVersion", "kind", "name"],
    additionalProperties: false,
    properties: {
      apiVersion: { const: target.identity.formRef.apiVersion },
      kind: { const: target.identity.formRef.kind },
      name: { type: "string" },
    },
    "x-takoform-target-formrefs": [
      {
        apiVersion: target.identity.formRef.apiVersion,
        kind: target.identity.formRef.kind,
        definitionVersion: target.identity.formRef.definitionVersion,
        schemaDigest: target.identity.formRef.schemaDigest,
      },
    ],
  };
}

function reference(target: InstalledTakoformForm, name: string) {
  return {
    apiVersion: target.identity.formRef.apiVersion,
    kind: target.identity.formRef.kind,
    name,
  };
}

function desiredResource(form: InstalledTakoformForm, name: string, spec: object) {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name, space: "main" },
    spec,
  };
}

function resourcePath(form: InstalledTakoformForm, name: string): string {
  return `${lane}/resources/${form.identity.formRef.apiVersion}/${form.identity.formRef.kind}/${name}`;
}

async function prepare(
  host: { handle(request: Request): Promise<Response | null> },
  desired: ReturnType<typeof desiredResource>,
): Promise<Record<string, string>> {
  const response = await host.handle(
    request(`${lane}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
  );
  if (!response?.ok) throw new Error(`prepare failed: ${response?.status}`);
  return ((await response.json()) as { review: Record<string, string> }).review;
}

async function create(
  host: { handle(request: Request): Promise<Response | null> },
  form: InstalledTakoformForm,
  name: string,
  spec: object,
): Promise<TakoformStoredResource> {
  const desired = desiredResource(form, name, spec);
  const review = await prepare(host, desired);
  const response = await host.handle(
    request(resourcePath(form, name), {
      method: "PUT",
      headers: { "idempotency-key": `create-${kindKey(form)}-${name}`, "if-none-match": "*" },
      body: JSON.stringify({ ...desired, review }),
    }),
  );
  if (response?.status !== 201) throw new Error(`create failed: ${response?.status}`);
  return (await response.json()) as TakoformStoredResource;
}

function kindKey(form: InstalledTakoformForm): string {
  return form.identity.formRef.kind.toLowerCase();
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer test");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://host.invalid${path}`, { ...init, headers });
}
