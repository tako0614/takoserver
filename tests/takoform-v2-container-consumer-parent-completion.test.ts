import { expect, test } from "bun:test";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import {
  createV2ContainerConsumerParentIoQualifier,
  createV2ContainerParentIoQualifier,
  decodeV2ContainerConsumerParentIoBinding,
  decodeV2ContainerParentIoBinding,
  isContainerConsumerParentIoTarget,
  readV2ContainerConsumerParentIoOriginal,
  type V2ContainerConsumerParentIoBinding,
  type V2ContainerConsumerParentIoClaim,
  type V2ContainerConsumerParentIoOriginal,
  type V2ContainerConsumerParentIoTarget,
  v2ContainerConsumerParentIoOriginalDigest,
  v2ContainerParentIoOriginalDigest,
} from "../src/takoform-v2/container-parent-completion.ts";
import type { V2WorkerInvocationRecord } from "../src/worker-invocation-port.ts";

const bindingFormat = "takoserver.container-parent-io-binding@2";
const originalFormat = "takoserver.container-parent-io-original@2";
const digest = `sha256:${"b".repeat(64)}` as const;
const one = "https://edge.forms.takoform.com/forms/Container/0.1.0/";
const two = "https://edge.forms.takoform.com/forms/Container/0.2.0/";

function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("expected qualified content");
  return value;
}

// Controlled source ports. Equality models an already selected accepted source;
// this fixture does not supply a physical owner, issuer or runtime authority.
function fixture(targetFormUrl: V2ContainerConsumerParentIoTarget["targetFormUrl"] = one) {
  const record: V2WorkerInvocationRecord = {
    handle: { invocationId: "parent-1", custodyToken: "fixture-custody-token-1" },
    backendId: "backend-1",
    targetKey: "host-1",
    principal: "principal-1",
    space: "space-1",
    workerUid: "worker-1",
    deploymentUid: "deployment-1",
    deploymentGeneration: 2,
    sourceOperationId: "deployment-op-2",
    versionUid: "version-1",
    versionGeneration: 3,
    versionOperationId: "version-op-3",
    nativeIdentity: "native-1",
    closureDigest: digest,
    confirmedReceipt: "receipt-1",
    ingress: { kind: "endpoint", endpointUid: "endpoint-1", endpointGeneration: 4 },
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
    sqliteDrainReceiptDigest: _receipt,
    retirement: _retirement,
    ...expected
  } = record;
  const claim: V2ContainerConsumerParentIoClaim = {
    handle: structuredClone(handle),
    expected: structuredClone(expected),
    target: {
      producerId: "issued-child-1",
      bindingName: "CONTAINER",
      workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.8.0/",
      targetFormUrl,
      targetUid: "container-1",
      targetGeneration: 5,
      targetSourceOperationId: "container-op-5",
      providerInstallationId: "installation-1",
      incarnationId: "incarnation-1",
      servingRevision: "revision-1",
      ownerId: "owner-1",
    },
  };
  const selected = canonicalJson(claim);
  const state: { record: V2WorkerInvocationRecord | null; authorized: boolean } = {
    record: structuredClone(record),
    authorized: true,
  };
  const ports = {
    readParent: async () => structuredClone(state.record),
    authorize: async (candidate: V2ContainerConsumerParentIoClaim) =>
      state.authorized && canonicalJson(candidate) === selected,
  };
  return {
    claim,
    record,
    state,
    ports,
    qualify: createV2ContainerConsumerParentIoQualifier(ports),
  };
}

async function complete(binding: V2ContainerConsumerParentIoBinding) {
  const payload: Omit<V2ContainerConsumerParentIoOriginal, "receiptDigest"> = {
    format: originalFormat,
    bindingDigest: binding.digest,
    producerId: binding.producerId,
    ownerEpoch: 2,
    completedAtMs: 1000,
    outcome: "transport_io_complete",
  };
  return { ...payload, receiptDigest: await v2ContainerConsumerParentIoOriginalDigest(payload) };
}

test("explicit @2 qualifies both accepted Container Forms without changing @1", async () => {
  for (const form of [one, two] as const) {
    const f = fixture(form);
    const binding = required(await f.qualify(f.claim));
    const scope = required(await decodeV2ContainerConsumerParentIoBinding(binding));
    expect(scope.format).toBe(bindingFormat);
    expect(scope.target).toEqual(f.claim.target);
    expect(scope.parent.invocationId).toBe(f.record.handle.invocationId);
    expect(binding.canonical).not.toContain(f.claim.handle.custodyToken);
    expect(Object.keys(binding).sort()).toEqual([
      "canonical",
      "digest",
      "producerId",
      "stillCurrent",
    ]);
    expect(Object.isFrozen(scope.parent)).toBe(true);
    expect(Object.isFrozen(scope.target)).toBe(true);
    expect(await decodeV2ContainerParentIoBinding(binding)).toBeNull();
    let authorizeCalls = 0;
    const old = createV2ContainerParentIoQualifier({
      readParent: f.ports.readParent,
      authorize: async () => {
        authorizeCalls++;
        throw new Error("foreign Form must refuse before authorize");
      },
    });
    // The old typed contract also refuses the same untrusted content at runtime.
    expect(await old(JSON.parse(JSON.stringify(f.claim)))).toBeNull();
    expect(authorizeCalls).toBe(0);
  }
});

test("@2 refuses old, foreign, malformed and surplus targets before authorization", async () => {
  const f = fixture();
  let authorizeCalls = 0;
  const qualify = createV2ContainerConsumerParentIoQualifier({
    ...f.ports,
    authorize: async (claim) => {
      authorizeCalls++;
      return f.ports.authorize(claim);
    },
  });
  for (const target of [
    {
      ...f.claim.target,
      workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/",
    },
    { ...f.claim.target, targetFormUrl: "https://edge.forms.takoform.com/forms/Container/0.3.0/" },
    { ...f.claim.target, targetGeneration: 0 },
    { ...f.claim.target, ready: true },
    { ...f.claim.target, ownerId: "" },
  ]) {
    expect(isContainerConsumerParentIoTarget(target)).toBe(false);
    expect(await qualify(JSON.parse(JSON.stringify({ ...f.claim, target })))).toBeNull();
    expect(authorizeCalls).toBe(0);
  }
});

test("@2 binds every accepted parent, custody and physical target coordinate", async () => {
  const f = fixture();
  for (const key of Object.keys(f.claim.target)) {
    const changed = structuredClone(f.claim);
    Object.assign(changed.target, { [key]: key === "targetGeneration" ? 6 : "other" });
    expect(await f.qualify(changed)).toBeNull();
  }
  for (const key of Object.keys(f.claim.expected)) {
    const changed = structuredClone(f.claim);
    Object.assign(changed.expected, { [key]: key.endsWith("Generation") ? 9 : "other" });
    expect(await f.qualify(changed)).toBeNull();
  }
  for (const key of ["invocationId", "custodyToken"] as const) {
    const changed = structuredClone(f.claim);
    Object.assign(changed.handle, { [key]: "different-parent-custody" });
    expect(await f.qualify(changed)).toBeNull();
  }
  f.state.record = null;
  expect(await f.qualify(f.claim)).toBeNull();
});

test("@2 checks revocation across hashing and before the producer's later send", async () => {
  const f = fixture(two);
  let reads = 0;
  const qualify = createV2ContainerConsumerParentIoQualifier({
    ...f.ports,
    readParent: async () => {
      if (++reads === 2) f.state.authorized = false;
      return structuredClone(f.state.record);
    },
  });
  expect(await qualify(f.claim)).toBeNull();
  expect(reads).toBe(2);
  f.state.authorized = true;
  const binding = required(await f.qualify(f.claim));
  f.state.authorized = false;
  expect(await binding.stillCurrent()).toBe(false);
  // Retained content remains decodable; decoding never reauthorizes a send.
  expect(await decodeV2ContainerConsumerParentIoBinding(binding)).not.toBeNull();
});

test("@2 refuses retired, undispatched and changed parent rows", async () => {
  const f = fixture();
  for (const changed of [
    { ...f.record, phase: "retired" },
    { ...f.record, retirement: { closed: true } },
    { ...f.record, noNativeDispatchAtMs: 1 },
    { ...f.record, nativeIdentity: "replacement" },
    { ...f.record, handle: { ...f.record.handle, custodyToken: "replacement-custody" } },
  ]) {
    const qualify = createV2ContainerConsumerParentIoQualifier({
      ...f.ports,
      readParent: async () => JSON.parse(JSON.stringify(changed)),
    });
    expect(await qualify(f.claim)).toBeNull();
  }
});

test("@2 captures claims before asynchronous ports and resists port mutation", async () => {
  const f = fixture();
  const qualify = createV2ContainerConsumerParentIoQualifier({
    readParent: async (handle) => {
      Object.assign(handle, { invocationId: "port-mutated" });
      return structuredClone(f.record);
    },
    authorize: async (claim) => {
      const allowed = await f.ports.authorize(claim);
      Object.assign(claim.target, { ownerId: "port-mutated" });
      return allowed;
    },
  });
  const pending = qualify(f.claim);
  Object.assign(f.claim.target, { ownerId: "caller-mutated" });
  const binding = required(await pending);
  expect(required(await decodeV2ContainerConsumerParentIoBinding(binding)).target.ownerId).toBe(
    "owner-1",
  );
  expect(await binding.stillCurrent()).toBe(true);
});

test("@2 decoder rejects cross-format and self-rehashed surplus content", async () => {
  const f = fixture();
  const binding = required(await f.qualify(f.claim));
  const scope = required(await decodeV2ContainerConsumerParentIoBinding(binding));
  for (const changed of [
    { ...scope, format: "takoserver.container-parent-io-binding@1" },
    { ...scope, grant: true },
    { ...scope, parent: { ...scope.parent, custodyToken: "not-a-grant" } },
    { ...scope, parent: { ...scope.parent, selectionDigest: "bad" } },
    { ...scope, target: { ...scope.target, closed: true } },
    {
      ...scope,
      target: {
        ...scope.target,
        workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/",
      },
    },
  ]) {
    const canonical = canonicalJson(changed);
    const changedBinding = {
      ...binding,
      canonical,
      digest: await bytesDigest(new TextEncoder().encode(`${bindingFormat}\0${canonical}`)),
    };
    expect(await decodeV2ContainerConsumerParentIoBinding(changedBinding)).toBeNull();
  }
  const oldCanonical = canonicalJson({
    ...scope,
    format: "takoserver.container-parent-io-binding@1",
    target: {
      ...scope.target,
      workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/",
    },
  });
  const oldBinding = {
    ...binding,
    canonical: oldCanonical,
    digest: await bytesDigest(
      new TextEncoder().encode(`takoserver.container-parent-io-binding@1\0${oldCanonical}`),
    ),
  };
  expect(await decodeV2ContainerParentIoBinding(oldBinding)).not.toBeNull();
  expect(await decodeV2ContainerConsumerParentIoBinding(oldBinding)).toBeNull();
});

test("@2 validates only the fixed owner's exact positive original and preserves nonpositive states", async () => {
  for (const form of [one, two] as const) {
    const f = fixture(form);
    const binding = required(await f.qualify(f.claim));
    const original = await complete(binding);
    const result = await readV2ContainerConsumerParentIoOriginal(binding, async (selected) => {
      expect(Object.isFrozen(selected)).toBe(true);
      expect(selected).toEqual({
        producerId: binding.producerId,
        canonical: binding.canonical,
        digest: binding.digest,
      });
      return { state: "complete", original };
    });
    expect(result).toEqual({ state: "complete", original });
    if (result.state === "complete") expect(Object.isFrozen(result.original)).toBe(true);
    for (const state of ["absent", "pending", "unknown"] as const) {
      expect(
        await readV2ContainerConsumerParentIoOriginal(binding, async () => ({ state })),
      ).toEqual({ state });
    }
  }
});

test("@2 rejects synthetic closure, malformed originals and cross-format receipts", async () => {
  const f = fixture(two);
  const binding = required(await f.qualify(f.claim));
  const original = await complete(binding);
  const oldPayload = { ...original, format: "takoserver.container-parent-io-original@1" as const };
  const oldOriginal = {
    ...oldPayload,
    receiptDigest: await v2ContainerParentIoOriginalDigest(oldPayload),
  };
  for (const result of [
    { state: "complete", closed: true },
    { state: "complete", original, pending: 0 },
    { state: "absent", original },
    { state: "complete", original: oldOriginal },
    ...[
      { ...original, bindingDigest: digest },
      { ...original, producerId: "foreign" },
      { ...original, ownerEpoch: 0 },
      { ...original, completedAtMs: 0 },
      { ...original, outcome: "closed" },
      { ...original, receiptDigest: digest },
      { ...original, disposed: true },
    ].map((original) => ({ state: "complete", original })),
  ]) {
    expect(await readV2ContainerConsumerParentIoOriginal(binding, async () => result)).toEqual({
      state: "unknown",
    });
  }
  expect(
    await readV2ContainerConsumerParentIoOriginal(binding, async () => {
      throw new Error("unreadable");
    }),
  ).toEqual({ state: "unknown" });
  let reads = 0;
  expect(
    await readV2ContainerConsumerParentIoOriginal({ ...binding, canonical: "{}" }, async () => {
      reads++;
      return { state: "complete", original };
    }),
  ).toEqual({ state: "unknown" });
  expect(reads).toBe(0);
});
