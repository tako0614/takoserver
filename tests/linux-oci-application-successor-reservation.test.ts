import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { LINUX_OCI_HOST_TOPOLOGY_FILE } from "../src/providers/linux-oci-host-topology.ts";
import * as bundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { ownedRawHttp } from "./helpers/container-http-transport-fixture.ts";
import { acceptedRawHttp, syntheticTopology } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

const reservations = "tf_v2_container_application_successors";
const insert = `INSERT INTO main.${reservations}`;

function replyToLiveInit(nativeId: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.defineProperties(new childProcess.ChildProcess(), {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  stdin.once("data", () => {
    const body = Buffer.from(
      JSON.stringify({
        kind: "linux-oci-parent-live-init@1",
        nativeId,
        namespaceDevice: "4",
        namespaceInode: "5",
        barrier: "unproven",
      }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    stdout.write(Buffer.concat([length, body]));
    stdout.emit("end");
    stderr.emit("end");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

function heldLiveInitPeer(
  nativeId: string,
  namespaceInode: string,
  beforeRead?: () => Promise<void>,
  acknowledgeClose = true,
  admitted?: () => string | undefined,
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.defineProperties(new childProcess.ChildProcess(), {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  const operations: string[] = [];
  const send = (value: object | string) => {
    const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    stdout.write(Buffer.concat([size, body]));
  };
  stdin.on("data", (bytes: Buffer) => {
    if (operations.length === 0) {
      expect(bytes.length).toBe(176);
      expect(bytes.subarray(4, 12).toString()).toBe("TKOPEER2");
      expect(bytes.subarray(12, 76).toString()).toBe(nativeId);
      operations.push("open");
      send({
        kind: "linux-oci-parent-held-live-init@1",
        nativeId,
        namespaceDevice: "4",
        namespaceInode,
        barrier: "unproven",
      });
      return;
    }
    const command = bytes.subarray(4).toString();
    if (command === '{"kind":"linux-oci-parent-held-live-init-read@1"}') {
      operations.push("read");
      void Promise.resolve(beforeRead?.()).then(
        () => {
          send({ kind: "linux-oci-parent-held-live-init-current@1", barrier: "unproven" });
        },
        (error) => child.emit("error", error),
      );
      return;
    }
    if (command === '{"kind":"linux-oci-parent-held-admission-read@1"}') {
      operations.push("admission");
      const body = admitted?.();
      if (body !== undefined) send(body);
      else {
        stdout.emit("end");
        stderr.emit("end");
        child.emit("exit", 77, null);
        child.emit("close", 77, null);
      }
      return;
    }
    expect(command).toBe('{"kind":"linux-oci-parent-held-live-init-close@1"}');
    operations.push("close");
    if (acknowledgeClose)
      send({ kind: "linux-oci-parent-held-live-init-closed@1", barrier: "unproven" });
    stdout.emit("end");
    stderr.emit("end");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return {
    child,
    operations,
    dispose() {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

async function topologyReply(path: string, nativeId: string, generation: number) {
  const stat = await lstat(path, { bigint: true });
  return {
    kind: "linux-oci-parent-held-admission-current@1",
    nativeId,
    generation: String(generation),
    namespaceDevice: "4",
    namespaceInode: "5",
    topology: {
      device: String(stat.dev),
      inode: String(stat.ino),
      size: String(stat.size),
      uid: "0",
      mode: String(stat.mode),
      nlink: String(stat.nlink),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    },
    barrier: "unproven",
  };
}

function modelNativeTopologyOwner(path: string, beforeClose?: () => Promise<void>) {
  const needsRootOwner = process.getuid?.() !== 0;
  if (!needsRootOwner && !beforeClose) return () => undefined;
  // The held H command runs as root. All other fixture stat fields come
  // from the real descriptor and pathname, even on a non-root test runner.
  const rootOwner = <T extends { uid: number | bigint }>(stat: T) => {
    Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    return stat;
  };
  const open = files.open;
  const opened = spyOn(files, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (args[0] === path) {
      if (needsRootOwner) {
        const stat = file.stat;
        file.stat = ((...args) => Reflect.apply(stat, file, args).then(rootOwner)) as typeof stat;
      }
      if (beforeClose) {
        const close = file.close;
        file.close = async () => {
          await beforeClose();
          await close.call(file);
        };
      }
    }
    return file;
  });
  const stat = fs.lstatSync;
  const named =
    needsRootOwner &&
    spyOn(fs, "lstatSync").mockImplementation(((...args) => {
      const result = Reflect.apply(stat, fs, args);
      return args[0] === path ? rootOwner(result) : result;
    }) as typeof stat);
  return () => {
    if (named) named.mockRestore();
    opened.mockRestore();
  };
}

async function withOriginal(
  check: (fixture: Awaited<ReturnType<typeof preparedOriginal>>) => Promise<void>,
  expectUnknownClose = false,
) {
  const fixture = await preparedOriginal();
  try {
    await check(fixture);
    expect(fixture.f.network).not.toHaveBeenCalled();
  } finally {
    const close = fixture.close();
    if (expectUnknownClose) await expect(close).rejects.toThrow("parent_peer_retained");
    else await close;
  }
}

async function preparedOriginal() {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  let fresh: ReturnType<typeof f.reconstructParent> | undefined;
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    await f.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await f.sql.batch(V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements);
    const operation = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: operation.id,
      status: "succeeded",
      effect: "complete",
    });
    await f.composition.close();
    const original = f.recordedCreate();
    const selector = { resourceUid: operation.resourceUid, incarnationId: original.incarnationId };
    const signal = new AbortController().signal;
    fresh = f.reconstructParent();
    const raw = spyOn(childProcess, "spawn");
    const captureCreator = async (creator: ReturnType<typeof f.reconstructParent>) => {
      const readLiveInit = bundle.readOriginalLinuxOciLiveInit;
      type Read = Parameters<typeof readLiveInit>;
      let custody: Read[0] | undefined;
      let core: Read[1] | undefined;
      const capture = spyOn(bundle, "readOriginalLinuxOciLiveInit").mockImplementationOnce(
        (...args) => {
          [custody, core] = args;
          return readLiveInit(...args);
        },
      );
      try {
        raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
        expect(await creator.readCurrentLiveInit(selector, signal)).toMatchObject({
          nativeId: original.claimId,
        });
      } finally {
        capture.mockRestore();
      }
      if (!core || !custody) throw Error("genuine fresh Core and custody not captured");
      return { core, custody };
    };
    return {
      f,
      ...(await captureCreator(fresh)),
      captureCreator,
      fresh,
      selector,
      signal,
      raw,
      original,
      async expand() {
        await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.statements);
      },
      async close() {
        try {
          await fresh?.close();
        } finally {
          await f.cleanup();
        }
      },
    };
  } catch (error) {
    await fresh?.close();
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}

test("a same-claim successor reservation is confined to its issuing creator and cannot open HTTP", async () => {
  await withOriginal(
    async ({
      f,
      core,
      custody,
      fresh,
      selector,
      signal,
      raw,
      original,
      captureCreator,
      expand,
    }) => {
      const foreign = f.reconstructParent();
      try {
        const second = await captureCreator(foreign);
        expect(second.core).not.toBe(core);
        expect(second.custody).not.toBe(custody);
        await expand();
        raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
        const reservation = await core.reserveOriginalApplicationSuccessor(
          selector,
          custody,
          signal,
        );
        const connectorCount = raw.mock.calls.length;

        await expect(
          core.assertOriginalApplicationSuccessorReservation(
            reservation,
            selector,
            custody,
            signal,
          ),
        ).resolves.toBeUndefined();
        const rows = await f.sql.query(
          `SELECT owner_token, close_document FROM main.${reservations}`,
        );
        expect(rows).toHaveLength(1);
        const copied = Object.freeze({
          ownerToken: rows[0]?.owner_token,
        }) as unknown as typeof reservation;
        for (const [owner, handle, identity, key] of [
          [core, copied, selector, custody],
          [core, reservation, { ...selector, incarnationId: "0".repeat(64) }, custody],
          [core, reservation, selector, second.custody],
          [second.core, reservation, selector, second.custody],
        ] as const) {
          await expect(
            owner.assertOriginalApplicationSuccessorReservation(handle, identity, key, signal),
          ).rejects.toThrow();
        }
        const abort = new AbortController();
        abort.abort();
        await expect(
          core.assertOriginalApplicationSuccessorReservation(
            reservation,
            selector,
            custody,
            abort.signal,
          ),
        ).rejects.toThrow();

        const io = ownedRawHttp();
        const rawRequest = new Request("http://ignored.invalid/original-claim", { signal });
        try {
          await expect(
            fresh.openServingHttp(selector, rawRequest, () => undefined),
          ).rejects.toThrow(/http_custody/);
          expect(io.counts().calls).toBe(0);
        } finally {
          io.restore();
        }

        const query = f.sql.query.bind(f.sql);
        const closingRead = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
          const result = await query(statement, params);
          if (statement.startsWith("SELECT epoch,owner_token,predecessor_close_document")) {
            expect(result).toHaveLength(1);
            await fresh.close();
            expect(signal.aborted).toBe(false);
          }
          return result;
        });
        try {
          await expect(
            core.assertOriginalApplicationSuccessorReservation(
              reservation,
              selector,
              custody,
              signal,
            ),
          ).rejects.toThrow(/parent_custody/);
        } finally {
          closingRead.mockRestore();
        }
        expect(raw.mock.calls.length).toBe(connectorCount);
        expect(
          await f.sql.query(`SELECT owner_token, close_document FROM main.${reservations}`),
        ).toEqual(rows);
      } finally {
        await foreign.close();
      }
    },
  );
}, 20_000);

for (const variant of ["current", "cross-namespace", "post-read stale", "caller abort"] as const) {
  test(`owning creator held init validates its original source before handoff: ${variant}`, async () => {
    await withOriginal(async ({ f, fresh, selector, signal, raw, original, expand }) => {
      const baseline = raw.mock.calls.length;
      await expect(fresh.openCurrentHeldLiveInit(selector, signal)).rejects.toThrow();
      expect(raw.mock.calls.length).toBe(baseline);
      await expand();
      const caller = new AbortController();
      const rawHeld = heldLiveInitPeer(
        original.claimId,
        variant === "cross-namespace" ? "6" : "5",
        variant === "post-read stale"
          ? async () => {
              expect(
                (
                  await f.sql.run(
                    "UPDATE tf_v2_resources SET observed_json=json_set(observed_json,'$.ready',json('false')) WHERE uid=?",
                    [selector.resourceUid],
                  )
                ).changes,
              ).toBe(1);
            }
          : variant === "caller abort"
            ? async () => caller.abort()
            : undefined,
      );
      try {
        raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
        raw.mockReturnValueOnce(rawHeld.child);
        const opening = fresh.openCurrentHeldLiveInit(selector, caller.signal);
        if (variant === "current") {
          const held = await opening;
          expect(held.identity).toMatchObject({
            nativeId: original.claimId,
            namespaceDevice: "4",
            namespaceInode: "5",
          });
          expect(rawHeld.operations).toEqual(["open", "read"]);
          expect(held.revocation.aborted).toBe(false);
          await held.assertCurrent(new AbortController().signal);
          expect(rawHeld.operations).toEqual(["open", "read", "read"]);
          await expect(fresh.openCurrentHeldLiveInit(selector, signal)).rejects.toThrow();
          expect(raw.mock.calls.length).toBe(baseline + 2);
          const io = ownedRawHttp();
          try {
            await expect(
              fresh.openServingHttp(
                selector,
                new Request("http://ignored.invalid/private-held-source", { signal }),
                () => undefined,
              ),
            ).rejects.toThrow(/http_custody/);
            expect(io.counts().calls).toBe(0);
          } finally {
            io.restore();
          }
          await fresh.close();
          expect(held.revocation.aborted).toBe(true);
          expect(rawHeld.operations).toEqual(["open", "read", "read", "close"]);
          await held.close();
          await expect(held.assertCurrent(signal)).rejects.toThrow();
        } else {
          await expect(opening).rejects.toThrow();
          expect(rawHeld.operations).toEqual(["open", "read", "close"]);
          expect(rawHeld.child.stdin?.writableEnded).toBe(true);
        }
        expect(raw.mock.calls.slice(baseline).map(([binary, args]) => [binary, args])).toEqual([
          [f.physicalBinary, ["--parent-peer-read-live-init"]],
          [f.physicalBinary, ["--parent-peer-hold-live-init"]],
        ]);
        expect(await f.sql.query(`SELECT epoch, close_document FROM main.${reservations}`)).toEqual(
          [{ epoch: 1, close_document: null }],
        );
        await expect(fresh.openCurrentHeldLiveInit(selector, signal)).rejects.toThrow();
        expect(raw.mock.calls.length).toBe(baseline + 2);
      } finally {
        await fresh.close().catch(() => undefined);
        rawHeld.dispose();
      }
    });
  }, 20_000);
}

for (const interruption of ["before read", "during final SQL", "creator close"] as const) {
  test(`held admission reads only original topology and refuses ${interruption}`, async () => {
    await withOriginal(async ({ f, fresh, selector, signal, raw, original, expand }) => {
      await expand();
      const path = join(original.allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE);
      const savedPath = `${path}.original`;
      const originalBytes = await readFile(path);
      const reply = JSON.stringify(
        await topologyReply(path, original.claimId, original.generation),
      );
      const restore = modelNativeTopologyOwner(path);
      const peer = heldLiveInitPeer(original.claimId, "5", undefined, true, () => reply);
      raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
      raw.mockReturnValueOnce(peer.child);
      const releaseFence = Promise.withResolvers<void>();
      const finalFence = Promise.withResolvers<void>();
      let replaced = false;
      let restoreQuery: (() => void) | undefined;
      try {
        const held = await fresh.openCurrentHeldLiveInit(selector, signal);
        const observation = await held.readOriginalTopology(signal);
        expect(observation).toEqual({
          claimId: original.claimId,
          generation: original.generation,
          namespaceDevice: "4",
          namespaceInode: "5",
          topology: syntheticTopology(),
        });
        expect(Object.isFrozen(observation.topology)).toBe(true);
        const io = ownedRawHttp();
        try {
          await expect(
            fresh.openServingHttp(
              selector,
              new Request("http://ignored.invalid/"),
              () => undefined,
            ),
          ).rejects.toThrow("http_custody");
          expect(io.counts().calls).toBe(0);
        } finally {
          io.restore();
        }
        const replace = async () => {
          await rename(path, savedPath);
          replaced = true;
          await writeFile(path, originalBytes, { flag: "wx", mode: 0o600 });
        };
        if (interruption !== "before read") {
          const query = f.sql.query.bind(f.sql);
          let fences = 0;
          const spy = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
            if (
              statement.startsWith("SELECT epoch,owner_token,predecessor_close_document") &&
              ++fences === 2
            ) {
              finalFence.resolve();
              await releaseFence.promise;
            }
            return query(statement, params);
          });
          restoreQuery = () => spy.mockRestore();
        } else await replace();
        const reading = held.readOriginalTopology(signal);
        const finished = reading.then(
          () => "resolved",
          () => "refused",
        );
        let closing: Promise<void> | undefined;
        if (interruption !== "before read") {
          expect(await Promise.race([finalFence.promise.then(() => "fenced"), finished])).toBe(
            "fenced",
          );
          if (interruption === "creator close") {
            closing = fresh.close();
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(peer.operations).toEqual(["open", "read", "admission", "admission"]);
          } else await replace();
          releaseFence.resolve();
        }
        expect(await finished).toBe("refused");
        await closing;
        await held.close();
        expect(peer.operations).toEqual(["open", "read", "admission", "admission", "close"]);
      } finally {
        releaseFence.resolve();
        restoreQuery?.();
        if (replaced) await rename(savedPath, path);
        restore();
        await fresh.close().catch(() => undefined);
        peer.dispose();
      }
    });
  }, 20_000);
}

test("held admission refuses a serving row revoked during topology FD close", async () => {
  await withOriginal(async ({ f, fresh, selector, signal, raw, original, expand }) => {
    await expand();
    const path = join(original.allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE);
    const reply = JSON.stringify(await topologyReply(path, original.claimId, original.generation));
    const peer = heldLiveInitPeer(original.claimId, "5", undefined, true, () => reply);
    raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
    raw.mockReturnValueOnce(peer.child);
    const held = await fresh.openCurrentHeldLiveInit(selector, signal);
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const restore = modelNativeTopologyOwner(path, async () => {
      closeStarted.resolve();
      await releaseClose.promise;
    });
    const query = f.sql.query.bind(f.sql);
    let fences = 0;
    const spy = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
      const rows = await query(statement, params);
      if (statement.startsWith("SELECT epoch,owner_token,predecessor_close_document")) fences++;
      return rows;
    });
    try {
      const finished = held.readOriginalTopology(signal).then(
        () => "resolved",
        () => "refused",
      );
      expect(await Promise.race([closeStarted.promise.then(() => "closing"), finished])).toBe(
        "closing",
      );
      expect(fences).toBe(2);
      expect(
        (
          await f.sql.run(
            "UPDATE tf_v2_resources SET observed_json=json_set(observed_json,'$.ready',json('false')) WHERE uid=?",
            [selector.resourceUid],
          )
        ).changes,
      ).toBe(1);
      expect(signal.aborted).toBe(false);
      expect(held.revocation.aborted).toBe(false);
      releaseClose.resolve();
      expect(await finished).toBe("refused");
      expect(fences).toBe(3);
      expect(peer.operations).toEqual(["open", "read", "admission", "close"]);
    } finally {
      releaseClose.resolve();
      spy.mockRestore();
      restore();
      await fresh.close().catch(() => undefined);
      peer.dispose();
    }
  });
}, 20_000);

for (const fault of ["namespace", "decimal", "duplicate field", "native refusal"] as const) {
  test(`held admission keeps original transport unknown after ${fault}`, async () => {
    await withOriginal(async ({ fresh, selector, signal, raw, original, expand }) => {
      await expand();
      const path = join(original.allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE);
      const reply = await topologyReply(path, original.claimId, original.generation);
      if (fault === "namespace") reply.namespaceInode = "6";
      if (fault === "decimal") reply.topology.inode = `0${reply.topology.inode}`;
      const body = JSON.stringify(reply);
      const adverse =
        fault === "duplicate field"
          ? body.replace('"uid":"0"', '"uid":"0","uid":"0"')
          : fault === "native refusal"
            ? undefined
            : body;
      const peer = heldLiveInitPeer(original.claimId, "5", undefined, true, () => adverse);
      raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
      raw.mockReturnValueOnce(peer.child);
      try {
        const held = await fresh.openCurrentHeldLiveInit(selector, signal);
        await expect(held.readOriginalTopology(signal)).rejects.toThrow("parent_peer_retained");
        expect(held.revocation.aborted).toBe(true);
        await expect(fresh.close()).rejects.toThrow("parent_peer_retained");
        expect(peer.operations).toEqual(["open", "read", "admission"]);
      } finally {
        peer.dispose();
      }
    }, true);
  }, 20_000);
}

test("creator close joins the final held init read before native close", async () => {
  await withOriginal(async ({ f, fresh, selector, signal, raw, original, expand }) => {
    await expand();
    const rawHeld = heldLiveInitPeer(original.claimId, "5");
    raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
    raw.mockReturnValueOnce(rawHeld.child);
    const held = await fresh.openCurrentHeldLiveInit(selector, signal);
    const finalFence = Promise.withResolvers<void>();
    const releaseFence = Promise.withResolvers<void>();
    const query = f.sql.query.bind(f.sql);
    let fences = 0;
    const spy = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
      if (
        statement.startsWith("SELECT epoch,owner_token,predecessor_close_document") &&
        ++fences === 2
      ) {
        finalFence.resolve();
        await releaseFence.promise;
      }
      return query(statement, params);
    });
    try {
      const reading = held.assertCurrent(signal);
      const finished = reading.then(
        () => "resolved",
        () => "refused",
      );
      expect(await Promise.race([finalFence.promise.then(() => "fenced"), finished])).toBe(
        "fenced",
      );
      const closure = fresh.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rawHeld.operations).toEqual(["open", "read", "read"]);
      releaseFence.resolve();
      expect(await finished).toBe("refused");
      await closure;
      expect(rawHeld.operations).toEqual(["open", "read", "read", "close"]);
    } finally {
      releaseFence.resolve();
      spy.mockRestore();
      await fresh.close().catch(() => undefined);
      rawHeld.dispose();
    }
  });
}, 20_000);

for (const revokedBy of ["read cancellation", "creator close"] as const) {
  test(`held init refuses ${revokedBy} after its final inner check`, async () => {
    await withOriginal(async ({ f, fresh, selector, signal, raw, original, expand }) => {
      await expand();
      const rawHeld = heldLiveInitPeer(original.claimId, "5");
      raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
      raw.mockReturnValueOnce(rawHeld.child);
      const held = await fresh.openCurrentHeldLiveInit(selector, signal);
      const caller = new AbortController();
      const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
      if (!aborted) throw Error("AbortSignal getter is unavailable");
      const query = f.sql.query.bind(f.sql);
      let fences = 0;
      let queued = false;
      let closing: Promise<void> | undefined;
      const spy = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
        const rows = await query(statement, params);
        if (statement.startsWith("SELECT epoch,owner_token,predecessor_close_document")) fences++;
        return rows;
      });
      Object.defineProperty(held.revocation, "aborted", {
        configurable: true,
        get() {
          const value = aborted.call(this);
          if (fences === 2 && !queued) {
            queued = true;
            // Queue real revocation after the inner check has read this value,
            // ahead of the outer continuation that returns the read result.
            queueMicrotask(() => {
              if (revokedBy === "read cancellation") caller.abort();
              else closing = fresh.close();
            });
          }
          return value;
        },
      });
      try {
        const outcome = await held.assertCurrent(caller.signal).then(
          () => "resolved",
          () => "refused",
        );
        expect(queued).toBe(true);
        expect(outcome).toBe("refused");
        expect(fences).toBe(2);
        await closing;
        expect(rawHeld.operations).toEqual(["open", "read", "read", "close"]);
      } finally {
        Reflect.deleteProperty(held.revocation, "aborted");
        spy.mockRestore();
        await fresh.close().catch(() => undefined);
        rawHeld.dispose();
      }
    });
  }, 20_000);
}

for (const terminal of [
  "acknowledged",
  "unknown",
  "refused before handoff",
  "opening lost",
  "creator closes during acquisition",
] as const) {
  test(`held init owns close through caller abort or refused handoff: ${terminal}`, async () => {
    await withOriginal(
      async ({ fresh, selector, raw, original, expand }) => {
        await expand();
        const caller = new AbortController();
        let entered!: () => void;
        let release!: () => void;
        const readEntered = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const readMayFinish = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reads = 0;
        const inFlight = terminal === "acknowledged";
        const acquiring = terminal === "creator closes during acquisition";
        const openingLost = terminal === "opening lost";
        const peer = heldLiveInitPeer(
          original.claimId,
          openingLost ? "invalid" : terminal === "refused before handoff" ? "6" : "5",
          async () => {
            reads++;
            if ((inFlight && reads === 2) || (acquiring && reads === 1)) {
              entered();
              await readMayFinish;
            }
          },
          inFlight || acquiring,
        );
        try {
          raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
          raw.mockReturnValueOnce(peer.child);
          const open = fresh.openCurrentHeldLiveInit(selector, caller.signal);
          if (acquiring) {
            const refused = open.then(
              () => false,
              () => true,
            );
            await readEntered;
            const closing = fresh.close();
            expect(peer.operations).toEqual(["open", "read"]);
            expect(peer.child.stdin?.writableEnded).toBe(false);
            release();
            expect(await refused).toBe(true);
            await closing;
          } else if (openingLost || terminal === "refused before handoff") {
            await expect(open).rejects.toThrow();
          } else {
            const held = await open;
            const reading = inFlight
              ? held.assertCurrent(caller.signal).then(
                  () => false,
                  () => true,
                )
              : undefined;
            if (reading) await readEntered;
            caller.abort();
            expect(held.revocation.aborted).toBe(true);
            await expect(held.assertCurrent(new AbortController().signal)).rejects.toThrow();
            const close = held.close();
            expect(held.close()).toBe(close);
            if (inFlight) {
              expect(peer.operations).toEqual(["open", "read", "read"]);
              expect(peer.child.stdin?.writableEnded).toBe(false);
              release();
              expect(await reading).toBe(true);
              await close;
            } else {
              await expect(close).rejects.toThrow("parent_peer_retained");
            }
          }
          if (inFlight) {
            await fresh.close();
            expect(peer.operations).toEqual(["open", "read", "read", "close"]);
          } else if (acquiring) {
            expect(peer.operations).toEqual(["open", "read", "close"]);
          } else {
            await expect(fresh.close()).rejects.toThrow("parent_peer_retained");
            await expect(fresh.close()).rejects.toThrow("parent_peer_retained");
            expect(peer.operations).toEqual(openingLost ? ["open"] : ["open", "read", "close"]);
          }
        } finally {
          release();
          await fresh.close().catch(() => undefined);
          peer.dispose();
        }
      },
      terminal === "unknown" ||
        terminal === "refused before handoff" ||
        terminal === "opening lost",
    );
  }, 20_000);
}

test("authentic H0 and the still-current original peer reserve one opaque epoch", async () => {
  await withOriginal(
    async ({ f, core, custody, fresh, selector, signal, raw, original, expand }) => {
      const count = raw.mock.calls.length;
      await expect(
        core.reserveOriginalApplicationSuccessor(selector, custody, signal),
      ).rejects.toThrow();
      await expand();
      await expect(fresh.readCurrentLiveInit(selector, signal)).rejects.toThrow();
      await expect(core.reserveOriginalApplicationSuccessor(selector, {}, signal)).rejects.toThrow(
        /parent_custody/,
      );
      const closeRows = await f.sql.query(
        "SELECT close_document FROM tf_v2_container_shutdown_io_closes",
      );
      if (closeRows.length !== 1 || typeof closeRows[0]?.close_document !== "string")
        throw Error("missing genuine shutdown receipt");
      const predecessor = closeRows[0].close_document;
      const read = f.sql.query.bind(f.sql);
      const corrupt = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
        if (
          !statement.startsWith(
            "SELECT close_document FROM main.tf_v2_container_shutdown_io_closes",
          )
        )
          return read(statement, params);
        const envelope = JSON.parse(predecessor);
        envelope.ciphertext = "A".repeat(envelope.ciphertext.length);
        return [{ close_document: JSON.stringify(envelope) }];
      });
      try {
        await expect(
          core.reserveOriginalApplicationSuccessor(selector, custody, signal),
        ).rejects.toThrow();
      } finally {
        corrupt.mockRestore();
      }
      expect(raw.mock.calls.length).toBe(count);
      expect(await f.sql.query(`SELECT * FROM ${reservations}`)).toEqual([]);
      raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
      const reservation = await core.reserveOriginalApplicationSuccessor(selector, custody, signal);
      expect(Object.isFrozen(reservation)).toBe(true);
      expect(Object.getPrototypeOf(reservation)).toBeNull();
      expect(Reflect.ownKeys(reservation)).toEqual([]);
      expect(raw.mock.calls.length).toBe(count + 1);
      expect(raw.mock.calls.at(-1)?.slice(0, 2)).toEqual([
        f.physicalBinary,
        ["--parent-peer-read-live-init"],
      ]);
      expect(
        await f.sql.query(
          `SELECT epoch,claim_id,native_id,predecessor_close_document,close_document FROM ${reservations}`,
        ),
      ).toEqual([
        {
          epoch: 1,
          claim_id: original.claimId,
          native_id: original.claimId,
          predecessor_close_document: predecessor,
          close_document: null,
        },
      ]);
      expect(
        await f.sql.query("SELECT close_document FROM tf_v2_container_shutdown_io_closes"),
      ).toEqual(closeRows);
      await expect(
        core.reserveOriginalApplicationSuccessor(selector, custody, signal),
      ).rejects.toThrow();
      expect(raw.mock.calls.length).toBe(count + 1);
    },
  );
}, 20_000);

for (const fault of [
  "lost ACK",
  "abort",
  "stale START",
  "wrong readback",
  "closed creator",
  "schema changed before INSERT",
  "schema changed before readback",
  "late TEMP proof view",
] as const) {
  test(`application successor returns no reservation on ${fault}`, async () => {
    await withOriginal(async ({ f, core, custody, fresh, selector, raw, original, expand }) => {
      await expand();
      const controller = new AbortController();
      const count = raw.mock.calls.length;
      const run = f.sql.run.bind(f.sql);
      const missingWrite =
        fault === "stale START" ||
        fault === "schema changed before INSERT" ||
        fault === "late TEMP proof view";
      const addForeignTrigger = () =>
        run(
          `CREATE TRIGGER tf_v2_container_fixture_drift AFTER UPDATE ON ${reservations}
          BEGIN SELECT 1; END`,
        );
      const query = f.sql.query.bind(f.sql);
      const readback =
        fault === "wrong readback"
          ? spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
              const rows = await query(statement, params);
              if (!statement.startsWith("SELECT epoch,owner_token,predecessor_close_document"))
                return rows;
              expect(rows).toHaveLength(1);
              return rows.map((row) => ({ ...row, owner_token: "0".repeat(64) }));
            })
          : undefined;
      let writes = 0;
      const intercept = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
        if (!statement.startsWith(insert)) return run(statement, params);
        writes++;
        if (fault === "stale START") {
          expect(
            (
              await run(
                "UPDATE tf_v2_container_start_attempts SET state='exited',confirmed_exited_at_ms=confirmed_running_at_ms WHERE create_claim_id=? AND state='running'",
                [original.claimId],
              )
            ).changes,
          ).toBe(1);
        }
        if (fault === "schema changed before INSERT") await addForeignTrigger();
        if (fault === "late TEMP proof view")
          await run("CREATE TEMP VIEW tf_v2_resources AS SELECT * FROM main.tf_v2_resources");
        const ack = await run(statement, params);
        expect(ack.changes).toBe(missingWrite ? 0 : 1);
        if (fault === "lost ACK") throw Error("fixture reservation ACK lost after commit");
        if (fault === "abort") controller.abort();
        if (fault === "closed creator") {
          await fresh.close();
          expect(controller.signal.aborted).toBe(false);
        }
        if (fault === "schema changed before readback") await addForeignTrigger();
        return ack;
      });
      try {
        raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
        await expect(
          core.reserveOriginalApplicationSuccessor(selector, custody, controller.signal),
        ).rejects.toThrow();
        expect(writes).toBe(1);
        expect(raw.mock.calls.length).toBe(count + 1);
        expect(await f.sql.query(`SELECT epoch, close_document FROM ${reservations}`)).toEqual(
          missingWrite ? [] : [{ epoch: 1, close_document: null }],
        );
        const freshSignal = new AbortController().signal;
        await expect(
          core.reserveOriginalApplicationSuccessor(selector, custody, freshSignal),
        ).rejects.toThrow();
        expect(writes).toBe(1);
        expect(raw.mock.calls.length).toBe(count + 1);
      } finally {
        intercept.mockRestore();
        readback?.mockRestore();
      }
    });
  }, 20_000);
}

test("a TEMP successor table never provides a reservation readback", async () => {
  await withOriginal(async ({ f, core, custody, selector, signal, raw, expand }) => {
    await expand();
    await f.sql.run(`CREATE TEMP TABLE ${reservations} (
      resource_uid TEXT, generation INTEGER, claim_id TEXT, native_id TEXT,
      epoch INTEGER, owner_token TEXT, predecessor_close_document TEXT, close_document TEXT
    )`);
    const calls = raw.mock.calls.length;
    // If a regressed path opens the reader, use only the existing raw mock.
    raw.mockReturnValueOnce(replyToLiveInit(f.recordedCreate().claimId));
    await expect(
      core.reserveOriginalApplicationSuccessor(selector, custody, signal),
    ).rejects.toThrow();
    expect(raw.mock.calls.length).toBe(calls);
    expect(await f.sql.query(`SELECT epoch FROM main.${reservations}`)).toEqual([]);
    expect(await f.sql.query(`SELECT epoch FROM temp.${reservations}`)).toEqual([]);
  });
}, 20_000);
