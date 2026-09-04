import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import type {
  Provider,
  ProviderArtifactConsumptionInput,
  ProviderOffering,
  ProviderRelation,
} from "../src/provider-port.ts";
import { type ArtifactBytes, CloudflareProvider } from "../src/providers/cloudflare.ts";
import type { CloudflareWorkersForPlatformsBackendOptions } from "../src/providers/cloudflare-worker-backend.ts";
import { ManagedWorkerState } from "../src/providers/managed-worker-state.ts";

const MANIFEST = `sha256:${"a".repeat(64)}` as const;
const BLOB = `sha256:${"d".repeat(64)}` as const;
const MODULE_BYTES = new TextEncoder().encode("export default { fetch() {} }");
const VERSION: ProviderOffering = {
  id: "cloudflare.edge.workerversion",
  kind: "takoform.WorkerVersion",
  displayName: "Cloudflare Worker Version",
  form: {
    apiVersion: "edge.forms.takoform.com",
    kind: "WorkerVersion",
    definitionVersion: "0.1.0",
    schemaDigest: `sha256:${"b".repeat(64)}`,
  },
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "delete", "observe"],
};
const MODULE_WORKER: ProviderOffering = {
  ...VERSION,
  id: "cloudflare.edge.moduleworker",
  kind: "takoform.ModuleWorker",
  form: { ...VERSION.form, kind: "ModuleWorker" },
};
const ARTIFACTS: ArtifactBytes = {
  async manifest(_tenantRef, digest) {
    return digest === MANIFEST
      ? {
          kind: "WorkerBundle",
          mainModule: "worker.mjs",
          modules: [
            {
              name: "worker.mjs",
              mediaType: "application/javascript+module",
              digest: BLOB,
            },
          ],
        }
      : null;
  },
  async blob(digest) {
    return digest === BLOB ? MODULE_BYTES : null;
  },
};

describe("Cloudflare artifact-consumer readback", () => {
  test("new immutable Versions persist the exact provider-owned manifest marker", async () => {
    const uploads: string[] = [];
    const provider = new CloudflareProvider({
      accountId: "account-id",
      offerings: [VERSION],
      artifacts: ARTIFACTS,
      authorize: () => "Bearer provider-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        uploads.push(await request.text());
        return Response.json({ success: true, errors: [], result: { id: "version-id" } });
      },
    });

    expect(
      await provider.apply({
        operationId: "operation-version-upload",
        operationMode: "initial",
        offering: VERSION,
        identity: {
          tenantRef: "org_repair",
          space: "default",
          name: "version-name",
          uid: "uid_version",
        },
        spec: { handlers: ["fetch"] },
        relations: versionRelations(),
      }),
    ).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-id" },
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('"name":"TAKOSERVER_INTERNAL_ARTIFACT_MANIFEST"');
    expect(uploads[0]).toContain(`"text":"${MANIFEST}"`);

    const beforeCollision = uploads.length;
    expect(
      await provider.apply({
        operationId: "operation-version-collision",
        operationMode: "initial",
        offering: VERSION,
        identity: {
          tenantRef: "org_repair",
          space: "default",
          name: "version-collision",
          uid: "uid_version_collision",
        },
        spec: {
          handlers: ["fetch"],
          vars: { TAKOSERVER_INTERNAL_ARTIFACT_MANIFEST: MANIFEST },
        },
        relations: versionRelations(),
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(uploads).toHaveLength(beforeCollision);
  });

  test("attributes an exact immutable Version from its provider-owned manifest marker", async () => {
    const { provider, methods } = fixture({
      id: "version-id",
      resources: {
        bindings: [
          {
            type: "plain_text",
            name: "TAKOSERVER_INTERNAL_ARTIFACT_MANIFEST",
            text: MANIFEST,
          },
        ],
      },
    });

    expect(await provider.verifyArtifactConsumption?.(historicalInput())).toEqual({
      outcome: "present",
      consumption: "identified",
      manifestDigests: [MANIFEST],
      evidence: { provider: "cloudflare", kind: "WorkerVersion", binding: "artifact_manifest" },
    });
    expect(methods).toEqual(["GET"]);
  });

  test("uses a succeeded operation marker only for one exact current Resource candidate", async () => {
    const operationId = "op-current-resource";
    const marker = await operationMarker(operationId);
    const result = {
      id: "version-id",
      resources: {
        bindings: [
          {
            type: "plain_text",
            name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
            text: marker,
          },
        ],
      },
    };
    const historical = fixture(result).provider;
    expect(await historical.verifyArtifactConsumption?.(historicalInput())).toEqual({
      outcome: "unknown",
      reason: "unsupported",
      retryable: false,
    });

    const current = fixture(result).provider;
    expect(
      await current.verifyArtifactConsumption?.({
        ...historicalInput(),
        currentResource: {
          revision: "7",
          relationsDigest: `sha256:${"c".repeat(64)}`,
          providerOperationIds: [operationId],
        },
      }),
    ).toEqual({
      outcome: "present",
      consumption: "identified",
      manifestDigests: [MANIFEST],
      evidence: { provider: "cloudflare", kind: "WorkerVersion", binding: "host_operation" },
    });
  });

  test("fresh exact 404 is absence and transport/authority failures remain unknown", async () => {
    for (const [response, expected] of [
      [new Response(null, { status: 404 }), { outcome: "absent" }],
      [new Response(null, { status: 503 }), { outcome: "unknown", reason: "transport" }],
      [
        new Response(null, { status: 403 }),
        { outcome: "unknown", reason: "authority_unavailable" },
      ],
    ] as const) {
      const { provider, methods } = fixtureResponse(response);
      expect(await provider.verifyArtifactConsumption?.(historicalInput())).toMatchObject(expected);
      expect(methods).toEqual(["GET"]);
    }
  });

  test("zero and multiple provider markers are never rounded into a unique match", async () => {
    for (const bindings of [
      [],
      [
        {
          type: "plain_text",
          name: "TAKOSERVER_INTERNAL_ARTIFACT_MANIFEST",
          text: MANIFEST,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_INTERNAL_ARTIFACT_MANIFEST",
          text: `sha256:${"d".repeat(64)}`,
        },
      ],
    ]) {
      const { provider } = fixture({ id: "version-id", resources: { bindings } });
      const result = await provider.verifyArtifactConsumption?.(historicalInput());
      expect(result?.outcome).toBe("unknown");
    }
  });

  test("a present non-artifact native identity is zero matches, never native absence", async () => {
    for (const [response, expected] of [
      [
        Response.json({ success: true, errors: [], result: {} }),
        { outcome: "present", consumption: "none" },
      ],
      [new Response(null, { status: 404 }), { outcome: "absent" }],
    ] as const) {
      const methods: string[] = [];
      const provider = new CloudflareProvider({
        accountId: "account-id",
        offerings: [MODULE_WORKER],
        artifacts: ARTIFACTS,
        authorize: () => "Bearer provider-token",
        apiOrigin: "https://api.cloudflare.test/client/v4",
        async fetch(request) {
          methods.push(request.method);
          return response.clone();
        },
      });
      expect(
        await provider.verifyArtifactConsumption?.({
          offering: MODULE_WORKER,
          nativeId: "worker:script-name",
          target: artifactReadTarget("uid_worker", "dep_worker"),
          identity: {
            tenantRef: "org_repair",
            resourceUid: "uid_worker",
            address: { space: "default", name: "worker-name" },
          },
          candidateManifestDigests: [MANIFEST],
        }),
      ).toMatchObject(expected);
      expect(methods).toEqual(["GET"]);
    }
  });

  test("managed Workers-for-Platforms attributes only its exact committed receipt", async () => {
    const sql = createEphemeralSql();
    const providerId = "cloudflare.wfp.integration";
    const nativeId = "version:logical-worker:release-worker";
    const operationId = "managed-release-operation";
    const descriptorDigest = `sha256:${"e".repeat(64)}` as const;
    const state = new ManagedWorkerState(providerId, sql);
    expect(
      await state.claimReceipt({
        resourceUid: "uid_version",
        nativeId,
        kind: "version",
        logicalWorkerId: "logical-worker",
        operationId,
        descriptorDigest,
      }),
    ).toMatchObject({ outcome: "claimed" });
    expect(
      await state.commitReceipt({
        resourceUid: "uid_version",
        operationId,
        descriptorDigest,
        providerEtag: "provider-etag",
        observed: { manifestDigest: MANIFEST },
      }),
    ).toBe(true);
    const methods: string[] = [];
    const provider = new CloudflareProvider({
      id: providerId,
      accountId: "account-id",
      offerings: [VERSION, MODULE_WORKER],
      artifacts: ARTIFACTS,
      authorize: () => "Bearer provider-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerBackend: managedBackend(sql),
      async fetch(request) {
        methods.push(request.method);
        return Response.json({ success: true, errors: [], result: {} });
      },
    });

    expect(await provider.verifyArtifactConsumption?.({ ...historicalInput(), nativeId })).toEqual({
      outcome: "present",
      consumption: "identified",
      manifestDigests: [MANIFEST],
      evidence: {
        provider: providerId,
        kind: "WorkerVersion",
        authority: "managed_release_receipt",
      },
    });
    expect(methods).toEqual(["GET"]);

    const workerNativeId = "worker:logical-worker";
    expect(
      await state.claimReceipt({
        resourceUid: "uid_worker",
        nativeId: workerNativeId,
        kind: "worker",
        logicalWorkerId: "logical-worker",
        operationId: "managed-worker-operation",
        descriptorDigest,
      }),
    ).toMatchObject({ outcome: "claimed" });
    expect(
      await state.commitReceipt({
        resourceUid: "uid_worker",
        operationId: "managed-worker-operation",
        descriptorDigest,
        providerEtag: "worker-etag",
        observed: {},
      }),
    ).toBe(true);
    expect(
      await provider.verifyArtifactConsumption?.({
        offering: MODULE_WORKER,
        nativeId: workerNativeId,
        target: artifactReadTarget("uid_worker", "dep_worker"),
        identity: { tenantRef: "org_repair", resourceUid: "uid_worker" },
        candidateManifestDigests: [MANIFEST],
      }),
    ).toEqual({
      outcome: "present",
      consumption: "none",
      evidence: {
        provider: providerId,
        kind: "ModuleWorker",
        state: "non_artifact_consumer",
      },
    });
    expect(methods).toEqual(["GET"]);
  });

  test("managed WorkerVersion native presence is never erased by receipt drift", async () => {
    for (const receiptState of ["missing", "mismatched", "deleted"] as const) {
      const sql = createEphemeralSql();
      const inputNativeId = "version:logical-worker:release-worker";
      if (receiptState !== "missing") {
        await seedManagedReceipt(new ManagedWorkerState("cloudflare.wfp.integration", sql), {
          resourceUid: "uid_version",
          nativeId:
            receiptState === "mismatched"
              ? "version:logical-worker:different-release-worker"
              : inputNativeId,
          kind: "version",
          logicalWorkerId: "logical-worker",
          state: receiptState === "deleted" ? "deleted" : "committed",
        });
      }
      const requests: Request[] = [];
      const provider = managedReadbackProvider(sql, [VERSION], async (request) => {
        requests.push(request);
        return Response.json({ success: true, errors: [], result: {} });
      });

      expect(
        await provider.verifyArtifactConsumption?.({
          ...historicalInput(),
          nativeId: inputNativeId,
        }),
      ).toEqual({
        outcome: "unknown",
        reason: "authority_unavailable",
        retryable: false,
      });
      const descriptor = managedVersionReadbackDescriptor(provider, inputNativeId);
      expect(await provider.verifyNativeAbsence?.({ offering: VERSION, descriptor })).toMatchObject(
        {
          outcome: "present",
        },
      );
      expect(requests).toHaveLength(2);
    }
  });

  test("managed WorkerVersion fresh 404 targets the requested release across receipt drift", async () => {
    for (const receiptState of [
      "missing",
      "committed",
      "pending",
      "deleting",
      "mismatched",
      "deleted",
    ] as const) {
      const sql = createEphemeralSql();
      const providerId = "cloudflare.wfp.integration";
      const inputNativeId = "version:logical-worker:release-worker";
      const receiptNativeId =
        receiptState === "mismatched"
          ? "version:logical-worker:different-release-worker"
          : inputNativeId;
      const state = new ManagedWorkerState(providerId, sql);
      if (receiptState !== "missing") {
        await seedManagedReceipt(state, {
          resourceUid: "uid_version",
          nativeId: receiptNativeId,
          kind: "version",
          logicalWorkerId: "logical-worker",
          state: receiptState === "mismatched" ? "committed" : receiptState,
        });
      }
      const requests: Request[] = [];
      const provider = managedReadbackProvider(sql, [VERSION], async (request) => {
        requests.push(request);
        return new Response(null, { status: 404 });
      });

      expect(
        await provider.verifyArtifactConsumption?.({
          ...historicalInput(),
          nativeId: inputNativeId,
        }),
      ).toMatchObject({ outcome: "absent" });
      const descriptor = managedVersionReadbackDescriptor(provider, inputNativeId);
      expect(await provider.verifyNativeAbsence?.({ offering: VERSION, descriptor })).toMatchObject(
        {
          outcome: "absent",
        },
      );
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/client/v4/accounts/account-id/workers/dispatch/namespaces/customer-workers/scripts/release-worker",
        "/client/v4/accounts/account-id/workers/dispatch/namespaces/customer-workers/scripts/release-worker",
      ]);
    }
  });

  test("managed WorkerVersion authorization and transport failures never prove absence", async () => {
    for (const [response, expected] of [
      [
        new Response(null, { status: 403 }),
        { outcome: "unknown", reason: "authority_unavailable", retryable: false },
      ],
      [
        new Response(null, { status: 503 }),
        { outcome: "unknown", reason: "transport", retryable: true },
      ],
    ] as const) {
      const sql = createEphemeralSql();
      const requests: Request[] = [];
      const provider = managedReadbackProvider(sql, [VERSION], async (request) => {
        requests.push(request);
        return response.clone();
      });

      expect(
        await provider.verifyArtifactConsumption?.({
          ...historicalInput(),
          nativeId: "version:logical-worker:release-worker",
        }),
      ).toEqual(expected);
      const descriptor = managedVersionReadbackDescriptor(
        provider,
        "version:logical-worker:release-worker",
      );
      expect(await provider.verifyNativeAbsence?.({ offering: VERSION, descriptor })).toEqual(
        expected,
      );
      expect(requests).toHaveLength(2);
    }
  });

  test("a managed non-Version tombstone without a fresh verifier stays unknown", async () => {
    const sql = createEphemeralSql();
    const nativeId = "worker:logical-worker";
    await seedManagedReceipt(new ManagedWorkerState("cloudflare.wfp.integration", sql), {
      resourceUid: "uid_worker",
      nativeId,
      kind: "worker",
      logicalWorkerId: "logical-worker",
      state: "deleted",
    });
    const requests: Request[] = [];
    const provider = managedReadbackProvider(sql, [MODULE_WORKER], async (request) => {
      requests.push(request);
      return new Response(null, { status: 404 });
    });

    expect(
      await provider.verifyArtifactConsumption?.({
        offering: MODULE_WORKER,
        nativeId,
        target: artifactReadTarget("uid_worker", "dep_worker", "retained"),
        identity: { tenantRef: "org_repair", resourceUid: "uid_worker" },
        candidateManifestDigests: [MANIFEST],
      }),
    ).toEqual({
      outcome: "unknown",
      reason: "authority_unavailable",
      retryable: false,
    });
    const descriptor = provider.createNativeReadbackDescriptor?.({
      offering: MODULE_WORKER,
      nativeId,
      identity: {
        tenantRef: "org_repair",
        space: "default",
        name: "worker-name",
        uid: "uid_worker",
      },
      spec: {},
    });
    if (!descriptor) throw new Error("managed readback descriptor is unavailable");
    expect(await provider.verifyNativeAbsence?.({ offering: MODULE_WORKER, descriptor })).toEqual({
      outcome: "unknown",
      reason: "authority_unavailable",
      retryable: false,
    });
    expect(requests).toEqual([]);
  });

  test("closed retained absence binds its attested address to the snapshotted generation", async () => {
    const { provider, methods } = fixtureResponse(new Response(null, { status: 404 }));
    const sold = {
      id: VERSION.id,
      providerPackRef: provider.id,
      providerInstallationRef: "cloudflare.staging",
      form: VERSION.form,
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: {
        list: () => [sold],
        findOffering: () => sold,
      } as never,
      ledger: {} as never,
      deployments: {} as never,
    });

    expect(
      await driver.artifactConsumerRepair.verifyNativeAbsence({
        deployment: {
          tenantId: "org_repair",
          deploymentId: "dep_retained_closed",
          resourceUid: "uid_version",
          offeringId: VERSION.id,
          providerPackRef: provider.id,
          providerInstallationRef: "cloudflare.staging",
          nativeId: "version:script-name:version-id",
          state: "retained",
          createdAt: 100,
          updatedAt: 200,
          observed: {},
          outputs: {
            __takoserver: {
              resourceUid: "uid_version",
              space: "default",
              name: "version-name",
              generation: "1",
            },
          },
        },
        address: {
          space: "default",
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "WorkerVersion",
          name: "version-name",
        },
        formRef: { ...VERSION.form },
      }),
    ).toMatchObject({ outcome: "absent" });
    expect(methods).toEqual(["GET"]);
  });

  test("the lifecycle driver forwards exact snapshotted Deployment artifact custody", async () => {
    let captured: ProviderArtifactConsumptionInput | undefined;
    const provider = {
      id: "cloudflare",
      offerings: [VERSION],
      async apply() {
        throw new Error("unused provider mutation");
      },
      async observe() {
        throw new Error("unused provider read");
      },
      async delete() {
        throw new Error("unused provider mutation");
      },
      async verifyArtifactConsumption(input: ProviderArtifactConsumptionInput) {
        captured = input;
        return {
          outcome: "present",
          consumption: "identified",
          manifestDigests: [MANIFEST],
          evidence: { provider: "executor-proxy" },
        } as const;
      },
    } satisfies Provider;
    const sold = {
      id: VERSION.id,
      providerPackRef: provider.id,
      providerInstallationRef: "cloudflare.staging",
      form: VERSION.form,
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: {
        list: () => [sold],
        findOffering: () => sold,
      } as never,
      ledger: {} as never,
      deployments: {} as never,
    });

    expect(
      await driver.artifactConsumerRepair.verifyArtifactConsumption({
        deployment: {
          tenantId: "org_snapshot",
          deploymentId: "dep_snapshot",
          resourceUid: "uid_snapshot",
          offeringId: VERSION.id,
          providerPackRef: provider.id,
          providerInstallationRef: "cloudflare.staging",
          nativeId: "version:script-name:version-id",
          state: "active",
          createdAt: 100,
          updatedAt: 222,
          observed: {},
          outputs: {
            __takoserver: {
              resourceUid: "uid_snapshot",
              space: "default",
              name: "version-name",
              generation: "7",
            },
          },
        },
        resource: {
          space: "default",
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "WorkerVersion",
          name: "version-name",
          uid: "uid_snapshot",
          revision: "revision-7",
          formRef: { ...VERSION.form },
          relationsDigest: `sha256:${"c".repeat(64)}`,
          providerOperationIds: ["operation-version"],
        },
        candidateManifestDigests: [MANIFEST],
      }),
    ).toMatchObject({
      outcome: "present",
      consumption: "identified",
      manifestDigests: [MANIFEST],
    });
    expect(captured?.target).toEqual({
      tenantId: "org_snapshot",
      resourceUid: "uid_snapshot",
      incarnationId: "dep_snapshot",
      state: "active",
      updatedAt: 222,
    });
  });

  test("the lifecycle driver never falls back from a malformed surviving FormRef", async () => {
    let providerCalls = 0;
    const provider = {
      id: "cloudflare",
      offerings: [VERSION],
      async apply() {
        throw new Error("unused provider mutation");
      },
      async observe() {
        throw new Error("unused provider mutation");
      },
      async delete() {
        throw new Error("unused provider mutation");
      },
      async verifyArtifactConsumption() {
        providerCalls += 1;
        return {
          outcome: "present",
          consumption: "identified",
          manifestDigests: [MANIFEST],
          evidence: { provider: "fixture" },
        } as const;
      },
    } satisfies Provider;
    const sold = {
      id: VERSION.id,
      providerPackRef: provider.id,
      providerInstallationRef: "cloudflare.staging",
      form: VERSION.form,
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: {
        list: () => [sold],
        findOffering: () => sold,
      } as never,
      ledger: {} as never,
      deployments: {} as never,
    });

    expect(
      await driver.artifactConsumerRepair.verifyArtifactConsumption({
        deployment: {
          tenantId: "org_repair",
          deploymentId: "dep_version",
          resourceUid: "uid_version",
          offeringId: VERSION.id,
          providerPackRef: provider.id,
          providerInstallationRef: "cloudflare.staging",
          nativeId: "version:script-name:version-id",
          state: "active",
          createdAt: 100,
          updatedAt: 200,
          observed: {},
          outputs: {
            __takoserver: {
              resourceUid: "uid_version",
              space: "default",
              name: "version-name",
            },
          },
        },
        resource: {
          space: "default",
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "WorkerVersion",
          name: "version-name",
          uid: "uid_version",
          revision: "revision-1",
          formRef: { ...VERSION.form, unexpected: true },
          relationsDigest: `sha256:${"c".repeat(64)}`,
          providerOperationIds: ["operation-version"],
        },
        candidateManifestDigests: [MANIFEST],
      }),
    ).toMatchObject({ outcome: "indeterminate" });
    expect(providerCalls).toBe(0);
  });

  test("a retained row without FormRef never guesses across reused offering families", async () => {
    let providerCalls = 0;
    const recoveryVersion: ProviderOffering = {
      ...VERSION,
      form: {
        ...VERSION.form,
        definitionVersion: "0.0.9",
        schemaDigest: `sha256:${"f".repeat(64)}`,
      },
    };
    const provider = {
      id: "cloudflare",
      offerings: [VERSION],
      recoveryOfferings: [recoveryVersion],
      async apply() {
        throw new Error("unused provider mutation");
      },
      async observe() {
        throw new Error("unused provider mutation");
      },
      async delete() {
        throw new Error("unused provider mutation");
      },
      async verifyArtifactConsumption() {
        providerCalls += 1;
        return {
          outcome: "present",
          consumption: "identified",
          manifestDigests: [MANIFEST],
          evidence: { provider: "fixture" },
        } as const;
      },
    } satisfies Provider;
    const sold = {
      id: VERSION.id,
      providerPackRef: provider.id,
      providerInstallationRef: "cloudflare.staging",
      form: VERSION.form,
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: {
        list: () => [sold],
        findOffering: () => sold,
      } as never,
      ledger: {} as never,
      deployments: {} as never,
    });

    expect(
      await driver.artifactConsumerRepair.verifyArtifactConsumption({
        deployment: {
          tenantId: "org_repair",
          deploymentId: "dep_retained",
          resourceUid: "uid_version",
          offeringId: VERSION.id,
          providerPackRef: provider.id,
          providerInstallationRef: "cloudflare.staging",
          nativeId: "version:script-name:version-id",
          state: "retained",
          createdAt: 100,
          updatedAt: 200,
          observed: {},
          outputs: {},
        },
        resource: undefined,
        candidateManifestDigests: [MANIFEST],
      }),
    ).toMatchObject({ outcome: "indeterminate" });
    expect(providerCalls).toBe(0);
  });
});

function historicalInput(): ProviderArtifactConsumptionInput {
  return {
    offering: VERSION,
    nativeId: "version:script-name:version-id",
    target: artifactReadTarget("uid_version", "dep_version"),
    identity: { tenantRef: "org_repair", resourceUid: "uid_version" },
    candidateManifestDigests: [MANIFEST],
  };
}

function artifactReadTarget(
  resourceUid: string,
  incarnationId: string,
  state: "active" | "retained" = "active",
) {
  return {
    tenantId: "org_repair",
    resourceUid,
    incarnationId,
    state,
    updatedAt: 200,
  } as const;
}

function versionRelations(): readonly ProviderRelation[] {
  const formRef = (kind: string) => ({
    apiVersion: "edge.forms.takoform.com",
    kind,
    definitionVersion: "0.1.0",
    schemaDigest: `sha256:${"b".repeat(64)}` as const,
  });
  return [
    {
      pointer: "/worker",
      relation: "/worker",
      targetUid: "uid_worker",
      resource: {
        apiVersion: "edge.forms.takoform.com/v1beta1",
        kind: "ModuleWorker",
        form: { formRef: formRef("ModuleWorker") },
        metadata: {
          name: "worker-name",
          space: "default",
          uid: "uid_worker",
          generation: "1",
          revision: "revision-worker",
        },
        spec: {},
      },
      deployment: {
        tenantId: "org_repair",
        id: "dep_worker",
        resourceUid: "uid_worker",
        offeringId: "cloudflare.edge.moduleworker",
        providerPackRef: "cloudflare",
        providerInstallationRef: "cloudflare.staging",
        nativeId: "worker:script-name",
        state: "active",
        observed: {},
        outputs: { scriptName: "script-name" },
        createdAt: "2026-09-03T19:00:00.000Z",
        updatedAt: "2026-09-03T19:00:00.000Z",
      },
    },
    {
      pointer: "/bundle",
      relation: "/bundle",
      targetUid: "uid_bundle",
      resource: {
        apiVersion: "edge.forms.takoform.com/v1beta1",
        kind: "WorkerBundle",
        form: { formRef: formRef("WorkerBundle") },
        metadata: {
          name: "bundle-name",
          space: "default",
          uid: "uid_bundle",
          generation: "1",
          revision: "revision-bundle",
        },
        spec: { manifestDigest: MANIFEST },
      },
    },
  ];
}

function fixture(result: unknown) {
  return fixtureResponse(Response.json({ success: true, errors: [], result }));
}

function fixtureResponse(response: Response) {
  const methods: string[] = [];
  const provider = new CloudflareProvider({
    accountId: "account-id",
    offerings: [VERSION],
    artifacts: ARTIFACTS,
    authorize: () => "Bearer provider-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    async fetch(request) {
      methods.push(request.method);
      return response.clone();
    },
  });
  return { provider, methods };
}

async function operationMarker(operationId: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(operationId) as unknown as BufferSource,
    ),
  );
  return `tsop-v1:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function managedBackend(
  sql: ReturnType<typeof createEphemeralSql>,
): CloudflareWorkersForPlatformsBackendOptions {
  return {
    kind: "workers-for-platforms",
    providerInstallationId: "cloudflare.staging",
    dispatchNamespace: "customer-workers",
    gatewayWorkerName: "gateway-worker",
    managedBaseDomain: "apps.takoserver.test",
    sql,
    async inspectRelease(input) {
      return {
        ok: true,
        scriptName: input.scriptName,
        descriptorDigest: input.descriptorDigest,
        operationId: input.operationId,
        handlers: input.declaredHandlers,
      };
    },
    async deriveSqliteInstanceName() {
      return "unused-sqlite";
    },
    async sealSqliteAdminProof() {
      return "unused-proof";
    },
    sqliteNamespace: {
      getByName() {
        throw new Error("unused SQLite authority");
      },
    },
  };
}

function managedReadbackProvider(
  sql: ReturnType<typeof createEphemeralSql>,
  offerings: readonly ProviderOffering[],
  fetch: (request: Request) => Promise<Response>,
): CloudflareProvider {
  return new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "account-id",
    offerings,
    artifacts: ARTIFACTS,
    authorize: () => "Bearer provider-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(sql),
    fetch,
  });
}

function managedVersionReadbackDescriptor(provider: CloudflareProvider, nativeId: string) {
  const descriptor = provider.createNativeReadbackDescriptor?.({
    offering: VERSION,
    nativeId,
    identity: {
      tenantRef: "org_repair",
      space: "default",
      name: "version-name",
      uid: "uid_version",
    },
    spec: {},
  });
  if (!descriptor) throw new Error("managed readback descriptor is unavailable");
  return descriptor;
}

async function seedManagedReceipt(
  state: ManagedWorkerState,
  input: {
    readonly resourceUid: string;
    readonly nativeId: string;
    readonly kind: "version" | "worker";
    readonly logicalWorkerId: string;
    readonly state: "pending" | "committed" | "deleting" | "deleted";
  },
): Promise<void> {
  const descriptorDigest = `sha256:${"e".repeat(64)}` as const;
  const operationId = `managed-${input.kind}-operation`;
  expect(
    await state.claimReceipt({
      resourceUid: input.resourceUid,
      nativeId: input.nativeId,
      kind: input.kind,
      logicalWorkerId: input.logicalWorkerId,
      operationId,
      descriptorDigest,
    }),
  ).toMatchObject({ outcome: "claimed" });
  if (input.state === "pending") return;
  expect(
    await state.commitReceipt({
      resourceUid: input.resourceUid,
      operationId,
      descriptorDigest,
      observed: input.kind === "version" ? { manifestDigest: MANIFEST } : {},
    }),
  ).toBe(true);
  if (input.state === "committed") return;
  const deleteOperationId = `managed-${input.kind}-delete`;
  expect(
    await state.beginReceiptDelete({
      resourceUid: input.resourceUid,
      nativeId: input.nativeId,
      operationId: deleteOperationId,
    }),
  ).toMatchObject({ state: "deleting" });
  if (input.state === "deleting") return;
  expect(
    await state.commitReceiptDelete({
      resourceUid: input.resourceUid,
      nativeId: input.nativeId,
      operationId: deleteOperationId,
    }),
  ).toBe(true);
}
