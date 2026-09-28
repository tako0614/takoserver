import { expect, test } from "bun:test";
import type { ApplyInput, ProviderOffering } from "../src/provider-port.ts";
import type { CloudflareProviderExecutorRpc } from "../src/providers/cloudflare-provider-executor-port.ts";
import { CloudflareProviderProxy } from "../src/providers/cloudflare-provider-proxy.ts";

const offering = {
  id: "container",
  kind: "ContainerService",
  displayName: "Container",
  form: {
    apiVersion: "takoform.io/v1alpha3",
    group: "edge.forms.takoform.com",
    kind: "ContainerService",
    definitionVersion: "1",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create"],
} as ProviderOffering;
const input: ApplyInput = {
  operationId: "op-context-1",
  operationMode: "initial",
  offering,
  identity: { tenantRef: "tenant", space: "space", name: "service", uid: "uid-1" },
  spec: {},
};
const failed = {
  phase: "failed",
  failure: { code: "unavailable", message: "test", retryable: true },
} as const;

function proxy(binding: Partial<CloudflareProviderExecutorRpc>) {
  return new CloudflareProviderProxy({
    providerInstallationId: "installation",
    managedBaseDomain: "workers.example.test",
    offerings: [offering],
    binding: binding as CloudflareProviderExecutorRpc,
  });
}

test("fresh create forwards a versioned context without changing legacy ApplyInput", async () => {
  const calls: unknown[] = [];
  const provider = proxy({
    apply: async (raw) => {
      calls.push(["legacy", raw]);
      return failed;
    },
    applyWithExecutionContextV1: async (envelope) => {
      calls.push(["v1", envelope]);
      return failed;
    },
  });
  await provider.apply(input, { prospectiveDeploymentId: "dep_op-context-1" });
  expect(calls).toEqual([
    [
      "v1",
      {
        schema: "takoserver.cloudflare-provider-mutation-context@v1",
        input,
        prospectiveDeploymentId: "dep_op-context-1",
      },
    ],
  ]);
  expect("prospectiveDeploymentId" in input.identity).toBe(false);
  expect("prospectiveDeploymentId" in input).toBe(false);
});

test("old CPE cannot silently discard a fresh-create context", async () => {
  let legacyCalls = 0;
  const provider = proxy({
    apply: async () => {
      legacyCalls++;
      return failed;
    },
  });
  const ticket = await provider.apply(input, { prospectiveDeploymentId: "dep_op-context-1" });
  expect(ticket).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });
  expect(legacyCalls).toBe(0);
});

test("context cannot turn a caller-selected incarnation into create custody", async () => {
  let calls = 0;
  const provider = proxy({
    applyWithExecutionContextV1: async () => {
      calls++;
      return failed;
    },
  });
  const ticket = await provider.apply(
    { ...input, identity: { ...input.identity, incarnationId: "dep_caller" } },
    { prospectiveDeploymentId: "dep_op-context-1" },
  );
  expect(ticket).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });
  expect(calls).toBe(0);
});

test("recovery forwards the same versioned context and never upgrades missing mode to initial", async () => {
  const calls: unknown[] = [];
  const provider = proxy({
    convergeApply: async (raw) => {
      calls.push(["legacy", raw]);
      return failed;
    },
    convergeApplyWithExecutionContextV1: async (envelope) => {
      calls.push(["v1", envelope]);
      return failed;
    },
  });
  const { operationMode: _mode, ...untagged } = input;
  await provider.convergeApply(untagged, { prospectiveDeploymentId: "dep_op-context-1" });
  expect(calls).toEqual([
    [
      "v1",
      {
        schema: "takoserver.cloudflare-provider-mutation-context@v1",
        input: untagged,
        prospectiveDeploymentId: "dep_op-context-1",
      },
    ],
  ]);
  await provider.convergeApply(input, { prospectiveDeploymentId: "dep_op-context-1" });
  expect(calls).toHaveLength(1);
});

test("old CPE cannot silently discard a recovery context", async () => {
  let legacyCalls = 0;
  const provider = proxy({
    convergeApply: async () => {
      legacyCalls++;
      return failed;
    },
  });
  const ticket = await provider.convergeApply(
    { ...input, operationMode: "recovery" },
    { prospectiveDeploymentId: "dep_op-context-1" },
  );
  expect(ticket).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });
  expect(legacyCalls).toBe(0);
});

test("dynamic RPC stub rejection stays uncertain without legacy replay", async () => {
  let legacyCalls = 0;
  const provider = proxy({
    apply: async () => {
      legacyCalls++;
      return failed;
    },
    applyWithExecutionContextV1: async () => {
      throw new Error("remote method unavailable");
    },
    convergeApply: async () => {
      legacyCalls++;
      return failed;
    },
    convergeApplyWithExecutionContextV1: async () => {
      throw new Error("remote method unavailable");
    },
  });
  expect(
    await provider.apply(input, { prospectiveDeploymentId: "dep_op-context-1" }),
  ).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(
    await provider.convergeApply(
      { ...input, operationMode: "recovery" },
      { prospectiveDeploymentId: "dep_op-context-1" },
    ),
  ).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(legacyCalls).toBe(0);
});

test("legacy no-context and recovery calls keep their existing RPC shape", async () => {
  const calls: unknown[] = [];
  const provider = proxy({
    apply: async (raw) => {
      calls.push(["apply", raw]);
      return failed;
    },
    convergeApply: async (raw) => {
      calls.push(["converge", raw]);
      return failed;
    },
  });
  await provider.apply(input);
  await provider.convergeApply({ ...input, operationMode: "recovery" });
  expect(calls).toEqual([
    ["apply", input],
    ["converge", { ...input, operationMode: "recovery" }],
  ]);
});
