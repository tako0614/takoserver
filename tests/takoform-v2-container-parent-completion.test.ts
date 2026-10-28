import { expect, test } from "bun:test";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import {
  createV2ContainerParentIoQualifier,
  readV2ContainerParentIoOriginal,
  type V2ContainerParentIoClaim,
  type V2ContainerParentIoOriginal,
  v2ContainerParentIoOriginalDigest,
} from "../src/takoform-v2/container-parent-completion.ts";
import type { V2WorkerInvocationRecord } from "../src/worker-invocation-port.ts";

const digest = `sha256:${"a".repeat(64)}` as const;
function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("expected qualified binding");
  return value;
}
function fixture() {
  const record: V2WorkerInvocationRecord = {
    handle: { invocationId: "parent-1", custodyToken: "secret-custody-token-1" },
    backendId: "worker-backend",
    targetKey: "host-target",
    principal: "principal",
    space: "space",
    workerUid: "worker-1",
    deploymentUid: "deployment-1",
    deploymentGeneration: 2,
    sourceOperationId: "deployment-operation-2",
    ingress: { kind: "endpoint", endpointUid: "endpoint-1", endpointGeneration: 3 },
    versionUid: "version-1",
    versionGeneration: 4,
    versionOperationId: "version-operation-4",
    nativeIdentity: "native-worker",
    closureDigest: digest,
    confirmedReceipt: "native-receipt",
    phase: "send_authorized",
    bodyState: null,
    noNativeDispatchAtMs: null,
    sqliteDrainState: null,
    sqliteDrainReceiptDigest: null,
    retirement: null,
  };
  const {
    handle,
    phase: _phase,
    bodyState: _body,
    noNativeDispatchAtMs: _noSend,
    sqliteDrainState: _drain,
    sqliteDrainReceiptDigest: _drainReceipt,
    retirement: _retirement,
    ...expected
  } = record;
  const claim: V2ContainerParentIoClaim = {
    handle: structuredClone(handle),
    expected: structuredClone(expected),
    target: {
      producerId: "child-1",
      bindingName: "SERVICE",
      workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/",
      targetFormUrl: "https://edge.forms.takoform.com/forms/Container/0.1.0/",
      targetUid: "container-1",
      targetGeneration: 5,
      targetSourceOperationId: "container-operation-5",
      providerInstallationId: "installation-1",
      incarnationId: "incarnation-1",
      servingRevision: "revision-1",
      ownerId: "owner-1",
    },
  };
  let current = structuredClone(record);
  let authorized = true;
  const qualify = createV2ContainerParentIoQualifier({
    readParent: async () => structuredClone(current),
    authorize: async () => authorized,
  });
  return {
    claim,
    qualify,
    record,
    setRecord: (r: V2WorkerInvocationRecord) => {
      current = r;
    },
    revoke: () => {
      authorized = false;
    },
  };
}
async function complete(
  binding: NonNullable<Awaited<ReturnType<ReturnType<typeof createV2ContainerParentIoQualifier>>>>,
) {
  const payload = {
    format: "takoserver.container-parent-io-original@1" as const,
    bindingDigest: binding.digest,
    producerId: binding.producerId,
    ownerEpoch: 1,
    completedAtMs: 1000,
    outcome: "transport_io_complete" as const,
  };
  return { ...payload, receiptDigest: await v2ContainerParentIoOriginalDigest(payload) };
}

test("qualifies one child scope without serializing plaintext custody or mutable parent state", async () => {
  const { claim, qualify } = fixture();
  const binding = await qualify(claim);
  expect(binding).not.toBeNull();
  expect(binding?.canonical.includes(claim.handle.custodyToken)).toBe(false);
  expect(binding?.canonical.includes("bodyState")).toBe(false);
  expect(JSON.parse(required(binding).canonical).parent.invocationId).toBe(
    claim.handle.invocationId,
  );
  expect(Object.isFrozen(binding)).toBe(true);
  expect(await required(binding).stillCurrent()).toBe(true);
});

test("binds every accepted parent identity, custody and exact target dimension", async () => {
  const f = fixture();
  const first = await f.qualify(f.claim);
  expect(first).not.toBeNull();
  for (const key of Object.keys(f.claim.expected)) {
    const g = fixture();
    const changed = structuredClone(g.claim) as unknown as {
      expected: Record<string, unknown>;
      target: Record<string, unknown>;
    };
    changed.expected[key] = typeof changed.expected[key] === "number" ? 42 : "other";
    expect(await g.qualify(changed as unknown as V2ContainerParentIoClaim)).toBeNull();
  }
  const wrong = structuredClone(f.claim);
  Object.assign(wrong.handle, { custodyToken: "another-custody-token" });
  expect(await f.qualify(wrong)).toBeNull();
  for (const key of Object.keys(f.claim.target)) {
    const other = structuredClone(f.claim) as unknown as {
      expected: Record<string, unknown>;
      target: Record<string, unknown>;
    };
    if (key === "targetFormUrl" || key === "workerVersionFormUrl") continue;
    other.target[key] = typeof other.target[key] === "number" ? 42 : "other";
    const binding = await f.qualify(other as unknown as V2ContainerParentIoClaim);
    expect(binding?.digest).not.toBe(required(first).digest);
  }
});

test("refuses 0.8, other Forms, malformed parent, and pre-send or retired parents", async () => {
  for (const patch of [
    { phase: "admitted" },
    { noNativeDispatchAtMs: 1 },
    { retirement: { retiredAtMs: 1, receiptDigest: digest } },
  ]) {
    const f = fixture();
    f.setRecord({ ...f.record, ...patch } as V2WorkerInvocationRecord);
    expect(await f.qualify(f.claim)).toBeNull();
  }
  for (const target of [
    { workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.8.0/" },
    { targetFormUrl: "https://edge.forms.takoform.com/forms/Container/0.2.0/" },
    { targetGeneration: 0 },
    { servingRevision: "" },
    { producerId: "x\0y" },
  ]) {
    const f = fixture();
    expect(
      await f.qualify({
        ...f.claim,
        target: { ...f.claim.target, ...target },
      } as V2ContainerParentIoClaim),
    ).toBeNull();
  }
});

test("rechecks authorization after async hashing and captures claim before awaits", async () => {
  const f = fixture();
  let calls = 0;
  const qualify = createV2ContainerParentIoQualifier({
    readParent: async () => structuredClone(f.record),
    authorize: async () => ++calls === 1,
  });
  expect(await qualify(f.claim)).toBeNull();
  let release: () => void = () => {
    throw new Error("barrier not initialized");
  };
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const capture = createV2ContainerParentIoQualifier({
    readParent: async () => {
      await barrier;
      return structuredClone(f.record);
    },
    authorize: async () => true,
  });
  const pending = capture(f.claim);
  Object.assign(f.claim.target, { servingRevision: "substituted" });
  release();
  const binding = await pending;
  expect(JSON.parse(required(binding).canonical).target.servingRevision).toBe("revision-1");
});

test("a qualified scope is not a permanent admission grant", async () => {
  const f = fixture();
  const binding = await f.qualify(f.claim);
  f.revoke();
  expect(await required(binding).stillCurrent()).toBe(false);
});

test("validates exact immutable original through the fixed trusted owner reader", async () => {
  const f = fixture();
  const binding = required(await f.qualify(f.claim));
  const original = await complete(binding);
  const result = await readV2ContainerParentIoOriginal(binding, async () => ({
    state: "complete",
    original,
  }));
  expect(result.state).toBe("complete");
  if (result.state !== "complete") throw new Error("no original");
  expect(result.original).toEqual(original);
  expect(Object.isFrozen(result.original)).toBe(true);
  expect("retired" in result).toBe(false);
});

test("absent, pending, unknown, reader loss and old transport DTOs never become positive", async () => {
  const f = fixture();
  const binding = required(await f.qualify(f.claim));
  for (const state of ["absent", "pending", "unknown"] as const)
    expect(await readV2ContainerParentIoOriginal(binding, async () => ({ state }))).toEqual({
      state,
    });
  for (const value of [
    null,
    { closed: true },
    { ready: true },
    { active: 0 },
    {},
    { state: "complete" },
    { state: "complete", original: { done: true } },
  ])
    expect((await readV2ContainerParentIoOriginal(binding, async () => value)).state).toBe(
      "unknown",
    );
  expect(
    (
      await readV2ContainerParentIoOriginal(binding, async () => {
        throw new Error("ACK lost");
      })
    ).state,
  ).toBe("unknown");
});

test("rejects wrong binding/producer/format/epoch/outcome/hash and surplus receipt fields", async () => {
  const f = fixture();
  const binding = required(await f.qualify(f.claim));
  const original = await complete(binding);
  for (const patch of [
    { bindingDigest: `sha256:${"b".repeat(64)}` },
    { producerId: "other-child" },
    { format: "takoserver.container-parent-io-original@2" },
    { ownerEpoch: 0 },
    { completedAtMs: -1 },
    { outcome: "canceled" },
    { receiptDigest: digest },
    { closed: true },
  ]) {
    expect(
      (
        await readV2ContainerParentIoOriginal(binding, async () => ({
          state: "complete",
          original: { ...original, ...patch },
        }))
      ).state,
    ).toBe("unknown");
  }
});

test("different child producer cannot replay a valid sibling original", async () => {
  const f = fixture();
  const a = required(await f.qualify(f.claim));
  const original = await complete(a);
  Object.assign(f.claim.target, { producerId: "child-2" });
  const b = required(await f.qualify(f.claim));
  expect(
    (await readV2ContainerParentIoOriginal(b, async () => ({ state: "complete", original }))).state,
  ).toBe("unknown");
});

test("receipt is detached before digest await and equivalent readback preserves original bytes", async () => {
  const f = fixture();
  const binding = required(await f.qualify(f.claim));
  const original = await complete(binding);
  const a = await readV2ContainerParentIoOriginal(binding, async () => ({
    state: "complete",
    original,
  }));
  const b = await readV2ContainerParentIoOriginal(binding, async () =>
    JSON.parse(JSON.stringify({ state: "complete", original })),
  );
  expect(canonicalJson(a)).toBe(canonicalJson(b));
  Object.assign(original, { completedAtMs: 9999 });
  if (a.state !== "complete") throw new Error("no original");
  expect(a.original.completedAtMs).toBe(1000);
  const payload: Omit<V2ContainerParentIoOriginal, "receiptDigest"> = { ...a.original };
  expect(await v2ContainerParentIoOriginalDigest(payload)).toBe(a.original.receiptDigest);
});

test("a well-hashed original for another binding or producer is still refused", async () => {
  const f = fixture();
  const binding = required(await f.qualify(f.claim));
  const original = await complete(binding);
  for (const patch of [
    { bindingDigest: `sha256:${"b".repeat(64)}` as const },
    { producerId: "wrong-child" },
  ]) {
    const changed = { ...original, ...patch };
    changed.receiptDigest = await v2ContainerParentIoOriginalDigest(changed);
    expect(
      (
        await readV2ContainerParentIoOriginal(binding, async () => ({
          state: "complete",
          original: changed,
        }))
      ).state,
    ).toBe("unknown");
  }
});

test("source-selected target authority can refuse a structurally valid scope", async () => {
  const f = fixture();
  const qualify = createV2ContainerParentIoQualifier({
    readParent: async () => structuredClone(f.record),
    authorize: async (claim) => canonicalJson(claim.target) === canonicalJson(f.claim.target),
  });
  for (const key of Object.keys(f.claim.target)) {
    const altered = structuredClone(f.claim);
    Object.assign(altered.target, {
      [key]: typeof altered.target[key as keyof typeof altered.target] === "number" ? 99 : "wrong",
    });
    expect(await qualify(altered)).toBeNull();
  }
});

test("valid cron/service identities qualify and valid-shaped identity substitutions refuse", async () => {
  const ingress = [
    {
      kind: "cron" as const,
      matchId: digest,
      triggerOperationId: "trigger-operation",
      leaseToken: "host-issued-lease-token",
      attempt: 1,
    },
    {
      kind: "service" as const,
      callerWorkerUid: "caller",
      callerVersionUid: "caller-version",
      callerVersionGeneration: 1,
      callerVersionOperationId: "caller-operation",
      bindingName: "TARGET",
      callerExecutionRef: "execution-1",
    },
  ];
  for (const value of ingress) {
    const f = fixture();
    f.setRecord({ ...f.record, ingress: value });
    Object.assign(f.claim.expected, { ingress: value });
    expect(await f.qualify(f.claim)).not.toBeNull();
    Object.assign(f.claim.expected, {
      ingress: {
        ...value,
        ...(value.kind === "cron" ? { attempt: 2 } : { callerExecutionRef: "execution-2" }),
      },
    });
    expect(await f.qualify(f.claim)).toBeNull();
  }
  const f = fixture();
  Object.assign(f.claim.expected, { closureDigest: `sha256:${"b".repeat(64)}` });
  expect(await f.qualify(f.claim)).toBeNull();
  const g = fixture();
  Object.assign(g.claim.expected.ingress, { endpointUid: "different-valid-endpoint" });
  expect(await g.qualify(g.claim)).toBeNull();
});

test("surplus fields, number strings and unknown ingress kinds refuse", async () => {
  for (const part of ["claim", "handle", "expected", "target"] as const) {
    const f = fixture();
    Object.assign(part === "claim" ? f.claim : f.claim[part], { extra: "ignored?" });
    expect(await f.qualify(f.claim)).toBeNull();
  }
  const f = fixture();
  Object.assign(f.claim.target, { targetGeneration: "5" });
  expect(await f.qualify(f.claim)).toBeNull();
  const g = fixture();
  Object.assign(g.claim.expected.ingress, { kind: "other" });
  expect(await g.qualify(g.claim)).toBeNull();
});

test("malformed stored bindings refuse before the trusted original reader", async () => {
  const f = fixture();
  const binding = required(await f.qualify(f.claim));
  let reads = 0;
  const read = async () => {
    reads++;
    return { state: "absent" };
  };
  for (const patch of [
    { canonical: "{}" },
    { canonical: "x".repeat(65537) },
    { digest: `sha256:${"b".repeat(64)}` },
    { producerId: "other-producer" },
  ]) {
    expect(
      (await readV2ContainerParentIoOriginal({ ...binding, ...patch } as typeof binding, read))
        .state,
    ).toBe("unknown");
  }
  const scope = JSON.parse(binding.canonical);
  scope.target.workerVersionFormUrl = "https://edge.forms.takoform.com/forms/WorkerVersion/0.8.0/";
  const canonical = canonicalJson(scope);
  const altered = {
    ...binding,
    canonical,
    digest: await bytesDigest(
      new TextEncoder().encode(`takoserver.container-parent-io-binding@1\0${canonical}`),
    ),
  };
  expect((await readV2ContainerParentIoOriginal(altered, read)).state).toBe("unknown");
  expect(reads).toBe(0);
});

test("nonpositive result objects cannot smuggle fields or coerce their state", async () => {
  const f = fixture();
  const binding = required(await f.qualify(f.claim));
  for (const value of [{ state: "pending", extra: true }, { state: ["absent"] }, { state: 0 }])
    expect((await readV2ContainerParentIoOriginal(binding, async () => value)).state).toBe(
      "unknown",
    );
});

test("parent custody is checked again after the asynchronous binding construction", async () => {
  const f = fixture();
  let reads = 0;
  const qualify = createV2ContainerParentIoQualifier({
    readParent: async () => ({
      ...f.record,
      phase: ++reads === 1 ? "send_authorized" : "pre_effect_refused",
    }),
    authorize: async () => true,
  });
  expect(await qualify(f.claim)).toBeNull();
  expect(reads).toBe(2);
});
