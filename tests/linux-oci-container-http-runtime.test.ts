import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import * as net from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { LINUX_OCI_HOST_TOPOLOGY_FILE } from "../src/providers/linux-oci-host-topology.ts";
import {
  v2ConfiguredUpdateDiscardTransition,
  v2FinalDeleteConfiguredUpdateDiscardTransition,
} from "../src/takoform-v2/configured-update-inputs-schema.ts";
import {
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
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

async function verifySuccessorHttpClose(
  outcome:
    | "joined"
    | "withdrawn"
    | "unknown"
    | "ack-lost"
    | "binding"
    | "delete"
    | "delete-late"
    | "delete-restart"
    | "delete-unknown",
) {
  const deleting = outcome.startsWith("delete");
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
  });
  let fresh: ReturnType<typeof f.reconstructParent> | undefined;
  let restarted: ReturnType<typeof f.reconstructParent> | undefined;
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
    if (deleting) {
      await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
      await f.sql.batch(v2FinalDeleteConfiguredUpdateDiscardTransition());
    }
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    await f.composition.close();
    health.restore();
    const original = f.recordedCreate();
    const selector = {
      resourceUid: accepted.resourceUid,
      incarnationId: original.incarnationId,
      generation: original.generation,
    };
    const signal = new AbortController().signal;
    const creator = f.reconstructParent();
    fresh = creator;
    const before = f.nativeCounts();
    await expect(
      creator.openServingHttp(selector, new Request("http://caller.invalid/"), () => {}),
    ).rejects.toThrow("http_custody");
    expect(f.nativeCounts()).toEqual(before);
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.statements);
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
        "SELECT generation,epoch,owner_token,close_document,json_extract(predecessor_close_document,'$.scope.controlDigest') AS control_digest FROM tf_v2_container_application_successors",
      );
    await expect(
      creator.openCurrentSuccessorServingHttp(
        { ...selector, generation: selector.generation + 1 },
        signal,
      ),
    ).rejects.toThrow();
    expect(await reservations()).toEqual([]);
    expect(raw.mock.calls).toHaveLength(existingCalls);
    expect(io.counts().calls).toBe(0);

    let heldCloses = 0;
    function queueOriginalPeers() {
      const live = successorPeer(() => [
        { kind: "linux-oci-parent-live-init@1", ...identity },
        true,
      ]);
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
    }

    queueOriginalPeers();
    if (outcome === "binding") {
      const cancel = new AbortController();
      const canceled = creator.openServingHttp(
        selector,
        new Request("http://caller.invalid/canceled", { signal: cancel.signal }),
        () => {},
      );
      let revoked = false;
      const revokedCall = creator.openServingHttp(
        selector,
        new Request("http://caller.invalid/revoked"),
        () => {
          if (revoked) throw new Error("NONSECRET caller lost its binding");
        },
      );
      const opening = creator.openServingHttp(
        selector,
        new Request("http://caller.invalid/first"),
        () => {},
      );
      cancel.abort();
      revoked = true;
      await expect(canceled).rejects.toThrow("revoked");
      await expect(revokedCall).rejects.toThrow("caller lost its binding");
      const first = await opening;
      for (let i = 0; i < 250 && !io.counts().calls; i++) await rawTick();
      expect(io.counts().calls).toBe(1);
      expect(String(io.targets[0])).toBe("http://10.240.0.3:8080/first");
      io.head();
      const response = await first.response;
      io.incoming.end("NONSECRET first binding exchange");
      expect(await response.text()).toBe("NONSECRET first binding exchange");
      io.closeResponse();
      io.closeRequest();
      await first.settlement;
      const originalRows = await reservations();
      expect(originalRows).toMatchObject([{ epoch: 1, close_document: null }]);
      expect(raw.mock.calls).toHaveLength(existingCalls + 2);

      io.restore();
      const again = ownedRawHttp();
      try {
        await expect(
          creator.fetchServingHttp(selector, new Request("http://caller.invalid/legacy")),
        ).rejects.toThrow("http_custody");
        const second = await creator.openServingHttp(
          selector,
          new Request("http://caller.invalid/again"),
          () => {},
        );
        for (let i = 0; i < 250 && !again.counts().calls; i++) await rawTick();
        expect(again.counts().calls).toBe(1);
        expect(String(again.targets[0])).toBe("http://10.240.0.3:8080/again");
        again.head();
        const hit = await second.response;
        again.incoming.end("NONSECRET second binding exchange");
        expect(await hit.text()).toBe("NONSECRET second binding exchange");
        again.closeResponse();
        again.closeRequest();
        await second.settlement;
        expect(await reservations()).toEqual(originalRows);
        expect(raw.mock.calls).toHaveLength(existingCalls + 2);
        creatorCloseChecked = true;
        await creator.close();
        expect(heldCloses).toBe(1);
        expect(typeof (await reservations())[0]?.close_document).toBe("string");
        expect(f.network).not.toHaveBeenCalled();
        return;
      } finally {
        again.closeResponse();
        again.closeRequest();
        again.restore();
      }
    }
    const connection = await creator.openCurrentSuccessorServingHttp(selector, signal);
    const originalCall = connection.open(
      new Request("https://caller.invalid/actual?x=1"),
      () => {},
    );
    if (outcome === "joined") {
      const contender = f.reconstructParent();
      try {
        // The latest owner is still active. A separate creator cannot renew or
        // adopt the claim from the original H0 receipt in this interval.
        await expect(contender.openCurrentSuccessorServingHttp(selector, signal)).rejects.toThrow();
        expect(await reservations()).toMatchObject([{ epoch: 1, close_document: null }]);
        expect(raw.mock.calls).toHaveLength(existingCalls + 2);
      } finally {
        await contender.close();
      }
    }
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

    if (deleting) {
      let currentCreator = creator;
      let priorClose: string | undefined;
      if (outcome === "delete-restart") {
        io.closeResponse();
        io.closeRequest();
        expect(await settled.value).toHaveProperty("result");
        creatorCloseChecked = true;
        await creator.close();
        const document = (await reservations())[0]?.close_document;
        if (typeof document !== "string") throw new Error("missing H1 close before restart");
        priorClose = document;
        currentCreator = restarted = f.reconstructParent();
      }
      let now = Date.now();
      const engine = createTakoformV2Engine(
        {
          sql: f.sql,
          now: () => new Date(now),
          authorize: async () => true,
          replayWindowSeconds: 3600,
          forms: { [currentCreator.formUrl]: currentCreator.retainedForm },
        },
        currentCreator.acceptance,
      );
      const principal = "synthetic-oci-parent";
      const removing = await engine.acceptDelete({
        principal,
        key: crypto.randomUUID(),
        uid: selector.resourceUid,
        expectedGeneration: selector.generation,
      });
      const acceptedDelete = await f.sql.query(
        "SELECT application_successor_owner_token FROM tf_v2_container_acceptances WHERE operation_id=?",
        [removing.id],
      );
      expect(acceptedDelete).toEqual([
        { application_successor_owner_token: (await reservations())[0]?.owner_token },
      ]);
      expect(io.counts().requestDestroy).toBe(0);

      const stops = () =>
        f.nativeCounts().requests.filter((kind) => kind === "linux-oci-stop-init@1").length;
      if (outcome === "delete-unknown") {
        const uncertainty = new Error("NONSECRET uncertain original request closure");
        const destroy = spyOn(io.request, "destroy").mockImplementation(() => {
          throw uncertainty;
        });
        try {
          expect(await engine.runNext()).toMatchObject({
            id: removing.id,
            status: "reconciling",
            effect: "unknown",
          });
          expect(await settled.value).toHaveProperty("error", uncertainty);
          expect(heldCloses).toBe(0);
          expect(stops()).toBe(0);
          expect((await reservations())[0]?.close_document).toBeNull();
          io.closeResponse();
          io.closeRequest();
          creatorCloseChecked = true;
          await expect(creator.close()).rejects.toThrow(uncertainty);
          expect(f.network).not.toHaveBeenCalled();
          return;
        } finally {
          destroy.mockRestore();
        }
      }

      let submittedCloses = 0;
      if (outcome === "delete-late") {
        const run = f.sql.run.bind(f.sql);
        const writes = spyOn(f.sql, "run").mockImplementation((statement, params) => {
          if (
            statement.startsWith(
              "UPDATE main.tf_v2_container_application_successors SET close_document=",
            )
          )
            submittedCloses++;
          return run(statement, params);
        });
        const cleanup = cleanupIo;
        cleanupIo = () => {
          writes.mockRestore();
          cleanup();
        };
      }
      const pass = observeRawPromise(engine.runNext());
      let first: Awaited<typeof pass.value> | undefined;
      if (outcome === "delete" || outcome === "delete-late") {
        for (let i = 0; i < 250 && !io.counts().requestDestroy; i++) await rawTick();
        expect(io.counts().requestDestroy).toBe(1);
        expect(stops()).toBe(0);
        expect(heldCloses).toBe(0);
        expect((await reservations())[0]?.close_document).toBeNull();
        if (outcome === "delete-late") {
          // Let the ordinary dispatch deadline expire with both original
          // streams pending. The source must keep that exact join in custody.
          first = await pass.value;
          expect(first).toMatchObject({
            result: { id: removing.id, status: "reconciling", effect: "unknown" },
          });
          expect(settled.state()).toBe("pending");
          expect(stops()).toBe(0);
          expect(heldCloses).toBe(0);
          expect(submittedCloses).toBe(0);
          expect((await reservations())[0]?.close_document).toBeNull();
        }
        io.closeResponse();
        await rawTick();
        expect(stops()).toBe(0);
        expect(heldCloses).toBe(0);
        io.closeRequest();
        expect(await settled.value).toHaveProperty("result");
      }
      first ??= await pass.value;
      if ("error" in first) throw first.error;
      let final = first.result;
      for (let i = 0; i < 12 && final?.status !== "succeeded"; i++) {
        now += 61000;
        final = await engine.runNext();
      }
      expect(final).toMatchObject({ id: removing.id, status: "succeeded", effect: "complete" });
      expect(stops()).toBe(1);
      expect(heldCloses).toBe(1);
      if (outcome === "delete-late") expect(submittedCloses).toBe(1);
      const stored = (await reservations())[0]?.close_document;
      expect(typeof stored).toBe("string");
      if (priorClose !== undefined) expect(stored).toBe(priorClose);
      const claims = await f.sql.query(
        "SELECT state,allocation_cleanup,application_io_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=?",
        [selector.resourceUid],
      );
      expect(claims).toMatchObject([{ state: "removed", allocation_cleanup: "closed" }]);
      const close = claims[0]?.application_io_cleanup;
      if (typeof close !== "string") throw new Error("missing accepted DELETE application close");
      expect(JSON.parse(close)).toMatchObject({
        kind: "linux-oci-sealed-application-io-close@1",
        scope: { operation: { operationId: removing.id } },
      });
      expect(f.network).not.toHaveBeenCalled();
      return;
    }

    let closeWrites = 0;
    let next: Awaited<ReturnType<typeof creator.openCurrentSuccessorServingHttp>> | undefined;
    let submittedClose: string | undefined;
    const run = f.sql.run.bind(f.sql);
    const write = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
      if (
        !statement.startsWith(
          "UPDATE main.tf_v2_container_application_successors SET close_document=",
        )
      )
        return run(statement, params);
      closeWrites++;
      const document = params?.[0];
      if (typeof document !== "string") throw new Error("missing submitted close document");
      submittedClose = document;
      const result = await run(statement, params);
      if (outcome === "joined" && closeWrites === 1 && result.changes === 1) {
        // H2 can open using the committed H1 close before H1 gets the write ACK.
        restarted = f.reconstructParent();
        queueOriginalPeers();
        next = await restarted.openCurrentSuccessorServingHttp(selector, signal);
        expect(await reservations()).toMatchObject([
          { epoch: 1, close_document: document },
          { epoch: 2, close_document: null },
        ]);
      }
      if (outcome === "ack-lost" && result.changes === 1)
        throw new Error("NONSECRET simulated lost acknowledgement after commit");
      return result;
    });
    const cleanup = cleanupIo;
    cleanupIo = () => {
      write.mockRestore();
      cleanup();
    };

    if (outcome === "withdrawn") {
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
    }
    if (outcome !== "unknown") {
      const close = creator.close();
      creatorCloseChecked = true;
      const closing = observeRawPromise(close);
      await rawTick();
      expect(closing.state()).toBe("pending");
      expect(heldCloses).toBe(0);
      expect(closeWrites).toBe(0);
      io.closeResponse();
      await rawTick();
      expect(closing.state()).toBe("pending");
      io.closeRequest();
      expect(await settled.value).toHaveProperty("result");
      if (outcome === "withdrawn") expect(await closing.value).toHaveProperty("error");
      else expect(await closing.value).toHaveProperty("result");
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
    const rows = await reservations();
    expect(rows).toHaveLength(outcome === "joined" ? 2 : 1);
    expect(rows[0]).toMatchObject({ generation: original.generation, epoch: 1 });
    if (outcome === "joined" || outcome === "ack-lost") {
      const document = rows[0]?.close_document;
      if (typeof document !== "string") throw new Error("missing owned successor close document");
      expect(submittedClose).toBe(document);
      expect(closeWrites).toBe(1);
      expect(JSON.parse(document)).toMatchObject({
        kind: "linux-oci-sealed-host-application-successor-close@1",
        scope: {
          purpose: "takoserver.linux-oci-host-application-successor-close@1",
          resourceUid: selector.resourceUid,
          incarnationId: selector.incarnationId,
          installationId: original.installationId,
          generation: original.generation,
          claimId: original.claimId,
          nativeId: original.claimId,
          epoch: 1,
          ownerToken: rows[0]?.owner_token,
          controlDigest: rows[0]?.control_digest,
        },
      });
    } else {
      expect(rows[0]?.close_document).toBeNull();
      if (outcome === "unknown") expect(closeWrites).toBe(0);
    }

    await expect(creator.openCurrentSuccessorServingHttp(selector, signal)).rejects.toThrow();
    expect(raw.mock.calls).toHaveLength(existingCalls + (outcome === "joined" ? 4 : 2));
    expect(io.counts().calls).toBe(1);
    if (outcome === "joined") {
      if (!restarted || !next) throw new Error("missing H2 from committed H1 close");
      io.restore();
      const secondIo = ownedRawHttp();
      try {
        const second = next.open(new Request("http://caller.invalid/restarted"), () => {});
        for (let i = 0; i < 250 && !secondIo.counts().calls; i++) await rawTick();
        expect(secondIo.counts().calls).toBe(1);
        expect(String(secondIo.targets[0])).toBe("http://10.240.0.3:8080/restarted");
        secondIo.head();
        const hit = await second.response;
        secondIo.incoming.end("NONSECRET response after a second Host restart");
        expect(await hit.text()).toBe("NONSECRET response after a second Host restart");
        secondIo.closeResponse();
        secondIo.closeRequest();
        await second.settlement;
        await restarted.close();

        const chain = await f.sql.query(
          "SELECT epoch,owner_token,claim_id,native_id,predecessor_close_document,close_document FROM tf_v2_container_application_successors ORDER BY epoch",
        );
        expect(chain).toMatchObject([
          {
            epoch: 1,
            claim_id: original.claimId,
            native_id: original.claimId,
            close_document: rows[0]?.close_document,
          },
          {
            epoch: 2,
            claim_id: original.claimId,
            native_id: original.claimId,
            predecessor_close_document: rows[0]?.close_document,
          },
        ]);
        expect(chain[1]?.owner_token).not.toBe(chain[0]?.owner_token);
        const secondClose = chain[1]?.close_document;
        if (typeof secondClose !== "string") throw new Error("missing second application close");
        expect(JSON.parse(secondClose)).toMatchObject({
          scope: { epoch: 2, ownerToken: chain[1]?.owner_token, nativeId: original.claimId },
        });
        expect(closeWrites).toBe(2);
        expect(heldCloses).toBe(2);
        expect(raw.mock.calls).toHaveLength(existingCalls + 4);
      } finally {
        secondIo.closeResponse();
        secondIo.closeRequest();
        secondIo.restore();
        await restarted.close();
      }
    }
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    cleanupIo();
    health.restore();
    try {
      await restarted?.close();
      if (!creatorCloseChecked) await fresh?.close();
    } finally {
      await f.cleanup();
    }
  }
}

test.each([
  "joined",
  "withdrawn",
  "unknown",
  "ack-lost",
  "binding",
  "delete",
  "delete-late",
  "delete-restart",
  "delete-unknown",
] as const)(
  "OCI HTTP successor closes its held connector only after confirmed I/O (%s)",
  verifySuccessorHttpClose,
  20_000,
);
