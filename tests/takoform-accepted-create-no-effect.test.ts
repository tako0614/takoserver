import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql } from "../src/ports.ts";
import {
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
