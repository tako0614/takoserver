import { expect, test } from "bun:test";
import {
  type ApplyInput,
  type ArtifactBytes,
  CloudflareProvider,
  type CloudflareProviderOptions,
  type CloudflareWorkerBackend,
  type CloudflareWorkerBackendFactoryContext,
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

test("CloudflareProvider rejects invalid managed factories without ordinary fallback", () => {
  const partial = { ...backend } as Partial<CloudflareWorkerBackend>;
  delete partial.recoverApply;
  const invalidBackends: readonly unknown[] = [
    null,
    Promise.resolve(backend),
    { kind: "ordinary-workers" },
    partial,
    { ...backend, readSqliteMigrationLedger: "not callable" },
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
