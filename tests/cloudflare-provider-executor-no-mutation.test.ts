import { describe, expect, test } from "bun:test";
import {
  type ApplyInput,
  failed,
  failedWithoutProviderMutation,
  type Provider,
  type ProviderExecutionAuthority,
  type ProviderOffering,
  type ProviderTicket,
  providerFailureProvesNoMutation,
} from "../src/provider-port.ts";
import {
  CLOUDFLARE_PROVIDER_EXECUTOR_NO_MUTATION_SCHEMA,
  type CloudflareProviderExecutorRpc,
  type CloudflareProviderInitialMutationResult,
} from "../src/providers/cloudflare-provider-executor-port.ts";
import { CloudflareProviderProxy } from "../src/providers/cloudflare-provider-proxy.ts";

type Action = "apply" | "delete" | "adopt";
type DeleteInput = Parameters<Provider["delete"]>[0];
type AdoptInput = Parameters<NonNullable<Provider["adopt"]>>[0];
type InitialInput = ApplyInput | DeleteInput | AdoptInput;
type InitialHandler = (action: Action, input: InitialInput) => unknown | Promise<unknown>;

const installationId = "cloudflare.installation";
const authority: ProviderExecutionAuthority = {
  tenantId: "tenant-1",
  resourceUid: "resource-1",
  leaseToken: "lease-token-1",
  fingerprint: "fingerprint-1",
};
const identity = {
  tenantRef: authority.tenantId,
  space: "default",
  name: "worker",
  uid: authority.resourceUid,
};
const offering = {} as ProviderOffering;

describe("Cloudflare provider executor no-mutation bridge", () => {
  test("restores cloned no-mutation evidence for initial apply, delete, and adopt", async () => {
    for (const action of ["apply", "delete", "adopt"] as const) {
      const input = makeInput(action);
      const proxy = createProxy(createBinding(() => proofFor(action, input)));

      const ticket = await invoke(proxy, action, input);

      expect(providerFailureProvesNoMutation(ticket, "operation-1")).toBe(true);
      expect(ticket).toEqual({
        phase: "failed",
        failure: {
          code: "conflict",
          message: "native identity is already present",
          retryable: false,
        },
      });
      expect(Object.hasOwn(ticket, "executorNoMutation")).toBe(false);
    }
  });

  test("refuses evidence with mismatched action, operation, installation, or authority", async () => {
    const mismatches: readonly [string, (proof: MutableProof) => void][] = [
      ["schema", (proof) => (proof.executorNoMutation.schema = "other-schema")],
      ["action", (proof) => (proof.executorNoMutation.action = "delete")],
      ["operation id", (proof) => (proof.executorNoMutation.operationId = "other-operation")],
      [
        "installation",
        (proof) => (proof.executorNoMutation.providerInstallationRef = "other-installation"),
      ],
      [
        "tenant",
        (proof) => (proof.executorNoMutation.executionAuthority.tenantId = "other-tenant"),
      ],
      [
        "resource uid",
        (proof) => (proof.executorNoMutation.executionAuthority.resourceUid = "other-resource"),
      ],
      [
        "lease token",
        (proof) => (proof.executorNoMutation.executionAuthority.leaseToken = "other-lease"),
      ],
      [
        "fingerprint",
        (proof) => (proof.executorNoMutation.executionAuthority.fingerprint = "other-fingerprint"),
      ],
    ];

    for (const [name, mutate] of mismatches) {
      const input = makeInput("apply");
      const malformed = mutateProof(proofFor("apply", input), mutate);
      const ticket = await createProxy(createBinding(() => malformed)).apply(input);
      expectUnavailable(ticket, name);
    }
  });

  test("requires the snapshotted identity and initial execution authority", async () => {
    const original = makeInput("apply");
    const proof = proofFor("apply", original);
    const { executionAuthority: _authority, ...withoutAuthority } = original;
    const { operationMode: _mode, ...withoutMode } = original;
    const cases = [
      ["tenant mismatch", makeInput("apply", { identity: { ...identity, tenantRef: "tenant-2" } })],
      [
        "resource uid mismatch",
        makeInput("apply", { identity: { ...identity, uid: "resource-2" } }),
      ],
      ["missing authority", withoutAuthority],
      ["recovery mode", makeInput("apply", { operationMode: "recovery" })],
      ["missing mode", withoutMode],
    ] as const;

    for (const [name, input] of cases) {
      const ticket = await createProxy(createBinding(() => proof)).apply(input);
      expectUnavailable(ticket, name);
    }
  });

  test("rejects extra keys and malformed failure data at every proof level", async () => {
    const input = makeInput("apply");
    const malformed: readonly [string, (proof: MutableProof) => void][] = [
      ["ticket key", (proof) => (proof.debug = true)],
      ["failure key", (proof) => (proof.failure.debug = true)],
      ["evidence key", (proof) => (proof.executorNoMutation.debug = true)],
      ["authority key", (proof) => (proof.executorNoMutation.executionAuthority.debug = true)],
      ["retryable failure", (proof) => (proof.failure.retryable = true)],
      ["unknown failure code", (proof) => (proof.failure.code = "other")],
      ["empty message", (proof) => (proof.failure.message = "")],
      ["oversized message", (proof) => (proof.failure.message = "x".repeat(1_025))],
    ];

    for (const [name, mutate] of malformed) {
      const result = mutateProof(proofFor("apply", input), mutate);
      const ticket = await createProxy(createBinding(() => result)).apply(input);
      expectUnavailable(ticket, name);
    }
  });

  test("keeps ordinary RPC failures ordinary and does not trust a cloned local proof", async () => {
    const ordinary = failed("conflict", "ordinary provider refusal", false);
    const ordinaryResult = await createProxy(createBinding(() => ordinary)).apply(
      makeInput("apply"),
    );
    expect(ordinaryResult).toEqual(ordinary);
    expect(providerFailureProvesNoMutation(ordinaryResult, "operation-1")).toBe(false);

    const localProof = failedWithoutProviderMutation(
      "operation-1",
      "conflict",
      "local proof cannot cross RPC",
    );
    const clonedLegacyTicket = structuredClone(localProof);
    const clonedResult = await createProxy(createBinding(() => clonedLegacyTicket)).apply(
      makeInput("apply"),
    );
    expect(clonedResult).toEqual(clonedLegacyTicket);
    expect(providerFailureProvesNoMutation(clonedResult, "operation-1")).toBe(false);
  });

  test("uses context captured before the RPC promise resolves", async () => {
    const input = makeInput("apply");
    const proof = proofFor("apply", input);
    let resolveResult: ((value: unknown) => void) | undefined;
    const pendingResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const proxy = createProxy(createBinding(() => pendingResult));
    const pendingTicket = proxy.apply(input);

    Object.assign(input, { operationId: "changed-operation" });
    Object.assign(input.identity, { tenantRef: "changed-tenant", uid: "changed-resource" });
    Object.assign(input.executionAuthority as object, { leaseToken: "changed-lease" });
    resolveResult?.(structuredClone(proof));

    const ticket = await pendingTicket;
    expect(providerFailureProvesNoMutation(ticket, "operation-1")).toBe(true);
  });

  test("recovery and polling RPCs do not restore cloned no-mutation tickets", async () => {
    const legacy = failedWithoutProviderMutation("operation-1", "conflict", "recovery ticket");
    const proxy = createProxy(createBinding(() => failed("unavailable", "unused", true), legacy));
    const apply = makeInput("apply");
    const deletion = makeInput("delete");
    const adoption = makeInput("adopt");
    const recovered = await Promise.all([
      proxy.recoverApply(apply as ApplyInput),
      proxy.convergeApply(apply as ApplyInput),
      proxy.recoverDelete(deletion as DeleteInput),
      proxy.recoverAdopt(adoption as AdoptInput),
      proxy.poll({ operationId: "operation-1", handle: "handle-1", executionAuthority: authority }),
    ]);

    for (const ticket of recovered) {
      expect(ticket).toEqual(legacy);
      expect(providerFailureProvesNoMutation(ticket, "operation-1")).toBe(false);
    }
  });
});

function makeInput(action: "apply", overrides?: Partial<ApplyInput>): ApplyInput;
function makeInput(action: "delete", overrides?: Partial<DeleteInput>): DeleteInput;
function makeInput(action: "adopt", overrides?: Partial<AdoptInput>): AdoptInput;
function makeInput(action: Action, overrides?: Partial<InitialInput>): InitialInput;
function makeInput(action: Action, overrides: Partial<InitialInput> = {}): InitialInput {
  const common = {
    operationId: "operation-1",
    operationMode: "initial" as const,
    executionAuthority: { ...authority },
    identity: { ...identity },
    offering,
  };
  if (action === "apply") {
    return { ...common, spec: {}, ...overrides } as ApplyInput;
  }
  if (action === "delete") {
    return { ...common, nativeId: "native-1", spec: {}, ...overrides } as DeleteInput;
  }
  return { ...common, nativeId: "native-1", spec: {}, ...overrides } as AdoptInput;
}

function proofFor(action: Action, input: InitialInput): CloudflareProviderInitialMutationResult {
  return {
    phase: "failed",
    failure: {
      code: "conflict",
      message: "native identity is already present",
      retryable: false,
    },
    executorNoMutation: {
      schema: CLOUDFLARE_PROVIDER_EXECUTOR_NO_MUTATION_SCHEMA,
      action,
      operationId: input.operationId,
      providerInstallationRef: installationId,
      executionAuthority: { ...(input.executionAuthority ?? authority) },
    },
  };
}

function invoke(proxy: CloudflareProviderProxy, action: Action, input: InitialInput) {
  if (action === "apply") return proxy.apply(input as ApplyInput);
  if (action === "delete") return proxy.delete(input as DeleteInput);
  return proxy.adopt(input as AdoptInput);
}

function createProxy(binding: CloudflareProviderExecutorRpc): CloudflareProviderProxy {
  return new CloudflareProviderProxy({
    providerInstallationId: installationId,
    offerings: [offering],
    managedBaseDomain: "workers.example.test",
    binding,
  });
}

function createBinding(
  handler: InitialHandler,
  recoveryResult: ProviderTicket = failed("unavailable", "unused", true),
): CloudflareProviderExecutorRpc {
  const initial = async (action: Action, input: InitialInput) =>
    structuredClone(await handler(action, input)) as CloudflareProviderInitialMutationResult;
  const recovery = async () => structuredClone(recoveryResult);
  const unused = async (): Promise<never> => {
    throw new Error("unused executor RPC");
  };
  return {
    apply: (input) => initial("apply", input),
    recoverApply: recovery,
    convergeApply: recovery,
    poll: recovery,
    observe: recovery,
    delete: (input) => initial("delete", input),
    recoverDelete: recovery,
    adopt: (input) => initial("adopt", input),
    recoverAdopt: recovery,
    verifyNativeAbsence: unused,
    verifyArtifactConsumption: unused,
    readSqliteMigrationLedger: unused,
    applySqliteMigrationSuffix: unused,
    readMeterUsage: unused,
  } satisfies CloudflareProviderExecutorRpc;
}

interface MutableProof {
  phase: unknown;
  failure: { code: unknown; message: unknown; retryable: unknown; [key: string]: unknown };
  executorNoMutation: {
    schema: unknown;
    action: unknown;
    operationId: unknown;
    providerInstallationRef: unknown;
    executionAuthority: {
      tenantId: unknown;
      resourceUid: unknown;
      leaseToken: unknown;
      fingerprint: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function mutateProof(
  proof: CloudflareProviderInitialMutationResult,
  mutate: (value: MutableProof) => void,
): unknown {
  const clone = structuredClone(proof) as unknown as MutableProof;
  mutate(clone);
  return clone;
}

function expectUnavailable(ticket: ProviderTicket, caseName: string): void {
  expect(ticket, caseName).toMatchObject({
    phase: "failed",
    failure: {
      code: "unavailable",
      message: "Provider executor returned invalid no-mutation evidence",
      retryable: true,
    },
  });
  expect(providerFailureProvesNoMutation(ticket, "operation-1"), caseName).toBe(false);
}
