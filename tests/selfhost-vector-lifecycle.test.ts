import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type {
  ProviderFailure,
  ProviderOffering,
  ProviderTicket,
  ResourceIdentity,
} from "../src/provider-port.ts";
import { createSelfhostProvider, type SelfhostProviderOptions } from "../src/providers/selfhost.ts";
import {
  createVectorIndexStore,
  type VectorIndexStore,
  VectorIndexStoreError,
} from "../src/vector-index-store.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const VECTOR_FORM = {
  apiVersion: "vector.forms.takoform.com",
  kind: "VectorIndex",
  definitionVersion: "0.1.0-dev.1",
  schemaDigest: `sha256:${"v".repeat(64)}`,
} as const;

const VECTOR_OFFERING: ProviderOffering = {
  id: "candidate.vector-index",
  kind: "takoform.VectorIndex",
  displayName: "Candidate VectorIndex",
  form: VECTOR_FORM,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "delete", "observe"],
};

const VECTOR_CONFIG = {
  dimension: 3,
  metric: "cosine",
  filterKeys: ["spaceId"],
} as const;

const identities = {
  first: { tenantRef: "org_alpha", space: "default", name: "vectors", uid: "uid-vector-a" },
  secondTenant: {
    tenantRef: "org_beta",
    space: "default",
    name: "vectors",
    uid: "uid-vector-a",
  },
} as const satisfies Record<string, ResourceIdentity>;

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function runtime(): WorkerdRuntime {
  return {
    async inspectModule(input) {
      return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
    },
    async write() {},
    async remove() {},
    async reload() {},
    async has() {
      return false;
    },
  };
}

function provider(
  options: {
    readonly offerings?: readonly ProviderOffering[];
    readonly store?: VectorIndexStore;
  } = {},
): {
  readonly provider: ReturnType<typeof createSelfhostProvider>;
  readonly store: VectorIndexStore;
} {
  const root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-vector-"));
  roots.push(root);
  const store = options.store ?? createVectorIndexStore({ sql: createEphemeralSql() });
  const configuration: SelfhostProviderOptions = {
    offerings: options.offerings ?? [VECTOR_OFFERING],
    vectorIndexStore: store,
    dataRoot: root,
    runtime: runtime(),
    artifacts: {
      async manifest() {
        return null;
      },
      async blob() {
        return null;
      },
    },
  };
  return { provider: createSelfhostProvider(configuration), store };
}

function applyInput(
  identity: ResourceIdentity = identities.first,
  overrides: Partial<Parameters<ReturnType<typeof createSelfhostProvider>["apply"]>[0]> = {},
): Parameters<ReturnType<typeof createSelfhostProvider>["apply"]>[0] {
  return {
    operationId: "vector-apply",
    operationMode: "initial",
    offering: VECTOR_OFFERING,
    identity,
    spec: VECTOR_CONFIG,
    ...overrides,
  };
}

function expectFailure(
  ticket: ProviderTicket,
  code: ProviderFailure["code"],
  retryable?: boolean,
): void {
  expect(ticket.phase).toBe("failed");
  if (ticket.phase !== "failed") return;
  expect(ticket.failure.code).toBe(code);
  if (retryable !== undefined) expect(ticket.failure.retryable).toBe(retryable);
}

describe("self-host VectorIndex lifecycle seam", () => {
  test("requires an explicitly offered VectorIndex and keeps the default provider undiscoverable", async () => {
    const local = provider({ offerings: [] }).provider;
    expect(local.offerings).toEqual([]);
    const ticket = await local.apply(applyInput());
    expectFailure(ticket, "invalid_spec", false);
  });

  test("creates idempotently, observes immutable config, and exposes only bounded observation", async () => {
    const local = provider().provider;
    const created = await local.apply(applyInput());
    expect(created.phase).toBe("succeeded");
    if (created.phase !== "succeeded") return;
    expect(created.result.observed).toEqual({
      dimension: 3,
      metric: "cosine",
      filterKeys: ["spaceId"],
      count: 0,
    });
    expect(created.result.outputs).toEqual({});
    expect(created.result.nativeId).toMatch(/^selfhost-vector:tvi-[0-9a-f]{64}$/u);

    const repeated = await local.apply(
      applyInput(identities.first, {
        operationId: "vector-apply-retry",
        previous: { nativeId: created.result.nativeId, spec: VECTOR_CONFIG },
      }),
    );
    expect(repeated).toEqual(created);

    const observed = await local.observe({
      offering: VECTOR_OFFERING,
      nativeId: created.result.nativeId,
      identity: identities.first,
      spec: VECTOR_CONFIG,
    });
    expect(observed).toEqual(created);

    const mismatch = await local.observe({
      offering: VECTOR_OFFERING,
      nativeId: created.result.nativeId,
      identity: identities.first,
      spec: { ...VECTOR_CONFIG, dimension: 4 },
    });
    expectFailure(mismatch, "conflict", false);
  });

  test("rejects missing UID before touching the SQL service", async () => {
    let calls = 0;
    const real = createVectorIndexStore({ sql: createEphemeralSql() });
    const store = Object.assign({}, real, {
      ensureIndex: async (...args: Parameters<VectorIndexStore["ensureIndex"]>) => {
        calls += 1;
        return await real.ensureIndex(...args);
      },
    }) as VectorIndexStore;
    const local = provider({ store }).provider;
    const ticket = await local.apply(
      applyInput({ tenantRef: "org_alpha", space: "default", name: "vectors" }),
    );
    expectFailure(ticket, "invalid_spec", false);
    expect(calls).toBe(0);
  });

  test("scopes native identity by tenant and refuses a cross-tenant native id", async () => {
    const local = provider().provider;
    const first = await local.apply(applyInput(identities.first));
    const second = await local.apply(
      applyInput(identities.secondTenant, { operationId: "vector-apply-other-tenant" }),
    );
    expect(first.phase).toBe("succeeded");
    expect(second.phase).toBe("succeeded");
    if (first.phase !== "succeeded" || second.phase !== "succeeded") return;
    expect(first.result.nativeId).not.toBe(second.result.nativeId);

    const forged = await local.observe({
      offering: VECTOR_OFFERING,
      nativeId: first.result.nativeId,
      identity: identities.secondTenant,
      spec: VECTOR_CONFIG,
    });
    expectFailure(forged, "conflict", false);
  });

  test("maps a transient store outage to retryable unavailable and succeeds on retry", async () => {
    const real = createVectorIndexStore({ sql: createEphemeralSql() });
    let fail = true;
    const store = Object.assign({}, real, {
      ensureIndex: async (...args: Parameters<VectorIndexStore["ensureIndex"]>) => {
        if (fail) {
          fail = false;
          throw new VectorIndexStoreError("unavailable");
        }
        return await real.ensureIndex(...args);
      },
    }) as VectorIndexStore;
    const local = provider({ store }).provider;
    const first = await local.apply(applyInput());
    expectFailure(first, "unavailable", true);
    const second = await local.apply(applyInput(identities.first, { operationId: "vector-retry" }));
    expect(second.phase).toBe("succeeded");
  });

  test("maps the store quota sentinel without claiming a retryable provider outage", async () => {
    const real = createVectorIndexStore({ sql: createEphemeralSql() });
    const store = Object.assign({}, real, {
      ensureIndex: async () => {
        throw new VectorIndexStoreError("quota");
      },
    }) as VectorIndexStore;
    const local = provider({ store }).provider;
    expectFailure(await local.apply(applyInput()), "quota", false);
  });

  test("proves SQL absence after delete and keeps recovery read-only and idempotent", async () => {
    const local = provider().provider;
    const created = await local.apply(applyInput());
    expect(created.phase).toBe("succeeded");
    if (created.phase !== "succeeded") return;
    if (
      !local.createNativeReadbackDescriptor ||
      !local.verifyNativeAbsence ||
      !local.recoverDelete
    ) {
      throw new Error("self-host VectorIndex lifecycle capabilities are missing");
    }
    const descriptor = local.createNativeReadbackDescriptor({
      offering: VECTOR_OFFERING,
      nativeId: created.result.nativeId,
      identity: identities.first,
      spec: VECTOR_CONFIG,
    });
    expect(descriptor).toMatchObject({
      kind: "VectorIndex",
      data: {
        tenantId: identities.first.tenantRef,
        resourceUid: identities.first.uid,
      },
    });
    const target = {
      tenantId: identities.first.tenantRef,
      resourceUid: identities.first.uid as string,
      incarnationId: "dep-vector",
      generation: "1",
    };
    expect(
      await local.verifyNativeAbsence({ offering: VECTOR_OFFERING, descriptor, target }),
    ).toMatchObject({ outcome: "present" });

    const deleted = await local.delete({
      operationId: "vector-delete",
      operationMode: "initial",
      offering: VECTOR_OFFERING,
      nativeId: created.result.nativeId,
      identity: identities.first,
      spec: VECTOR_CONFIG,
    });
    expect(deleted).toMatchObject({
      phase: "succeeded",
      result: {
        nativeId: created.result.nativeId,
        observed: { deleted: true },
        disposition: "deleted",
      },
    });
    expect(
      await local.verifyNativeAbsence({ offering: VECTOR_OFFERING, descriptor, target }),
    ).toMatchObject({ outcome: "absent" });
    expect(
      await local.recoverDelete({
        operationId: "vector-delete-recovery",
        operationMode: "recovery",
        offering: VECTOR_OFFERING,
        nativeId: created.result.nativeId,
        identity: identities.first,
        spec: VECTOR_CONFIG,
      }),
    ).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
  });

  test("apply recovery observes an already durable index and refuses to invent one", async () => {
    const local = provider().provider;
    if (!local.recoverApply) throw new Error("self-host provider is missing apply recovery");
    const recoverApply = local.recoverApply;
    const beforeCreate = await recoverApply(applyInput());
    expectFailure(beforeCreate, "unavailable", true);

    const created = await local.apply(applyInput());
    expect(created.phase).toBe("succeeded");
    if (created.phase !== "succeeded") return;
    const recovered = await recoverApply(
      applyInput(identities.first, {
        operationId: "vector-recover",
        operationMode: "recovery",
        previous: { nativeId: created.result.nativeId, spec: VECTOR_CONFIG },
      }),
    );
    expect(recovered).toEqual(created);
  });
});
