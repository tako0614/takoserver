import { expect, spyOn, test } from "bun:test";
import * as originalBundle from "../src/providers/linux-oci-owned-bundle.ts";
import { observeRawPromise, ownedRawHttp, rawTick } from "./container-http-transport.test.ts";
import { acceptedRawHttp } from "./linux-oci-owned-bundle.test.ts";
import { originalPeerDeleteFixture } from "./linux-oci-peer-reconstruction.test.ts";

// Original accepted Core/normal Engine/creator and actual transport bodies.
// NONSECRET memorySQLite + intercepted child/HTTP streams; imported cases never run.
async function live(hResultFault?: "unknown") {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    allocationSchema: true,
    ...(hResultFault === undefined ? {} : { hResultFault }),
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(f.failures).toEqual([]);
    return { f, accepted };
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}
type Live = Awaited<ReturnType<typeof live>>;
const hResults = (x: Live) =>
  x.f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-read-result@1").length;
const stops = (x: Live) =>
  x.f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1").length;
async function acceptDelete(x: Live) {
  await x.f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid: x.accepted.resourceUid,
    expectedGeneration: 1,
  });
}
async function resultStep(x: Live, engine = x.f.engine) {
  for (let pass = 0; pass < 16; pass++) {
    expect(await engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    if (hResults(x)) return;
    x.f.advanceNormalClock(61_000);
  }
  throw Error("original H result phase not reached");
}
function observedSource() {
  const source = originalBundle.originalLinuxOciHttpRetirementSource;
  const results: ReturnType<typeof source>[] = [];
  const args: Parameters<typeof source>[] = [];
  const spy = spyOn(originalBundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (...input) => {
      const actual = source(...input); // never synthesize a runtime or positive witness
      args.push(input);
      results.push(actual);
      return actual;
    },
  );
  return { results, args, source, restore: () => spy.mockRestore() };
}

test("retirement handoff consumes same original application close and H result while DELETE stays unknown", async () => {
  const x = await live(),
    io = ownedRawHttp(),
    source = observedSource();
  try {
    const created = x.f.recordedCreate();
    const response = x.f.composition.fetchServingHttp(
      { resourceUid: created.resourceUid, incarnationId: created.incarnationId },
      new Request("http://ignored.invalid/active"),
    );
    for (let i = 0; i < 30 && !io.counts().calls; i++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    const head = await response;
    const body = observeRawPromise(head.body!.getReader().read());
    await acceptDelete(x);
    const first = observeRawPromise(x.f.engine.runNext());
    for (let i = 0; i < 30 && !io.counts().requestDestroy; i++) await rawTick();
    expect(io.counts().requestDestroy).toBe(1);
    expect(body.state()).toBe("rejected");
    expect(await first.value).toHaveProperty("result");
    expect(stops(x)).toBe(1);
    io.closeResponse();
    await rawTick();
    expect(stops(x)).toBe(1);
    io.closeRequest();
    expect(stops(x)).toBe(1);
    x.f.advanceNormalClock(61_000);
    await resultStep(x);
    expect(hResults(x)).toBe(1);
    expect(source.results.length).toBeGreaterThanOrEqual(5); // actual private Core before/after join reached
    const actual = source.results[0];
    expect(actual).toBeDefined();
    expect(source.results.every((v) => v === actual)).toBe(true);
    expect(actual!.close()).toBe(actual!.close()); // same original Promise, never a replacement
    const [key, core, record] = source.args[0]!;
    expect(() => source.source({}, core, record, new AbortController().signal)).toThrow();
    expect(() =>
      source.source(
        key,
        core,
        { ...record, nativeId: "f".repeat(64) },
        new AbortController().signal,
      ),
    ).toThrow();
    const canceled = new AbortController();
    canceled.abort();
    expect(() => source.source(key, core, record, canceled.signal)).toThrow();
    expect(
      (
        await x.f.sql.query(
          "SELECT state,removed_at_ms,allocation_cleanup FROM tf_v2_container_create_claims",
        )
      )[0],
    ).toMatchObject({ state: "bound", removed_at_ms: null, allocation_cleanup: "closed" });
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

for (const fault of ["row", "execution", "cancel"] as const) {
  test(`retirement handoff ${fault} after original H result refuses before allocation cleanup`, async () => {
    const x = await live(),
      source = observedSource(),
      query = x.f.sql.query.bind(x.f.sql);
    let armed = false,
      reached = false;
    const spy = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (
        !reached &&
        source.results.length &&
        sql.startsWith("SELECT native_control FROM tf_v2_container_create_claims")
      ) {
        if (fault === "row") {
          reached = true;
          return [{ native_control: null }];
        }
        armed = true;
      } else if (!reached && armed && sql.includes(" WHERE i.resource_uid=? AND v.generation=?")) {
        reached = true;
        if (fault === "cancel") void x.f.composition.close().catch(() => undefined);
        else {
          const execution = x.f.execution;
          if (!execution) throw Error("original execution missing");
          Reflect.set(execution, "leaseToken", "synthetic-late-application-lease");
        }
      }
      return rows;
    });
    try {
      await acceptDelete(x);
      await resultStep(x);
      expect(reached).toBe(true);
      expect(hResults(x)).toBe(1);
      expect(source.results).toHaveLength(1); // initial actual lookup, no post-await local continuation
      expect(
        (
          await query(
            "SELECT state,removed_at_ms,allocation_cleanup FROM tf_v2_container_create_claims",
          )
        )[0],
      ).toMatchObject({ state: "bound", removed_at_ms: null, allocation_cleanup: "untouched" });
      expect(x.f.network).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      source.restore();
      await x.f.cleanup();
    }
  });
}

test("retirement handoff distinct missing source: lost H fact never consumes application source", async () => {
  const x = await live("unknown"),
    source = observedSource();
  try {
    await acceptDelete(x);
    await resultStep(x);
    expect(hResults(x)).toBe(1);
    expect(source.results).toHaveLength(0); // actual private H getter refused before application lookup
    expect(
      (
        await x.f.sql.query(
          "SELECT state,removed_at_ms,allocation_cleanup FROM tf_v2_container_create_claims",
        )
      )[0],
    ).toMatchObject({ state: "bound", removed_at_ms: null, allocation_cleanup: "untouched" });
    const result = await x.f.composition.close().then(
      () => "closed",
      () => "unknown",
    );
    expect(result).toBe("unknown");
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    source.restore();
    await x.f.cleanup();
  }
});

test("retirement handoff distinct missing source: fresh creator physical progress does not manufacture old HTTP custody", async () => {
  const x = await live(),
    source = observedSource(),
    fresh = x.f.reconstructNormal();
  try {
    await fresh.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: x.accepted.resourceUid,
      expectedGeneration: 1,
    });
    await resultStep(x, fresh.engine);
    expect(stops(x)).toBe(1);
    expect(hResults(x)).toBe(1);
    expect(source.results.length).toBeGreaterThan(0);
    expect(source.results.every((v) => v === undefined)).toBe(true);
    expect(
      (await x.f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"))[0],
    ).toMatchObject({ state: "bound", removed_at_ms: null });
    expect(
      x.f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@2"),
    ).toHaveLength(1);
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    source.restore();
    await fresh.close().catch(() => undefined);
    await x.f.cleanup();
  }
});
