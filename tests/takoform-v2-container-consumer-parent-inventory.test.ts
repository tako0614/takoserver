import { expect, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import {
  type V2ContainerConsumerParentIoBinding,
  type V2ContainerConsumerParentIoClaim,
  type V2ContainerConsumerParentIoTarget,
  type V2ContainerParentIoClaim,
  v2ContainerConsumerParentIoOriginalDigest,
} from "../src/takoform-v2/container-parent-completion.ts";
import {
  createV2ContainerConsumerParentIoInventory,
  createV2ContainerParentIoInventory,
  type V2ContainerParentIoInventoryStorage,
} from "../src/takoform-v2/container-parent-io-inventory.ts";
import type { V2WorkerInvocationRecord } from "../src/worker-invocation-port.ts";

const digest = `sha256:${"c".repeat(64)}` as const;
const one = "https://edge.forms.takoform.com/forms/Container/0.1.0/";
const two = "https://edge.forms.takoform.com/forms/Container/0.2.0/";
const target: Omit<V2ContainerConsumerParentIoTarget, "producerId"> = {
  bindingName: "CONTAINER",
  workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.8.0/",
  targetFormUrl: one,
  targetUid: "container-1",
  targetGeneration: 3,
  targetSourceOperationId: "container-op-3",
  providerInstallationId: "installation-1",
  incarnationId: "incarnation-1",
  servingRevision: "revision-1",
  ownerId: "owner-1",
};
const legacyTarget: Omit<V2ContainerParentIoClaim["target"], "producerId"> = {
  ...target,
  workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/" as const,
  targetFormUrl: one,
};

function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("expected registered child");
  return value;
}

// Atomic clone-on-read storage and fixed source ports, not a physical producer.
function fixture() {
  let rows = new Map<string, unknown>();
  let queue = Promise.resolve();
  let loseAcknowledgement = false;
  const get = async (key: string) => structuredClone(rows.get(key));
  const put = async (key: string, value: unknown) => {
    rows.set(key, structuredClone(value));
  };
  const storage: V2ContainerParentIoInventoryStorage = {
    get,
    put,
    async transaction<T>(callback: (tx: { get: typeof get; put: typeof put }) => Promise<T>) {
      const operation = queue.then(async () => {
        const before = structuredClone(rows);
        let value: T;
        try {
          value = await callback({ get, put });
        } catch (error) {
          rows = before;
          throw error;
        }
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("durable commit acknowledgement lost");
        }
        return value;
      });
      queue = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
    async list({ prefix, startAfter, limit }) {
      return new Map(
        [...rows]
          .filter(
            ([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter),
          )
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit)
          .map(([key, value]) => [key, structuredClone(value)]),
      );
    },
  };
  const record: V2WorkerInvocationRecord = {
    handle: { invocationId: "parent-1", custodyToken: "fixture-parent-custody-1" },
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
  const parent = { handle: structuredClone(handle), expected: structuredClone(expected) };
  const state: {
    record: V2WorkerInvocationRecord | null;
    authorized: boolean;
    beforeAuthorize?: () => Promise<void>;
    beforeOriginal?: () => Promise<void>;
  } = { record: structuredClone(record), authorized: true };
  const originals = new Map<string, unknown>();
  const reads: string[] = [];
  const options = {
    storage,
    readParent: async () => structuredClone(state.record),
    authorize: async (claim: V2ContainerConsumerParentIoClaim | V2ContainerParentIoClaim) => {
      await state.beforeAuthorize?.();
      const { producerId: _producer, ...selected } = claim.target;
      return (
        state.authorized &&
        canonicalJson(claim.handle) === canonicalJson(parent.handle) &&
        canonicalJson(claim.expected) === canonicalJson(parent.expected) &&
        [target, { ...target, targetFormUrl: two }, legacyTarget].some(
          (accepted) => canonicalJson(accepted) === canonicalJson(selected),
        )
      );
    },
    readOriginal: async (binding: V2ContainerConsumerParentIoBinding) => {
      reads.push(binding.producerId);
      await state.beforeOriginal?.();
      return structuredClone(originals.get(binding.producerId) ?? { state: "absent" });
    },
  };
  return {
    parent,
    record,
    state,
    storage,
    originals,
    reads,
    options,
    reopen: () => createV2ContainerConsumerParentIoInventory(options),
    rows: () => rows,
    restore: (saved: Map<string, unknown>) => {
      rows = structuredClone(saved);
    },
    loseNextAcknowledgement: () => {
      loseAcknowledgement = true;
    },
    retire: () => {
      state.record = { ...record, retirement: { retiredAtMs: 1000, receiptDigest: digest } };
    },
  };
}

async function original(binding: V2ContainerConsumerParentIoBinding) {
  const payload = {
    format: "takoserver.container-parent-io-original@2" as const,
    bindingDigest: binding.digest,
    producerId: binding.producerId,
    ownerEpoch: 1,
    completedAtMs: 1000,
    outcome: "transport_io_complete" as const,
  };
  return {
    state: "complete",
    original: {
      ...payload,
      receiptDigest: await v2ContainerConsumerParentIoOriginalDigest(payload),
    },
  };
}

test("@2 retains both Form's exact originals, nonpositive states and sealed set across restart", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.open(f.parent)).toBe(true);
  const first = required(await owner.issue(f.parent, target));
  const second = required(await owner.issue(f.parent, { ...target, targetFormUrl: two }));
  expect(first.producerId).not.toBe(second.producerId);
  expect(JSON.parse(first.canonical).format).toBe("takoserver.container-parent-io-binding@2");
  f.originals.set(first.producerId, await original(first));
  expect((await owner.read(f.parent)).state).toBe("open");
  f.retire();
  expect(await owner.seal(f.parent)).toBe(true);
  expect(await first.stillCurrent()).toBe(false);
  expect(await owner.issue(f.parent, target)).toBeNull();
  for (const state of ["absent", "pending", "unknown"] as const) {
    f.originals.set(second.producerId, { state });
    expect(await owner.read(f.parent)).toEqual({ state });
  }
  f.originals.set(second.producerId, await original(second));
  expect(await owner.read(f.parent)).toEqual({ state: "sealed_io_complete", childCount: 2 });
  const successor = await f.reopen();
  expect(await successor.read(f.parent)).toEqual({ state: "sealed_io_complete", childCount: 2 });
  expect((await owner.read(f.parent)).state).toBe("unknown");
  expect(JSON.stringify([...f.rows()])).not.toContain(f.parent.handle.custodyToken);
  expect(JSON.stringify([...f.rows()])).not.toContain("stillCurrent");
});

test("@2 namespace and epoch never rewrite @1 or interpret its children as the new set", async () => {
  const f = fixture();
  const old = await createV2ContainerParentIoInventory(f.options);
  expect(await old.open(f.parent)).toBe(true);
  const legacy = required(await old.issue(f.parent, legacyTarget));
  const oldRows = new Map(
    [...f.rows()].filter(([key]) => key.startsWith("container-parent-io/v1/")),
  );
  const owner = await f.reopen();
  expect(await owner.read(f.parent)).toEqual({ state: "absent" });
  expect(await legacy.stillCurrent()).toBe(true);
  expect(await owner.open(f.parent)).toBe(true);
  const current = required(await owner.issue(f.parent, target));
  expect(await old.issue(f.parent, JSON.parse(JSON.stringify(target)))).toBeNull();
  expect(await owner.issue(f.parent, JSON.parse(JSON.stringify(legacyTarget)))).toBeNull();
  expect(
    new Map([...f.rows()].filter(([key]) => key.startsWith("container-parent-io/v1/"))),
  ).toEqual(oldRows);
  await createV2ContainerParentIoInventory(f.options);
  expect(await legacy.stillCurrent()).toBe(false);
  expect(await current.stillCurrent()).toBe(true);
});

test("@2 restart cannot reopen or drop an old unresolved child; native recovery only seals it", async () => {
  const f = fixture();
  const old = await f.reopen();
  expect(await old.open(f.parent)).toBe(true);
  const binding = required(await old.issue(f.parent, target));
  const owner = await f.reopen();
  expect(await binding.stillCurrent()).toBe(false);
  expect(await owner.open(f.parent)).toBe(false);
  expect(await owner.issue(f.parent, target)).toBeNull();
  expect(await owner.seal(f.parent)).toBe(false);
  expect(await owner.sealAfterNativeRetirement(f.parent)).toBe(false);
  f.retire();
  expect(await owner.sealAfterNativeRetirement(f.parent)).toBe(true);
  expect(await owner.read(f.parent)).toEqual({ state: "absent" });
  f.originals.set(binding.producerId, { state: "unknown" });
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
  f.originals.set(binding.producerId, await original(binding));
  expect(await owner.read(f.parent)).toEqual({ state: "sealed_io_complete", childCount: 1 });
  expect([...f.rows().keys()].filter((key) => key.includes("/child/"))).toHaveLength(1);
});

test("@2 revocation after durable issue retains an unbound child instead of an empty success", async () => {
  const f = fixture();
  const owner = await f.reopen();
  await owner.open(f.parent);
  f.state.beforeAuthorize = async () => {
    f.state.authorized = false;
  };
  expect(await owner.issue(f.parent, target)).toBeNull();
  expect(await owner.seal(f.parent)).toBe(true);
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
  const successor = await f.reopen();
  expect(await successor.read(f.parent)).toEqual({ state: "unknown" });
  expect(
    [...f.rows().values()].filter((row) => JSON.stringify(row).includes('"binding":null')),
  ).toHaveLength(1);
});

test("@2 seal fences in-flight authorization without erasing its committed issuance", async () => {
  const f = fixture();
  const owner = await f.reopen();
  await owner.open(f.parent);
  let entered!: () => void;
  let release!: () => void;
  const start = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.beforeAuthorize = async () => {
    entered();
    await gate;
  };
  const pending = owner.issue(f.parent, target);
  await start;
  expect(await owner.seal(f.parent)).toBe(true);
  release();
  expect(await pending).toBeNull();
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
});

test("@2 lost commit ACK preserves the registered unresolved intent without replay", async () => {
  const f = fixture();
  const owner = await f.reopen();
  await owner.open(f.parent);
  f.loseNextAcknowledgement();
  expect(await owner.issue(f.parent, target)).toBeNull();
  expect(await owner.seal(f.parent)).toBe(true);
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
  const successor = await f.reopen();
  expect(await successor.issue(f.parent, target)).toBeNull();
  expect(await successor.read(f.parent)).toEqual({ state: "unknown" });
  expect([...f.rows().keys()].filter((key) => key.includes("/child/"))).toHaveLength(1);
});

test("@2 lost retirement seal ACK leaves admission sealed but does not fabricate child I/O", async () => {
  const f = fixture();
  const owner = await f.reopen();
  await owner.open(f.parent);
  const binding = required(await owner.issue(f.parent, target));
  f.retire();
  f.loseNextAcknowledgement();
  expect(await owner.sealAfterNativeRetirement(f.parent)).toBe(false);
  expect(await owner.issue(f.parent, target)).toBeNull();
  expect(await owner.read(f.parent)).toEqual({ state: "absent" });
  f.originals.set(binding.producerId, { state: "complete", closed: true });
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
  f.originals.set(binding.producerId, await original(binding));
  expect(await owner.read(f.parent)).toEqual({ state: "sealed_io_complete", childCount: 1 });
});

test("@2 refuses foreign custody, absent sets and non-native retirement markers", async () => {
  const f = fixture();
  const owner = await f.reopen();
  f.retire();
  expect(await owner.sealAfterNativeRetirement(f.parent)).toBe(false);
  f.state.record = structuredClone(f.record);
  await owner.open(f.parent);
  f.retire();
  const retired = required(f.state.record);
  expect(
    await owner.sealAfterNativeRetirement({
      ...f.parent,
      handle: { ...f.parent.handle, custodyToken: "foreign-parent-token" },
    }),
  ).toBe(false);
  for (const record of [
    { ...retired, noNativeDispatchAtMs: 1 },
    { ...retired, retirement: null },
    { ...retired, retirement: { retiredAtMs: 0, receiptDigest: digest } },
    { ...retired, retirement: { retiredAtMs: 1000, receiptDigest: digest, closed: true } },
  ]) {
    f.state.record = JSON.parse(JSON.stringify(record));
    expect(await owner.sealAfterNativeRetirement(f.parent)).toBe(false);
  }
});

test("@2 refuses corrupted counts, cross-profile rows and changed bindings", async () => {
  const f = fixture();
  const owner = await f.reopen();
  await owner.open(f.parent);
  const binding = required(await owner.issue(f.parent, target));
  f.originals.set(binding.producerId, await original(binding));
  await owner.seal(f.parent);
  const saved = structuredClone(f.rows());
  const childKey = required([...saved.keys()].find((key) => key.includes("/child/")));
  const headerKey = required(childKey.split("/child/")[0]);
  const child = JSON.parse(JSON.stringify(saved.get(childKey)));
  const header = JSON.parse(JSON.stringify(saved.get(headerKey)));
  for (const [key, value] of [
    [headerKey, { ...header, format: "takoserver.container-parent-io-inventory@1" }],
    [headerKey, { ...header, next: 0 }],
    [childKey, { ...child, format: "takoserver.container-parent-io-inventory-child@1" }],
    [childKey, { ...child, binding: { ...child.binding, digest } }],
    [childKey, { ...child, target: { ...child.target, ownerId: "foreign" } }],
  ] as const) {
    f.restore(saved);
    await f.storage.put(key, value);
    expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
  }
  f.restore(saved);
  f.rows().delete(childKey);
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
  f.restore(saved);
  f.rows().set(`${childKey}-extra`, child);
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
});

test("@2 reads a complete paged set and refuses a missing child beyond its first page", async () => {
  const f = fixture();
  const owner = await f.reopen();
  await owner.open(f.parent);
  for (let i = 0; i < 129; i++) {
    const binding = required(
      await owner.issue(f.parent, { ...target, targetFormUrl: i % 2 ? one : two }),
    );
    f.originals.set(binding.producerId, await original(binding));
  }
  await owner.seal(f.parent);
  expect(await owner.read(f.parent)).toEqual({ state: "sealed_io_complete", childCount: 129 });
  const last = required(
    [...f.rows().keys()]
      .filter((key) => key.includes("/child/"))
      .sort()
      .at(-1),
  );
  f.rows().delete(last);
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
});

test("@2 currentness refuses owner drift and injected producer IDs", async () => {
  const f = fixture();
  const owner = await f.reopen();
  await owner.open(f.parent);
  expect(
    await owner.issue(f.parent, JSON.parse(JSON.stringify({ ...target, producerId: "caller-id" }))),
  ).toBeNull();
  expect(await owner.issue(f.parent, { ...target, ownerId: "foreign" })).toBeNull();
  const binding = required(await owner.issue(f.parent, target));
  f.state.record = { ...f.record, nativeIdentity: "replacement-native" };
  expect(await binding.stillCurrent()).toBe(false);
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
});

test("@2 epoch change while reading originals cannot certify the old issuer", async () => {
  const f = fixture();
  const owner = await f.reopen();
  await owner.open(f.parent);
  const binding = required(await owner.issue(f.parent, target));
  f.originals.set(binding.producerId, await original(binding));
  await owner.seal(f.parent);
  f.state.beforeOriginal = async () => {
    delete f.state.beforeOriginal;
    await f.reopen();
  };
  expect(await owner.read(f.parent)).toEqual({ state: "unknown" });
});
