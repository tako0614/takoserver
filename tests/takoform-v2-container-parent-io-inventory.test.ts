import { expect, test } from "bun:test";
import {
  type V2ContainerParentIoBinding,
  type V2ContainerParentIoClaim,
  v2ContainerParentIoOriginalDigest,
} from "../src/takoform-v2/container-parent-completion.ts";
import { createV2ContainerParentIoInventory } from "../src/takoform-v2/container-parent-io-inventory.ts";
import type { V2WorkerInvocationRecord } from "../src/worker-invocation-port.ts";

const digest = `sha256:${"a".repeat(64)}` as const;
const record: V2WorkerInvocationRecord = {
  handle: { invocationId: "parent-1", custodyToken: "host-custody-token-1" },
  backendId: "worker-backend",
  targetKey: "host-target",
  principal: "principal",
  space: "space",
  workerUid: "worker-1",
  deploymentUid: "deployment-1",
  deploymentGeneration: 2,
  sourceOperationId: "deployment-operation-2",
  ingress: {
    kind: "endpoint",
    endpointUid: "endpoint-1",
    endpointGeneration: 3,
  },
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
  sqliteDrainReceiptDigest: _receipt,
  retirement: _retirement,
  ...expected
} = record;
const parent = { handle, expected };
const target: Omit<V2ContainerParentIoClaim["target"], "producerId"> = {
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
};

// An atomic, clone-on-read storage port; reopen() retains only durable bytes.
function fixture(
  hooks: { authorize?: () => Promise<void>; readOriginal?: () => Promise<void> } = {},
) {
  let rows = new Map<string, unknown>();
  let queue = Promise.resolve();
  let loseCommitAcknowledgement = false;
  const get = async (key: string) => structuredClone(rows.get(key));
  const put = async (key: string, value: unknown) => {
    rows.set(key, structuredClone(value));
  };
  const storage = {
    get,
    put,
    async list(options: { prefix: string; startAfter?: string; limit: number }) {
      return new Map(
        [...rows]
          .filter(
            ([k]) =>
              k.startsWith(options.prefix) && (!options.startAfter || k > options.startAfter),
          )
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, options.limit)
          .map(([k, v]) => [k, structuredClone(v)]),
      );
    },
    async transaction<T>(
      callback: (tx: { get: typeof get; put: typeof put }) => Promise<T>,
    ): Promise<T> {
      const operation = queue.then(async () => {
        const before = structuredClone(rows);
        let result: T;
        try {
          result = await callback({ get, put });
        } catch (error) {
          rows = before;
          throw error;
        }
        // Inject an ACK loss AFTER the write is committed, without rollback.
        if (loseCommitAcknowledgement) {
          loseCommitAcknowledgement = false;
          throw new Error("committed transaction acknowledgement lost");
        }
        return result;
      });
      queue = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
  };
  const originals = new Map<string, unknown>();
  let current = structuredClone(record);
  let authorized = true;
  const reads: string[] = [];
  const options = {
    storage,
    readParent: async () => structuredClone(current),
    authorize: async (claim: V2ContainerParentIoClaim) => {
      await hooks.authorize?.();
      return authorized && claim.target.ownerId === "owner-1";
    },
    readOriginal: async (binding: V2ContainerParentIoBinding) => {
      reads.push(binding.producerId);
      await hooks.readOriginal?.();
      return structuredClone(originals.get(binding.producerId) ?? { state: "absent" });
    },
  };
  return {
    reopen: () => createV2ContainerParentIoInventory(options),
    rows: () => rows,
    originals,
    reads,
    loseNextCommitAcknowledgement: () => {
      loseCommitAcknowledgement = true;
    },
    revoke: () => {
      authorized = false;
    },
    retire: () => {
      current = {
        ...current,
        retirement: { retiredAtMs: 1000, receiptDigest: digest },
      };
    },
  };
}
function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("expected admitted child");
  return value;
}
async function original(binding: V2ContainerParentIoBinding) {
  const payload = {
    format: "takoserver.container-parent-io-original@1" as const,
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
      receiptDigest: await v2ContainerParentIoOriginalDigest(payload),
    },
  };
}

test("closed durable inventory requires every actual child original and survives reconstruction", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  const first = required(await owner.issue(parent, target));
  const second = required(await owner.issue(parent, target));
  expect(first.producerId).not.toBe(second.producerId);
  expect(await first.stillCurrent()).toBe(true);
  f.originals.set(first.producerId, await original(first));
  expect((await owner.read(parent)).state).toBe("open");
  f.retire();
  expect(await owner.seal(parent)).toBe(true);
  expect(await first.stillCurrent()).toBe(false);
  expect(await owner.issue(parent, target)).toBeNull();
  expect((await owner.read(parent)).state).toBe("absent");
  f.originals.set(second.producerId, { state: "pending" });
  expect((await owner.read(parent)).state).toBe("pending");
  f.originals.set(second.producerId, await original(second));
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_complete",
    childCount: 2,
  });
  const successor = await f.reopen();
  expect(await successor.read(parent)).toEqual({
    state: "sealed_io_complete",
    childCount: 2,
  });
  expect((await owner.read(parent)).state).toBe("unknown");
  expect(JSON.stringify([...f.rows()])).not.toContain(parent.handle.custodyToken);
  expect(JSON.stringify([...f.rows()])).not.toContain("stillCurrent");
});

test("reconstruction fences old callbacks and cannot seal or replay an unclosed prior set", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.issue(parent, target)).toBeNull();
  expect(await owner.open(parent)).toBe(true);
  const child = required(await owner.issue(parent, target));
  const successor = await f.reopen();
  expect(await child.stillCurrent()).toBe(false);
  expect(await owner.seal(parent)).toBe(false);
  expect(await successor.open(parent)).toBe(false);
  expect(await successor.issue(parent, target)).toBeNull();
  expect(await successor.seal(parent)).toBe(false);
  f.originals.set(child.producerId, await original(child));
  expect(await successor.read(parent)).toEqual({ state: "unknown" });
});

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await waiting;
    },
  };
}

test("a seal racing qualification retains the issued intent and never certifies an empty set", async () => {
  const b = barrier();
  const f = fixture({ authorize: b.wait });
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  const issuing = owner.issue(parent, target);
  await b.entered;
  expect(await owner.seal(parent)).toBe(true);
  b.release();
  expect(await issuing).toBeNull();
  expect(await owner.read(parent)).toEqual({ state: "unknown" });
  expect(f.reads).toEqual([]);
});

test("epoch changes while a fixed owner read is pending cannot certify the old reader", async () => {
  const b = barrier();
  const f = fixture({ readOriginal: b.wait });
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  const child = required(await owner.issue(parent, target));
  f.originals.set(child.producerId, await original(child));
  expect(await owner.seal(parent)).toBe(true);
  const reading = owner.read(parent);
  await b.entered;
  await f.reopen();
  b.release();
  expect(await reading).toEqual({ state: "unknown" });
});

test("parallel invocations get separate durable attempts and lost delivery never removes one", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  const [a, b] = await Promise.all([owner.issue(parent, target), owner.issue(parent, target)]);
  const first = required(a);
  const lostReply = required(b);
  expect(first.producerId).not.toBe(lostReply.producerId);
  // The second committed return is deliberately not delivered to a producer.
  f.originals.set(first.producerId, await original(first));
  expect(await owner.seal(parent)).toBe(true);
  expect(await owner.read(parent)).toEqual({ state: "absent" });
  expect(await owner.open(parent)).toBe(false);
  expect(await owner.issue(parent, target)).toBeNull();
  f.originals.set(lostReply.producerId, { state: "unknown" });
  expect(await owner.read(parent)).toEqual({ state: "unknown" });
});

test("forged custody, selection and owner never reuse a genuine admitted child", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  expect(await owner.issue(parent, { ...target, ownerId: "foreign-owner" })).toBeNull();
  const changed = {
    ...parent,
    expected: { ...parent.expected, deploymentGeneration: 99 },
  };
  const stolen = {
    ...parent,
    handle: { ...handle, custodyToken: "foreign-custody-token" },
  };
  for (const input of [changed, stolen]) {
    expect(await owner.open(input)).toBe(false);
    expect(await owner.issue(input, target)).toBeNull();
    expect(await owner.seal(input)).toBe(false);
    expect(await owner.read(input)).toEqual({ state: "unknown" });
  }
  f.revoke();
  expect(await owner.issue(parent, target)).toBeNull();
  expect(await owner.seal(parent)).toBe(true);
  expect(await owner.read(parent)).toEqual({ state: "unknown" });
  expect(f.reads).toEqual([]);
});

test("read pages do not cap admitted children and a sibling original cannot fill a gap", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  const children: V2ContainerParentIoBinding[] = [];
  for (let i = 0; i < 129; i++) {
    const child = required(await owner.issue(parent, target));
    children.push(child);
    f.originals.set(child.producerId, await original(child));
  }
  expect(await owner.seal(parent)).toBe(true);
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_complete",
    childCount: 129,
  });
  const last = children[128];
  const first = children[0];
  if (!last || !first) throw new Error("expected both read pages");
  f.originals.set(last.producerId, await original(first));
  expect(await owner.read(parent)).toEqual({ state: "unknown" });
});

test("sealed zero-child evidence requires a preexisting open, and never claims parent retirement", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.read(parent)).toEqual({ state: "absent" });
  expect(await owner.seal(parent)).toBe(false);
  expect(await owner.open(parent)).toBe(true);
  expect(await owner.seal(parent)).toBe(true);
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_complete",
    childCount: 0,
  });
  expect(record.retirement).toBeNull();
});

test("a committed issuance whose storage ACK is lost stays registered and nonpositive", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  f.loseNextCommitAcknowledgement();
  expect(await owner.issue(parent, target)).toBeNull();
  expect(await owner.seal(parent)).toBe(true);
  expect(await owner.read(parent)).toEqual({ state: "unknown" });
  expect(f.reads).toEqual([]);
  expect(await (await f.reopen()).read(parent)).toEqual({ state: "unknown" });
});

test("missing, surplus and re-keyed stored children cannot certify a complete sealed set", async () => {
  for (const corrupt of ["missing", "surplus", "rekey", "count"] as const) {
    const f = fixture();
    const owner = await f.reopen();
    expect(await owner.open(parent)).toBe(true);
    const child = required(await owner.issue(parent, target));
    f.originals.set(child.producerId, await original(child));
    expect(await owner.seal(parent)).toBe(true);
    const [key, value] = required([...f.rows()].find(([key]) => key.includes("/child/")));
    // Corrupt the durable input, then observe only the public inventory result.
    if (corrupt === "missing") f.rows().delete(key);
    if (corrupt === "surplus") f.rows().set(`${key}1`, structuredClone(value));
    if (corrupt === "rekey") {
      f.rows().delete(key);
      f.rows().set(`${key}1`, value);
    }
    if (corrupt === "count") {
      const [headerKey, raw] = required(
        [...f.rows()].find(([key]) => key.includes("/parent/") && !key.includes("/child/")),
      );
      f.rows().set(headerKey, { ...(raw as object), next: 0 });
    }
    expect(await owner.read(parent)).toEqual({ state: "unknown" });
  }
});
