import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createInMemoryTakoformHost,
  createMemoryObjectStore,
  createTakoformHost,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  InMemoryTakoformResourceDriver,
  type InstalledTakoformBinding,
  type InstalledTakoformForm,
  TAKOFORM_EDGE_OBJECTS_INTERFACE,
  TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM,
  TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM,
  type TakoformHost,
  type TakoformResourceDriver,
} from "../src/index.ts";

const OWNER_IDENTITY: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
  },
};

const SETTLEMENT: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "settlement_1", amountMinor: 100_000, currency: "USD" };
  },
};

/** Serves one Takoform Host through the real router and control plane. */
function handlerFor(
  takoformHost: TakoformHost,
  identity: ExternalIdentityVerifier = OWNER_IDENTITY,
) {
  return buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity,
    settlement: SETTLEMENT,
    publicOrigin: "https://api.takoserver.com",
    forms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    takoformHost,
  }).fetch;
}

describe("Takoserver current Takoform Host", () => {
  test("refuses provider deletion while a logical Attachment still references the Resource", async () => {
    const formRef = {
      apiVersion: "data.resources.takoform.com/v1alpha1",
      kind: "SqliteDatabase",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"b".repeat(64)}` as const,
    };
    const host = createInMemoryTakoformHost({
      authenticate: async () => ({ tenantId: "organization-a", principalId: "provider-key" }),
      forms: [
        {
          identity: { formRef },
          desiredSchema: { type: "object", properties: {}, additionalProperties: false },
          operations: ["create", "read", "delete"],
        },
      ],
      blockingRelations: async (_tenantId, resourceUid) =>
        resourceUid.length > 0 ? ["att_api_main_db"] : [],
    });
    const handler = handlerFor(host);
    const auth = { authorization: "Bearer provider-key" };
    const resource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "main", space: "production" },
      spec: {},
    };
    const prepared = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      resource,
      auth,
    );
    const prepareDigest = requiredString(requiredRecord(prepared.body, "review"), "prepareDigest");
    const created = await jsonRequest(
      handler,
      "PUT",
      "/apis/forms.takoform.com/v1alpha3/resources/data.resources.takoform.com/v1alpha1/SqliteDatabase/main",
      { ...resource, review: { prepareDigest } },
      { ...auth, "idempotency-key": "create-sqlite-main-001", "if-none-match": "*" },
    );
    expect(created.status).toBe(201);

    const query = new URLSearchParams({
      space: "production",
      group: formRef.apiVersion,
      kind: formRef.kind,
      definitionVersion: formRef.definitionVersion,
      schemaDigest: formRef.schemaDigest,
    });
    const deleted = await jsonRequest(
      handler,
      "DELETE",
      `/apis/forms.takoform.com/v1alpha3/resources/data.resources.takoform.com/v1alpha1/SqliteDatabase/main?${query}`,
      undefined,
      {
        ...auth,
        "idempotency-key": "delete-sqlite-main-001",
        "takoform-expected-generation": "1",
      },
    );
    expect(deleted.status).toBe(409);
    expect(deleted.body).toMatchObject({ error: { code: "dependency_in_use" } });
  });

  test("serves the exact ObjectBucket Form used by released provider v2.1.1", async () => {
    const { packageDigest: _packageDigest, ...formRef } = TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM;
    const host = createInMemoryTakoformHost({
      authenticate: async (authorization) =>
        authorization === "Bearer provider-v2.1.1"
          ? { tenantId: "organization-a", principalId: "provider-key" }
          : null,
      forms: [TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM],
    });
    const handler = handlerFor(host);

    const discovery = await handler(
      new Request("https://api.takoserver.com/.well-known/takoform/v1beta1"),
    );
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      api_versions: ["forms.takoform.com/v1beta1"],
      endpoints: { api: "https://api.takoserver.com/apis/forms.takoform.com/v1beta1" },
    });

    const query = new URLSearchParams({
      space: "provider-space",
      group: formRef.apiVersion,
      kind: formRef.kind,
      definitionVersion: formRef.definitionVersion,
      schemaDigest: formRef.schemaDigest,
    });
    const forms = await handler(
      new Request(`https://api.takoserver.com/apis/forms.takoform.com/v1beta1/forms?${query}`, {
        headers: { authorization: "Bearer provider-v2.1.1" },
      }),
    );
    expect(forms.status).toBe(200);
    expect(await forms.json()).toMatchObject({
      forms: [{ identity: { formRef }, installed: true, executable: true }],
    });
    const definition = await handler(
      new Request(
        `https://api.takoserver.com/apis/forms.takoform.com/v1beta1/form-definitions/${formRef.apiVersion}/${formRef.kind}?space=provider-space&group=${encodeURIComponent(formRef.apiVersion)}&kind=${formRef.kind}&definitionVersion=${formRef.definitionVersion}&schemaDigest=${encodeURIComponent(formRef.schemaDigest)}`,
        { headers: { authorization: "Bearer provider-v2.1.1" } },
      ),
    );
    expect(definition.status).toBe(200);
    const definitionBody = (await definition.json()) as Record<string, unknown>;
    expect(definitionBody).toMatchObject({ identity: { formRef } });
    expect(Object.keys(definitionBody).sort()).toEqual([
      "description",
      "desiredSchema",
      "displayName",
      "identity",
    ]);
    const interfaceSupport = await handler(
      new Request(
        "https://api.takoserver.com/apis/forms.takoform.com/v1beta1/support/interfaces/edge.objects/1.0.0",
        { headers: { authorization: "Bearer provider-v2.1.1" } },
      ),
    );
    expect(interfaceSupport.status).toBe(200);
    expect(await interfaceSupport.json()).toEqual({
      apiVersion: "support.takoform.com/v1alpha1",
      kind: "InterfaceSupport",
      interfaceRef: TAKOFORM_EDGE_OBJECTS_INTERFACE,
    });
  });

  test("serves installed Binding and target Interface support without inventing a provider Form", async () => {
    const targetInterface = TAKOFORM_EDGE_OBJECTS_INTERFACE;
    const binding: InstalledTakoformBinding = {
      bindingRef: {
        apiVersion: "bindings.takoform.com/v1alpha1",
        name: "module-worker.object-bucket",
        version: "1.0.0",
        schemaDigest: `sha256:${"9".repeat(64)}`,
      },
      sourceRole: "revision",
      targetInterface,
      allowedTargetForms: [
        { apiVersion: "edge.forms.takoform.com/v1alpha1", kind: "ObjectBucket" },
      ],
    };
    const host = createInMemoryTakoformHost({
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
      forms: [],
      bindings: [binding],
    });
    const handler = handlerFor(host);
    const auth = { headers: { authorization: "Bearer primary" } };
    const bindingSupport = await handler(
      new Request(
        "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/support/bindings/module-worker.object-bucket/1.0.0",
        auth,
      ),
    );
    expect(bindingSupport.status).toBe(200);
    expect(await bindingSupport.json()).toEqual({
      apiVersion: "support.takoform.com/v1alpha1",
      kind: "BindingSupport",
      bindingRef: binding.bindingRef,
    });
    const interfaceSupport = await handler(
      new Request(
        "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/support/interfaces/edge.objects/1.0.0",
        auth,
      ),
    );
    expect(interfaceSupport.status).toBe(200);
    expect(await interfaceSupport.json()).toEqual({
      apiVersion: "support.takoform.com/v1alpha1",
      kind: "InterfaceSupport",
      interfaceRef: targetInterface,
    });
  });

  test("rejects two schema digests for the same installed Form definition", () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "EdgeObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"1".repeat(64)}` as const,
    };
    expect(() =>
      createInMemoryTakoformHost({
        authenticate: async () => null,
        forms: [
          {
            identity: { formRef },
            desiredSchema: { type: "object" },
            operations: ["create", "read", "delete"],
          },
          {
            identity: {
              formRef: { ...formRef, schemaDigest: `sha256:${"2".repeat(64)}` },
            },
            desiredSchema: { type: "object" },
            operations: ["create", "read", "delete"],
          },
        ],
      }),
    ).toThrow("ambiguous installed Form definition");
  });

  test("checks an existing-resource create fence before update capability", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "ModuleWorker",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"7".repeat(64)}` as const,
    };
    const host = createInMemoryTakoformHost({
      authenticate: async (authorization) =>
        authorization === "Bearer primary" || authorization === "Bearer alternate"
          ? {
              tenantId: "tenant-a",
              principalId: authorization === "Bearer primary" ? "primary" : "alternate",
            }
          : null,
      forms: [
        {
          identity: { formRef },
          desiredSchema: { type: "object", properties: {}, additionalProperties: false },
          operations: ["create", "read", "delete", "import", "observe"],
        },
      ],
    });
    const handler = handlerFor(host);
    const resource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "worker", space: "conformance" },
      spec: {},
    };
    const prepared = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      resource,
      { authorization: "Bearer primary" },
    );
    const prepareDigest = requiredString(requiredRecord(prepared.body, "review"), "prepareDigest");
    const target =
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/ModuleWorker/worker";
    const created = await jsonRequest(
      handler,
      "PUT",
      target,
      { ...resource, review: { prepareDigest } },
      {
        authorization: "Bearer primary",
        "idempotency-key": "create-worker",
        "if-none-match": "*",
      },
    );
    expect(created.status).toBe(201);
    const collision = await jsonRequest(
      handler,
      "PUT",
      target,
      { ...resource, review: { prepareDigest } },
      {
        authorization: "Bearer alternate",
        "idempotency-key": "create-worker",
        "if-none-match": "*",
      },
    );
    expect(collision.status).toBe(412);
    expect(collision.body).toMatchObject({ error: { code: "generation_conflict" } });
  });

  test("rejects an in-place revision-role update as invalid desired state", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "WorkerVersion",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"c".repeat(64)}` as const,
    };
    const host = createInMemoryTakoformHost({
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "primary" }),
      forms: [
        {
          identity: { formRef },
          role: "revision",
          desiredSchema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            additionalProperties: false,
          },
          operations: ["create", "read", "delete", "observe"],
        },
      ],
    });
    const handler = handlerFor(host);
    const auth = { authorization: "Bearer primary" };
    const path =
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/WorkerVersion/revision";
    const initial = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "revision", space: "conformance" },
      spec: { label: "one" },
    };
    const firstPrepare = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      initial,
      auth,
    );
    const firstDigest = requiredString(
      requiredRecord(firstPrepare.body, "review"),
      "prepareDigest",
    );
    expect(
      (
        await jsonRequest(
          handler,
          "PUT",
          path,
          { ...initial, review: { prepareDigest: firstDigest } },
          { ...auth, "idempotency-key": "create-revision", "if-none-match": "*" },
        )
      ).status,
    ).toBe(201);
    const changed = { ...initial, spec: { label: "two" } };
    const updatePrepare = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      changed,
      { ...auth, "takoform-expected-generation": "1" },
    );
    const updateDigest = requiredString(
      requiredRecord(updatePrepare.body, "review"),
      "prepareDigest",
    );
    const rejected = await jsonRequest(
      handler,
      "PUT",
      path,
      { ...changed, expectedGeneration: "1", review: { prepareDigest: updateDigest } },
      { ...auth, "idempotency-key": "update-revision", "takoform-expected-generation": "1" },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: { code: "invalid_argument" } });
  });

  test("pins same-space relation targets before mutation and blocks target deletion", async () => {
    const targetFormRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "ModuleWorker",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"a".repeat(64)}` as const,
    };
    const sourceFormRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "WorkerDeployment",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"b".repeat(64)}` as const,
    };
    const memory = new InMemoryTakoformResourceDriver();
    const sql = createEphemeralSql();
    let sourceMutations = 0;
    let resolvedTargetUid: string | undefined;
    const driver: TakoformResourceDriver = {
      async apply(input) {
        if (input.form.identity.formRef.kind === sourceFormRef.kind) {
          sourceMutations += 1;
          expect(input.relations).toHaveLength(1);
          expect(input.relations[0]?.resource.metadata.uid).toBe(input.relations[0]?.targetUid);
          resolvedTargetUid = input.relations[0]?.targetUid;
        }
        return memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
      import: (input) => memory.import(input),
    };
    const referenceSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        apiVersion: { const: targetFormRef.apiVersion },
        kind: { const: targetFormRef.kind },
        name: { type: "string" },
      },
      required: ["apiVersion", "kind", "name"],
      "x-takoform-target-formrefs": [targetFormRef],
    } as const;
    const host = createTakoformHost({
      sql,
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "primary" }),
      forms: [
        {
          identity: { formRef: targetFormRef },
          desiredSchema: { type: "object", properties: {}, additionalProperties: false },
          operations: ["create", "read", "update", "delete", "observe"],
        },
        {
          identity: { formRef: sourceFormRef },
          desiredSchema: {
            type: "object",
            properties: { worker: referenceSchema },
            required: ["worker"],
            additionalProperties: false,
          },
          operations: ["create", "read", "update", "delete", "observe"],
        },
      ],
      driver,
    });
    const handler = handlerFor(host);
    const auth = { authorization: "Bearer primary" };
    const source = {
      apiVersion: sourceFormRef.apiVersion,
      kind: sourceFormRef.kind,
      form: { formRef: sourceFormRef },
      metadata: { name: "deployment", space: "conformance" },
      spec: {
        worker: {
          apiVersion: targetFormRef.apiVersion,
          kind: targetFormRef.kind,
          name: "absent-worker",
        },
      },
    };
    const sourcePrepared = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      source,
      auth,
    );
    const sourcePrepareDigest = requiredString(
      requiredRecord(sourcePrepared.body, "review"),
      "prepareDigest",
    );
    const sourcePath =
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/WorkerDeployment/deployment";
    const missing = await jsonRequest(
      handler,
      "PUT",
      sourcePath,
      { ...source, review: { prepareDigest: sourcePrepareDigest } },
      { ...auth, "idempotency-key": "create-deployment", "if-none-match": "*" },
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "resource_not_found" } });
    expect(sourceMutations).toBe(0);

    const target = {
      apiVersion: targetFormRef.apiVersion,
      kind: targetFormRef.kind,
      form: { formRef: targetFormRef },
      metadata: { name: "absent-worker", space: "conformance" },
      spec: {},
    };
    const targetPrepared = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      target,
      auth,
    );
    const targetPrepareDigest = requiredString(
      requiredRecord(targetPrepared.body, "review"),
      "prepareDigest",
    );
    const targetPath =
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/ModuleWorker/absent-worker";
    const createdTarget = await jsonRequest(
      handler,
      "PUT",
      targetPath,
      { ...target, review: { prepareDigest: targetPrepareDigest } },
      { ...auth, "idempotency-key": "create-worker", "if-none-match": "*" },
    );
    expect(createdTarget.status).toBe(201);
    const oldTargetUid = requiredString(requiredRecord(createdTarget.body, "metadata"), "uid");
    expect(
      (
        await jsonRequest(
          handler,
          "PUT",
          sourcePath,
          { ...source, review: { prepareDigest: sourcePrepareDigest } },
          { ...auth, "idempotency-key": "create-deployment", "if-none-match": "*" },
        )
      ).status,
    ).toBe(201);
    expect(sourceMutations).toBe(1);
    expect(resolvedTargetUid).toBe(oldTargetUid);

    const targetQuery = new URLSearchParams({
      space: "conformance",
      group: targetFormRef.apiVersion,
      kind: targetFormRef.kind,
      definitionVersion: targetFormRef.definitionVersion,
      schemaDigest: targetFormRef.schemaDigest,
    });
    const blocked = await jsonRequest(
      handler,
      "DELETE",
      `${targetPath}?${targetQuery}`,
      undefined,
      {
        ...auth,
        "idempotency-key": "delete-worker",
        "takoform-expected-generation": "1",
      },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: { code: "dependency_in_use" } });

    expect(
      (
        await sql.run(
          `DELETE FROM tf_resources
           WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?`,
          [
            "tenant-a",
            "conformance",
            targetFormRef.apiVersion,
            targetFormRef.kind,
            "absent-worker",
          ],
        )
      ).changes,
    ).toBe(1);
    const sourceQuery = new URLSearchParams({
      space: "conformance",
      group: sourceFormRef.apiVersion,
      kind: sourceFormRef.kind,
      definitionVersion: sourceFormRef.definitionVersion,
      schemaDigest: sourceFormRef.schemaDigest,
    });
    const missingRead = await jsonRequest(
      handler,
      "GET",
      `${sourcePath}?${sourceQuery}`,
      undefined,
      auth,
    );
    expect(missingRead.body).toMatchObject({
      metadata: { generation: "1", revision: "2" },
      status: {
        conditions: [{ status: "False", reason: "DependencyMissing" }],
      },
    });

    const recreatedPrepare = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      target,
      auth,
    );
    const recreatedDigest = requiredString(
      requiredRecord(recreatedPrepare.body, "review"),
      "prepareDigest",
    );
    const recreatedTarget = await jsonRequest(
      handler,
      "PUT",
      targetPath,
      { ...target, review: { prepareDigest: recreatedDigest } },
      { ...auth, "idempotency-key": "recreate-worker", "if-none-match": "*" },
    );
    expect(recreatedTarget.status).toBe(201);
    const newTargetUid = requiredString(requiredRecord(recreatedTarget.body, "metadata"), "uid");
    expect(newTargetUid).not.toBe(oldTargetUid);
    const changedRead = await jsonRequest(
      handler,
      "GET",
      `${sourcePath}?${sourceQuery}`,
      undefined,
      auth,
    );
    expect(changedRead.body).toMatchObject({
      metadata: { generation: "1", revision: "3" },
      status: {
        conditions: [
          {
            status: "False",
            reason: "ExternalChange",
          },
        ],
      },
    });
    const changedConditions = requiredRecord(changedRead.body, "status").conditions;
    expect(Array.isArray(changedConditions)).toBeTrue();
    const changedCondition = (changedConditions as Record<string, unknown>[])[0] ?? {};
    const hostReason = requiredString(changedCondition, "hostReason");
    expect(hostReason).toContain(oldTargetUid);
    expect(hostReason).toContain(newTargetUid);
  });

  test("records a provider status transition without moving desired generation", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "EdgeKVNamespace",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"6".repeat(64)}` as const,
    };
    const memory = new InMemoryTakoformResourceDriver();
    const driver: TakoformResourceDriver = {
      apply: (input) => memory.apply(input),
      import: (input) => memory.import(input),
      delete: (input) => memory.delete(input),
      async observe(input) {
        return {
          ...(await memory.observe(input)),
          conditions: [
            {
              type: "Ready",
              status: "True",
              reason: "Available",
              lastTransitionTime: "2026-08-19T00:00:01.000Z",
              message: "provider status refreshed",
            },
          ],
        };
      },
    };
    const host = createTakoformHost({
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "primary" }),
      forms: [
        {
          identity: { formRef },
          desiredSchema: { type: "object", properties: {}, additionalProperties: false },
          operations: ["create", "read", "delete", "import", "observe"],
        },
      ],
      driver,
      clock: () => new Date("2026-08-19T00:00:00.000Z"),
    });
    const handler = handlerFor(host);
    const resource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "queue", space: "conformance" },
      spec: {},
    };
    const prepared = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      resource,
      { authorization: "Bearer primary" },
    );
    const prepareDigest = requiredString(requiredRecord(prepared.body, "review"), "prepareDigest");
    const target =
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeKVNamespace/queue";
    const created = await jsonRequest(
      handler,
      "PUT",
      target,
      { ...resource, review: { prepareDigest } },
      {
        authorization: "Bearer primary",
        "idempotency-key": "create-queue",
        "if-none-match": "*",
      },
    );
    expect(created.body).toMatchObject({ metadata: { generation: "1", revision: "1" } });
    const observed = await jsonRequest(
      handler,
      "POST",
      `${target}/observe?space=conformance&group=${encodeURIComponent(formRef.apiVersion)}&kind=${formRef.kind}&definitionVersion=${formRef.definitionVersion}&schemaDigest=${encodeURIComponent(formRef.schemaDigest)}`,
      undefined,
      {
        authorization: "Bearer primary",
        "idempotency-key": "observe-queue",
        "takoform-expected-generation": "1",
      },
    );
    expect(observed.status).toBe(200);
    expect(requiredRecord(observed.body, "resource")).toMatchObject({
      metadata: { generation: "1", revision: "2" },
      status: { conditions: [{ message: "provider status refreshed" }] },
    });
  });

  test("distinguishes a held manifest of the wrong artifact kind from a missing artifact", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "WorkerBundle",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"5".repeat(64)}` as const,
    };
    const manifestDigest = `sha256:${"4".repeat(64)}` as const;
    const host = createTakoformHost({
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "primary" }),
      forms: [
        {
          identity: { formRef },
          desiredSchema: {
            type: "object",
            properties: { manifestDigest: { type: "string" } },
            required: ["manifestDigest"],
            additionalProperties: false,
          },
          artifactRequirement: { specField: "manifestDigest", kind: "WorkerBundle" },
          operations: ["create", "read", "delete", "import", "observe"],
        },
      ],
      driver: new InMemoryTakoformResourceDriver(),
      artifacts: {
        async handle() {
          return null;
        },
        async resolveManifest() {
          return {
            apiVersion: "artifacts.takoform.com/v1alpha1",
            kind: "StaticAssetBundle",
            files: [],
          };
        },
        async resolveBlob() {
          return null;
        },
      },
    });
    const handler = handlerFor(host);
    const resource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "bundle", space: "conformance" },
      spec: { manifestDigest },
    };
    const prepared = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      resource,
      { authorization: "Bearer primary" },
    );
    expect(prepared.status).toBe(200);
    const prepareDigest = requiredString(requiredRecord(prepared.body, "review"), "prepareDigest");
    const applied = await jsonRequest(
      handler,
      "PUT",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/WorkerBundle/bundle",
      { ...resource, review: { prepareDigest } },
      {
        authorization: "Bearer primary",
        "idempotency-key": "apply-wrong-kind",
        "if-none-match": "*",
      },
    );
    expect(applied.status).toBe(400);
    expect(applied.body).toMatchObject({ error: { code: "artifact_invalid" } });
  });

  test("keeps the current versioned v1alpha3 discovery contract beside the released lane", async () => {
    const identity: ExternalIdentityVerifier = {
      async verify() {
        return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
      },
    };
    const handler = handlerFor(
      createInMemoryTakoformHost({
        authenticate: async () => null,
        forms: [],
      }),
    );

    const response = await handler(
      new Request("https://api.takoserver.com/.well-known/takoform/v1alpha3"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      api_versions: ["forms.takoform.com/v1alpha3"],
      features: {
        service_forms: true,
        exact_form_ref: true,
        optimistic_concurrency: true,
        idempotent_lifecycle: true,
        operations: true,
        artifact_upload: true,
        support_profiles: true,
      },
      endpoints: {
        api: "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3",
        artifacts: "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/artifacts",
        operations: "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/operations",
        support: "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/support",
      },
    });

    const legacy = await handler(new Request("https://api.takoserver.com/.well-known/takoform"));
    expect(legacy.status).toBe(404);
  });

  test("normalizes driver failures into the stable Host error envelope", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "EdgeObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"8".repeat(64)}` as const,
    };
    const driver: TakoformResourceDriver = {
      async apply() {
        throw new Error("provider secret must never escape");
      },
      async observe() {
        throw new Error("unused");
      },
      async delete() {},
    };
    const host = createTakoformHost({
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
      forms: [
        {
          identity: { formRef },
          desiredSchema: { type: "object", additionalProperties: false },
          operations: ["create", "read", "delete", "observe"],
        },
      ],
      driver,
    });
    const handler = handlerFor(host);
    const resource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "failure", space: "space-a" },
      spec: {},
    };
    const auth = { authorization: "Bearer tenant-a" };
    const prepared = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      resource,
      auth,
    );
    const prepareDigest = requiredString(requiredRecord(prepared.body, "review"), "prepareDigest");
    const response = await jsonRequest(
      handler,
      "PUT",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/failure",
      { ...resource, review: { prepareDigest } },
      { ...auth, "idempotency-key": "driver-failure-001", "if-none-match": "*" },
    );
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: { code: "internal_error", message: "internal error", retryable: false },
    });
    expect(JSON.stringify(response.body)).not.toContain("provider secret");
    expect(requiredString(requiredRecord(response.body, "error"), "requestId")).toStartWith("req_");
  });

  test("runs reviewed create, exact read, fenced update, observe, delete, and recreate", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "EdgeObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"1".repeat(64)}`,
    } as const;
    const alternateFormRef = {
      ...formRef,
      definitionVersion: "2.0.0",
      schemaDigest: `sha256:${"9".repeat(64)}` as const,
    };
    const host = createInMemoryTakoformHost({
      authenticate: async (authorization) => {
        if (authorization !== "Bearer tenant-a") return null;
        return { tenantId: "tenant-a", principalId: "principal-a" };
      },
      forms: [
        {
          identity: { formRef, packageDigest: `sha256:${"2".repeat(64)}` },
          displayName: "Edge object bucket",
          desiredSchema: {
            type: "object",
            additionalProperties: false,
            properties: { location: { type: "string" } },
            required: ["location"],
          },
          operations: ["create", "read", "update", "delete", "import", "observe"],
        },
        {
          identity: { formRef: alternateFormRef },
          desiredSchema: {
            type: "object",
            additionalProperties: false,
            properties: { location: { type: "string" } },
            required: ["location"],
          },
          operations: ["create", "read", "update", "delete", "import", "observe"],
        },
      ],
      clock: () => new Date("2026-08-17T12:00:00.000Z"),
    });
    const handler = handlerFor(host);
    const resource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef, packageDigest: `sha256:${"2".repeat(64)}` },
      metadata: { name: "media", space: "space-a" },
      spec: { location: "auto" },
    };
    const auth = { authorization: "Bearer tenant-a" };

    const availability = await jsonRequest(
      handler,
      "GET",
      `/apis/forms.takoform.com/v1alpha3/forms?space=space-a&group=${encodeURIComponent(formRef.apiVersion)}&kind=${formRef.kind}&definitionVersion=${formRef.definitionVersion}&schemaDigest=${encodeURIComponent(formRef.schemaDigest)}`,
      undefined,
      auth,
    );
    expect(availability.status).toBe(200);
    expect(availability.body).toMatchObject({
      forms: [{ identity: { formRef }, installed: true, executable: true }],
    });

    const duplicateMember = await handler(
      new Request(
        "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/resources/validate",
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(resource).replace(
            '"location":"auto"',
            '"location":"auto","location":"substituted"',
          ),
        },
      ),
    );
    expect(duplicateMember.status).toBe(400);

    const preparedCreate = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      resource,
      auth,
    );
    expect(preparedCreate.status).toBe(200);
    const createDigest = requiredString(
      requiredRecord(preparedCreate.body, "review"),
      "prepareDigest",
    );
    const created = await jsonRequest(
      handler,
      "PUT",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media",
      { ...resource, review: { prepareDigest: createDigest } },
      { ...auth, "idempotency-key": "create-media-001", "if-none-match": "*" },
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"1"');
    expect(created.headers.get("cache-control")).toBe("no-transform");
    expect(created.body).toMatchObject({
      metadata: { name: "media", space: "space-a", generation: "1", revision: "1" },
      status: { observedGeneration: "1", conditions: [{ type: "Ready", status: "True" }] },
    });
    expect(requiredRecord(created.body, "status")).not.toHaveProperty("outputs");
    expect(requiredRecord(created.body, "status")).not.toHaveProperty("observed");
    const firstUid = requiredString(requiredRecord(created.body, "metadata"), "uid");
    const reformattedReplay = await handler(
      new Request(
        "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media",
        {
          method: "PUT",
          headers: {
            ...auth,
            "content-type": "application/json",
            "idempotency-key": "create-media-001",
            "if-none-match": "*",
          },
          body: JSON.stringify({ ...resource, review: { prepareDigest: createDigest } }, null, 2),
        },
      ),
    );
    expect(reformattedReplay.status).toBe(400);
    const replayedCreate = await jsonRequest(
      handler,
      "PUT",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media",
      { ...resource, review: { prepareDigest: createDigest } },
      { ...auth, "idempotency-key": "create-media-001", "if-none-match": "*" },
    );
    expect(replayedCreate.status).toBe(201);
    expect(replayedCreate.body).toEqual(created.body);

    const changedForm = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      {
        ...resource,
        form: { formRef: alternateFormRef },
      },
      { ...auth, "takoform-expected-generation": "1" },
    );
    expect(changedForm.status).toBe(404);
    expect(changedForm.body).toMatchObject({ error: { code: "resource_not_found" } });

    const updatedResource = { ...resource, spec: { location: "weur" } };
    const unfencedPrepare = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      updatedResource,
      auth,
    );
    expect(unfencedPrepare.status).toBe(400);
    expect(unfencedPrepare.body).toMatchObject({ error: { code: "invalid_argument" } });
    const preparedUpdate = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      updatedResource,
      { ...auth, "takoform-expected-generation": "1" },
    );
    const updateDigest = requiredString(
      requiredRecord(preparedUpdate.body, "review"),
      "prepareDigest",
    );
    const updated = await jsonRequest(
      handler,
      "PUT",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media",
      {
        ...updatedResource,
        expectedUid: firstUid,
        expectedGeneration: "1",
        review: { prepareDigest: updateDigest },
      },
      {
        ...auth,
        "idempotency-key": "update-media-001",
        "takoform-expected-generation": "1",
        "if-match": '"1"',
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBe('"2"');
    expect(updated.body).toMatchObject({
      metadata: { uid: firstUid, generation: "2", revision: "2" },
      spec: { location: "weur" },
    });

    const read = await jsonRequest(
      handler,
      "GET",
      `/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media?space=space-a&group=${encodeURIComponent(formRef.apiVersion)}&kind=${formRef.kind}&definitionVersion=1.0.0&schemaDigest=${encodeURIComponent(formRef.schemaDigest)}`,
      undefined,
      auth,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe('"2"');
    expect(read.body).toEqual(updated.body);

    const deleted = await jsonRequest(
      handler,
      "DELETE",
      `/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media?space=space-a&group=${encodeURIComponent(formRef.apiVersion)}&kind=${formRef.kind}&definitionVersion=1.0.0&schemaDigest=${encodeURIComponent(formRef.schemaDigest)}`,
      undefined,
      {
        ...auth,
        "idempotency-key": "delete-media-001",
        "takoform-expected-generation": "2",
      },
    );
    expect(deleted.status).toBe(204);

    const recreatedPrepare = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      resource,
      auth,
    );
    const recreatedDigest = requiredString(
      requiredRecord(recreatedPrepare.body, "review"),
      "prepareDigest",
    );
    const recreated = await jsonRequest(
      handler,
      "PUT",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media",
      { ...resource, review: { prepareDigest: recreatedDigest } },
      { ...auth, "idempotency-key": "create-media-001", "if-none-match": "*" },
    );
    expect(recreated.status).toBe(201);
    expect(requiredString(requiredRecord(recreated.body, "metadata"), "uid")).not.toBe(firstUid);
    expect(recreated.body).toMatchObject({ metadata: { generation: "1", revision: "1" } });

    const replayedDelete = await jsonRequest(
      handler,
      "DELETE",
      `/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media?space=space-a&group=${encodeURIComponent(formRef.apiVersion)}&kind=${formRef.kind}&definitionVersion=1.0.0&schemaDigest=${encodeURIComponent(formRef.schemaDigest)}`,
      undefined,
      {
        ...auth,
        "idempotency-key": "delete-media-001",
        "takoform-expected-generation": "2",
      },
    );
    expect(replayedDelete.status).toBe(204);
    const replacementAfterReplay = await jsonRequest(
      handler,
      "GET",
      `/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media?space=space-a&group=${encodeURIComponent(formRef.apiVersion)}&kind=${formRef.kind}&definitionVersion=1.0.0&schemaDigest=${encodeURIComponent(formRef.schemaDigest)}`,
      undefined,
      auth,
    );
    expect(replacementAfterReplay.status).toBe(200);
    expect(requiredString(requiredRecord(replacementAfterReplay.body, "metadata"), "uid")).toBe(
      requiredString(requiredRecord(recreated.body, "metadata"), "uid"),
    );
  });

  test("owns support profiles and content-addressed artifacts by tenant and upload principal", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "EdgeObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"3".repeat(64)}`,
    } as const;
    const host = createInMemoryTakoformHost({
      authenticate: async (authorization) => {
        if (authorization === "Bearer tenant-a-owner") {
          return { tenantId: "tenant-a", principalId: "owner" };
        }
        if (authorization === "Bearer tenant-a-builder") {
          return { tenantId: "tenant-a", principalId: "builder" };
        }
        if (authorization === "Bearer tenant-b-owner") {
          return { tenantId: "tenant-b", principalId: "owner" };
        }
        return null;
      },
      forms: [
        {
          identity: { formRef },
          desiredSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              tier: { type: "string", default: "standard" },
              bundleManifestDigest: { type: "string" },
            },
            required: ["bundleManifestDigest"],
          },
          artifactRequirement: {
            specField: "bundleManifestDigest",
            kind: "WorkerBundle",
          },
          operations: ["create", "read", "delete", "import", "observe"],
        },
      ],
    });
    const handler = handlerFor(host);
    const owner = { authorization: "Bearer tenant-a-owner" };
    const uncommittedResource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "uncommitted", space: "shared" },
      spec: { bundleManifestDigest: `sha256:${"9".repeat(64)}` },
    };
    const uncommittedPrepare = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      uncommittedResource,
      owner,
    );
    expect(uncommittedPrepare.status).toBe(200);
    const uncommittedDigest = requiredString(
      requiredRecord(uncommittedPrepare.body, "review"),
      "prepareDigest",
    );
    const uncommittedApply = await jsonRequest(
      handler,
      "PUT",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/uncommitted",
      { ...uncommittedResource, review: { prepareDigest: uncommittedDigest } },
      { ...owner, "idempotency-key": "uncommitted-apply", "if-none-match": "*" },
    );
    expect(uncommittedApply.status).toBe(404);
    expect(uncommittedApply.body).toMatchObject({ error: { code: "artifact_missing" } });
    const support = await jsonRequest(
      handler,
      "GET",
      "/apis/forms.takoform.com/v1alpha3/support/forms",
      undefined,
      owner,
    );
    expect(support.status).toBe(200);
    expect(support.body).toEqual({
      profiles: [
        {
          apiVersion: "support.takoform.com/v1alpha1",
          kind: "FormSupport",
          formRef,
          operations: ["create", "read", "delete", "import", "observe"],
          limits: { maximumBundleBytes: 10_485_760, maximumBundleFiles: 4_096 },
        },
      ],
    });
    expect(JSON.stringify(support.body)).not.toMatch(/price|sku|region|quota/iu);

    const orphanSourceMap = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/artifacts/uploads",
      {
        manifest: {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: "WorkerBundle",
          mainModule: "worker.js",
          modules: [
            {
              name: "worker.js",
              mediaType: "application/javascript+module",
              size: 1,
              digest: `sha256:${"1".repeat(64)}`,
            },
            {
              name: "missing.js.map",
              mediaType: "application/source-map+json",
              size: 1,
              digest: `sha256:${"2".repeat(64)}`,
            },
          ],
        },
      },
      { ...owner, "idempotency-key": "artifact-orphan-map" },
    );
    expect(orphanSourceMap.status).toBe(400);

    const oversizedBundle = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/artifacts/uploads",
      {
        manifest: {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: "WorkerBundle",
          mainModule: "worker.js",
          modules: [
            {
              name: "worker.js",
              mediaType: "application/javascript+module",
              size: 10_485_761,
              digest: `sha256:${"3".repeat(64)}`,
            },
          ],
        },
      },
      { ...owner, "idempotency-key": "artifact-bundle-too-large" },
    );
    expect(oversizedBundle.status).toBe(400);

    const moduleBytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('ok') } }",
    );
    const moduleDigest = await digestBytes(moduleBytes);
    const manifest = {
      apiVersion: "artifacts.takoform.com/v1alpha1",
      kind: "WorkerBundle",
      mainModule: "worker.js",
      modules: [
        {
          name: "worker.js",
          mediaType: "application/javascript+module",
          size: moduleBytes.byteLength,
          digest: moduleDigest,
        },
      ],
    };
    const started = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/artifacts/uploads",
      { manifest },
      { ...owner, "idempotency-key": "artifact-start-001" },
    );
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ missingBlobs: [moduleDigest] });
    const uploadId = requiredString(started.body, "uploadId");

    const foreignUpload = await handler(
      new Request(
        `https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/artifacts/uploads/${uploadId}/blobs/${moduleDigest}`,
        { method: "PUT", headers: { authorization: "Bearer tenant-a-builder" }, body: moduleBytes },
      ),
    );
    expect(foreignUpload.status).toBe(404);

    const uploaded = await handler(
      new Request(
        `https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/artifacts/uploads/${uploadId}/blobs/${moduleDigest}`,
        { method: "PUT", headers: owner, body: moduleBytes },
      ),
    );
    expect(uploaded.status).toBe(201);
    const committed = await jsonRequest(
      handler,
      "POST",
      `/apis/forms.takoform.com/v1alpha3/artifacts/uploads/${uploadId}/commit`,
      undefined,
      { ...owner, "idempotency-key": "artifact-commit-001" },
    );
    expect(committed.status).toBe(201);
    const manifestDigest = requiredString(committed.body, "manifestDigest");

    const sameTenantRead = await jsonRequest(
      handler,
      "GET",
      `/apis/forms.takoform.com/v1alpha3/artifacts/${manifestDigest}`,
      undefined,
      { authorization: "Bearer tenant-a-builder" },
    );
    expect(sameTenantRead.status).toBe(200);
    expect(sameTenantRead.body).toEqual(manifest);
    const foreignTenantRead = await jsonRequest(
      handler,
      "GET",
      `/apis/forms.takoform.com/v1alpha3/artifacts/${manifestDigest}`,
      undefined,
      { authorization: "Bearer tenant-b-owner" },
    );
    expect(foreignTenantRead.status).toBe(404);

    const importedResource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "adopted", space: "shared" },
      spec: { bundleManifestDigest: manifestDigest },
      nativeId: "provider-native-123",
    };
    const imported = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/adopted/import",
      importedResource,
      {
        ...owner,
        "idempotency-key": "import-adopted-001",
        "if-none-match": "*",
      },
    );
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      spec: { tier: "standard", bundleManifestDigest: manifestDigest },
    });
    const conflictingImport = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/other/import",
      { ...importedResource, metadata: { name: "other", space: "shared" } },
      {
        ...owner,
        "idempotency-key": "import-adopted-002",
        "if-none-match": "*",
      },
    );
    expect(conflictingImport.status).toBe(409);
    const otherTenantImport = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/adopted/import",
      importedResource,
      {
        authorization: "Bearer tenant-b-owner",
        "idempotency-key": "import-adopted-001",
        "if-none-match": "*",
      },
    );
    expect(otherTenantImport.status).toBe(404);
    expect(otherTenantImport.body).toMatchObject({ error: { code: "artifact_missing" } });
  });

  test("uses an organization resources:write API key as the provider bearer, never a one-shot grant", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "EdgeObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"4".repeat(64)}`,
    } as const;
    const form: InstalledTakoformForm = {
      identity: { formRef },
      desiredSchema: { type: "object", properties: {}, additionalProperties: false },
      operations: ["create", "read", "delete", "import", "observe"],
    };
    // No Host is injected here: the app wires the lane to its own control
    // plane, which is exactly the policy under test.
    const handler = buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      identity: OWNER_IDENTITY,
      settlement: SETTLEMENT,
      publicOrigin: "https://api.takoserver.com",
      forms: [form],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
    }).fetch;

    const session = await jsonRequest(handler, "POST", "/v1/sessions", {
      provider: "github",
      assertion: "verified-assertion",
    });
    const sessionToken = String(session.body.sessionToken);
    const organization = await jsonRequest(
      handler,
      "POST",
      "/v1/organizations",
      { name: "Host organization" },
      { authorization: `Bearer ${sessionToken}` },
    );
    const organizationId = String((organization.body.organization as { id: string }).id);
    const created = await jsonRequest(
      handler,
      "POST",
      `/v1/organizations/${organizationId}/api-keys`,
      { name: "Takoform provider", scopes: ["resources:write"], expiresInSeconds: 3_600 },
      { authorization: `Bearer ${sessionToken}` },
    );
    const apiKey = { secret: String(created.body.secret) };

    const query = `/apis/forms.takoform.com/v1alpha3/forms?space=provider-space&group=${encodeURIComponent(formRef.apiVersion)}&kind=${formRef.kind}&definitionVersion=${formRef.definitionVersion}&schemaDigest=${encodeURIComponent(formRef.schemaDigest)}`;
    const sessionRejected = await jsonRequest(handler, "GET", query, undefined, {
      authorization: `Bearer ${sessionToken}`,
    });
    expect(sessionRejected.status).toBe(401);
    const providerAuthorized = await jsonRequest(handler, "GET", query, undefined, {
      authorization: `Bearer ${apiKey.secret}`,
    });
    expect(providerAuthorized.status).toBe(200);
  });

  test("lets one tenant-run bearer manage multiple resources only inside its exact space", async () => {
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "EdgeObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"8".repeat(64)}`,
    } as const;
    const host = createInMemoryTakoformHost({
      authenticate: async (authorization) =>
        authorization === "Bearer tenant-run"
          ? {
              tenantId: "organization-a",
              principalId: "run:run-001",
              scope: { mode: "tenant-run", space: "workspace-a" },
            }
          : null,
      forms: [
        {
          identity: { formRef },
          desiredSchema: { type: "object", properties: {}, additionalProperties: false },
          operations: ["create", "read", "delete"],
        },
      ],
    });
    const handler = handlerFor(host);
    const auth = { authorization: "Bearer tenant-run" };

    for (const [index, name] of ["assets", "backups"].entries()) {
      const resource = {
        apiVersion: formRef.apiVersion,
        kind: formRef.kind,
        form: { formRef },
        metadata: { name, space: "workspace-a" },
        spec: {},
      };
      const prepared = await jsonRequest(
        handler,
        "POST",
        "/apis/forms.takoform.com/v1alpha3/resources/prepare",
        resource,
        auth,
      );
      expect(prepared.status).toBe(200);
      const prepareDigest = requiredString(
        requiredRecord(prepared.body, "review"),
        "prepareDigest",
      );
      const created = await jsonRequest(
        handler,
        "PUT",
        `/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/${name}`,
        { ...resource, review: { prepareDigest } },
        { ...auth, "idempotency-key": `tenant-run-create-${index}`, "if-none-match": "*" },
      );
      expect(created.status).toBe(201);
    }

    const query = new URLSearchParams({
      space: "workspace-a",
      group: formRef.apiVersion,
      kind: formRef.kind,
      definitionVersion: formRef.definitionVersion,
      schemaDigest: formRef.schemaDigest,
    });
    for (const name of ["assets", "backups"]) {
      const read = await jsonRequest(
        handler,
        "GET",
        `/apis/forms.takoform.com/v1alpha3/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/${name}?${query}`,
        undefined,
        auth,
      );
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ metadata: { name, space: "workspace-a" } });
    }

    const moduleBytes = new TextEncoder().encode("export default { fetch() {} }");
    const moduleDigest = await digestBytes(moduleBytes);
    const upload = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/artifacts/uploads",
      {
        manifest: {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: "WorkerBundle",
          mainModule: "worker.js",
          modules: [
            {
              name: "worker.js",
              mediaType: "application/javascript+module",
              size: moduleBytes.byteLength,
              digest: moduleDigest,
            },
          ],
        },
      },
      { ...auth, "idempotency-key": "tenant-run-artifact-start" },
    );
    expect(upload.status).toBe(201);
    expect(upload.body).toMatchObject({ missingBlobs: [moduleDigest] });

    const foreignSpace = await jsonRequest(
      handler,
      "POST",
      "/apis/forms.takoform.com/v1alpha3/resources/prepare",
      {
        apiVersion: formRef.apiVersion,
        kind: formRef.kind,
        form: { formRef },
        metadata: { name: "foreign", space: "workspace-b" },
        spec: {},
      },
      auth,
    );
    expect(foreignSpace.status).toBe(404);
    expect(foreignSpace.body).toMatchObject({ error: { code: "resource_not_found" } });
  });
});

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function jsonRequest(
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}> {
  const response = await handler(
    new Request(`https://api.takoserver.com${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>),
  };
}

function requiredRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new Error(`missing ${key}`);
  }
  return found as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== "string") throw new Error(`missing ${key}`);
  return found;
}
