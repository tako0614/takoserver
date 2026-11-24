import { expect, spyOn, test } from "bun:test";
import { canonicalJson, isJsonObject } from "../src/json.ts";
import * as codec from "../src/providers/container-secret-codec.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import {
  inspectV2ContainerOwnerFinalDeleteSchema,
  inspectV2ContainerOwnerHistoricalDeleteSchema,
  inspectV2ContainerOwnerSelectedSchema,
  V2_CONTAINER_OWNER_HISTORICAL_DELETE_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { qualifiedNormalDeleteFixture } from "./helpers/linux-oci-normal-delete-fixture.ts";
import {
  acceptNormalUpdate,
  normalUpdateAlternateTopology,
  runNormalUpdateStep,
} from "./helpers/linux-oci-normal-update-fixture.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";

// Genuine original factory/Engine/crypto/atomic memorySql, raw process/HTTP
// interception only. Assertions stay outside callbacks swallowed by Engine.
test("normal-historical-delete original CREATE UPDATE DELETE consumes the historical close under its own operation", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: normalUpdateAlternateTopology(),
  });
  await f.sql.batch(V2_CONTAINER_OWNER_HISTORICAL_DELETE_EXPAND.statements);
  expect(await inspectV2ContainerOwnerHistoricalDeleteSchema(f.sql)).toBe(true);
  expect(await inspectV2ContainerOwnerFinalDeleteSchema(f.sql)).toBe(false);
  expect(await inspectV2ContainerOwnerSelectedSchema(f.sql, "control")).toBe(true);
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    const changed = await acceptNormalUpdate(f, accepted.resourceUid);
    let state: Awaited<ReturnType<typeof runNormalUpdateStep>> = null;
    for (let phase = 0; phase < 20; phase++) {
      state = await runNormalUpdateStep(f);
      if (state?.status === "succeeded") break;
    }
    expect(state).toMatchObject({ id: changed.id, status: "succeeded", effect: "complete" });
    const old = (
      await f.sql.query(
        "SELECT application_io_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
      )
    )[0]?.application_io_cleanup;
    if (typeof old !== "string") throw Error("NONSECRET historical close absent");
    expect(JSON.parse(old).scope.operation.operationId).toBe(changed.id);
    const removal = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 2,
    });
    for (let phase = 0; phase < 20; phase++) {
      state = await runNormalUpdateStep(f);
      if (state?.status === "succeeded") break;
    }
    expect(
      await f.sql.query(
        "SELECT generation,state,allocation_cleanup FROM tf_v2_container_create_claims ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, state: "removed", allocation_cleanup: "closed" },
      { generation: 2, state: "removed", allocation_cleanup: "closed" },
    ]);
    expect(state).toMatchObject({ id: removal.id, status: "succeeded", effect: "complete" });
    expect(
      (
        await f.sql.query(
          "SELECT application_io_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
        )
      )[0]?.application_io_cleanup,
    ).toBe(old);
    expect(
      await f.sql.query("SELECT * FROM tf_v2_operation_configured_private_inputs"),
    ).toHaveLength(0);
    expect(await f.sql.query("SELECT * FROM tf_v2_configured_private_inputs")).toHaveLength(0);
    expect(
      await f.sql.query(
        "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
      ),
    ).toHaveLength(0);
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1"),
    ).toHaveLength(2);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(2);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    health.restore();
    await f.cleanup();
  }
}, 30000);

type Fixture = Awaited<ReturnType<typeof qualifiedNormalDeleteFixture>>["f"];
type MutableJsonValue =
  | null
  | boolean
  | number
  | string
  | MutableJsonValue[]
  | { [key: string]: MutableJsonValue };
async function historicalDelete(successor = true) {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: normalUpdateAlternateTopology(),
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    if (successor) await f.sql.batch(V2_CONTAINER_OWNER_HISTORICAL_DELETE_EXPAND.statements);
    const changed = await acceptNormalUpdate(f, accepted.resourceUid);
    let state: Awaited<ReturnType<typeof runNormalUpdateStep>> = null;
    for (let phase = 0; phase < 20; phase++) {
      state = await runNormalUpdateStep(f);
      if (state?.status === "succeeded") break;
    }
    expect(state).toMatchObject({ id: changed.id, status: "succeeded", effect: "complete" });
    const old = (
      await f.sql.query(
        "SELECT application_io_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
      )
    )[0]?.application_io_cleanup;
    if (typeof old !== "string") throw Error("NONSECRET actual historical fact absent");
    const removal = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 2,
    });
    return {
      f,
      accepted,
      changed,
      removal,
      old,
      async cleanup() {
        health.restore();
        await f.cleanup();
      },
    };
  } catch (error) {
    health.restore();
    await f.cleanup();
    throw error;
  }
}
async function drive(f: Fixture, stop: () => boolean) {
  let state: Awaited<ReturnType<typeof runNormalUpdateStep>> = null;
  for (let phase = 0; phase < 20; phase++) {
    state = await runNormalUpdateStep(f);
    if (stop() || state?.status === "succeeded") break;
  }
  return state;
}
async function retained(f: Fixture, removal: { id: string }) {
  expect(
    await f.sql.query(
      "SELECT generation,state,allocation_cleanup FROM tf_v2_container_create_claims ORDER BY generation",
    ),
  ).toEqual([
    { generation: 1, state: "removed", allocation_cleanup: "closed" },
    { generation: 2, state: "removed", allocation_cleanup: "closed" },
  ]);
  expect(
    (await f.sql.query("SELECT status,effect FROM tf_v2_operations WHERE id=?", [removal.id]))[0],
  ).toEqual({ status: "reconciling", effect: "unknown" });
  expect(await f.sql.query("SELECT * FROM tf_v2_operation_configured_private_inputs")).toHaveLength(
    1,
  );
  expect(
    await f.sql.query(
      "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
    ),
  ).toHaveLength(2);
  expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(2);
  expect(f.network).not.toHaveBeenCalled();
}

test("normal-historical-delete unselected original schema cannot grant historical finalization", async () => {
  const x = await historicalDelete(false);
  try {
    expect(await inspectV2ContainerOwnerFinalDeleteSchema(x.f.sql)).toBe(true);
    expect(await inspectV2ContainerOwnerHistoricalDeleteSchema(x.f.sql)).toBe(false);
    expect(await drive(x.f, () => false)).toMatchObject({ id: x.removal.id, effect: "unknown" });
    await retained(x.f, x.removal);
  } finally {
    await x.cleanup();
  }
}, 15000);

for (const fault of [
  "missing-history",
  "unsuccessful-history",
  "lease-lost",
  "cancelled",
] as const) {
  test(`normal-historical-delete refusal ${fault} at original historical SQL read`, async () => {
    const x = await historicalDelete(),
      f = x.f,
      actual = f.sql.query.bind(f.sql),
      run = f.sql.run.bind(f.sql);
    let hit = false,
      closing: Promise<void> | undefined;
    const query = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      if (sql.startsWith("SELECT ha.") && params?.[0] === x.changed.id) {
        hit = true;
        if (fault === "unsuccessful-history")
          await run("UPDATE tf_v2_operations SET status='failed',effect='none' WHERE id=?", [
            x.changed.id,
          ]);
        const rows = await actual(sql, params);
        if (fault === "lease-lost")
          await run(
            "UPDATE tf_v2_operations SET lease_token='NONSECRET-replaced-delete-lease' WHERE id=?",
            [x.removal.id],
          );
        if (fault === "cancelled") {
          closing = f.composition.close();
          void closing.catch(() => undefined);
        }
        return fault === "missing-history" ? [] : rows;
      }
      return actual(sql, params);
    });
    try {
      expect(await drive(f, () => hit)).toMatchObject({ id: x.removal.id, effect: "unknown" });
      expect(hit).toBe(true);
      await retained(f, x.removal);
    } finally {
      query.mockRestore();
      await closing?.catch(() => undefined);
      await x.cleanup();
    }
  }, 15000);
}

test("normal-historical-delete refusal valid encrypted foreign fingerprint never replaces historical authority", async () => {
  const x = await historicalDelete(),
    f = x.f,
    actual = f.sql.query.bind(f.sql);
  let hit = false;
  const envelope: MutableJsonValue = JSON.parse(x.old);
  if (
    !isJsonObject(envelope) ||
    !isJsonObject(envelope.scope) ||
    !isJsonObject(envelope.scope.operation)
  )
    throw Error("NONSECRET envelope shape");
  envelope.scope.operation.acceptedFingerprint = "NONSECRET-foreign-fingerprint";
  const body = new TextEncoder().encode('{"kind":"linux-oci-original-application-io-closed@1"}'),
    nonce = new Uint8Array(12).fill(0x6d),
    key = f.configuredInputs.keyring.current.key;
  const encrypted = new Uint8Array(
    await encryptContainerSecretBytes(
      key,
      nonce,
      body,
      new TextEncoder().encode(canonicalJson(envelope.scope)),
    ),
  );
  expect(encrypted.length).toBeGreaterThan(16);
  expect(
    new TextDecoder().decode(
      await decryptContainerSecretBytes(
        key,
        nonce,
        encrypted,
        new TextEncoder().encode(canonicalJson(envelope.scope)),
      ),
    ),
  ).toBe(new TextDecoder().decode(body));
  envelope.nonce = encodeContainerSecretBytes(nonce);
  envelope.ciphertext = encodeContainerSecretBytes(encrypted);
  const foreign = canonicalJson(envelope);
  const query = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await actual(sql, params);
    if (
      sql.startsWith("SELECT allocation_cleanup,application_io_cleanup") &&
      sql.includes("state='removed'") &&
      params?.[1] === 1
    ) {
      hit = true;
      return rows.map((row) => ({ ...row, application_io_cleanup: foreign }));
    }
    return rows;
  });
  try {
    expect(await drive(f, () => hit)).toMatchObject({ id: x.removal.id, effect: "unknown" });
    expect(hit).toBe(true);
    await retained(f, x.removal);
  } finally {
    query.mockRestore();
    await x.cleanup();
  }
}, 15000);

test("normal-historical-delete refusal tampered ciphertext reaches actual AEAD rejection", async () => {
  const x = await historicalDelete(),
    f = x.f,
    actual = f.sql.query.bind(f.sql);
  let hit = false,
    decrypted = 0;
  const envelope: MutableJsonValue = JSON.parse(x.old);
  if (!isJsonObject(envelope) || typeof envelope.ciphertext !== "string")
    throw Error("NONSECRET envelope shape");
  const encrypted = decodeContainerSecretBytes(envelope.ciphertext);
  if (encrypted.length < 17) throw Error("NONSECRET cipher absent");
  encrypted[0] = (encrypted[0] ?? 0) ^ 1;
  envelope.ciphertext = encodeContainerSecretBytes(encrypted);
  const damaged = canonicalJson(envelope);
  const original = codec.decryptContainerSecretBytes,
    cryptoRead = spyOn(codec, "decryptContainerSecretBytes").mockImplementation((...args) => {
      if (encodeContainerSecretBytes(args[2]) === encodeContainerSecretBytes(encrypted))
        decrypted++;
      return original(...args);
    });
  const query = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await actual(sql, params);
    if (
      sql.startsWith("SELECT allocation_cleanup,application_io_cleanup") &&
      sql.includes("state='removed'") &&
      params?.[1] === 1
    ) {
      hit = true;
      return rows.map((row) => ({ ...row, application_io_cleanup: damaged }));
    }
    return rows;
  });
  try {
    expect(await drive(f, () => hit)).toMatchObject({ id: x.removal.id, effect: "unknown" });
    expect(hit).toBe(true);
    expect(decrypted).toBe(1);
    await retained(f, x.removal);
  } finally {
    query.mockRestore();
    cryptoRead.mockRestore();
    await x.cleanup();
  }
}, 15000);

test("normal-historical-delete lost final commit ACK reconstructs same operation without native resend", async () => {
  const x = await historicalDelete(),
    f = x.f,
    actual = f.sql.batch.bind(f.sql);
  let lost = false;
  const batch = spyOn(f.sql, "batch").mockImplementation(async (statements) => {
    const result = await actual(statements);
    if (
      !lost &&
      statements.some((s) =>
        s.sql.startsWith(
          "UPDATE tf_v2_container_acceptances SET configured_private_inputs_json=NULL",
        ),
      )
    ) {
      lost = true;
      throw Error("NONSECRET lost committed finalization ACK");
    }
    return result;
  });
  let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    expect(await drive(f, () => lost)).toMatchObject({ id: x.removal.id, effect: "unknown" });
    expect(lost).toBe(true);
    batch.mockRestore();
    expect(
      await f.sql.query("SELECT * FROM tf_v2_operation_configured_private_inputs"),
    ).toHaveLength(0);
    expect(
      await f.sql.query(
        "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
      ),
    ).toHaveLength(0);
    const before = f.nativeCounts();
    fresh = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      id: x.removal.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(f.nativeCounts()).toEqual(before);
    expect(
      (
        await f.sql.query(
          "SELECT application_io_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
        )
      )[0]?.application_io_cleanup,
    ).toBe(x.old);
    expect(await f.sql.query("SELECT * FROM tf_v2_configured_private_inputs")).toHaveLength(0);
  } finally {
    batch.mockRestore();
    await fresh?.close();
    await x.cleanup();
  }
}, 15000);

test("normal-historical-delete refusal key revoked after historical decrypt on fresh original creator", async () => {
  const x = await historicalDelete(),
    f = x.f,
    actual = f.sql.query.bind(f.sql);
  let staged = false;
  const stage = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await actual(sql, params);
    if (sql.startsWith("SELECT ha.")) {
      staged = true;
      return [];
    }
    return rows;
  });
  let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    expect(await drive(f, () => staged)).toMatchObject({ id: x.removal.id, effect: "unknown" });
    expect(staged).toBe(true);
    stage.mockRestore();
    const lookup = f.configuredInputs.keyring.keyForDecryption.bind(f.configuredInputs.keyring);
    let live = true,
      reads = 0;
    const key = spyOn(f.configuredInputs.keyring, "keyForDecryption").mockImplementation((id) =>
      live ? lookup(id) : undefined,
    );
    const query = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await actual(sql, params);
      if (sql.startsWith("SELECT ha.") && ++reads === 2) live = false;
      return rows;
    });
    try {
      fresh = f.reconstructNormal();
      const before = f.nativeCounts();
      f.advanceNormalClock(61_000);
      expect(await fresh.engine.runNext()).toMatchObject({ id: x.removal.id, effect: "unknown" });
      expect(reads).toBe(2);
      expect(live).toBe(false);
      expect(f.nativeCounts()).toEqual(before);
      await retained(f, x.removal);
    } finally {
      query.mockRestore();
      key.mockRestore();
    }
  } finally {
    stage.mockRestore();
    await fresh?.close();
    await x.cleanup();
  }
}, 15000);
