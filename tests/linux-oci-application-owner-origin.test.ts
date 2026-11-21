import { expect, spyOn, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import { V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND } from "../src/takoform-v2/container-owner-schema.ts";
import { acceptedRawHttp } from "./linux-oci-owned-bundle.test.ts";
import { originalPeerDeleteFixture } from "./linux-oci-peer-reconstruction.test.ts";

// Fixed NONSECRET key/capability fixtures, actual Core/memorySql and intercepted
// spawn/stream source. Imported old cases are filtered, never executed.
const exited = Object.freeze({
  kind: "linux-oci-parent-application-owner-exited@1",
  device: "5",
  inode: "1311768467463790321",
  bootId: "11111111-2222-4333-8444-555555555555",
  barrier: "unproven",
});
async function original(applicationOwner = true) {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    localCleanup: true,
    allocationSchema: true,
    applicationOwner,
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
    const row = (await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
    if (!row) throw Error("original claim absent");
    expect(row.allocation_cleanup).toBe("untouched");
    await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    return { f, row };
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}

test("application-owner fresh normal reconcile consumes same original process exit without H or I/O authority", async () => {
  const { f, row } = await original();
  const d = JSON.parse(String(row.native_control));
  const bytes = await decryptContainerSecretBytes(
    f.configuredInputs.keyring.current.key,
    decodeContainerSecretBytes(d.nonce),
    decodeContainerSecretBytes(d.ciphertext),
    new TextEncoder().encode(canonicalJson(d.scope)),
  );
  try {
    const binding = JSON.parse(new TextDecoder().decode(bytes));
    expect(binding.purpose).toBe("takoserver.linux-oci-peer-application-owner-reconstruction@1");
    expect(binding.applicationOwner).toEqual({
      kind: "linux-oci-application-owner@1",
      device: exited.device,
      inode: exited.inode,
      bootId: exited.bootId,
    });
  } finally {
    bytes.fill(0);
  }
  f.applicationOwnerState(true);
  const before = f.nativeCounts(),
    fresh = f.reconstructNormal();
  try {
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.nativeCounts()).toEqual({
      processes: before.processes + 1,
      requests: [...before.requests, "linux-oci-parent-read-application-owner@1"],
    });
    expect((await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    await fresh.close(); // only the original readonly connector's true terminal join
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await fresh.close().catch(() => undefined);
    await f.cleanup();
  }
});

test("application-owner original live creator keeps graceful close and STOP while its application process lives", async () => {
  const { f } = await original();
  try {
    f.applicationOwnerState(false);
    f.advanceNormalClock(61_000);
    expect(await f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(f.nativeCounts().requests).toContain("linux-oci-stop-init@1");
    expect(f.nativeCounts().requests).not.toContain("linux-oci-parent-read-application-owner@1");
    const [claim] = await f.sql.query(
      "SELECT application_io_cleanup,allocation_cleanup FROM tf_v2_container_create_claims",
    );
    if (typeof claim?.application_io_cleanup !== "string")
      throw new Error("original application I/O close fact missing");
    const closeFact = JSON.parse(claim.application_io_cleanup);
    expect(closeFact.kind).toBe("linux-oci-sealed-application-io-close@1");
    expect(closeFact.scope?.purpose).toBe("takoserver.linux-oci-application-io-close@1");
    expect(claim.allocation_cleanup).toBe("untouched");
  } finally {
    await f.cleanup();
  }
});

test("application-owner accepted operation receives exact readonly data once without close backfill", async () => {
  const { f, row } = await original();
  f.applicationOwnerState(true);
  const reader = f.reconstructParent(),
    fresh = f.reconstructNormal(),
    before = f.nativeCounts();
  let reached = false;
  f.beforeRetire(async (execution) => {
    expect(await reader.manageRetainedPeerInit(execution)).toEqual([exited]);
    const refused = await reader.manageRetainedPeerInit(execution).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    reached = true;
    throw Error("NONSECRET stops after actual accepted process-fact consumer");
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

for (const fault of ["alive", "foreign", "boot", "lost", "exit"] as const)
  test(`application-owner refuses ${fault} original process result and retains unknown connector`, async () => {
    const { f, row } = await original();
    f.applicationOwnerState(fault !== "alive", fault === "alive" ? undefined : fault);
    const reader = f.reconstructParent(),
      fresh = f.reconstructNormal(),
      before = f.nativeCounts();
    let reached = false;
    f.beforeRetire(async (execution) => {
      const refusal = await reader.manageRetainedPeerInit(execution).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(Error);
      reached = true;
      throw Error("NONSECRET actual process-result refusal captured");
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
      expect(
        await reader.close().then(
          () => undefined,
          (error: unknown) => error,
        ),
      ).toBeInstanceOf(Error);
      expect((await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    } finally {
      await reader.close().catch(() => undefined);
      await fresh.close().catch(() => undefined);
      await f.cleanup();
    }
  });

for (const fault of [
  "null",
  "consumed",
  "tampered",
  "cancel",
  "execution",
  "operation",
  "key",
] as const)
  test(`application-owner refuses ${fault} accepted source before connector`, async () => {
    const { f, row } = await original();
    f.applicationOwnerState(true);
    const query = f.sql.query.bind(f.sql),
      controller = new AbortController();
    let reached = false,
      active = true;
    const lookup = f.configuredInputs.keyring.keyForDecryption.bind(f.configuredInputs.keyring);
    // Core captures .bind at construction: install before this genuine factory.
    const keys = spyOn(f.configuredInputs.keyring, "keyForDecryption").mockImplementation((id) =>
      active ? lookup(id) : undefined,
    );
    let execution: typeof f.execution;
    const read = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (sql.startsWith("SELECT native_control,allocation_cleanup FROM")) {
        reached = true;
        if (fault === "cancel") controller.abort();
        if (fault === "execution" && execution)
          Object.assign(execution, { leaseToken: "NONSECRET-foreign-operation-lease" });
        if (fault === "operation" && execution)
          Object.assign(execution, { operationId: "NONSECRET-other-operation" });
        if (fault === "key") active = false;
        return rows.map((r) => ({
          ...r,
          ...(fault === "null" || fault === "consumed"
            ? { allocation_cleanup: fault === "null" ? null : "consumed" }
            : {}),
          ...(fault === "tampered" ? { native_control: String(r.native_control) + " " } : {}),
        }));
      }
      return rows;
    });
    const reader = f.reconstructParent(),
      fresh = f.reconstructNormal(),
      before = f.nativeCounts();
    let refused = false;
    f.beforeRetire(async (e) => {
      execution = e;
      const error = await reader.manageRetainedPeerInit(e, controller.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      refused = true;
      throw Error("NONSECRET scope refusal captured before native read");
    });
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(reached && refused).toBe(true);
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

for (const fault of ["old-profile", "missing-owner", "foreign-owner"] as const)
  test(`application-owner refuses validly sealed ${fault} origin without retrofit`, async () => {
    const { f, row } = await original();
    f.applicationOwnerState(true);
    const sealed = JSON.parse(String(row.native_control)),
      key = f.configuredInputs.keyring.current.key;
    const aad = new TextEncoder().encode(canonicalJson(sealed.scope)),
      nonce = decodeContainerSecretBytes(sealed.nonce);
    const plaintext = await decryptContainerSecretBytes(
      key,
      nonce,
      decodeContainerSecretBytes(sealed.ciphertext),
      aad,
    );
    const binding = JSON.parse(new TextDecoder().decode(plaintext));
    plaintext.fill(0);
    if (fault === "old-profile")
      binding.purpose = "takoserver.linux-oci-peer-local-cleanup-reconstruction@1";
    if (fault === "missing-owner") delete binding.applicationOwner;
    if (fault === "foreign-owner") binding.applicationOwner.inode = "99";
    const mutated = new TextEncoder().encode(JSON.stringify(binding));
    sealed.ciphertext = encodeContainerSecretBytes(
      new Uint8Array(await encryptContainerSecretBytes(key, nonce, mutated, aad)),
    );
    expect(sealed.ciphertext.length).toBeGreaterThan(0);
    const roundtrip = await decryptContainerSecretBytes(
      key,
      nonce,
      decodeContainerSecretBytes(sealed.ciphertext),
      aad,
    );
    expect(roundtrip).toEqual(mutated);
    roundtrip.fill(0);
    mutated.fill(0);
    const foreign = canonicalJson(sealed),
      query = f.sql.query.bind(f.sql);
    let reached = false;
    const read = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (sql.startsWith("SELECT native_control")) {
        reached = true;
        return rows.map((r) => ({ ...r, native_control: foreign }));
      }
      return rows;
    });
    const reader = f.reconstructParent(),
      fresh = f.reconstructNormal(),
      before = f.nativeCounts();
    let refused = false;
    f.beforeRetire(async (e) => {
      const error = await reader.manageRetainedPeerInit(e).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      refused = true;
      throw Error("NONSECRET sealed-origin refusal captured");
    });
    try {
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(reached && refused).toBe(true);
      expect(f.nativeCounts()).toEqual(
        fault === "foreign-owner"
          ? {
              processes: before.processes + 1,
              requests: [...before.requests, "linux-oci-parent-read-application-owner@1"],
            }
          : before,
      );
      expect((await query("SELECT * FROM tf_v2_container_create_claims"))[0]).toEqual(row);
    } finally {
      read.mockRestore();
      await reader.close().catch(() => undefined);
      await fresh.close().catch(() => undefined);
      await f.cleanup();
    }
  });
