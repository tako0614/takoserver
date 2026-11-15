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

// NONSECRET fixture keys/raw streams, fresh memorySql/files, original normal
// factory/Engine. Imported old cases are registered but filtered, NEVER invoked.
async function original(
  options: {
    legacy?: boolean;
    retirementFault?: "begin-retained" | "begin-lost" | "dispose-retained";
    hResultFault?: "stdout";
  } = {},
) {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    ...(options.legacy ? {} : { localCleanup: true }),
    allocationSchema: true,
    ...(options.retirementFault ? { retirementFault: options.retirementFault } : {}),
    ...(options.hResultFault ? { hResultFault: options.hResultFault } : {}),
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
  requests(x).filter((k) => k === `linux-oci-${op}@1`).length;
async function remove(x: Original) {
  await x.f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid: x.accepted.resourceUid,
    expectedGeneration: 1,
  });
}
async function step(x: Original, engine = x.f.engine) {
  x.f.advanceNormalClock(61_000);
  expect(await engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
}
async function until(x: Original, op: string, engine = x.f.engine) {
  for (let i = 0; i < 14; i++) {
    await step(x, engine);
    if (count(x, op)) return;
  }
  throw Error("original local-cleanup phase not visited");
}
async function row(x: Original) {
  const r = (await x.f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
  if (!r || typeof r.native_control !== "string") throw Error("original sealed row missing");
  return r;
}

test("selected-local normal original cleanup feeds genuine H-result and allocation consumer then fresh same-operation read", async () => {
  const x = await original();
  let fresh: ReturnType<typeof x.f.reconstructNormal> | undefined;
  try {
    const saved = await row(x),
      envelope = JSON.parse(String(saved.native_control));
    expect(envelope.scope.purpose).toBe("takoserver.linux-oci-parent-peer-control@1");
    expect(requests(x).filter((k) => k.startsWith("linux-oci-parent-bootstrap@"))).toEqual([
      "linux-oci-parent-bootstrap@4",
    ]);
    await remove(x);
    await until(x, "begin-tracked-join");
    expect(count(x, "read-tracked-join")).toBe(0);
    expect(count(x, "dispose-born")).toBe(0);
    await until(x, "dispose-born");
    await until(x, "parent-read-result");
    expect(await row(x)).toMatchObject({
      allocation_cleanup: "closed",
      removed_at_ms: null,
      native_control: saved.native_control,
    });
    const closed = await row(x);
    expect(JSON.parse(String(closed.application_io_cleanup)).kind).toBe(
      "linux-oci-sealed-application-io-close@1",
    );
    fresh = x.f.reconstructNormal();
    await step(x, fresh.engine);
    expect(await row(x)).toMatchObject({
      allocation_cleanup: "closed",
      removed_at_ms: null,
      native_control: saved.native_control,
      application_io_cleanup: closed.application_io_cleanup,
    });
    for (const op of [
      "create-stopped",
      "start",
      "stop-init",
      "release-namespace",
      "delete-born",
      "begin-tracked-join",
      "dispose-born",
    ])
      expect(count(x, op)).toBe(1);
    expect(count(x, "read-tracked-join")).toBe(0);
    expect(requests(x).filter((k) => k.startsWith("linux-oci-parent-bootstrap@"))).toHaveLength(1);
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await fresh?.close();
    await x.f.cleanup();
  }
});

test("selected-local preserves prior profile3 READ-before-DISPOSE without upgrade", async () => {
  const x = await original({ legacy: true });
  try {
    await remove(x);
    await until(x, "begin-tracked-join");
    await step(x);
    expect(count(x, "read-tracked-join")).toBe(1);
    expect(count(x, "dispose-born")).toBe(0);
    expect(requests(x).filter((k) => k.startsWith("linux-oci-parent-bootstrap@"))).toEqual([
      "linux-oci-parent-bootstrap@3",
    ]);
    expect((await row(x)).removed_at_ms).toBeNull();
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await x.f.cleanup();
  }
});

test("selected-local UNKNOWN or lost BEGIN never becomes local disposal or a new effect", async () => {
  for (const retirementFault of ["begin-retained", "begin-lost"] as const) {
    const x = await original({ retirementFault });
    try {
      await remove(x);
      await until(x, "begin-tracked-join");
      const before = requests(x).slice();
      for (let i = 0; i < 3; i++) await step(x);
      expect(requests(x).slice(before.length)).toEqual(
        retirementFault === "begin-retained" ? ["linux-oci-parent-read-outcome@2"] : [],
      ); // Same-P history read only; never a new H command or effect.
      expect(count(x, "read-tracked-join")).toBe(0);
      expect(count(x, "dispose-born")).toBe(0);
      expect(await row(x)).toMatchObject({ allocation_cleanup: "untouched", removed_at_ms: null });
      expect(x.f.network).not.toHaveBeenCalled();
    } finally {
      await x.f.cleanup();
    }
  }
});

test("selected-local retained disposal only continues original phase and consumes genuine result", async () => {
  const x = await original({ retirementFault: "dispose-retained" });
  try {
    await remove(x);
    await until(x, "dispose-born");
    await until(x, "continue-born-disposal");
    await until(x, "parent-read-result");
    expect(count(x, "dispose-born")).toBe(1);
    expect(count(x, "continue-born-disposal")).toBe(1);
    expect(count(x, "read-tracked-join")).toBe(0);
    expect(await row(x)).toMatchObject({ allocation_cleanup: "closed", removed_at_ms: null });
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await x.f.cleanup();
  }
});

test("selected-local missing actual H output EOF cannot authorize allocation cleanup", async () => {
  const x = await original({ hResultFault: "stdout" });
  try {
    await remove(x);
    await until(x, "parent-read-result");
    expect(count(x, "dispose-born")).toBe(1);
    expect(count(x, "read-tracked-join")).toBe(0);
    expect(await row(x)).toMatchObject({ allocation_cleanup: "untouched", removed_at_ms: null });
    expect(JSON.parse(String((await row(x)).application_io_cleanup)).kind).toBe(
      "linux-oci-application-io-reserved@1",
    );
    const before = requests(x).slice();
    await step(x);
    expect(requests(x).slice(before.length)).toEqual([
      "linux-oci-parent-read-outcome@2",
      "linux-oci-parent-read-result@1",
    ]); // Genuine retained P facts may be reread; no H effect is repeated.
    expect(await row(x)).toMatchObject({ allocation_cleanup: "untouched", removed_at_ms: null });
    expect(JSON.parse(String((await row(x)).application_io_cleanup)).kind).toBe(
      "linux-oci-application-io-reserved@1",
    );
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await x.f.cleanup();
  }
});

test("selected-local cross-profile authenticated inner purpose refuses before any management effect", async () => {
  const x = await original();
  const query = x.f.sql.query.bind(x.f.sql);
  let reached = false;
  try {
    const saved = await row(x),
      envelope = JSON.parse(String(saved.native_control)),
      key = x.f.configuredInputs.keyring.current.key;
    const plaintext = await decryptContainerSecretBytes(
      key,
      decodeContainerSecretBytes(envelope.nonce),
      decodeContainerSecretBytes(envelope.ciphertext),
      new TextEncoder().encode(canonicalJson(envelope.scope)),
    );
    const binding = JSON.parse(new TextDecoder().decode(plaintext));
    plaintext.fill(0);
    expect(binding.purpose).toBe("takoserver.linux-oci-peer-local-cleanup-reconstruction@1");
    binding.purpose = "takoserver.linux-oci-peer-runtime-reconstruction@1";
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
    const roundtrip = await decryptContainerSecretBytes(
      key,
      decodeContainerSecretBytes(envelope.nonce),
      decodeContainerSecretBytes(envelope.ciphertext),
      new TextEncoder().encode(canonicalJson(envelope.scope)),
    );
    expect(roundtrip).toEqual(bytes);
    roundtrip.fill(0);
    bytes.fill(0);
    const document = canonicalJson(envelope),
      reads = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
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
      await step(x);
      expect(reached).toBe(true);
      expect(x.f.nativeCounts().processes).toBe(before);
      expect(count(x, "stop-init")).toBe(0);
      expect((await row(x)).removed_at_ms).toBeNull();
      expect(x.f.network).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  } finally {
    await x.f.cleanup();
  }
});

test("selected-local final awaited execution loss sends no local DISPOSE", async () => {
  const x = await original();
  try {
    await remove(x);
    await until(x, "begin-tracked-join");
    const query = x.f.sql.query.bind(x.f.sql);
    let countReads = 0,
      armed = false,
      reached = false;
    const reads = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (sql.startsWith("SELECT native_control FROM tf_v2_container_create_claims")) {
        countReads++;
        if (countReads === 4) armed = true;
      }
      if (armed && !reached && sql.includes(" WHERE i.resource_uid=? AND v.generation=?")) {
        const e = x.f.execution;
        if (!e) throw Error("original execution absent");
        Reflect.set(e, "leaseToken", "NONSECRET-local-dispose-revoked");
        reached = true;
      }
      return rows;
    });
    try {
      await step(x);
      expect(reached).toBe(true);
      expect(countReads).toBe(4);
      expect(count(x, "dispose-born")).toBe(0);
      expect(count(x, "read-tracked-join")).toBe(0);
      expect((await row(x)).removed_at_ms).toBeNull();
      expect(x.f.network).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  } finally {
    await x.f.cleanup();
  }
});
