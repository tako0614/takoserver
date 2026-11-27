import { expect, spyOn, test } from "bun:test";
import { canonicalDigest } from "../src/json.ts";
import * as bundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

async function runningFixture() {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
  });
  const seal = bundle.sealOriginalLinuxOciParentControl;
  type Seal = Parameters<typeof seal>;
  const captures: { custody: Seal[0]; core: Seal[1]; record: Seal[2] }[] = [];
  const capture = spyOn(bundle, "sealOriginalLinuxOciParentControl").mockImplementation(
    (...args) => {
      captures.push({ custody: args[0], core: args[1], record: args[2] });
      return seal(...args);
    },
  );
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    await f.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await f.sql.batch(V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements);
    const created = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: created.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(captures.length).toBe(1);
    const original = captures[0];
    if (!original) throw Error("missing original owner");
    const rows = await f.sql.query("SELECT native_id FROM tf_v2_container_create_claims");
    const nativeId = rows[0]?.native_id;
    if (rows.length !== 1 || typeof nativeId !== "string") throw Error("missing bound native ID");
    const record = Object.freeze({ ...original.record, nativeId, state: "bound" as const });
    const digest = async () =>
      canonicalDigest(
        await Promise.all([
          f.sql.query("SELECT * FROM tf_v2_container_create_claims"),
          f.sql.query("SELECT * FROM tf_v2_container_start_attempts"),
          f.sql.query("SELECT * FROM tf_v2_operations"),
          f.sql.query("SELECT * FROM tf_v2_container_shutdown_io_closes"),
        ]),
      );
    const fact = Object.freeze({
      kind: "linux-oci-parent-live-init@1",
      nativeId,
      namespaceDevice: "1",
      namespaceInode: "2",
      barrier: "unproven",
    } as const);
    return { f, created, ...original, record, digest, fact };
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    capture.mockRestore();
    health.restore();
  }
}

test("readCurrentOciInit keeps the original running claim and shutdown path untouched", async () => {
  const { f, core, custody, record, digest, fact } = await runningFixture();
  let stale: (() => Promise<void>) | undefined;
  const read = spyOn(bundle, "readOriginalLinuxOciLiveInit").mockImplementation(
    async (_custody, _core, _record, artifact, value, _signal, assertCurrent) => {
      expect(Object.isFrozen(artifact)).toBe(true);
      const binding = value as { readonly allocation: object };
      expect(Object.isFrozen(binding.allocation)).toBe(true);
      await assertCurrent();
      stale = assertCurrent;
      return fact;
    },
  );
  try {
    const before = await digest();
    const native = f.nativeCounts();
    const signal = new AbortController().signal;
    expect(await core.readCurrentOciInit(record, custody, signal)).toBe(fact);
    if (!stale) throw Error("current scope was not supplied");
    await expect(stale()).rejects.toThrow();
    expect(await digest()).toBe(before);
    expect(f.nativeCounts()).toEqual(native);
    await f.composition.close();
    const witnesses = await f.sql.query(
      "SELECT count(*) AS n FROM tf_v2_container_shutdown_io_closes",
    );
    expect(witnesses[0]?.n).toBe(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    await f.cleanup();
  }
});

test("readCurrentOciInit refuses foreign custody and drops an observation on accepted DELETE or abort", async () => {
  const { f, core, custody, record, created, fact } = await runningFixture();
  const read = spyOn(bundle, "readOriginalLinuxOciLiveInit");
  try {
    const controller = new AbortController();
    await expect(core.readCurrentOciInit(record, {}, controller.signal)).rejects.toThrow(
      /parent_custody/,
    );
    read.mockImplementationOnce(async () => {
      controller.abort();
      return fact;
    });
    await expect(core.readCurrentOciInit(record, custody, controller.signal)).rejects.toThrow(
      /Docker Core owner authority refused/,
    );

    const signal = new AbortController().signal;
    const native = f.nativeCounts();
    read.mockImplementationOnce(async () => {
      const deletion = await f.engine.acceptDelete({
        principal: "synthetic-oci-parent",
        key: crypto.randomUUID(),
        uid: created.resourceUid,
        expectedGeneration: created.generation,
      });
      expect(deletion.status).toBe("queued");
      return fact;
    });
    await expect(core.readCurrentOciInit(record, custody, signal)).rejects.toThrow(
      /Docker Core owner authority refused/,
    );
    expect(read.mock.calls.length).toBe(3);
    await expect(core.readCurrentOciInit(record, custody, signal)).rejects.toThrow(
      /Docker Core owner authority refused/,
    );
    expect(read.mock.calls.length).toBe(3);
    expect(f.nativeCounts()).toEqual(native);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    await f.cleanup();
  }
});
