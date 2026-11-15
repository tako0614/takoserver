import { expect, spyOn, test } from "bun:test";
import { lstat } from "node:fs/promises";
import { canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import {
  inspectV2ContainerOwnerApplicationIoSchema,
  V2_CONTAINER_APPLICATION_IO_RESERVED,
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { acceptedRawHttp } from "./linux-oci-owned-bundle.test.ts";
import { originalPeerDeleteFixture } from "./linux-oci-peer-reconstruction.test.ts";

// NONSECRET original memorySql/normal factory/raw spawn+HTTP sources only.
// Imported old cases are registered but filtered, never run.
async function savedClose(missing = false) {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    localCleanup: true,
    allocationSchema: true,
    applicationOwner: true,
  });
  await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    if (missing) {
      const row = (await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
      if (!row) throw Error("original pending close claim absent");
      expect(row.allocation_cleanup).toBe("untouched");
      expect(row.application_io_cleanup).toBe(V2_CONTAINER_APPLICATION_IO_RESERVED);
      return { f, row };
    }
    for (let i = 0; i < 14; i++) {
      f.advanceNormalClock(61_000);
      expect(await f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
      const row = (await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
      if (row?.allocation_cleanup === "closed") {
        expect(JSON.parse(String(row.application_io_cleanup)).kind).toBe(
          "linux-oci-sealed-application-io-close@1",
        );
        return { f, row };
      }
    }
    throw Error("original profile5 close/allocation consumer not reached");
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}

test("saved-close-selection profile5 fresh normal creator consumes genuine saved same-operation close then original H result", async () => {
  const { f, row } = await savedClose();
  const before = f.nativeCounts(),
    fresh = f.reconstructNormal();
  try {
    expect(
      await lstat(f.recordedCreate().allocationRoot).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      ),
    ).toBe(true);
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.nativeCounts()).toEqual({
      processes: before.processes + 1,
      requests: [...before.requests, "linux-oci-parent-read-result@2"],
    });
    expect((await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    await fresh.close();
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await fresh.close().catch(() => undefined);
    await f.cleanup();
  }
});

test("saved-close-selection exact captured H result is consumed once without owner reader fallback", async () => {
  const { f, row } = await savedClose();
  const reader = f.reconstructParent(),
    fresh = f.reconstructNormal(),
    before = f.nativeCounts();
  let reached = false;
  f.beforeRetire(async (execution) => {
    expect(await reader.manageRetainedPeerInit(execution)).toEqual([
      { kind: "linux-oci-parent-h-exited@1", error: 0, barrier: "unproven" },
    ]);
    expect(
      await reader.manageRetainedPeerInit(execution).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(Error);
    reached = true;
    throw Error("NONSECRET ends after actual same-operation H consumer");
  });
  try {
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(reached).toBe(true);
    expect(f.nativeCounts()).toEqual({
      processes: before.processes + 1,
      requests: [...before.requests, "linux-oci-parent-read-result@2"],
    });
    expect((await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    await reader.close();
  } finally {
    await reader.close().catch(() => undefined);
    await fresh.close().catch(() => undefined);
    await f.cleanup();
  }
});

test("saved-close-selection genuinely missing close retains only original process readonly recovery input", async () => {
  const { f, row } = await savedClose(true);
  f.applicationOwnerState(true);
  const reader = f.reconstructParent(),
    fresh = f.reconstructNormal(),
    before = f.nativeCounts();
  let reached = false;
  f.beforeRetire(async (execution) => {
    expect(await reader.manageRetainedPeerInit(execution)).toEqual([
      {
        kind: "linux-oci-parent-application-owner-exited@1",
        device: "5",
        inode: "1311768467463790321",
        bootId: "11111111-2222-4333-8444-555555555555",
        barrier: "unproven",
      },
    ]);
    reached = true;
    throw Error("NONSECRET ends after actual process-only input");
  });
  try {
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(reached).toBe(true);
    expect(f.nativeCounts()).toEqual({
      processes: before.processes + 1,
      requests: [...before.requests, "linux-oci-parent-read-application-owner@1"],
    });
    expect((await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    await reader.close();
  } finally {
    await reader.close().catch(() => undefined);
    await fresh.close().catch(() => undefined);
    await f.cleanup();
  }
});

for (const fault of [
  "null",
  "reserved",
  "tampered",
  "foreign-operation",
  "unfinished-allocation",
] as const)
  test(`saved-close-selection refuses ${fault} saved source without missing-origin fallback`, async () => {
    const { f, row } = await savedClose();
    f.applicationOwnerState(true); // would supply a positive process fact if wrongly selected
    let foreign = "";
    if (fault === "foreign-operation") {
      const sealed = JSON.parse(String(row.application_io_cleanup)),
        key = f.configuredInputs.keyring.current.key;
      const plaintext = await decryptContainerSecretBytes(
        key,
        decodeContainerSecretBytes(sealed.nonce),
        decodeContainerSecretBytes(sealed.ciphertext),
        new TextEncoder().encode(canonicalJson(sealed.scope)),
      );
      sealed.scope.operation.operationId = "NONSECRET-other-operation";
      const aad = new TextEncoder().encode(canonicalJson(sealed.scope));
      try {
        sealed.ciphertext = encodeContainerSecretBytes(
          new Uint8Array(
            await encryptContainerSecretBytes(
              key,
              decodeContainerSecretBytes(sealed.nonce),
              plaintext,
              aad,
            ),
          ),
        );
        expect(sealed.ciphertext.length).toBeGreaterThan(0);
        const roundtrip = await decryptContainerSecretBytes(
          key,
          decodeContainerSecretBytes(sealed.nonce),
          decodeContainerSecretBytes(sealed.ciphertext),
          aad,
        );
        expect(roundtrip).toEqual(plaintext);
        roundtrip.fill(0);
        foreign = canonicalJson(sealed);
      } finally {
        plaintext.fill(0);
      }
    }
    const query = f.sql.query.bind(f.sql);
    let selected = false,
      ownerReads = 0;
    const read = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (sql.startsWith("SELECT native_control,allocation_cleanup FROM")) ownerReads++;
      if (sql.startsWith("SELECT allocation_cleanup,application_io_cleanup FROM")) {
        selected = true;
        return rows.map((r) => ({
          ...r,
          ...(fault === "unfinished-allocation" ? { allocation_cleanup: "untouched" } : {}),
          application_io_cleanup:
            fault === "null"
              ? null
              : fault === "reserved"
                ? V2_CONTAINER_APPLICATION_IO_RESERVED
                : fault === "foreign-operation"
                  ? foreign
                  : fault === "tampered"
                    ? String(r.application_io_cleanup) + " "
                    : r.application_io_cleanup,
        }));
      }
      return rows;
    });
    const reader = f.reconstructParent(),
      fresh = f.reconstructNormal(),
      before = f.nativeCounts();
    let refused = false;
    f.beforeRetire(async (execution) => {
      expect(
        await reader.manageRetainedPeerInit(execution).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ).toBeInstanceOf(Error);
      refused = true;
      throw Error("NONSECRET actual saved-fact refusal");
    });
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(selected && refused).toBe(true);
      expect(ownerReads).toBe(0);
      expect(f.nativeCounts()).toEqual(before);
      expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    } finally {
      read.mockRestore();
      await reader.close().catch(() => undefined);
      await fresh.close().catch(() => undefined);
      await f.cleanup();
    }
  });

for (const fault of ["cancel", "execution", "key"] as const)
  test(`saved-close-selection rejects ${fault} in saved-reader final SQL window`, async () => {
    const { f, row } = await savedClose();
    const query = f.sql.query.bind(f.sql),
      controller = new AbortController();
    let guards = 0,
      active = true,
      execution: typeof f.execution;
    const lookup = f.configuredInputs.keyring.keyForDecryption.bind(f.configuredInputs.keyring);
    // Bind before the actual fresh Core constructor captures this method.
    const keys = spyOn(f.configuredInputs.keyring, "keyForDecryption").mockImplementation((id) =>
      active ? lookup(id) : undefined,
    );
    const read = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (
        sql.startsWith("SELECT native_control,allocation_cleanup,application_io_cleanup FROM") &&
        ++guards === 2
      ) {
        if (fault === "cancel") controller.abort();
        if (fault === "execution" && execution)
          Object.assign(execution, { leaseToken: "NONSECRET-expired-lease" });
        if (fault === "key") active = false;
      }
      return rows;
    });
    const reader = f.reconstructParent(),
      fresh = f.reconstructNormal(),
      before = f.nativeCounts();
    let refused = false;
    f.beforeRetire(async (e) => {
      execution = e;
      expect(
        await reader.manageRetainedPeerInit(e, controller.signal).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ).toBeInstanceOf(Error);
      refused = true;
      throw Error("NONSECRET last SQL-window refusal captured");
    });
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(guards).toBe(2);
      expect(refused).toBe(true);
      expect(f.nativeCounts()).toEqual(before);
      expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    } finally {
      read.mockRestore();
      keys.mockRestore();
      await reader.close().catch(() => undefined);
      await fresh.close().catch(() => undefined);
      await f.cleanup();
    }
  });

test("saved-close-selection rejects transient application schema inspection loss without process fallback", async () => {
  const { f } = await savedClose(true);
  const run = f.sql.run.bind(f.sql);
  let paused = false;
  const pause = spyOn(f.sql, "run").mockImplementation(async (sql, params) => {
    if (sql.startsWith("UPDATE tf_v2_container_create_claims SET allocation_cleanup='consumed'")) {
      paused = true;
      throw Error("NONSECRET stops before original allocation consume");
    }
    return run(sql, params);
  });
  let reader: ReturnType<typeof f.reconstructParent> | undefined;
  let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    for (let i = 0; i < 14 && !paused; i++) {
      f.advanceNormalClock(61_000);
      expect(await f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    }
    pause.mockRestore();
    expect(paused).toBe(true);
    const row = (await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
    expect(row?.allocation_cleanup).toBe("untouched");
    expect(JSON.parse(String(row?.application_io_cleanup)).kind).toBe(
      "linux-oci-sealed-application-io-close@1",
    );
    // The close was produced and sealed by the actual original H-result/I/O
    // branch. No fixture row overwrite or fake positive I/O-close document.
    expect(await inspectV2ContainerOwnerApplicationIoSchema(f.sql)).toBe(true);
    f.applicationOwnerState(true);
    const query = f.sql.query.bind(f.sql);
    let failed = false,
      ownerReads = 0;
    const read = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      if (
        !failed &&
        sql.startsWith("SELECT (WITH container_owner_application_io_values(document)")
      ) {
        failed = true;
        throw Error("NONSECRET only the first original app-schema query fails");
      }
      if (sql.startsWith("SELECT native_control,allocation_cleanup FROM")) ownerReads++;
      return query(sql, params);
    });
    const before = f.nativeCounts();
    reader = f.reconstructParent();
    fresh = f.reconstructNormal();
    const originalReader = reader;
    let outcome: unknown;
    f.beforeRetire(async (execution) => {
      outcome = await originalReader.manageRetainedPeerInit(execution).then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      throw Error("NONSECRET captures the original recovery selection outcome");
    });
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(failed).toBe(true);
      expect(await inspectV2ContainerOwnerApplicationIoSchema(f.sql)).toBe(true); // subsequent genuine query succeeds
      expect(outcome).toMatchObject({ ok: false, error: expect.any(Error) });
      expect(ownerReads).toBe(0);
      expect(f.nativeCounts()).toEqual(before);
      expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    } finally {
      read.mockRestore();
    }
  } finally {
    pause.mockRestore();
    await reader?.close().catch(() => undefined);
    await fresh?.close().catch(() => undefined);
    await f.cleanup();
  }
});
