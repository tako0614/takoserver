import { expect, spyOn, test } from "bun:test";
import { lstat } from "node:fs/promises";
import { canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import { V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND } from "../src/takoform-v2/container-owner-schema.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

// NONSECRET keys and raw spawn/HTTP streams only. Imported old cases are
// registered but filtered. The original normal Engine supplies every phase.
async function closedRuntime() {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    allocationSchema: true,
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    for (let phase = 0; phase < 16; phase++) {
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
    throw Error("original runtime3 READ/H/app-close/allocation chain not reached");
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}

test("runtime-first-closed fresh normal creator authenticates original H after genuine same-operation cleanup", async () => {
  const { f, row } = await closedRuntime();
  const fresh = f.reconstructNormal(),
    before = f.nativeCounts();
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
    const joined = f.nativeCounts();
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.nativeCounts()).toEqual(joined); // same readonly slot is one-use
    expect(row.state).toBe("bound");
    expect(row.removed_at_ms).toBe(null);
    expect(f.network).not.toHaveBeenCalled();
    await fresh.close();
  } finally {
    await fresh.close().catch(() => undefined);
    await f.cleanup();
  }
});

for (const fault of ["null", "tampered", "foreign-operation"] as const)
  test(`runtime-first-closed refuses ${fault} saved fact without alternate reader or native replay`, async () => {
    const { f, row } = await closedRuntime();
    let document: string | null =
      fault === "null" ? null : String(row.application_io_cleanup) + " ";
    if (fault === "foreign-operation") {
      const sealed = JSON.parse(String(row.application_io_cleanup)),
        key = f.configuredInputs.keyring.current.key,
        plaintext = await decryptContainerSecretBytes(
          key,
          decodeContainerSecretBytes(sealed.nonce),
          decodeContainerSecretBytes(sealed.ciphertext),
          new TextEncoder().encode(canonicalJson(sealed.scope)),
        );
      try {
        sealed.scope.operation.operationId = "NONSECRET-foreign-operation";
        const aad = new TextEncoder().encode(canonicalJson(sealed.scope));
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
        expect(sealed.ciphertext.length).toBeGreaterThan(16);
        const decoded = await decryptContainerSecretBytes(
          key,
          decodeContainerSecretBytes(sealed.nonce),
          decodeContainerSecretBytes(sealed.ciphertext),
          aad,
        );
        expect(decoded).toEqual(plaintext);
        decoded.fill(0);
        document = canonicalJson(sealed);
      } finally {
        plaintext.fill(0);
      }
    }
    const query = f.sql.query.bind(f.sql);
    let selected = false,
      refused = false;
    const querying = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (sql.startsWith("SELECT allocation_cleanup,application_io_cleanup FROM")) {
        selected = true;
        return rows.map((r) => ({ ...r, application_io_cleanup: document }));
      }
      return rows;
    });
    const reader = f.reconstructParent(),
      fresh = f.reconstructNormal(),
      before = f.nativeCounts();
    f.beforeRetire(async (execution) => {
      const result = await reader.manageRetainedPeerInit(execution).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(result).toHaveProperty("error");
      refused = true;
      throw Error("NONSECRET records exact runtime3 saved-fact refusal");
    });
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(selected && refused).toBe(true);
      expect(f.nativeCounts()).toEqual(before);
      expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      querying.mockRestore();
      await reader.close().catch(() => undefined);
      await fresh.close().catch(() => undefined);
      await f.cleanup();
    }
  });

for (const fault of ["cancel", "lease", "key"] as const)
  test(`runtime-first-closed refuses ${fault} in actual final saved-reader SQL window`, async () => {
    const { f, row } = await closedRuntime();
    const query = f.sql.query.bind(f.sql),
      run = f.sql.run.bind(f.sql),
      controller = new AbortController();
    const lookup = f.configuredInputs.keyring.keyForDecryption.bind(f.configuredInputs.keyring);
    let active = true,
      guards = 0,
      refused = false,
      execution: typeof f.execution;
    // The actual Core constructor binds this original method before any read.
    const keys = spyOn(f.configuredInputs.keyring, "keyForDecryption").mockImplementation((id) =>
      active ? lookup(id) : undefined,
    );
    const querying = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (
        sql.startsWith("SELECT native_control,allocation_cleanup,application_io_cleanup FROM") &&
        ++guards === 2
      ) {
        if (fault === "cancel") controller.abort();
        if (fault === "key") active = false;
        if (fault === "lease") {
          if (!execution) throw Error("original execution absent");
          await run("UPDATE tf_v2_operations SET lease_token=? WHERE id=?", [
            "NONSECRET-replaced-lease",
            execution.operationId,
          ]);
        }
      }
      return rows;
    });
    const reader = f.reconstructParent(),
      fresh = f.reconstructNormal(),
      before = f.nativeCounts();
    f.beforeRetire(async (actual) => {
      execution = actual;
      const result = await reader.manageRetainedPeerInit(actual, controller.signal).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(result).toHaveProperty("error");
      refused = true;
      throw Error("NONSECRET records actual final SQL-window refusal");
    });
    try {
      f.advanceNormalClock(61_000);
      await fresh.engine.runNext();
      expect(guards).toBe(2);
      expect(refused).toBe(true);
      expect(f.nativeCounts()).toEqual(before);
      expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      querying.mockRestore();
      keys.mockRestore();
      await reader.close().catch(() => undefined);
      await fresh.close().catch(() => undefined);
      await f.cleanup();
    }
  });
