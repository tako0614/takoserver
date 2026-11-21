import { expect, spyOn, test } from "bun:test";
import * as bundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  observeRawPromise,
  ownedRawHttp,
  rawTick,
} from "./helpers/container-http-transport-fixture.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

// Original normal Engine/accepted Core/creator and actual I/O bodies. Imported
// prior cases never run. Child/network syscalls are raw spies; NONSECRET only.
async function live() {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    allocationSchema: true,
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    return { f, accepted };
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}
type Live = Awaited<ReturnType<typeof live>>;
const count = (x: Live, kind: string) =>
  x.f.nativeCounts().requests.filter((k) => k === `linux-oci-${kind}@1`).length;
function sourceObserver() {
  const original = bundle.originalLinuxOciHttpRetirementSource;
  const actual: ReturnType<typeof original>[] = [];
  const spy = spyOn(bundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (...args) => {
      const value = original(...args);
      actual.push(value);
      return value;
    },
  );
  return { actual, restore: () => spy.mockRestore() };
}
async function acceptDelete(x: Live) {
  await x.f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid: x.accepted.resourceUid,
    expectedGeneration: 1,
  });
}
async function reachApplicationConsumer(x: Live, source: ReturnType<typeof sourceObserver>) {
  for (let i = 0; i < 16; i++) {
    x.f.advanceNormalClock(61_000); // scheduling model only, not a 30s timing proof
    const pass = observeRawPromise(x.f.engine.runNext());
    for (let tick = 0; tick < 100 && pass.state() === "pending" && !source.actual.length; tick++)
      await rawTick();
    if (source.actual.length) return pass;
    expect(await pass.value).toHaveProperty("result");
  }
  throw Error("actual private H-result application consumer not reached");
}

test("retirement obligation STOP progresses while original I/O is pending and allocation still joins it", async () => {
  const x = await live(),
    io = ownedRawHttp(),
    source = sourceObserver();
  try {
    const identity = x.f.recordedCreate();
    const response = x.f.composition.fetchServingHttp(
      identity,
      new Request("http://ignored.invalid/pending"),
    );
    for (let i = 0; i < 30 && !io.counts().calls; i++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    const head = await response;
    if (!head.body) throw Error("original response body absent");
    const body = observeRawPromise(head.body.getReader().read());
    await acceptDelete(x);
    expect(await x.f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(io.counts().requestDestroy).toBe(1);
    expect(body.state()).toBe("rejected");
    expect(count(x, "stop-init")).toBe(1); // no terminal-close event was emitted
    expect(source.actual).toHaveLength(0); // STOP and the later H-result consumer are distinct
    const final = await reachApplicationConsumer(x, source);
    const actual = source.actual[0];
    if (!actual) throw Error("genuine original application source absent");
    const join = observeRawPromise(actual.close());
    for (let i = 0; i < 100 && source.actual.length < 3; i++) await rawTick();
    expect(source.actual.length).toBeGreaterThanOrEqual(3); // Core reaches the actual close await
    expect(count(x, "parent-read-result")).toBe(1);
    expect(final.state()).toBe("pending");
    expect(join.state()).toBe("pending");
    expect(
      (
        await x.f.sql.query(
          "SELECT allocation_cleanup,state,removed_at_ms FROM tf_v2_container_create_claims",
        )
      )[0],
    ).toMatchObject({ allocation_cleanup: "untouched", state: "bound", removed_at_ms: null });
    io.closeResponse();
    await rawTick();
    expect(final.state()).toBe("pending");
    expect(join.state()).toBe("pending");
    io.closeRequest();
    expect(await join.value).toHaveProperty("result");
    expect(await final.value).toHaveProperty("result");
    expect(source.actual.every((v) => v === actual)).toBe(true);
    expect(
      (
        await x.f.sql.query(
          "SELECT allocation_cleanup,state,removed_at_ms FROM tf_v2_container_create_claims",
        )
      )[0],
    ).toMatchObject({ allocation_cleanup: "closed", state: "bound", removed_at_ms: null });
    expect(count(x, "stop-init")).toBe(1);
    expect(io.counts().calls).toBe(1);
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    source.restore();
    io.closeResponse();
    io.closeRequest();
    io.restore();
    await x.f.cleanup();
  }
});

test("retirement obligation unknown raw close permits STOP but refuses allocation and replay", async () => {
  const x = await live(),
    io = ownedRawHttp(),
    source = sourceObserver();
  let destroys = 0;
  const failure = spyOn(io.request, "destroy").mockImplementation(() => {
    destroys++;
    throw Error("NONSECRET unknown raw close");
  });
  try {
    const response = x.f.composition.fetchServingHttp(
      x.f.recordedCreate(),
      new Request("http://ignored.invalid/unknown"),
    );
    for (let i = 0; i < 30 && !io.counts().calls; i++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    await response;
    await acceptDelete(x);
    expect(await x.f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(count(x, "stop-init")).toBe(1);
    expect(destroys).toBe(1); // actual intercepted native destroy throws, not logical body cancel
    io.closeResponse();
    io.closeRequest();
    const final = await reachApplicationConsumer(x, source);
    expect(await final.value).toHaveProperty("result");
    const actual = source.actual[0];
    if (!actual) throw Error("original failed application source absent");
    const joined = observeRawPromise(actual.close());
    expect(await joined.value).toHaveProperty("error");
    expect(
      (
        await x.f.sql.query(
          "SELECT allocation_cleanup,state,removed_at_ms FROM tf_v2_container_create_claims",
        )
      )[0],
    ).toMatchObject({ allocation_cleanup: "untouched", state: "bound", removed_at_ms: null });
    x.f.advanceNormalClock(61_000);
    expect(await x.f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(source.actual.every((v) => v === actual)).toBe(true);
    expect(count(x, "stop-init")).toBe(1);
    for (const effect of ["begin-tracked-join", "delete-born", "dispose-born"])
      expect(count(x, effect)).toBe(1);
    expect(count(x, "create-stopped")).toBe(1);
    expect(count(x, "start")).toBe(1);
    expect(destroys).toBe(1);
    expect(
      (
        await x.f.sql.query(
          "SELECT allocation_cleanup,state,removed_at_ms FROM tf_v2_container_create_claims",
        )
      )[0],
    ).toMatchObject({ allocation_cleanup: "untouched", state: "bound", removed_at_ms: null });
    const closed = await x.f.composition.close().then(
      () => "closed",
      () => "unknown",
    );
    expect(closed).toBe("unknown");
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    source.restore();
    failure.mockRestore();
    io.closeResponse();
    io.closeRequest();
    io.restore();
    await x.f.cleanup();
  }
});
