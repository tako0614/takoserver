import { expect, test } from "bun:test";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import * as completion from "../src/takoform-v2/container-parent-completion.ts";
import {
  createV2ContainerConsumerParentIoQualifier,
  createV2ContainerParentIoQualifier,
  readV2ContainerConsumerParentIoOriginal,
  readV2ContainerParentIoOriginal,
  type V2ContainerConsumerParentIoTarget,
  type V2ContainerParentIoBinding,
  type V2ContainerParentIoTarget,
  v2ContainerConsumerParentIoOriginalDigest,
  v2ContainerParentIoOriginalDigest,
} from "../src/takoform-v2/container-parent-completion.ts";
import {
  createV2ContainerConsumerParentIoInventory,
  createV2ContainerParentIoInventory,
  type V2ContainerParentIoInventoryStorage,
} from "../src/takoform-v2/container-parent-io-inventory.ts";
import type { V2WorkerInvocationRecord } from "../src/worker-invocation-port.ts";

// Core reads a fixed owner's durable `closed` (no native request was ever made
// with that one-use send key) as terminal, settles a sealed set only when every
// child is complete or closed, and asks the fixed owner to close never-presented
// children only after Core itself observed native parent retirement. The native
// journal below is an explicit double of its compare-and-set close, not the
// private Container journal.

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
const retired: V2WorkerInvocationRecord = {
  ...record,
  retirement: { retiredAtMs: 1000, receiptDigest: digest },
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
const target: Omit<V2ContainerParentIoTarget, "producerId"> = {
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
const consumerTarget: Omit<V2ContainerConsumerParentIoTarget, "producerId"> = {
  ...target,
  workerVersionFormUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.8.0/",
  targetFormUrl: "https://edge.forms.takoform.com/forms/Container/0.2.0/",
};

type JournalRow =
  | { readonly digest: string; readonly state: "pending" | "unknown" | "closed" }
  | { readonly digest: string; readonly state: "complete"; readonly original: unknown };

/**
 * Double of the fixed-owner native journal, keyed by the one-use producerId.
 * `cas` mirrors closeUnsent: closed only on an undefined key, never a rewrite,
 * an existing matching close is idempotent. `blind` overwrites any row, so a
 * Core request to close a non-absent child becomes visible in the rows.
 * A closed row reads `{ state: "closed", bindingDigest }` from its stored
 * binding digest (the agreed native shape); `bare` and `foreign` model a wrong owner.
 */
function nativeJournal(format: "@1" | "@2") {
  const rows = new Map<string, JournalRow>();
  const closes: V2ContainerParentIoBinding[] = [];
  const reads: string[] = [];
  const hooks: {
    mode: "cas" | "blind";
    closedShape: "bound" | "bare" | "foreign";
    beforeRead: ((binding: V2ContainerParentIoBinding) => Promise<void>) | undefined;
    beforeClose: ((binding: V2ContainerParentIoBinding) => Promise<void>) | undefined;
    loseNextCloseAcknowledgement: boolean;
  } = {
    mode: "cas",
    closedShape: "bound",
    beforeRead: undefined,
    beforeClose: undefined,
    loseNextCloseAcknowledgement: false,
  };
  async function original(binding: V2ContainerParentIoBinding) {
    const payload = {
      format:
        format === "@1"
          ? ("takoserver.container-parent-io-original@1" as const)
          : ("takoserver.container-parent-io-original@2" as const),
      bindingDigest: binding.digest,
      producerId: binding.producerId,
      ownerEpoch: 1,
      completedAtMs: 1000,
      outcome: "transport_io_complete" as const,
    };
    const receiptDigest =
      payload.format === "takoserver.container-parent-io-original@1"
        ? await v2ContainerParentIoOriginalDigest({ ...payload, format: payload.format })
        : await v2ContainerConsumerParentIoOriginalDigest({ ...payload, format: payload.format });
    return { ...payload, receiptDigest };
  }
  return {
    rows,
    closes,
    reads,
    hooks,
    snapshot: () => JSON.stringify([...rows].sort(([a], [b]) => a.localeCompare(b))),
    async readOriginal(binding: V2ContainerParentIoBinding): Promise<unknown> {
      reads.push(binding.producerId);
      await hooks.beforeRead?.(binding);
      const row = rows.get(binding.producerId);
      if (row === undefined) return { state: "absent" };
      if (row.digest !== binding.digest) return { state: "unknown" };
      if (row.state === "closed") {
        if (hooks.closedShape === "bare") return { state: "closed" };
        return {
          state: "closed",
          bindingDigest: hooks.closedShape === "foreign" ? `sha256:${"f".repeat(64)}` : row.digest,
        };
      }
      return row.state === "complete"
        ? { state: "complete", original: structuredClone(row.original) }
        : { state: row.state };
    },
    async closeOriginal(binding: V2ContainerParentIoBinding): Promise<boolean> {
      closes.push(structuredClone(binding));
      await hooks.beforeClose?.(binding);
      const row = rows.get(binding.producerId);
      if (hooks.mode === "blind") {
        rows.set(binding.producerId, { digest: binding.digest, state: "closed" });
        return true;
      }
      if (row !== undefined) return row.digest === binding.digest && row.state === "closed";
      rows.set(binding.producerId, { digest: binding.digest, state: "closed" });
      if (hooks.loseNextCloseAcknowledgement) {
        hooks.loseNextCloseAcknowledgement = false;
        throw new Error("committed close acknowledgement lost");
      }
      return true;
    },
    /** invoke's one-use pending CAS: only an undefined key can become pending. */
    present(binding: V2ContainerParentIoBinding): boolean {
      if (rows.has(binding.producerId)) return false;
      rows.set(binding.producerId, { digest: binding.digest, state: "pending" });
      return true;
    },
    set(binding: V2ContainerParentIoBinding, state: "pending" | "unknown" | "closed") {
      rows.set(binding.producerId, { digest: binding.digest, state });
    },
    async complete(binding: V2ContainerParentIoBinding) {
      rows.set(binding.producerId, {
        digest: binding.digest,
        state: "complete",
        original: await original(binding),
      });
    },
  };
}

// Atomic clone-on-read inventory storage, as in the existing inventory tests.
function inventoryStorage() {
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
          throw new Error("committed transaction acknowledgement lost");
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
  return {
    storage,
    rows: () => rows,
    loseNextAcknowledgement: () => {
      loseAcknowledgement = true;
    },
  };
}

function fixture(profile: "@1" | "@2" = "@1", options: { close?: boolean } = {}) {
  const store = inventoryStorage();
  const journal = nativeJournal(profile);
  const state = { record: structuredClone(record) as V2WorkerInvocationRecord };
  const ports = {
    storage: store.storage,
    readParent: async () => structuredClone(state.record),
    authorize: async (claim: { readonly target: { readonly ownerId: string } }) =>
      claim.target.ownerId === "owner-1",
    readOriginal: (binding: V2ContainerParentIoBinding) => journal.readOriginal(binding),
    ...(options.close === false
      ? {}
      : {
          closeOriginal: (binding: V2ContainerParentIoBinding) => journal.closeOriginal(binding),
        }),
  };
  return {
    store,
    journal,
    state,
    ports,
    reopen: () =>
      profile === "@1"
        ? createV2ContainerParentIoInventory(ports)
        : createV2ContainerConsumerParentIoInventory(ports),
    target: profile === "@1" ? target : consumerTarget,
    retire: () => {
      state.record = structuredClone(retired);
    },
    setRecord: (value: V2WorkerInvocationRecord) => {
      state.record = structuredClone(value);
    },
  };
}
function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}
const bindingOf = (b: V2ContainerParentIoBinding): V2ContainerParentIoBinding => ({
  producerId: b.producerId,
  canonical: b.canonical,
  digest: b.digest,
});
type Fixture = ReturnType<typeof fixture>;
type Inventory = Awaited<ReturnType<Fixture["reopen"]>>;
async function issueChildren(f: Fixture, count: number) {
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  const children: V2ContainerParentIoBinding[] = [];
  for (let i = 0; i < count; i++)
    children.push(bindingOf(required(await owner.issue(parent, f.target as never))));
  return { owner, children };
}
async function retireAndSeal(f: Fixture, owner: Inventory) {
  f.retire();
  expect(await owner.sealAfterNativeRetirement(parent)).toBe(true);
}
function storedChildTargets(f: Fixture) {
  return [...f.store.rows()]
    .filter(([key]) => key.includes("/child/"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value as { target: V2ContainerParentIoTarget; binding: unknown });
}

test("closed is a terminal readback bound to its exact binding digest through both validators", async () => {
  const one = createV2ContainerParentIoQualifier({
    readParent: async () => structuredClone(record),
    authorize: async () => true,
  });
  const two = createV2ContainerConsumerParentIoQualifier({
    readParent: async () => structuredClone(record),
    authorize: async () => true,
  });
  const b1 = bindingOf(required(await one({ ...parent, target: { ...target, producerId: "c1" } })));
  const b2 = bindingOf(
    required(await two({ ...parent, target: { ...consumerTarget, producerId: "c2" } })),
  );
  const r1 = await readV2ContainerParentIoOriginal(b1, async () => ({
    state: "closed",
    bindingDigest: b1.digest,
  }));
  const r2 = await readV2ContainerConsumerParentIoOriginal(b2, async () => ({
    state: "closed",
    bindingDigest: b2.digest,
  }));
  expect(r1).toEqual({ state: "closed", bindingDigest: b1.digest });
  expect(r2).toEqual({ state: "closed", bindingDigest: b2.digest });
  expect(Object.keys(r1).sort()).toEqual(["bindingDigest", "state"]);
  // The result is the accepted input shape, so the chained owner-side and
  // Host-side re-validations (owner adapter -> Host original reader -> inventory) keep it.
  const chained = await readV2ContainerParentIoOriginal(b1, async () =>
    readV2ContainerParentIoOriginal(b1, async () =>
      readV2ContainerParentIoOriginal(b1, async () => ({
        state: "closed",
        bindingDigest: b1.digest,
      })),
    ),
  );
  expect(chained).toEqual({ state: "closed", bindingDigest: b1.digest });
  for (const [b, other, read] of [
    [b1, b2, readV2ContainerParentIoOriginal],
    [b2, b1, readV2ContainerConsumerParentIoOriginal],
  ] as const) {
    for (const value of [
      // The bare pre-agreement shape names no binding.
      { state: "closed" },
      // A well-formed digest of another binding, or of nothing.
      { state: "closed", bindingDigest: other.digest },
      { state: "closed", bindingDigest: `sha256:${"b".repeat(64)}` },
      // Malformed digests and surplus fields.
      { state: "closed", bindingDigest: "sha256:x" },
      { state: "closed", bindingDigest: b.digest.toUpperCase() },
      { state: "closed", bindingDigest: 7 },
      { state: "closed", bindingDigest: b.digest, extra: true },
      { state: "closed", bindingDigest: b.digest, original: {} },
      { state: "closed", original: {} },
      { state: "CLOSED", bindingDigest: b.digest },
      { closed: true, bindingDigest: b.digest },
    ])
      expect(await read(b, async () => value)).toEqual({ state: "unknown" });
  }
  // Cross-profile and undecodable bindings never reach the fixed owner reader.
  let contacted = 0;
  const counting = async () => {
    contacted++;
    return { state: "closed", bindingDigest: b1.digest };
  };
  expect(await readV2ContainerParentIoOriginal(b2, counting)).toEqual({ state: "unknown" });
  expect(await readV2ContainerConsumerParentIoOriginal(b1, counting)).toEqual({
    state: "unknown",
  });
  expect(
    await readV2ContainerParentIoOriginal({ ...b1, digest: `sha256:${"b".repeat(64)}` }, counting),
  ).toEqual({ state: "unknown" });
  expect(contacted).toBe(0);
});

test("binding derivation reproduces the exact qualifier output for both profiles and refuses foreign shapes", async () => {
  const scope = required(await completion.containerParentIoScope(parent));
  const one = createV2ContainerParentIoQualifier({
    readParent: async () => structuredClone(record),
    authorize: async () => true,
  });
  const two = createV2ContainerConsumerParentIoQualifier({
    readParent: async () => structuredClone(record),
    authorize: async () => true,
  });
  const t1 = { ...target, producerId: "derived-1" };
  const t2 = { ...consumerTarget, producerId: "derived-2" };
  const q1 = bindingOf(required(await one({ ...parent, target: t1 })));
  const q2 = bindingOf(required(await two({ ...parent, target: t2 })));
  const d1 = await completion.deriveContainerParentIoBinding(scope, t1);
  const d2 = await completion.deriveContainerConsumerParentIoBinding(scope, t2);
  expect(d1).toEqual(q1);
  expect(d2).toEqual(q2);
  expect(Object.keys(required(d1)).sort()).toEqual(["canonical", "digest", "producerId"]);
  // Profiles keep disjoint formats/hash domains and refuse each other's targets.
  expect(await completion.deriveContainerParentIoBinding(scope, t2 as never)).toBeNull();
  expect(await completion.deriveContainerConsumerParentIoBinding(scope, t1 as never)).toBeNull();
  expect(
    await completion.deriveContainerParentIoBinding({ ...scope, extra: true } as never, t1),
  ).toBeNull();
  expect(
    await completion.deriveContainerParentIoBinding({ ...scope, custodyDigest: "x" } as never, t1),
  ).toBeNull();
  expect(
    await completion.deriveContainerParentIoBinding(scope, { ...t1, extra: true } as never),
  ).toBeNull();
});

test("the qualifier keeps its binding bytes from before the close port, independently recomputed here", async () => {
  // Independent of the shared construction: canonical JSON of {format, parent
  // scope, target} and sha256 over `${format}\0${canonical}`, per profile.
  const scope = required(await completion.containerParentIoScope(parent));
  const ports = { readParent: async () => structuredClone(record), authorize: async () => true };
  const t1 = { ...target, producerId: "golden-1" };
  const t2 = { ...consumerTarget, producerId: "golden-2" };
  const q1 = required(await createV2ContainerParentIoQualifier(ports)({ ...parent, target: t1 }));
  const q2 = required(
    await createV2ContainerConsumerParentIoQualifier(ports)({ ...parent, target: t2 }),
  );
  for (const [format, t, q] of [
    ["takoserver.container-parent-io-binding@1", t1, q1],
    ["takoserver.container-parent-io-binding@2", t2, q2],
  ] as const) {
    const canonical = canonicalJson({ format, parent: scope, target: t });
    expect(q.producerId).toBe(t.producerId);
    expect(q.canonical).toBe(canonical);
    expect(q.digest).toBe(await bytesDigest(new TextEncoder().encode(`${format}\0${canonical}`)));
  }
});

test("a sealed set settles only when every child is complete or closed, and closed survives reconstruction", async () => {
  const f = fixture();
  const { owner, children } = await issueChildren(f, 3);
  const [done, left, right] = children;
  if (!done || !left || !right) throw new Error("expected three children");
  await f.journal.complete(done);
  await retireAndSeal(f, owner);
  expect(await owner.read(parent)).toEqual({ state: "absent" });
  const completeRow = JSON.stringify(f.journal.rows.get(done.producerId));
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes.map((b) => b.producerId)).toEqual([left.producerId, right.producerId]);
  expect(f.journal.closes).toEqual([left, right]);
  expect(JSON.stringify(f.journal.rows.get(done.producerId))).toBe(completeRow);
  const settled = await owner.read(parent);
  expect(settled).toEqual({ state: "sealed_io_settled", childCount: 3, closedCount: 2 });
  expect(Object.keys(settled).sort()).toEqual(["childCount", "closedCount", "state"]);
  const successor = await f.reopen();
  expect(await successor.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 3,
    closedCount: 2,
  });
  // A closed child can never be presented again: invoke's one-use CAS refuses it.
  expect(f.journal.present(left)).toBe(false);
  expect(await successor.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 3,
    closedCount: 2,
  });
});

test("unknown and pending never settle in any position beside complete and closed children", async () => {
  for (const blocking of ["pending", "unknown", "absent"] as const) {
    for (const position of [0, 1, 2]) {
      const f = fixture();
      const { owner, children } = await issueChildren(f, 3);
      for (const [index, child] of children.entries()) {
        if (index === position) {
          if (blocking !== "absent") f.journal.set(child, blocking);
        } else if (index === (position + 1) % 3) await f.journal.complete(child);
        else f.journal.set(child, "closed");
      }
      await retireAndSeal(f, owner);
      if (blocking === "absent") {
        // Only the close port may turn a never-presented child into closed.
        expect(await owner.read(parent)).toEqual({ state: "absent" });
        continue;
      }
      const before = f.journal.snapshot();
      expect(await owner.read(parent)).toEqual({ state: blocking });
      expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
      expect(f.journal.closes).toEqual([]);
      expect(f.journal.snapshot()).toBe(before);
      expect(await owner.read(parent)).toEqual({ state: blocking });
      expect(await (await f.reopen()).read(parent)).toEqual({ state: blocking });
    }
  }
});

test("a set without closed children keeps the exact sealed_io_complete shape", async () => {
  const f = fixture();
  const { owner, children } = await issueChildren(f, 2);
  for (const child of children) await f.journal.complete(child);
  await retireAndSeal(f, owner);
  expect(JSON.stringify(await owner.read(parent))).toBe(
    JSON.stringify({ state: "sealed_io_complete", childCount: 2 }),
  );
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toEqual([]);
  expect(JSON.stringify(await owner.read(parent))).toBe(
    JSON.stringify({ state: "sealed_io_complete", childCount: 2 }),
  );
  const empty = fixture();
  const opened = await issueChildren(empty, 0);
  await retireAndSeal(empty, opened.owner);
  expect(await opened.owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(JSON.stringify(await opened.owner.read(parent))).toBe(
    JSON.stringify({ state: "sealed_io_complete", childCount: 0 }),
  );
  expect(empty.journal.closes).toEqual([]);
});

test("the close port refuses before Native without Core-observed native parent retirement", async () => {
  const f = fixture();
  const { owner, children } = await issueChildren(f, 1);
  const [child] = children;
  if (!child) throw new Error("expected one child");
  // A live parent's set can be sealed, but sealing is not retirement.
  expect(await owner.seal(parent)).toBe(true);
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  for (const changed of [
    { ...retired, noNativeDispatchAtMs: 1 },
    { ...retired, phase: "pre_effect_refused" as const },
    { ...retired, retirement: { retiredAtMs: 0, receiptDigest: digest } },
    { ...retired, retirement: { retiredAtMs: 1000, receiptDigest: "sha256:wrong" as const } },
    { ...retired, retirement: { retiredAtMs: 1000, receiptDigest: digest, grant: true } },
  ]) {
    f.setRecord(changed as V2WorkerInvocationRecord);
    expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  }
  // The caller cannot supply retirement: only the fixed Core parent reader can.
  f.setRecord(record);
  expect(
    await owner.closeUnsentAfterNativeRetirement({
      ...parent,
      retirement: retired.retirement,
    } as never),
  ).toBe(false);
  expect(f.journal.closes).toEqual([]);
  expect(f.journal.rows.size).toBe(0);
  expect(await owner.read(parent)).toEqual({ state: "absent" });
  // A presentation by the still-live parent is never refused by a close.
  expect(f.journal.present(child)).toBe(true);
  f.journal.rows.clear();
  f.retire();
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toEqual([child]);
});

test("the close port requires an opted-in close port and a sealed set; a superseded instance is refused best-effort", async () => {
  // Retired parent whose set is still open: admission is not closed.
  const open = fixture();
  const opened = await issueChildren(open, 1);
  open.retire();
  expect(await opened.owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  // No durable set at all.
  const none = fixture();
  const bare = await none.reopen();
  none.retire();
  expect(await bare.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  // A superseded instance observes the successor epoch and stops. This is
  // best-effort only; safety rests on the D1 native retirement precondition.
  const superseded = fixture();
  const first = await issueChildren(superseded, 1);
  const successor = await superseded.reopen();
  await retireAndSeal(superseded, successor);
  expect(await first.owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(open.journal.closes).toEqual([]);
  expect(none.journal.closes).toEqual([]);
  expect(superseded.journal.closes).toEqual([]);
  expect(await successor.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(superseded.journal.closes).toEqual(first.children);
  // Without closeOriginal the port is inert and unbound children keep reading unknown.
  const plain = fixture("@1", { close: false });
  const owner = await plain.reopen();
  expect(await owner.open(parent)).toBe(true);
  plain.store.loseNextAcknowledgement();
  expect(await owner.issue(parent, target as never)).toBeNull();
  await retireAndSeal(plain, owner);
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(await owner.read(parent)).toEqual({ state: "unknown" });
  expect(plain.journal.reads).toEqual([]);
  expect(plain.journal.closes).toEqual([]);
  await expect(
    createV2ContainerParentIoInventory({ ...plain.ports, closeOriginal: true as never }),
  ).rejects.toThrow(TypeError);
});

test("the close port asks Native to close only absent originals and never touches pending, unknown or complete rows", async () => {
  const f = fixture();
  // A non-CAS Native double makes any Core request to close a non-absent child visible.
  f.journal.hooks.mode = "blind";
  const { owner, children } = await issueChildren(f, 5);
  const [absent, pending, unknown, done, closed] = children;
  if (!absent || !pending || !unknown || !done || !closed) throw new Error("expected children");
  f.journal.set(pending, "pending");
  f.journal.set(unknown, "unknown");
  await f.journal.complete(done);
  f.journal.set(closed, "closed");
  await retireAndSeal(f, owner);
  const kept = [pending, unknown, done, closed].map((c) =>
    JSON.stringify(f.journal.rows.get(c.producerId)),
  );
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(f.journal.closes).toEqual([absent]);
  expect(
    [pending, unknown, done, closed].map((c) => JSON.stringify(f.journal.rows.get(c.producerId))),
  ).toEqual(kept);
  expect(f.journal.rows.get(absent.producerId)?.state).toBe("closed");
  expect(await owner.read(parent)).toEqual({ state: "pending" });
});

test("the close port is idempotent, including a retry after a lost Native acknowledgement", async () => {
  const f = fixture();
  const { owner, children } = await issueChildren(f, 2);
  await retireAndSeal(f, owner);
  f.journal.hooks.loseNextCloseAcknowledgement = true;
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(f.journal.closes).toEqual(children);
  const afterFirst = f.journal.snapshot();
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 2,
    closedCount: 2,
  });
  for (let i = 0; i < 2; i++) {
    expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
    expect(f.journal.closes).toEqual(children);
    expect(f.journal.snapshot()).toBe(afterFirst);
  }
  const successor = await f.reopen();
  expect(await successor.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toEqual(children);
  expect(await successor.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 2,
    closedCount: 2,
  });
});

test("an unbound issuance is read and closed under the exact binding the qualifier would have produced", async () => {
  const f = fixture();
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  f.store.loseNextAcknowledgement();
  expect(await owner.issue(parent, target as never)).toBeNull();
  const [stored] = storedChildTargets(f);
  if (!stored) throw new Error("expected the durable unbound intent");
  expect(stored.binding).toBeNull();
  const qualify = createV2ContainerParentIoQualifier({
    readParent: async () => structuredClone(record),
    authorize: async () => true,
  });
  const golden = bindingOf(required(await qualify({ ...parent, target: stored.target })));
  await retireAndSeal(f, owner);
  expect(await owner.read(parent)).toEqual({ state: "absent" });
  expect(f.journal.reads).toEqual([golden.producerId]);
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toEqual([golden]);
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 1,
    closedCount: 1,
  });
  // The stored intent stays unbound: re-derivation never rewrites the inventory.
  expect(storedChildTargets(f)[0]?.binding).toBeNull();
  // A consumer that did not opt in keeps today's unbound `unknown`.
  const plain = await createV2ContainerParentIoInventory({
    storage: f.ports.storage,
    readParent: f.ports.readParent,
    authorize: f.ports.authorize,
    readOriginal: f.ports.readOriginal,
  });
  const reads = f.journal.reads.length;
  expect(await plain.read(parent)).toEqual({ state: "unknown" });
  expect(f.journal.reads.length).toBe(reads);
});

test("a late presentation racing close never ends settled while anything is pending or unknown", async () => {
  // The presentation qualified before retirement and commits pending first.
  const f = fixture();
  const { owner, children } = await issueChildren(f, 2);
  const [late, quiet] = children;
  if (!late || !quiet) throw new Error("expected two children");
  await retireAndSeal(f, owner);
  const observed: string[] = [];
  const read = async () => {
    const result = await owner.read(parent);
    observed.push(result.state);
    return result;
  };
  expect(await read()).toEqual({ state: "absent" });
  f.journal.hooks.beforeClose = async (binding) => {
    if (binding.producerId === late.producerId) f.journal.present(late);
  };
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  f.journal.hooks.beforeClose = undefined;
  expect(f.journal.rows.get(late.producerId)?.state).toBe("pending");
  expect(f.journal.rows.get(quiet.producerId)?.state).toBe("closed");
  expect(await read()).toEqual({ state: "pending" });
  // Its recheck after the pending commit refuses (the parent is retired): unknown.
  f.journal.set(late, "unknown");
  const closes = f.journal.closes.length;
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(f.journal.closes.length).toBe(closes);
  expect(f.journal.rows.get(late.producerId)?.state).toBe("unknown");
  expect(await read()).toEqual({ state: "unknown" });
  expect(await (await f.reopen()).read(parent)).toEqual({ state: "unknown" });
  expect(observed.some((state) => state.startsWith("sealed_io"))).toBe(false);

  // The close commits first: the late presentation's one-use CAS is refused.
  const g = fixture();
  const won = await issueChildren(g, 1);
  const [child] = won.children;
  if (!child) throw new Error("expected one child");
  await retireAndSeal(g, won.owner);
  expect(await won.owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(g.journal.present(child)).toBe(false);
  expect(await won.owner.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 1,
    closedCount: 1,
  });
});

test("forged custody, changed selection and any inconsistent stored child refuse before every Native close", async () => {
  // The first child is a valid never-presented child in every case: the whole set
  // is validated before any close, so a later defect also keeps it unclosed.
  for (const corrupt of [
    "custody",
    "selection",
    "binding",
    "late-binding",
    "missing",
    "count",
  ] as const) {
    const f = fixture();
    const { owner, children } = await issueChildren(f, 2);
    await retireAndSeal(f, owner);
    let input: unknown = parent;
    if (corrupt === "custody")
      input = { ...parent, handle: { ...handle, custodyToken: "foreign-custody-token" } };
    if (corrupt === "selection")
      input = { ...parent, expected: { ...expected, deploymentGeneration: 99 } };
    const childRows = [...f.store.rows()].filter(([key]) => key.includes("/child/")).sort();
    const [firstKey, firstValue] = required(childRows[0]);
    const [secondKey, secondValue] = required(childRows[1]);
    if (corrupt === "binding")
      f.store.rows().set(firstKey, {
        ...(firstValue as object),
        binding: (secondValue as { binding: unknown }).binding,
      });
    if (corrupt === "late-binding")
      f.store.rows().set(secondKey, {
        ...(secondValue as object),
        binding: (firstValue as { binding: unknown }).binding,
      });
    if (corrupt === "missing") f.store.rows().delete(secondKey);
    if (corrupt === "count") {
      const [headerKey, raw] = required(
        [...f.store.rows()].find(([key]) => key.includes("/parent/") && !key.includes("/child/")),
      );
      f.store.rows().set(headerKey, { ...(raw as object), next: 1 });
    }
    expect(await owner.closeUnsentAfterNativeRetirement(input as never)).toBe(false);
    expect(f.journal.closes).toEqual([]);
    expect(f.journal.rows.size).toBe(0);
    // Nonpositive either way: the defect itself, or the still-absent first child.
    expect(await owner.read(input as never)).toEqual({
      state:
        corrupt === "custody" || corrupt === "selection" || corrupt === "binding"
          ? "unknown"
          : "absent",
    });
    expect(children).toHaveLength(2);
  }
});

test("an owner closed readback that is bare or names another binding never settles or re-closes", async () => {
  for (const shape of ["bare", "foreign"] as const) {
    const f = fixture();
    const { owner, children } = await issueChildren(f, 2);
    const [done, closed] = children;
    if (!done || !closed) throw new Error("expected two children");
    await f.journal.complete(done);
    f.journal.set(closed, "closed");
    await retireAndSeal(f, owner);
    expect(await owner.read(parent)).toEqual({
      state: "sealed_io_settled",
      childCount: 2,
      closedCount: 1,
    });
    f.journal.hooks.closedShape = shape;
    const before = f.journal.snapshot();
    expect(await owner.read(parent)).toEqual({ state: "unknown" });
    expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
    expect(f.journal.closes).toEqual([]);
    expect(f.journal.snapshot()).toBe(before);
    expect(await owner.read(parent)).toEqual({ state: "unknown" });
  }
});

test("a non-opt-in inventory reads a bound closed child as settled without any close port", async () => {
  const f = fixture("@1", { close: false });
  const { owner, children } = await issueChildren(f, 2);
  const [done, closed] = children;
  if (!done || !closed) throw new Error("expected two children");
  await f.journal.complete(done);
  await retireAndSeal(f, owner);
  expect(await owner.read(parent)).toEqual({ state: "absent" });
  // Closed by the fixed owner through another path; this instance only reads it.
  f.journal.set(closed, "closed");
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 2,
    closedCount: 1,
  });
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(f.journal.closes).toEqual([]);
});

test("the close walk pages past 128 children and closes every absent one exactly once", async () => {
  const f = fixture();
  const { owner, children } = await issueChildren(f, 130);
  const [done, ...rest] = children;
  if (!done) throw new Error("expected children");
  await f.journal.complete(done);
  await retireAndSeal(f, owner);
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toEqual(rest);
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 130,
    closedCount: 129,
  });
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toHaveLength(129);
  // A gap in the second page refuses before any close of the first page.
  const g = fixture();
  const gapped = await issueChildren(g, 130);
  await retireAndSeal(g, gapped.owner);
  const lastKey = required(
    [...g.store.rows().keys()]
      .filter((key) => key.includes("/child/"))
      .sort()
      .at(-1),
  );
  g.store.rows().delete(lastKey);
  expect(await gapped.owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(g.journal.closes).toEqual([]);
});

test("a successor closes an old-epoch set including its unbound child under the derived binding", async () => {
  const f = fixture();
  const first = await f.reopen();
  expect(await first.open(parent)).toBe(true);
  const bound = bindingOf(required(await first.issue(parent, target as never)));
  f.store.loseNextAcknowledgement();
  expect(await first.issue(parent, target as never)).toBeNull();
  const unbound = required(storedChildTargets(f)[1]);
  expect(unbound.binding).toBeNull();
  const golden = bindingOf(
    required(
      await createV2ContainerParentIoQualifier({
        readParent: async () => structuredClone(record),
        authorize: async () => true,
      })({ ...parent, target: unbound.target }),
    ),
  );
  // The physical owner was reconstructed before the parent retired.
  const successor = await f.reopen();
  f.retire();
  expect(await first.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(await successor.sealAfterNativeRetirement(parent)).toBe(true);
  expect(await successor.read(parent)).toEqual({ state: "absent" });
  expect(await successor.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toEqual([bound, golden]);
  expect(await successor.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 2,
    closedCount: 2,
  });
  // The retained header keeps its original epoch and both intents.
  const header = required(
    [...f.store.rows()].find(([key]) => key.includes("/parent/") && !key.includes("/child/")),
  )[1] as { epoch: number; next: number; state: string };
  expect(header).toMatchObject({ epoch: 1, next: 2, state: "sealed" });
});

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await released;
    },
  };
}

test("a successor constructed mid-walk stops the superseded walk; the successor finishes the close", async () => {
  // During pass 1: no close at all, and no further owner contact after the check.
  const f = fixture();
  const { owner, children } = await issueChildren(f, 3);
  await retireAndSeal(f, owner);
  const reading = gate();
  let armed = true;
  f.journal.hooks.beforeRead = async () => {
    if (!armed) return;
    armed = false;
    await reading.wait();
  };
  const readsBefore = f.journal.reads.length;
  const walking = owner.closeUnsentAfterNativeRetirement(parent);
  await reading.entered;
  const successor = await f.reopen();
  reading.release();
  expect(await walking).toBe(false);
  expect(f.journal.closes).toEqual([]);
  expect(f.journal.reads.slice(readsBefore)).toEqual([required(children[0]).producerId]);
  expect(await successor.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toEqual(children);

  // During pass 2: the close in flight completes, the next one is not started.
  const g = fixture();
  const late = await issueChildren(g, 3);
  await retireAndSeal(g, late.owner);
  const closing = gate();
  let first = true;
  g.journal.hooks.beforeClose = async () => {
    if (!first) return;
    first = false;
    await closing.wait();
  };
  const walk = late.owner.closeUnsentAfterNativeRetirement(parent);
  await closing.entered;
  const next = await g.reopen();
  closing.release();
  expect(await walk).toBe(false);
  expect(g.journal.closes).toEqual([required(late.children[0])]);
  expect(await next.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(g.journal.closes).toEqual(late.children);
  expect(await next.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 3,
    closedCount: 3,
  });
});

test("@2: closed settles, an unbound child is re-derived under @2 and retirement stays mandatory", async () => {
  const f = fixture("@2");
  const owner = await f.reopen();
  expect(await owner.open(parent)).toBe(true);
  const done = bindingOf(required(await owner.issue(parent, consumerTarget as never)));
  const absent = bindingOf(required(await owner.issue(parent, consumerTarget as never)));
  f.store.loseNextAcknowledgement();
  expect(await owner.issue(parent, consumerTarget as never)).toBeNull();
  await f.journal.complete(done);
  const stored = storedChildTargets(f)[2];
  if (!stored) throw new Error("expected the unbound @2 intent");
  const golden = bindingOf(
    required(
      await createV2ContainerConsumerParentIoQualifier({
        readParent: async () => structuredClone(record),
        authorize: async () => true,
      })({ ...parent, target: stored.target as unknown as V2ContainerConsumerParentIoTarget }),
    ),
  );
  expect(await owner.seal(parent)).toBe(true);
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(false);
  expect(f.journal.closes).toEqual([]);
  f.retire();
  expect(await owner.closeUnsentAfterNativeRetirement(parent)).toBe(true);
  expect(f.journal.closes).toEqual([absent, golden]);
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 3,
    closedCount: 2,
  });
  // @1 derivation of the same stored @2 target is refused (disjoint profiles).
  const scope = required(await completion.containerParentIoScope(parent));
  expect(await completion.deriveContainerParentIoBinding(scope, stored.target as never)).toBeNull();
  expect(canonicalJson(golden)).not.toBe(canonicalJson(absent));
});

test("claims passed to the close port are detached before its first await", async () => {
  const f = fixture();
  const { owner, children } = await issueChildren(f, 1);
  await retireAndSeal(f, owner);
  const input = structuredClone(parent) as { handle: { custodyToken: string } };
  const pending = owner.closeUnsentAfterNativeRetirement(input as never);
  input.handle.custodyToken = "foreign-custody-token";
  expect(await pending).toBe(true);
  expect(f.journal.closes).toEqual(children);
  expect(await owner.read(parent)).toEqual({
    state: "sealed_io_settled",
    childCount: 1,
    closedCount: 1,
  });
});
