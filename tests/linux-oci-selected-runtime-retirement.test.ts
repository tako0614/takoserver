import { expect, spyOn, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import { acceptedRawHttp } from "./linux-oci-owned-bundle.test.ts";
import { originalPeerDeleteFixture } from "./linux-oci-peer-reconstruction.test.ts";

// Explicit NONSECRET fresh memorySql/original normal factory/raw streams.
// Imported old tests register but only selected-runtime names are invoked.
async function original(fault?: "delete-retained" | "delete-lost") {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    allocationSchema: true,
    ...(fault === undefined ? {} : { retirementFault: fault }),
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    return { f, accepted };
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}
type Original = Awaited<ReturnType<typeof original>>;
const requests = (x: Original) => x.f.nativeCounts().requests;
const count = (x: Original, op: string) =>
  requests(x).filter((v) => v === `linux-oci-${op}@1`).length;
async function remove(x: Original) {
  await x.f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid: x.accepted.resourceUid,
    expectedGeneration: 1,
  });
}
async function until(x: Original, op: string, engine = x.f.engine) {
  for (let i = 0; i < 16; i++) {
    x.f.advanceNormalClock(61_000);
    expect(await engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    if (count(x, op)) return;
  }
  throw Error("actual selected phase absent");
}
async function row(x: Original) {
  const r = (await x.f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
  if (!r || typeof r.native_control !== "string") throw Error("original sealed claim absent");
  return r;
}

test("selected-runtime normal original DELETE precedes tracked join and feeds original cleanup", async () => {
  const x = await original();
  let fresh: ReturnType<typeof x.f.reconstructNormal> | undefined;
  try {
    const saved = await row(x),
      envelope = JSON.parse(String(saved.native_control));
    expect(envelope.scope.purpose).toBe("takoserver.linux-oci-parent-peer-control@1");
    expect(requests(x).filter((v) => v.startsWith("linux-oci-parent-bootstrap@"))).toEqual([
      "linux-oci-parent-bootstrap@3",
    ]);
    await remove(x);
    await until(x, "delete-born");
    expect(count(x, "begin-tracked-join")).toBe(0);
    expect(count(x, "read-tracked-join")).toBe(0);
    expect(count(x, "release-namespace")).toBe(1);
    expect(count(x, "continue-namespace-release")).toBe(0);
    // The genuine namespace reply supplied by the raw stream has netGone=0;
    // H's selected source still requires actual own-cleanup/release completion.
    await until(x, "join-born-delete");
    // A new original normal factory reads the same sealed profile and actual
    // files/peer; it cannot bootstrap or CREATE a replacement P/H.
    fresh = x.f.reconstructNormal();
    await until(x, "begin-tracked-join", fresh.engine);
    const q = requests(x);
    expect(q.indexOf("linux-oci-delete-born@1")).toBeLessThan(
      q.indexOf("linux-oci-begin-tracked-join@1"),
    );
    expect(q.indexOf("linux-oci-join-born-delete@1")).toBeLessThan(
      q.indexOf("linux-oci-begin-tracked-join@1"),
    );
    expect(count(x, "dispose-born")).toBe(0);
    await until(x, "read-tracked-join", fresh.engine);
    await until(x, "dispose-born", fresh.engine);
    expect(q.filter((v) => v === "linux-oci-create-stopped@1")).toHaveLength(1);
    for (const op of [
      "create-stopped",
      "start",
      "stop-init",
      "delete-born",
      "begin-tracked-join",
      "dispose-born",
    ])
      expect(count(x, op)).toBe(1);
    expect(await row(x)).toMatchObject({
      native_control: saved.native_control,
      removed_at_ms: null,
    });
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await fresh?.close();
    await x.f.cleanup();
  }
});

test("selected-runtime retained DELETE advances only same-original JOIN before tracked cleanup", async () => {
  const x = await original("delete-retained");
  try {
    await remove(x);
    await until(x, "delete-born");
    expect(count(x, "begin-tracked-join")).toBe(0);
    await until(x, "join-born-delete");
    await until(x, "begin-tracked-join");
    expect(count(x, "delete-born")).toBe(1);
    expect(count(x, "join-born-delete")).toBe(1);
    expect(count(x, "create-stopped")).toBe(1);
    expect((await row(x)).removed_at_ms).toBeNull();
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await x.f.cleanup();
  }
});

test("selected-runtime lost DELETE reply keeps original UNKNOWN and never resends or begins tracked join", async () => {
  const x = await original("delete-lost");
  try {
    await remove(x);
    await until(x, "delete-born");
    const before = x.f.nativeCounts().processes;
    for (let i = 0; i < 3; i++) {
      x.f.advanceNormalClock(61_000);
      expect(await x.f.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
    }
    expect(x.f.nativeCounts().processes).toBe(before);
    expect(count(x, "delete-born")).toBe(1);
    expect(count(x, "join-born-delete")).toBe(0);
    expect(count(x, "begin-tracked-join")).toBe(0);
    expect(count(x, "dispose-born")).toBe(0);
    expect((await row(x)).removed_at_ms).toBeNull();
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await x.f.cleanup();
  }
});

test("selected-runtime cross-profile and malformed seals refuse before any original management effect", async () => {
  for (const fault of ["old-scope", "old-inner", "malformed"] as const) {
    const x = await original(),
      saved = await row(x),
      envelope = JSON.parse(String(saved.native_control));
    const key = x.f.configuredInputs.keyring.current.key;
    const plaintext = await decryptContainerSecretBytes(
      key,
      decodeContainerSecretBytes(envelope.nonce),
      decodeContainerSecretBytes(envelope.ciphertext),
      new TextEncoder().encode(canonicalJson(envelope.scope)),
    );
    const binding = JSON.parse(new TextDecoder().decode(plaintext));
    plaintext.fill(0);
    if (fault === "old-scope") envelope.scope.purpose = "takoserver.linux-oci-parent-control@1";
    if (fault === "old-inner") binding.purpose = "takoserver.linux-oci-peer-reconstruction@1";
    const bytes = new TextEncoder().encode(JSON.stringify(binding));
    envelope.ciphertext = encodeContainerSecretBytes(
      new Uint8Array(
        await encryptContainerSecretBytes(
          key,
          decodeContainerSecretBytes(envelope.nonce),
          bytes,
          new TextEncoder().encode(canonicalJson(envelope.scope)),
        ),
      ),
    );
    expect(envelope.ciphertext.length).toBeGreaterThan(16);
    const actual = await decryptContainerSecretBytes(
      key,
      decodeContainerSecretBytes(envelope.nonce),
      decodeContainerSecretBytes(envelope.ciphertext),
      new TextEncoder().encode(canonicalJson(envelope.scope)),
    );
    expect(actual).toEqual(bytes);
    actual.fill(0);
    bytes.fill(0);
    if (fault === "malformed") envelope.ciphertext = "AAAA";
    const document = canonicalJson(envelope),
      query = x.f.sql.query.bind(x.f.sql);
    let reached = false;
    const read = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (sql.startsWith("SELECT native_control FROM tf_v2_container_create_claims")) {
        reached = true;
        return rows.map((r) => ({ ...r, native_control: document }));
      }
      return rows;
    });
    try {
      const before = x.f.nativeCounts().processes;
      await remove(x);
      x.f.advanceNormalClock(61_000);
      expect(await x.f.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(reached).toBe(true);
      expect(x.f.nativeCounts().processes).toBe(before);
      expect(count(x, "stop-init")).toBe(0);
      expect(count(x, "delete-born")).toBe(0);
      expect((await row(x)).removed_at_ms).toBeNull();
      expect(x.f.network).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      await x.f.cleanup();
    }
  }
});

test("selected-runtime execution revoked in last awaited management window sends no runtime DELETE", async () => {
  const x = await original();
  try {
    await remove(x);
    await until(x, "release-namespace");
    const query = x.f.sql.query.bind(x.f.sql);
    let controlReads = 0,
      armed = false,
      reached = false;
    const reading = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (sql.startsWith("SELECT native_control FROM tf_v2_container_create_claims")) {
        controlReads++;
        if (controlReads === 4) armed = true; // guarded SQL after actual P outcome
      }
      if (armed && !reached && sql.includes(" WHERE i.resource_uid=? AND v.generation=?")) {
        const execution = x.f.execution;
        if (!execution) throw Error("original active execution missing");
        reached = true;
        Reflect.set(execution, "leaseToken", "NONSECRET-final-management-revoked");
      }
      return rows;
    });
    try {
      x.f.advanceNormalClock(61_000);
      expect(await x.f.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(reached).toBe(true);
      expect(controlReads).toBe(4);
      expect(count(x, "delete-born")).toBe(0);
      expect(count(x, "begin-tracked-join")).toBe(0);
      expect(count(x, "stop-init")).toBe(1);
      expect((await row(x)).removed_at_ms).toBeNull();
      expect(x.f.network).not.toHaveBeenCalled();
    } finally {
      reading.mockRestore();
    }
  } finally {
    await x.f.cleanup();
  }
});
