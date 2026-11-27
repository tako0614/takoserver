import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { canonicalDigest } from "../src/json.ts";
import * as bundle from "../src/providers/linux-oci-owned-bundle.ts";
import * as sqlite from "../src/sql-sqlite.ts";
import {
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

test("fresh OCI creator selects the current durable original through its own read-only Sql scope", async () => {
  const createSql = sqlite.createSqliteSql;
  const createBundle = bundle.createLinuxOciOwnedBundle;
  let database: Parameters<typeof createSql>[0] | undefined;
  let options: Parameters<typeof createBundle>[0] | undefined;
  const captureSql = spyOn(sqlite, "createSqliteSql").mockImplementation((db) => {
    database ??= db;
    return createSql(db);
  });
  const captureBundle = spyOn(bundle, "createLinuxOciOwnedBundle").mockImplementation(
    (selected) => {
      options ??= selected;
      return createBundle(selected);
    },
  );
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
  }).finally(() => {
    captureBundle.mockRestore();
    captureSql.mockRestore();
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    if (!database || !options) throw Error("missing original database or creator inputs");
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    await f.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await f.sql.batch(V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements);
    const operation = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ id: operation.id, status: "succeeded" });
    const original = f.recordedCreate();
    await f.composition.close();

    const freshSql = createSql(database);
    expect(freshSql).not.toBe(f.sql);
    const fresh = createBundle({ ...options, sql: freshSql });
    const foreign = createBundle({ ...options, sql: createSql(database), targetKey: "foreign" });
    try {
      const signal = new AbortController().signal;
      const selector = {
        resourceUid: operation.resourceUid,
        incarnationId: original.incarnationId,
      };
      const ledger = async () =>
        canonicalDigest(
          await Promise.all([
            freshSql.query("SELECT * FROM tf_v2_operations"),
            freshSql.query("SELECT * FROM tf_v2_resources"),
            freshSql.query("SELECT * FROM tf_v2_container_instances"),
            freshSql.query("SELECT * FROM tf_v2_container_create_claims"),
            freshSql.query("SELECT * FROM tf_v2_container_start_attempts"),
            freshSql.query("SELECT * FROM tf_v2_container_shutdown_io_closes"),
          ]),
        );
      const baseline = await ledger();
      const native = f.nativeCounts();
      const raw = spyOn(childProcess, "spawn");
      const prior = raw.mock.calls.length;
      await expect(foreign.readCurrentLiveInit(selector, signal)).rejects.toThrow();
      await expect(
        fresh.readCurrentLiveInit({ ...selector, incarnationId: "0".repeat(64) }, signal),
      ).rejects.toThrow();
      await expect(
        fresh.readCurrentLiveInit({ ...selector, resourceUid: "foreign" }, signal),
      ).rejects.toThrow();
      const augmented = Object.defineProperty({ ...selector }, "claimId", {
        value: original.claimId,
      });
      await expect(fresh.readCurrentLiveInit(augmented, signal)).rejects.toThrow();
      expect(raw.mock.calls.length).toBe(prior);

      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.defineProperties(new childProcess.ChildProcess(), {
        stdin: { value: stdin },
        stdout: { value: stdout },
        stderr: { value: stderr },
      });
      const reply = {
        kind: "linux-oci-parent-live-init@1",
        nativeId: original.claimId,
        namespaceDevice: "4",
        namespaceInode: "5",
        barrier: "unproven",
      } as const;
      let request:
        | { readonly wire: string; readonly claim: string; readonly generation: bigint }
        | undefined;
      stdin.once("data", (frame: Buffer) => {
        request = {
          wire: frame.subarray(4, 12).toString(),
          claim: frame.subarray(12, 76).toString(),
          generation: frame.readBigUInt64BE(76),
        };
        const body = Buffer.from(JSON.stringify(reply));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length);
        stdout.write(Buffer.concat([length, body]));
        stdout.emit("end");
        stderr.emit("end");
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      raw.mockReturnValueOnce(child);
      const run = spyOn(freshSql, "run");
      const batch = spyOn(freshSql, "batch");
      try {
        expect(await fresh.readCurrentLiveInit(selector, signal)).toEqual(reply);
        expect(request).toEqual({
          wire: "TKOPEER2",
          claim: original.claimId,
          generation: BigInt(operation.generation),
        });
        expect(raw.mock.calls.at(-1)?.slice(0, 2)).toEqual([
          f.physicalBinary,
          ["--parent-peer-read-live-init"],
        ]);
        expect(raw.mock.calls.length).toBe(prior + 1);
        expect(run).not.toHaveBeenCalled();
        expect(batch).not.toHaveBeenCalled();
        expect(await ledger()).toBe(baseline);
      } finally {
        run.mockRestore();
        batch.mockRestore();
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
      }

      const deleteOwner = f.reconstructNormal();
      try {
        const deletion = await deleteOwner.engine.acceptDelete({
          principal: "synthetic-oci-parent",
          key: crypto.randomUUID(),
          uid: operation.resourceUid,
          expectedGeneration: operation.generation,
        });
        expect(deletion.status).toBe("queued");
        await expect(fresh.readCurrentLiveInit(selector, signal)).rejects.toThrow();
        expect(raw.mock.calls.length).toBe(prior + 1);
        expect(f.nativeCounts()).toEqual(native);
        expect(f.network).not.toHaveBeenCalled();
      } finally {
        await deleteOwner.close();
      }
    } finally {
      await foreign.close();
      await fresh.close();
    }
  } finally {
    health.restore();
    await f.cleanup();
  }
});
