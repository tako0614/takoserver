import { expect, spyOn, test } from "bun:test";
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import {
  V2_CONTAINER_APPLICATION_IO_RESERVED,
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

// NONSECRET keys and intercepted spawn/HTTP streams only. Imported old cases
// are filtered by the closed-peer prefix and never executed.
async function closedOriginal(pending = false) {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    localCleanup: true,
    allocationSchema: true,
    ...(pending ? { pending: true } : {}),
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
    for (let i = 0; i < 14; i++) {
      f.advanceNormalClock(61_000);
      expect(await f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
      const row = (await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
      if (row?.allocation_cleanup === "closed") return { f, row };
    }
    throw Error("original allocation cleanup not reached");
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}

test("closed-peer fresh normal reconcile authenticates same P and consumes readonly H result after actual allocation removal", async () => {
  const { f, row } = await closedOriginal();
  let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    const absent = await lstat(f.recordedCreate().allocationRoot).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    expect(absent).toBe(true);
    const before = f.nativeCounts();
    fresh = f.reconstructNormal();
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
    await fresh.close(); // joins that same actual reader Promise, not Map emptiness
    fresh = undefined;
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await fresh?.close();
    await f.cleanup();
  }
});

test("closed-peer exact original readonly data is consumed and a second use refuses", async () => {
  const { f, row } = await closedOriginal();
  const reader = f.reconstructParent(),
    normal = f.reconstructNormal(),
    before = f.nativeCounts();
  let reached = false;
  f.beforeRetire(async (execution) => {
    expect(await reader.readRetainedPeerResults(execution)).toEqual([
      { kind: "linux-oci-parent-h-exited@1", error: 0, barrier: "unproven" },
    ]);
    const refused = await reader.readRetainedPeerResults(execution).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    reached = true;
    throw Error("NONSECRET fixture stops after actual read-only consumer");
  });
  try {
    f.advanceNormalClock(61_000);
    expect(await normal.engine.runNext()).toMatchObject({
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
    await reader.close();
    await normal.close();
    await f.cleanup();
  }
});

for (const fault of [
  "null",
  "consumed",
  "reserved",
  "foreign-operation",
  "tampered-control",
] as const)
  test(`closed-peer refuses ${fault} durable source before any connector`, async () => {
    const { f, row } = await closedOriginal();
    const query = f.sql.query.bind(f.sql);
    let foreign = "",
      reached = false;
    if (fault === "foreign-operation") {
      const sealed = JSON.parse(String(row.application_io_cleanup)),
        key = f.configuredInputs.keyring.current.key,
        plaintext = await decryptContainerSecretBytes(
          key,
          decodeContainerSecretBytes(sealed.nonce),
          decodeContainerSecretBytes(sealed.ciphertext),
          new TextEncoder().encode(canonicalJson(sealed.scope)),
        );
      sealed.scope.operation.operationId = "NONSECRET-foreign-operation";
      try {
        sealed.ciphertext = encodeContainerSecretBytes(
          new Uint8Array(
            await encryptContainerSecretBytes(
              key,
              decodeContainerSecretBytes(sealed.nonce),
              plaintext,
              new TextEncoder().encode(canonicalJson(sealed.scope)),
            ),
          ),
        );
        expect(sealed.ciphertext.length).toBeGreaterThan(0);
        const roundtrip = await decryptContainerSecretBytes(
          key,
          decodeContainerSecretBytes(sealed.nonce),
          decodeContainerSecretBytes(sealed.ciphertext),
          new TextEncoder().encode(canonicalJson(sealed.scope)),
        );
        expect(roundtrip).toEqual(plaintext);
        roundtrip.fill(0);
        foreign = canonicalJson(sealed);
      } finally {
        plaintext.fill(0);
      }
    }
    const reads = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (
        fault === "tampered-control" &&
        sql.startsWith(
          "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=",
        )
      ) {
        reached = true;
        return rows.map((r) => ({ ...r, native_control: String(r.native_control) + " " }));
      }
      if (sql.startsWith("SELECT allocation_cleanup,application_io_cleanup FROM")) {
        reached = true;
        return rows.map((r) => ({
          ...r,
          ...(fault === "null" || fault === "consumed"
            ? { allocation_cleanup: fault === "null" ? null : "consumed" }
            : {}),
          ...(fault === "reserved"
            ? { application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED }
            : {}),
          ...(fault === "foreign-operation" ? { application_io_cleanup: foreign } : {}),
        }));
      }
      return rows;
    });
    const before = f.nativeCounts(),
      fresh = f.reconstructNormal();
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(reached).toBe(true);
      expect(f.nativeCounts()).toEqual(before);
      expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      await fresh.close();
      await f.cleanup();
    }
  });

for (const fault of ["lease", "key"] as const)
  test(`closed-peer refuses ${fault} loss at final awaited guard before connector`, async () => {
    const { f, row } = await closedOriginal();
    const query = f.sql.query.bind(f.sql),
      lookup = f.configuredInputs.keyring.keyForDecryption;
    let guardReads = 0,
      revoked = false;
    const keys = spyOn(f.configuredInputs.keyring, "keyForDecryption").mockImplementation((id) =>
      revoked && fault === "key" ? undefined : lookup(id),
    ); // Installed BEFORE the genuine fresh Core captures its bound lookup.
    const reads = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (
        sql.startsWith("SELECT native_control,allocation_cleanup,application_io_cleanup FROM") &&
        ++guardReads === 2
      ) {
        revoked = true;
        if (fault === "lease") {
          const execution = f.execution;
          if (!execution) throw Error("original execution absent");
          Reflect.set(execution, "leaseToken", "NONSECRET-closed-read-revoked");
        }
      }
      return rows;
    });
    const before = f.nativeCounts(),
      fresh = f.reconstructNormal();
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(revoked).toBe(true);
      expect(guardReads).toBe(2);
      expect(f.nativeCounts()).toEqual(before);
      expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    } finally {
      reads.mockRestore();
      keys.mockRestore();
      await fresh.close();
      await f.cleanup();
    }
  });

test("closed-peer refused P result remains UNKNOWN and never respawns that one-use reader", async () => {
  const { f, row } = await closedOriginal(true),
    before = f.nativeCounts(),
    query = f.sql.query.bind(f.sql),
    fresh = f.reconstructNormal();
  let guards = 0;
  const reads = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await query(sql, params);
    if (sql.startsWith("SELECT native_control,allocation_cleanup,application_io_cleanup FROM"))
      guards++;
    return rows;
  });
  try {
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(guards).toBe(2); // Refused actual result never passes the post-read consume guard.
    expect(f.nativeCounts()).toEqual({
      processes: before.processes + 1,
      requests: [...before.requests, "linux-oci-parent-read-result@2"],
    });
    const retained = f.nativeCounts();
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.nativeCounts()).toEqual(retained);
    expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
  } finally {
    reads.mockRestore();
    await fresh.close();
    await f.cleanup();
  }
});

for (const fault of ["allocation", "executable"] as const)
  test(`closed-peer refuses replaced actual ${fault} before sending capability`, async () => {
    const { f, row } = await closedOriginal();
    if (fault === "allocation") await mkdir(f.recordedCreate().allocationRoot, { mode: 0o700 });
    else {
      await rename(f.physicalBinary, f.physicalBinary + ".NONSECRET-original");
      await writeFile(f.physicalBinary, "NONEXECUTED REPLACEMENT RAW FIXTURE\n", { mode: 0o700 });
    }
    const before = f.nativeCounts(),
      fresh = f.reconstructNormal();
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(f.nativeCounts()).toEqual(before);
      expect((await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      await fresh.close();
      await f.cleanup();
    }
  });
