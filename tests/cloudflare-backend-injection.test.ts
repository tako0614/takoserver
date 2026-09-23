import { expect, test } from "bun:test";
import {
  type ApplyInput,
  type ArtifactBytes,
  CloudflareProvider,
  type CloudflareProviderOptions,
  type CloudflareWorkerAdoptInput,
  type CloudflareWorkerBackend,
  type CloudflareWorkerBackendFactoryContext,
  derivedProviderResourceIncarnationName,
  type ProviderApplyNoEffectConclusionInput,
  type ProviderOffering,
} from "@takoserver/core/provider-extension";

const offering: ProviderOffering = {
  id: "cloudflare.injected.module-worker",
  kind: "takoform.ModuleWorker",
  displayName: "Injected ModuleWorker",
  form: {
    apiVersion: "edge.forms.takoform.com",
    kind: "ModuleWorker",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "delete", "observe"],
};

const artifacts: ArtifactBytes = {
  async manifest() {
    return null;
  },
  async blob() {
    return null;
  },
};

const authorize = () => "Bearer injected";
const fetch = async () => {
  throw new Error("the injected backend must own this operation");
};

const backend: CloudflareWorkerBackend = {
  kind: "workers-for-platforms" as const,
  deriveOrigin: async () => ({ canonicalPublicOrigin: "https://injected.example.test" }),
  owns: () => true,
  apply: async (_input: ApplyInput) => ({
    phase: "succeeded" as const,
    result: { nativeId: "injected-native", observed: {}, outputs: {} },
  }),
  recoverApply: async () => ({
    phase: "succeeded" as const,
    result: { nativeId: "injected-native", observed: {}, outputs: {} },
  }),
  convergeApply: async () => ({
    phase: "succeeded" as const,
    result: { nativeId: "injected-native", observed: {}, outputs: {} },
  }),
  observe: async () => ({
    phase: "succeeded" as const,
    result: { nativeId: "injected-native", observed: {}, outputs: {} },
  }),
  delete: async () => ({
    phase: "succeeded" as const,
    result: { nativeId: "injected-native", observed: {}, outputs: {} },
  }),
  recoverDelete: async () => ({
    phase: "succeeded" as const,
    result: { nativeId: "injected-native", observed: {}, outputs: {} },
  }),
  createNativeReadbackDescriptor: () => ({
    apiVersion: "providers.takoserver.com/readback/v1",
    provider: "cloudflare.injected",
    kind: "ModuleWorker",
    nativeId: "injected-native",
    data: {},
  }),
  verifyNativeAbsence: async () => ({
    outcome: "absent" as const,
    evidence: { state: "absent" },
  }),
  verifyArtifactConsumption: async () => ({
    outcome: "absent" as const,
    evidence: { state: "absent" },
  }),
};
Object.assign(backend, { readSqliteMigrationLedger: undefined });

function baseOptions(): Omit<CloudflareProviderOptions, "workerBackend"> {
  return {
    id: "cloudflare.injected",
    accountId: "account-injected",
    offerings: [offering],
    artifacts,
    authorize,
    apiOrigin: "https://api.cloudflare.injected/client/v4",
    workerCompatibilityDate: "2026-08-01",
    fetch,
  };
}

test("CloudflareProvider honors one synchronous managed backend factory and its context", async () => {
  let factoryCalls = 0;
  let applyCalls = 0;
  let context: CloudflareWorkerBackendFactoryContext | undefined;
  const injectedBackend: CloudflareWorkerBackend = {
    ...backend,
    apply: async (input: ApplyInput) => {
      applyCalls += 1;
      return await backend.apply(input);
    },
  };
  const sourceOfferings = [offering];
  const provider = new CloudflareProvider({
    ...baseOptions(),
    offerings: sourceOfferings,
    workerBackend: {
      kind: "workers-for-platforms",
      create(received) {
        factoryCalls += 1;
        context = received;
        return injectedBackend;
      },
    },
  });

  expect(factoryCalls).toBe(1);
  expect(context).toEqual({
    providerId: "cloudflare.injected",
    accountId: "account-injected",
    apiOrigin: "https://api.cloudflare.injected/client/v4",
    authorize,
    fetch,
    artifacts,
    offerings: provider.offerings,
    workerCompatibilityDate: "2026-08-01",
    zoneFor: expect.any(Function),
  });
  expect(context?.offerings).not.toBe(provider.offerings);
  expect(context?.offerings).not.toBe(sourceOfferings);
  const mutableOfferings = context?.offerings as Array<{ displayName: string }> | undefined;
  if (!mutableOfferings) throw new Error("factory context offerings are missing");
  const firstOffering = mutableOfferings[0];
  if (!firstOffering) throw new Error("factory context offerings are empty");
  firstOffering.displayName = "mutated in factory";
  expect(provider.offerings[0]?.displayName).toBe("Injected ModuleWorker");

  expect(
    await provider.workerEndpointOriginReservations.derive({
      tenantRef: "tenant-injected",
      requestedSubdomain: "ignored",
    }),
  ).toEqual({ canonicalPublicOrigin: "https://injected.example.test" });
  expect(
    await provider.apply({
      operationId: "injected-operation",
      operationMode: "initial",
      offering,
      identity: {
        tenantRef: "tenant-injected",
        space: "default",
        name: "worker",
        uid: "worker-injected",
      },
      spec: {},
    }),
  ).toMatchObject({ phase: "succeeded", result: { nativeId: "injected-native" } });
  expect(factoryCalls).toBe(1);
  expect(applyCalls).toBe(1);
});

test("CloudflareProvider delegates no-effect conclusion only to its owning managed backend", async () => {
  let received: ProviderApplyNoEffectConclusionInput | undefined;
  let conclusionCalls = 0;
  const conclusion = { phase: "unsupported" as const };
  const injectedBackend: CloudflareWorkerBackend = {
    ...backend,
    owns: (candidate) => candidate.id === offering.id,
    async concludeApplyNoEffect(input) {
      conclusionCalls += 1;
      received = input;
      return conclusion;
    },
  };
  const provider = new CloudflareProvider({
    ...baseOptions(),
    workerBackend: { kind: "workers-for-platforms", create: () => injectedBackend },
  });
  const input: ProviderApplyNoEffectConclusionInput = {
    operationId: "managed-conclusion-operation",
    providerInstallationRef: "cloudflare.injected.primary",
    executionAuthority: {
      tenantId: "tenant-injected",
      resourceUid: "worker-injected",
      leaseToken: "provider-conclusion-lease",
      fingerprint: '{"request":"accepted"}',
    },
    offering,
    identity: {
      tenantRef: "tenant-injected",
      space: "default",
      name: "worker",
      uid: "worker-injected",
    },
  };
  if (!provider.concludeApplyNoEffect) throw new Error("managed conclusion port is missing");

  await expect(provider.concludeApplyNoEffect(input)).resolves.toBe(conclusion);
  expect(received).toBe(input);
  expect(conclusionCalls).toBe(1);

  await expect(
    provider.concludeApplyNoEffect({
      ...input,
      offering: { ...offering, id: "cloudflare.injected.unmanaged" },
    }),
  ).resolves.toEqual({ phase: "unsupported" });
  expect(conclusionCalls).toBe(1);
});

test("managed backend context delegates zone selection with existing restrictions and precedence", () => {
  let context: CloudflareWorkerBackendFactoryContext | undefined;
  const provider = new CloudflareProvider({
    ...baseOptions(),
    zones: [
      {
        suffix: "apps.example.test",
        zoneId: "shared-zone",
        reservedLabels: ["admin"],
        singleLabel: true,
      },
      {
        suffix: "apps.example.test",
        zoneId: "tenant-zone",
        tenantRef: "tenant-a",
        reservedLabels: ["admin"],
        singleLabel: true,
      },
      {
        suffix: "eu.apps.example.test",
        zoneId: "regional-zone",
        tenantRef: "tenant-a",
      },
      {
        suffix: "tenant-only.example.test",
        zoneId: "tenant-only-zone",
        tenantRef: "tenant-b",
      },
      {
        suffix: "customer.test",
        zoneId: "customer-apex-zone",
        tenantRef: "tenant-a",
        apex: true,
        singleLabel: true,
      },
    ],
    workerBackend: {
      kind: "workers-for-platforms",
      create(received) {
        context = received;
        return backend;
      },
    },
  });
  expect(provider).toBeInstanceOf(CloudflareProvider);
  if (!context) throw new Error("managed backend factory context is missing");

  expect(context.zoneFor("worker.apps.example.test", "tenant-a")).toEqual({
    suffix: "apps.example.test",
    zoneId: "tenant-zone",
    tenantRef: "tenant-a",
    reservedLabels: ["admin"],
    singleLabel: true,
  });
  expect(context.zoneFor("worker.eu.apps.example.test", "tenant-a")?.zoneId).toBe("regional-zone");
  expect(context.zoneFor("admin.apps.example.test", "tenant-b")).toBeUndefined();
  expect(context.zoneFor("nested.worker.apps.example.test", "tenant-a")).toBeUndefined();
  expect(context.zoneFor("tenant-only.example.test", "tenant-b")).toBeUndefined();
  expect(context.zoneFor("api.tenant-only.example.test", "tenant-b")?.zoneId).toBe(
    "tenant-only-zone",
  );
  expect(context.zoneFor("api.tenant-only.example.test", "tenant-a")).toBeUndefined();
  expect(context.zoneFor("customer.test", "tenant-a")?.zoneId).toBe("customer-apex-zone");
  expect(context.zoneFor("customer.test", "tenant-b")).toBeUndefined();
});

test("managed Worker adoption and recovery delegate the original opaque handle", async () => {
  let adoptedInput: CloudflareWorkerAdoptInput | undefined;
  let recoveredInput: CloudflareWorkerAdoptInput | undefined;
  const adopted = {
    phase: "succeeded" as const,
    result: { nativeId: "wfp-adopted", observed: { backend: "wfp" }, outputs: {} },
  };
  const recovered = {
    phase: "succeeded" as const,
    result: { nativeId: "wfp-recovered", observed: { backend: "wfp" }, outputs: {} },
  };
  const injectedBackend: CloudflareWorkerBackend = {
    ...backend,
    adopt: async (input) => {
      adoptedInput = input;
      return adopted;
    },
    recoverAdopt: async (input) => {
      recoveredInput = input;
      return recovered;
    },
  };
  const provider = new CloudflareProvider({
    ...baseOptions(),
    workerBackend: {
      kind: "workers-for-platforms",
      create: () => injectedBackend,
    },
  });
  const identity = {
    tenantRef: "tenant-injected",
    space: "default",
    name: "worker",
    uid: "worker-injected",
    incarnationId: "incarnation-injected",
    generation: "7",
  };
  const adoptInput: CloudflareWorkerAdoptInput = {
    operationId: "managed-adopt-operation",
    operationMode: "recovery",
    providerHandle: "opaque-wfp-adopt-handle",
    offering,
    nativeId: "worker:managed-native",
    identity,
    spec: { hostnames: ["worker.apps.example.test"] },
    relations: [],
  };
  const recoverAdoptInput: CloudflareWorkerAdoptInput = {
    ...adoptInput,
    operationId: "managed-recover-adopt-operation",
    providerHandle: "opaque-wfp-recovery-handle",
  };

  await expect(provider.adopt(adoptInput)).resolves.toBe(adopted);
  await expect(provider.recoverAdopt(recoverAdoptInput)).resolves.toBe(recovered);
  expect(adoptedInput).toBe(adoptInput);
  expect(adoptedInput?.providerHandle).toBe("opaque-wfp-adopt-handle");
  expect(adoptedInput?.operationMode).toBe("recovery");
  expect(recoveredInput).toBe(recoverAdoptInput);
  expect(recoveredInput?.providerHandle).toBe("opaque-wfp-recovery-handle");
  expect(recoveredInput?.operationMode).toBe("recovery");
});

test("managed Worker adoption fails closed when optional backend methods are absent", async () => {
  const identity = {
    tenantRef: "tenant-adoption-refusal",
    space: "default",
    name: "bucket",
    uid: "bucket-adoption-refusal",
  };
  const objectBucketOffering: ProviderOffering = {
    ...offering,
    id: "cloudflare.injected.legacy-object-bucket",
    kind: "object_bucket",
    form: { ...offering.form, kind: "ObjectBucket" },
  };
  const nativeId = `r2:${await derivedProviderResourceIncarnationName("ts", identity)}`;
  const ordinaryCalls: Request[] = [];
  const provider = new CloudflareProvider({
    ...baseOptions(),
    fetch: async (request) => {
      ordinaryCalls.push(request);
      return Response.json({ success: true, errors: [], result: {} });
    },
    workerBackend: {
      kind: "workers-for-platforms",
      create: () => backend,
    },
  });
  const adoptInput: CloudflareWorkerAdoptInput = {
    operationId: "managed-adopt-without-port",
    offering: objectBucketOffering,
    nativeId,
    identity,
    spec: {},
  };

  await expect(provider.adopt(adoptInput)).resolves.toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: false },
  });
  await expect(
    provider.recoverAdopt({ ...adoptInput, operationId: "managed-recover-without-port" }),
  ).resolves.toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: false },
  });
  expect(ordinaryCalls).toEqual([]);
});

test("CloudflareProvider forwards managed delete and readback authority objects unchanged", async () => {
  type DeleteInput = Parameters<CloudflareWorkerBackend["delete"]>[0];
  type VerifyNativeAbsenceInput = Parameters<CloudflareWorkerBackend["verifyNativeAbsence"]>[0];

  let deleteInput: DeleteInput | undefined;
  let recoverDeleteInput: DeleteInput | undefined;
  let verifyNativeAbsenceInput: VerifyNativeAbsenceInput | undefined;
  const injectedBackend: CloudflareWorkerBackend = {
    ...backend,
    delete: async (input) => {
      deleteInput = input;
      return await backend.delete(input);
    },
    recoverDelete: async (input) => {
      recoverDeleteInput = input;
      return await backend.recoverDelete(input);
    },
    verifyNativeAbsence: async (input) => {
      verifyNativeAbsenceInput = input;
      return await backend.verifyNativeAbsence(input);
    },
  };
  const provider = new CloudflareProvider({
    ...baseOptions(),
    workerBackend: {
      kind: "workers-for-platforms",
      create: () => injectedBackend,
    },
  });
  const executionAuthority = {
    tenantId: "tenant-injected",
    resourceUid: "resource-injected",
    leaseToken: "lease-injected",
    fingerprint: "fingerprint-injected",
  };
  const identity = {
    tenantRef: "tenant-injected",
    space: "default",
    name: "worker",
    uid: "resource-injected",
    incarnationId: "incarnation-injected",
    generation: "7",
  };
  const deleteInputValue = {
    operationId: "delete-operation",
    operationMode: "initial" as const,
    executionAuthority,
    offering,
    nativeId: "injected-native",
    identity,
    spec: {},
    relations: [],
  };
  const recoverDeleteInputValue = {
    ...deleteInputValue,
    operationId: "recover-delete-operation",
    operationMode: "recovery" as const,
  };

  await expect(provider.delete(deleteInputValue)).resolves.toMatchObject({ phase: "succeeded" });
  await expect(provider.recoverDelete(recoverDeleteInputValue)).resolves.toMatchObject({
    phase: "succeeded",
  });

  expect(deleteInput).toBe(deleteInputValue);
  expect(deleteInput?.executionAuthority).toBe(executionAuthority);
  expect(recoverDeleteInput).toBe(recoverDeleteInputValue);
  expect(recoverDeleteInput?.executionAuthority).toBe(executionAuthority);

  const descriptor = {
    apiVersion: "providers.takoserver.com/readback/v1" as const,
    provider: "cloudflare.injected",
    kind: "ModuleWorker",
    nativeId: "injected-native",
    data: { marker: "descriptor-marker" },
  };
  const target = {
    tenantId: "tenant-injected",
    resourceUid: "resource-injected",
    incarnationId: "incarnation-injected",
    generation: "7",
  };
  const verifyNativeAbsenceInputValue = { offering, descriptor, target };

  await expect(provider.verifyNativeAbsence(verifyNativeAbsenceInputValue)).resolves.toMatchObject({
    outcome: "absent",
  });
  expect(verifyNativeAbsenceInput).toBe(verifyNativeAbsenceInputValue);
  expect(verifyNativeAbsenceInput?.descriptor).toBe(descriptor);
  expect(verifyNativeAbsenceInput?.target).toBe(target);
});

test("CloudflareProvider rejects invalid managed factories without ordinary fallback", () => {
  const partial = { ...backend } as Partial<CloudflareWorkerBackend>;
  delete partial.recoverApply;
  const invalidBackends: readonly unknown[] = [
    null,
    Promise.resolve(backend),
    { kind: "ordinary-workers" },
    partial,
    { ...backend, readSqliteMigrationLedger: "not callable" },
    { ...backend, adopt: "not callable" },
    { ...backend, recoverAdopt: "not callable" },
  ];
  for (const invalid of invalidBackends) {
    expect(
      () =>
        new CloudflareProvider({
          ...baseOptions(),
          workerBackend: {
            kind: "workers-for-platforms",
            create: () => invalid as never,
          },
        }),
    ).toThrow("managed Workers-for-Platforms backend factory returned an invalid backend");
  }

  let factoryCalls = 0;
  expect(
    () =>
      new CloudflareProvider({
        ...baseOptions(),
        workerEndpointSuffix: "workers.dev",
        workerBackend: {
          kind: "workers-for-platforms",
          create: () => {
            factoryCalls += 1;
            return backend;
          },
        },
      }),
  ).toThrow("workerEndpointSuffix");
  expect(factoryCalls).toBe(0);

  expect(
    () =>
      new CloudflareProvider({
        ...baseOptions(),
        workerBackend: {
          kind: "workers-for-platforms",
        } as unknown as NonNullable<CloudflareProviderOptions["workerBackend"]>,
      }),
  ).toThrow("managed Workers-for-Platforms backend factory must be callable");
});
