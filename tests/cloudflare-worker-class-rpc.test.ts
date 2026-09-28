import { expect, test } from "bun:test";
import type { CloudflareProviderExecutorRpc } from "../src/providers/cloudflare-provider-executor-port.ts";
import { CloudflareProviderProxy } from "../src/providers/cloudflare-provider-proxy.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import type { ProviderWorkerClassRuntime } from "../src/worker-class-runtime-port.ts";
import { createWorkerProductionComposition } from "../src/worker-production-composition.ts";
import { edgeSuppliesFixture } from "./helpers/hosted-supply-fixtures.ts";

const formRef = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ActorNamespace",
  definitionVersion: "0.2.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};
const contract = {
  formRef,
  packageDigest: `sha256:${"b".repeat(64)}` as const,
  runtimeClassRef: {
    apiVersion: "interfaces.takoform.com/v1alpha1" as const,
    name: "worker.actor",
    version: "2.0.0",
    schemaDigest: `sha256:${"c".repeat(64)}` as const,
  },
};
const identity = { uid: "holder", generation: "1", revision: "revision-1", formRef };
const input: Parameters<ProviderWorkerClassRuntime["inspect"]>[0] = {
  contract,
  tenantId: "tenant",
  space: "main",
  className: "Counter",
  holder: identity,
  worker: { ...identity, uid: "worker" },
  deployment: { ...identity, uid: "deployment" },
  version: { ...identity, uid: "version" },
  weight: 10_000,
  bundle: { ...identity, uid: "bundle", manifestDigest: `sha256:${"d".repeat(64)}` },
  providerInstallationRef: "installation",
  holderNativeId: `actor:${"e".repeat(32)}`,
  versionNativeId: "worker:version",
};

function proxy(binding: Partial<CloudflareProviderExecutorRpc>, configured = true) {
  return new CloudflareProviderProxy({
    providerInstallationId: "installation",
    offerings: [],
    managedBaseDomain: "workers.example.test",
    binding: binding as CloudflareProviderExecutorRpc,
    ...(configured ? { workerClassRuntimeContracts: [contract] } : {}),
  });
}

test("class RPC is dormant without explicit local software contracts", () => {
  expect(proxy({}, false).workerClassRuntime).toBeUndefined();
});

test("real Worker composition forwards only explicit class capability without changing offerings", async () => {
  const supplies = edgeSuppliesFixture();
  let calls = 0;
  const options = {
    env: {
      TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(supplies),
      TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
      CLOUDFLARE_PROVIDER_EXECUTOR: {
        async inspectWorkerClass(value: typeof input) {
          calls += 1;
          expect(value.contract).toEqual(contract);
          return "valid" as const;
        },
      } as CloudflareProviderExecutorRpc,
    },
    forms: stableProductionTakoformCatalog().forms,
    now: new Date("2026-09-27T00:00:00.000Z"),
  };
  const ordinary = createWorkerProductionComposition(options);
  const explicit = createWorkerProductionComposition({
    ...options,
    workerClassRuntimeContracts: [contract],
  });
  expect(ordinary.providers[0]?.workerClassRuntime).toBeUndefined();
  expect(explicit.offerings).toEqual(ordinary.offerings);
  expect(explicit.offerings.some((value) => value.form.kind === "ActorNamespace")).toBe(false);
  expect(
    await explicit.providers[0]?.workerClassRuntime?.inspect({
      ...input,
      providerInstallationRef: supplies.providerInstallation.id,
    }),
  ).toBe("valid");
  expect(calls).toBe(1);
});

test("class RPC forwards the complete value-free identity and fixed verdict", async () => {
  for (const verdict of ["valid", "invalid", "unavailable"] as const) {
    let calls = 0;
    const provider = proxy({
      async inspectWorkerClass(value) {
        calls += 1;
        expect(value).toEqual(input);
        expect(value).not.toBe(input);
        return verdict;
      },
    });
    expect(await provider.workerClassRuntime?.inspect(input)).toBe(verdict);
    expect(calls).toBe(1);
  }
});

test("class RPC refuses unconfigured contracts and foreign installations before transport", async () => {
  let calls = 0;
  const provider = proxy({
    async inspectWorkerClass() {
      calls += 1;
      return "valid";
    },
  });
  for (const changed of [
    { ...input, providerInstallationRef: "foreign" },
    { ...input, contract: { ...contract, packageDigest: `sha256:${"f".repeat(64)}` as const } },
    {
      ...input,
      contract: { ...contract, runtimeClassRef: { ...contract.runtimeClassRef, version: "0.1.0" } },
    },
  ])
    expect(await provider.workerClassRuntime?.inspect(changed)).toBe("unavailable");
  expect(calls).toBe(0);
});

test("missing, throwing and malformed executor capability cannot become valid", async () => {
  expect(await proxy({}).workerClassRuntime?.inspect(input)).toBe("unavailable");
  expect(
    await proxy({
      async inspectWorkerClass() {
        throw new Error("private diagnostic");
      },
    }).workerClassRuntime?.inspect(input),
  ).toBe("unavailable");
  for (const value of [undefined, null, true, { verdict: "valid" }, "ready"]) {
    const provider = proxy({
      inspectWorkerClass: (async () => value) as NonNullable<
        CloudflareProviderExecutorRpc["inspectWorkerClass"]
      >,
    });
    expect(await provider.workerClassRuntime?.inspect(input)).toBe("unavailable");
  }
});
