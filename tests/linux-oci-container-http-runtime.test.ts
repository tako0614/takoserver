import { expect, spyOn, test } from "bun:test";
import * as net from "node:net";
import { observeRawPromise, ownedRawHttp, rawTick } from "./container-http-transport.test.ts";
import {
  acceptedHttpSelection,
  acceptedRawHttp,
  originalOwnedOciFixture,
} from "./linux-oci-owned-bundle.test.ts";

// Original signed Core/acceptance/Engine/creator, memorySQLite and intercepted
// P/H/HTTP streams only. Imported prior cases are filtered, never invoked.
async function liveOriginal() {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0xa5),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const comparison = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0x5a),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  let byte = 0x60;
  const random = spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(value: T): T => {
      if (!(value instanceof Uint8Array)) throw Error("NONSECRET raw random shape");
      value.fill(++byte);
      return value;
    },
  );
  const network = spyOn(net, "createConnection").mockImplementation(() => {
    throw Error("unexpected actual socket");
  });
  let f: Awaited<ReturnType<typeof originalOwnedOciFixture>> | undefined;
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    f = await originalOwnedOciFixture(false, {
      ...acceptedHttpSelection(),
      normalBackend: true,
      parentPeer: true,
      fixedKeys: { key, comparison },
    });
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(f.failures).toEqual([]);
    const created = f.recordedCreate();
    const identity = { resourceUid: created.resourceUid, incarnationId: created.incarnationId };
    health.restore();
    const original = f;
    return {
      f: original,
      accepted,
      identity,
      network,
      async cleanup() {
        try {
          await original.close();
        } catch {
          /* unknown original custody is not a success oracle */
        } finally {
          network.mockRestore();
          random.mockRestore();
        }
      },
    };
  } catch (error) {
    health.restore();
    try {
      await f?.close();
    } catch {
      /* test-only teardown */
    }
    network.mockRestore();
    random.mockRestore();
    throw error;
  }
}
const stops = (f: Awaited<ReturnType<typeof liveOriginal>>["f"]) =>
  f.nativeCounts().requests.filter((kind) => kind === "linux-oci-stop-init@1").length;
async function acceptDelete(x: Awaited<ReturnType<typeof liveOriginal>>) {
  return x.f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid: x.accepted.resourceUid,
    expectedGeneration: 1,
  });
}

test("OCI HTTP original creator uses accepted serving/native source and ignores caller URL authority", async () => {
  const x = await liveOriginal(),
    io = ownedRawHttp();
  try {
    const response = x.f.composition.fetchServingHttp(
      x.identity,
      new Request("https://caller.invalid/actual?x=1"),
    );
    for (let i = 0; i < 30 && !io.counts().calls; i++) await rawTick();
    expect(io.counts().calls).toBe(1);
    expect(String(io.targets[0])).toBe("http://10.240.0.3:8080/actual?x=1");
    io.head();
    const head = await response;
    expect(head.status).toBe(200);
    io.incoming.end("NONSECRET response");
    expect(await head.text()).toBe("NONSECRET response");
    io.closeResponse();
    io.closeRequest();
    await rawTick();
    expect(
      x.f.nativeCounts().requests.filter((kind) => kind === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
    expect(x.f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(
      1,
    );
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});

test("OCI HTTP ordinary DELETE waits original stream closes before same creator STOP", async () => {
  const x = await liveOriginal(),
    io = ownedRawHttp();
  try {
    const response = x.f.composition.fetchServingHttp(
      x.identity,
      new Request("http://caller.invalid/active"),
    );
    for (let i = 0; i < 30 && !io.counts().calls; i++) await rawTick();
    io.head();
    const head = await response;
    const body = observeRawPromise(head.body!.getReader().read());
    await acceptDelete(x);
    const pass = observeRawPromise(x.f.engine.runNext());
    for (let i = 0; i < 30 && !io.counts().requestDestroy; i++) await rawTick();
    expect(io.counts().requestDestroy).toBe(1);
    expect(body.state()).toBe("rejected");
    expect(stops(x.f)).toBe(0);
    expect(pass.state()).toBe("pending");
    io.closeResponse();
    await rawTick();
    expect(stops(x.f)).toBe(0);
    io.closeRequest();
    const result = await pass.value;
    expect(result).toHaveProperty("result");
    expect("result" in result && result.result).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(stops(x.f)).toBe(1);
    expect(io.counts().calls).toBe(1);
    const rejected = observeRawPromise(
      x.f.composition.fetchServingHttp(x.identity, new Request("http://caller.invalid/late")),
    );
    expect(await rejected.value).toHaveProperty("error");
    expect(io.counts().calls).toBe(1);
    expect((await x.f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
      "bound",
    );
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});

test("OCI HTTP foreign selector and final-await cancellation refuse before raw send", async () => {
  const x = await liveOriginal(),
    io = ownedRawHttp(),
    signal = new AbortController();
  let reached = false;
  const nativeReads = () =>
    x.f.nativeCounts().requests.filter((kind) => kind === "linux-oci-observe-started@1").length;
  const before = nativeReads();
  const query = x.f.sql.query.bind(x.f.sql);
  const spy = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await query(sql, params);
    // Selector, coordinator readback, then invoke's final fresh read. Only
    // the actual third native read can reach this last dispatch bookend.
    if (nativeReads() >= before + 3 && sql.startsWith("SELECT 1 AS owner_current WHERE")) {
      reached = true;
      signal.abort();
    }
    return rows;
  });
  try {
    expect(
      await observeRawPromise(
        x.f.composition.fetchServingHttp(
          { ...x.identity, incarnationId: "foreign-original" },
          new Request("http://caller.invalid/"),
        ),
      ).value,
    ).toHaveProperty("error");
    expect(io.counts().calls).toBe(0);
    expect(
      await observeRawPromise(
        x.f.composition.fetchServingHttp(
          x.identity,
          new Request("http://caller.invalid/", { signal: signal.signal }),
        ),
      ).value,
    ).toHaveProperty("error");
    expect(reached).toBe(true);
    expect(io.counts().calls).toBe(0);
    expect(stops(x.f)).toBe(0);
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    io.restore();
    await x.cleanup();
  }
});

test("OCI HTTP retire during final pre-send read fences the already-owned runtime", async () => {
  const x = await liveOriginal(),
    io = ownedRawHttp();
  // A real existing exchange makes the source's cancellation rendezvous
  // observable. Merely starting DELETE or yielding a tick is not that fact.
  const first = x.f.composition.fetchServingHttp(
    x.identity,
    new Request("http://caller.invalid/first"),
  );
  for (let i = 0; i < 30 && !io.counts().calls; i++) await rawTick();
  io.head();
  await first;
  const nativeReads = () =>
    x.f.nativeCounts().requests.filter((kind) => kind === "linux-oci-observe-started@1").length;
  const before = nativeReads();
  let release!: () => void,
    entered!: () => void,
    reached = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const query = x.f.sql.query.bind(x.f.sql);
  const spy = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await query(sql, params);
    if (
      !reached &&
      nativeReads() >= before + 3 &&
      sql.startsWith("SELECT 1 AS owner_current WHERE")
    ) {
      reached = true;
      entered();
      await gate;
    }
    return rows;
  });
  try {
    const request = observeRawPromise(
      x.f.composition.fetchServingHttp(x.identity, new Request("http://caller.invalid/pending")),
    );
    await ready;
    await acceptDelete(x);
    const pass = observeRawPromise(x.f.engine.runNext());
    for (let i = 0; i < 30 && !io.counts().requestDestroy; i++) await rawTick();
    expect(io.counts().requestDestroy).toBe(1);
    expect(io.counts().calls).toBe(1);
    expect(stops(x.f)).toBe(0);
    io.closeRequest();
    io.closeResponse();
    await rawTick();
    expect(stops(x.f)).toBe(0); // pending original invoke has not joined yet
    release();
    expect(await request.value).toHaveProperty("error");
    expect(await pass.value).toHaveProperty("result");
    expect(stops(x.f)).toBe(1);
    expect(io.counts().calls).toBe(1);
    expect(
      x.f.nativeCounts().requests.filter((kind) => kind === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    release();
    spy.mockRestore();
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});

test("OCI HTTP unknown upload cancellation retains original handle and blocks STOP/replay", async () => {
  const x = await liveOriginal(),
    io = ownedRawHttp();
  const upload = new ReadableStream<Uint8Array>(
    {
      cancel() {
        return Promise.reject(Error("NONSECRET unknown cancellation"));
      },
    },
    { highWaterMark: 0 },
  );
  try {
    const response = x.f.composition.fetchServingHttp(
      x.identity,
      new Request("http://caller.invalid/", {
        method: "POST",
        body: upload,
        ...({ duplex: "half" } as { duplex: "half" }),
      }),
    );
    for (let i = 0; i < 30 && !io.counts().calls; i++) await rawTick();
    io.head();
    await response;
    const deletion = await acceptDelete(x);
    const pass = x.f.engine.runNext();
    io.closeResponse();
    io.closeRequest();
    expect(await pass).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(stops(x.f)).toBe(0);
    await x.f.sql.run(
      "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
      [deletion.id],
    );
    expect(await x.f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(stops(x.f)).toBe(0);
    expect(io.counts().calls).toBe(1);
    expect(io.counts().requestDestroy).toBeLessThanOrEqual(1);
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});
