import { expect, test } from "bun:test";
import {
  createHttpRevisionServing,
  type HttpRevisionServingBackend,
  type HttpRevisionServingIdentity,
  type HttpRevisionServingOptions,
  type HttpRevisionServingRevision,
  type HttpRevisionServingSnapshot,
  type HttpRevisionServingStatePort,
} from "../src/providers/http-revision-serving.ts";

type Revision = HttpRevisionServingRevision;
type Snapshot = HttpRevisionServingSnapshot<Revision, string>;

const identity: HttpRevisionServingIdentity = {
  resourceUid: "resource-one",
  incarnationId: "incarnation-one",
};

function revision(generation: number): Revision {
  return {
    ...identity,
    generation,
    revision: `revision-${generation}`,
  };
}

function key(value: HttpRevisionServingIdentity): string {
  return JSON.stringify([value.resourceUid, value.incarnationId]);
}

function makeFixture() {
  const snapshots = new Map<string, Snapshot>();
  const native = new Map<number, string>();
  const retired: number[] = [];
  let failRetire = false;
  let failPersist = false;

  const backend: HttpRevisionServingBackend<Revision, string> = {
    async observe(input) {
      const nativeId = native.get(input.generation);
      return nativeId === undefined ? { state: "absent" } : { state: "ready", nativeId };
    },
    async reconcile(input) {
      const nativeId = native.get(input.generation) ?? `native-${input.generation}`;
      native.set(input.generation, nativeId);
      return { state: "ready", nativeId };
    },
    async invoke(_input, _request) {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    },
    async retire(input) {
      if (failRetire) throw new Error("backend retirement failed");
      retired.push(input.generation);
      native.delete(input.generation);
    },
  };

  const state: HttpRevisionServingStatePort<Revision, string> = {
    async load(value) {
      const snapshot = snapshots.get(key(value));
      return snapshot === undefined ? null : structuredClone(snapshot);
    },
    async persist(value, snapshot) {
      if (failPersist) throw new Error("state persistence failed");
      snapshots.set(key(value), structuredClone(snapshot));
    },
  };

  function options(
    overrides: Partial<HttpRevisionServingOptions<Revision, string>> = {},
  ): HttpRevisionServingOptions<Revision, string> {
    return {
      backend,
      state,
      drainTimeoutMs: 10,
      automaticTimers: false,
      ...overrides,
    };
  }

  function markDue(generation: number): void {
    const snapshot = snapshots.get(key(identity));
    if (!snapshot) throw new Error("missing serving snapshot");
    const current = snapshot.revisions.find((entry) => entry.input.generation === generation);
    if (!current) throw new Error(`missing generation ${generation}`);
    current.retireAt = Date.now() - 1;
    snapshots.set(key(identity), snapshot);
  }

  return {
    snapshots,
    native,
    retired,
    backend,
    state,
    options,
    markDue,
    setFailRetire(value: boolean) {
      failRetire = value;
    },
    setFailPersist(value: boolean) {
      failPersist = value;
    },
  };
}

async function seedTwoRevisions(fixture: ReturnType<typeof makeFixture>): Promise<void> {
  const coordinator = createHttpRevisionServing(fixture.options());
  const handle = coordinator.open();
  await handle.reconcile(revision(1));
  await handle.reconcile(revision(2));
  await handle.close();
}

test("durable sweep retires an overdue revision after restart while serving its successor", async () => {
  const current = makeFixture();
  await seedTwoRevisions(current);
  current.markDue(1);

  const restarted = createHttpRevisionServing(current.options());
  const handle = restarted.open();
  await expect(handle.sweep(identity)).resolves.toMatchObject({
    state: "ready",
    desiredGeneration: 2,
    servingGeneration: 2,
    retiringGenerations: [],
  });
  expect(current.retired).toEqual([1]);
  expect(current.native.has(1)).toBe(false);
  expect(current.native.get(2)).toBe("native-2");
  await handle.close();
});

test("durable sweep surfaces backend retirement failure and safely retries", async () => {
  const current = makeFixture();
  await seedTwoRevisions(current);
  current.markDue(1);
  current.setFailRetire(true);

  const coordinator = createHttpRevisionServing(current.options());
  const handle = coordinator.open();
  await expect(handle.sweep(identity)).rejects.toThrow("backend retirement failed");
  expect(current.retired).toEqual([]);

  current.setFailRetire(false);
  await expect(handle.sweep(identity)).resolves.toMatchObject({
    state: "ready",
    servingGeneration: 2,
    retiringGenerations: [],
  });
  expect(current.retired).toEqual([1]);
  await handle.close();
});

test("durable sweep surfaces state persistence failure and retries after restart", async () => {
  const current = makeFixture();
  await seedTwoRevisions(current);
  current.markDue(1);
  current.setFailPersist(true);

  const failed = createHttpRevisionServing(current.options());
  const failedHandle = failed.open();
  await expect(failedHandle.sweep(identity)).rejects.toMatchObject({ code: "unavailable" });
  await failedHandle.close();

  current.setFailPersist(false);
  const restarted = createHttpRevisionServing(current.options());
  const handle = restarted.open();
  await expect(handle.sweep(identity)).resolves.toMatchObject({
    state: "ready",
    servingGeneration: 2,
    retiringGenerations: [],
  });
  expect(current.retired).toEqual([1]);
  await handle.close();
});

test("sweep aborts an old revision body at the same drain deadline", async () => {
  const current = makeFixture();
  const coordinator = createHttpRevisionServing(current.options({ drainTimeoutMs: 10 }));
  const handle = coordinator.open();
  await handle.reconcile(revision(1));
  const response = await handle.invoke(identity, new Request("https://example.test/"));
  const body = response.body;
  if (!body) throw new Error("missing response body");
  const pendingRead = body
    .getReader()
    .read()
    .then(
      () => null,
      (error: unknown) => error,
    );

  await handle.reconcile(revision(2));
  await new Promise((resolve) => setTimeout(resolve, 15));
  await expect(handle.sweep(identity)).resolves.toMatchObject({
    state: "ready",
    servingGeneration: 2,
  });
  expect(await pendingRead).toMatchObject({ code: "unavailable" });
  await handle.close();
});
