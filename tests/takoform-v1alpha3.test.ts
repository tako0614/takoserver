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
          limits: { maximumBundleBytes: 10_485_760 },
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
