import { describe, expect, test } from "bun:test";
import type { ProviderOffering, ProviderTicket } from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";

const OFFERING: ProviderOffering = {
  id: "storage.object.standard",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: {
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "ObjectBucket",
    definitionVersion: "0.1.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "observe", "import"],
};

const IDENTITY = { tenantRef: "tenant_x", space: "default", name: "assets" };

function applyInput(overrides: Partial<Parameters<FakeProvider["apply"]>[0]> = {}) {
  return {
    operationId: "op_1",
    offering: OFFERING,
    identity: IDENTITY,
    spec: { location: "apac" },
    ...overrides,
  };
}

describe("provider port", () => {
  test("lets a synchronous backend settle in one call", async () => {
    const provider = new FakeProvider({ offerings: [OFFERING] });
    const ticket = await provider.apply(applyInput());
    expect(ticket.phase).toBe("succeeded");
    if (ticket.phase !== "succeeded") throw new Error("expected success");
    expect(ticket.result.nativeId).toBe("fake:tenant_x/default/assets");
    expect(ticket.result.observed).toEqual({ location: "apac" });
  });

  test("represents work that has not finished, and settles it on poll", async () => {
    const provider = new FakeProvider({
      offerings: [OFFERING],
      mode: "async",
      pollsToSettle: 3,
    });
    const started = await provider.apply(applyInput());
    expect(started.phase).toBe("running");
    if (started.phase !== "running") throw new Error("expected running");
    expect(started.pollAfterMs).toBeGreaterThan(0);

    // The whole point: the operation is a durable thing that outlives the
    // request that started it, and only polling moves it forward.
    let ticket: ProviderTicket = await provider.poll({
      operationId: "op_1",
      handle: started.handle,
    });
    expect(ticket.phase).toBe("running");
    ticket = await provider.poll({ operationId: "op_1", handle: started.handle });
    expect(ticket.phase).toBe("running");
    ticket = await provider.poll({ operationId: "op_1", handle: started.handle });
    expect(ticket.phase).toBe("succeeded");

    // A settled handle is consumed; polling it again is not a second success.
    const after = await provider.poll({ operationId: "op_1", handle: started.handle });
    expect(after.phase).toBe("failed");
  });

  test("reports failure as a classified value rather than throwing", async () => {
    const provider = new FakeProvider({ offerings: [OFFERING], failOn: ["assets"] });
    const ticket = await provider.apply(applyInput());
    expect(ticket.phase).toBe("failed");
    if (ticket.phase !== "failed") throw new Error("expected failure");
    expect(ticket.failure).toMatchObject({ code: "provider_error", retryable: false });
    // Nothing was recorded, so a retry is a clean create rather than a conflict.
    expect(provider.listResources()).toEqual([]);
  });

  test("refuses to create over something that already exists", async () => {
    const provider = new FakeProvider({ offerings: [OFFERING] });
    await provider.apply(applyInput());
    const again = await provider.apply(applyInput({ operationId: "op_2" }));
    expect(again.phase).toBe("failed");
    if (again.phase !== "failed") throw new Error("expected failure");
    expect(again.failure.code).toBe("conflict");
  });

  test("updates in place when a previous native resource is named", async () => {
    const provider = new FakeProvider({ offerings: [OFFERING] });
    const created = await provider.apply(applyInput());
    if (created.phase !== "succeeded") throw new Error("expected success");

    const updated = await provider.apply(
      applyInput({
        operationId: "op_2",
        spec: { location: "weur" },
        previous: { nativeId: created.result.nativeId, spec: { location: "apac" } },
      }),
    );
    expect(updated.phase).toBe("succeeded");
    if (updated.phase !== "succeeded") throw new Error("expected success");
    // Identity survives an update; only observed state moves.
    expect(updated.result.nativeId).toBe(created.result.nativeId);
    expect(updated.result.observed).toEqual({ location: "weur" });
  });

  test("observes and deletes what it created", async () => {
    const provider = new FakeProvider({ offerings: [OFFERING] });
    const created = await provider.apply(applyInput());
    if (created.phase !== "succeeded") throw new Error("expected success");

    const observed = await provider.observe({
      offering: OFFERING,
      nativeId: created.result.nativeId,
      identity: IDENTITY,
      spec: { location: "apac" },
    });
    expect(observed.phase).toBe("succeeded");

    await provider.delete({
      operationId: "op_3",
      offering: OFFERING,
      nativeId: created.result.nativeId,
      identity: IDENTITY,
    });
    expect(provider.listResources()).toEqual([]);
    const missing = await provider.observe({
      offering: OFFERING,
      nativeId: created.result.nativeId,
      identity: IDENTITY,
      spec: {},
    });
    expect(missing.phase).toBe("failed");
  });
});
