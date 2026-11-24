import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import * as net from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { LINUX_OCI_HOST_TOPOLOGY_FILE } from "../src/providers/linux-oci-host-topology.ts";
import {
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import {
  observeRawPromise,
  ownedRawHttp,
  rawTick,
} from "./helpers/container-http-transport-fixture.ts";
import {
  acceptedHttpSelection,
  acceptedRawHttp,
  originalOwnedOciFixture,
} from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

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

test("OCI HTTP ordinary DELETE starts original stream close before same creator STOP", async () => {
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
    const result = await pass.value;
    expect(result).toHaveProperty("result");
    expect("result" in result && result.result).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(stops(x.f)).toBe(1);
    io.closeResponse();
    await rawTick();
    expect(stops(x.f)).toBe(1);
    io.closeRequest();
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
    expect(await pass.value).toHaveProperty("result");
    expect(stops(x.f)).toBe(1);
    io.closeRequest();
    io.closeResponse();
    await rawTick();
    expect(stops(x.f)).toBe(1); // pending original invoke still cannot send
    release();
    expect(await request.value).toHaveProperty("error");
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

test("OCI HTTP unknown upload cancellation retains original handle without STOP/replay duplication", async () => {
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
    expect(stops(x.f)).toBe(1);
    await x.f.sql.run(
      "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
      [deletion.id],
    );
    expect(await x.f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(stops(x.f)).toBe(1);
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

function successorPeer(replies: (command: string) => readonly [body: object, final: boolean]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.defineProperties(new childProcess.ChildProcess(), {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  stdin.on("data", (bytes: Buffer) => {
    const [reply, final] = replies(bytes.subarray(4).toString());
    const body = Buffer.from(JSON.stringify({ ...reply, barrier: "unproven" }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    stdout.write(Buffer.concat([length, body]));
    if (final) {
      stdout.emit("end");
      stderr.emit("end");
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }
  });
  return child;
}

function modelRootTopology(path: string) {
  if (process.getuid?.() === 0) return () => undefined;
  // Native root ownership is the only inferred stat field in this portable fixture.
  const root = (stat: fs.BigIntStats) => Object.assign(stat, { uid: 0n });
  const open = files.open;
  const opened = spyOn(files, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (args[0] === path) {
      const stat = file.stat.bind(file);
      file.stat = ((...opts: Parameters<typeof file.stat>) =>
        stat(...opts).then((actual) => root(actual as fs.BigIntStats))) as typeof file.stat;
    }
    return file;
  });
  const lstat = fs.lstatSync;
  const named = spyOn(fs, "lstatSync").mockImplementation(((...args) => {
    const stat = Reflect.apply(lstat, fs, args);
    return args[0] === path ? root(stat) : stat;
  }) as typeof lstat);
  return () => {
    opened.mockRestore();
    named.mockRestore();
  };
}

async function verifySuccessorHttpClose(outcome: "joined" | "unknown") {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
  });
  let fresh: ReturnType<typeof f.reconstructParent> | undefined;
  let creatorCloseChecked = false;
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  let cleanupIo = () => {};
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    await f.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await f.sql.batch(V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements);
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    await f.composition.close();
    health.restore();
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.statements);

    const original = f.recordedCreate();
    const selector = {
      resourceUid: accepted.resourceUid,
      incarnationId: original.incarnationId,
      generation: original.generation,
    };
    const signal = new AbortController().signal;
    const creator = f.reconstructParent();
    fresh = creator;
    const path = join(original.allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE);
    const identity = { nativeId: original.claimId, namespaceDevice: "4", namespaceInode: "5" };
    const stat = await files.lstat(path, { bigint: true });
    const topology = {
      device: String(stat.dev),
      inode: String(stat.ino),
      size: String(stat.size),
      uid: "0",
      mode: String(stat.mode),
      nlink: String(stat.nlink),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    };
    const restoreRoot = modelRootTopology(path);
    const raw = spyOn(childProcess, "spawn");
    const io = ownedRawHttp();
    cleanupIo = () => {
      io.closeResponse();
      io.closeRequest();
      io.restore();
      restoreRoot();
      raw.mockRestore();
    };
    const existingCalls = raw.mock.calls.length;
    const reservations = () =>
      f.sql.query(
        "SELECT generation,epoch,close_document FROM tf_v2_container_application_successors",
      );
    await expect(
      creator.openCurrentSuccessorServingHttp(
        { ...selector, generation: selector.generation + 1 },
        signal,
      ),
    ).rejects.toThrow();
    expect(await reservations()).toEqual([]);
    expect(raw.mock.calls).toHaveLength(existingCalls);
    await expect(
      creator.openServingHttp(selector, new Request("http://caller.invalid/"), () => {}),
    ).rejects.toThrow("http_custody");
    expect(io.counts().calls).toBe(0);

    let heldCloses = 0;
    const live = successorPeer(() => [{ kind: "linux-oci-parent-live-init@1", ...identity }, true]);
    let opened = false;
    const held = successorPeer((command) => {
      if (!opened) {
        opened = true;
        expect(command.startsWith("TKOPEER2")).toBe(true);
        return [{ kind: "linux-oci-parent-held-live-init@1", ...identity }, false];
      }
      switch (JSON.parse(command).kind) {
        case "linux-oci-parent-held-live-init-read@1":
          return [{ kind: "linux-oci-parent-held-live-init-current@1" }, false];
        case "linux-oci-parent-held-admission-read@1":
          return [
            {
              kind: "linux-oci-parent-held-admission-current@1",
              nativeId: identity.nativeId,
              generation: String(original.generation),
              namespaceDevice: identity.namespaceDevice,
              namespaceInode: identity.namespaceInode,
              topology,
            },
            false,
          ];
        case "linux-oci-parent-held-live-init-close@1":
          heldCloses++;
          return [{ kind: "linux-oci-parent-held-live-init-closed@1" }, true];
        default:
          throw new Error("unexpected held command");
      }
    });

    raw.mockReturnValueOnce(live).mockReturnValueOnce(held);
    const connection = await creator.openCurrentSuccessorServingHttp(selector, signal);
    const originalCall = connection.open(
      new Request("https://caller.invalid/actual?x=1"),
      () => {},
    );
    const settled = observeRawPromise(originalCall.settlement);
    for (let i = 0; i < 250 && !io.counts().calls; i++) await rawTick();
    expect(io.counts().calls).toBe(1);
    expect(String(io.targets[0])).toBe("http://10.240.0.3:8080/actual?x=1");
    io.head();
    const response = await originalCall.response;
    io.incoming.end("NONSECRET successor response");
    expect(await response.text()).toBe("NONSECRET successor response");
    await rawTick();
    expect(settled.state()).toBe("pending");

    if (outcome === "joined") {
      // Serving readiness was withdrawn while the original exchange still
      // owns its raw handles. This refusal starts the H1 drain.
      await f.sql.run(
        "UPDATE tf_v2_resources SET observed_json=json_set(observed_json,'$.ready',json('false')) WHERE uid=?",
        [selector.resourceUid],
      );
      const refusal = connection.open(new Request("http://caller.invalid/"), () => {});
      await expect(refusal.response).rejects.toThrow();
      await refusal.settlement;
      expect(io.counts().requestDestroy).toBe(1);

      const closing = observeRawPromise(connection.close());
      await rawTick();
      expect(closing.state()).toBe("pending");
      expect(heldCloses).toBe(0);
      io.closeResponse();
      await rawTick();
      expect(closing.state()).toBe("pending");
      io.closeRequest();
      expect(await settled.value).toHaveProperty("result");
      expect(await closing.value).toHaveProperty("result");
      expect(heldCloses).toBe(1);
    } else {
      const failure = new Error("NONSECRET uncertain raw request shutdown");
      const requestDestroy = spyOn(io.request, "destroy").mockImplementation(() => {
        throw failure;
      });
      try {
        const closing = connection.close();
        await expect(closing).rejects.toThrow(failure);
        expect(connection.close()).toBe(closing);
        expect(await settled.value).toHaveProperty("error", failure);
        io.closeResponse();
        io.closeRequest();
        const creatorClose = creator.close();
        creatorCloseChecked = true;
        await expect(creatorClose).rejects.toThrow(failure);
        expect(heldCloses).toBe(0);
      } finally {
        requestDestroy.mockRestore();
      }
    }
    expect(await reservations()).toEqual([
      {
        generation: original.generation,
        epoch: 1,
        close_document: null,
      },
    ]);

    await expect(creator.openCurrentSuccessorServingHttp(selector, signal)).rejects.toThrow();
    expect(raw.mock.calls).toHaveLength(existingCalls + 2);
    expect(io.counts().calls).toBe(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    cleanupIo();
    health.restore();
    try {
      if (!creatorCloseChecked) await fresh?.close();
    } finally {
      await f.cleanup();
    }
  }
}

test.each(["joined", "unknown"] as const)(
  "OCI HTTP successor closes its held connector only after confirmed I/O (%s)",
  verifySuccessorHttpClose,
  20_000,
);
