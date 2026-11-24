import { expect, spyOn, test } from "bun:test";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { isJsonObject } from "../src/json.ts";
import { V2_CONTAINER_OWNER_HISTORICAL_DELETE_EXPAND } from "../src/takoform-v2/container-owner-schema.ts";
import { ownedRawHttp, rawTick } from "./helpers/container-http-transport-fixture.ts";
import { qualifiedNormalDeleteFixture } from "./helpers/linux-oci-normal-delete-fixture.ts";
import {
  normalUpdateAlternateTopology,
  runNormalUpdateStep,
} from "./helpers/linux-oci-normal-update-fixture.ts";
import {
  acceptedHttpSelection,
  acceptedRawHttp,
} from "./helpers/linux-oci-owned-bundle-fixture.ts";

type Fixture = Awaited<ReturnType<typeof qualifiedNormalDeleteFixture>>["f"];
async function update(f: Fixture, uid: string, generation: number) {
  const row = (await f.sql.query("SELECT spec_json FROM tf_v2_resources WHERE uid=?", [uid]))[0];
  if (typeof row?.spec_json !== "string") throw Error("NONSECRET spec missing");
  const spec: unknown = JSON.parse(row.spec_json);
  if (!isJsonObject(spec)) throw Error("NONSECRET spec malformed");
  return f.engine.acceptUpdate({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid,
    expectedGeneration: generation,
    spec: { ...spec, [C.fields.workloadRevision]: String(generation + 1).repeat(64) },
    privateInputs: { SECRET: "NONSECRET-generation-" + (generation + 1) },
  });
}
async function settle(f: Fixture) {
  let state: Awaited<ReturnType<typeof runNormalUpdateStep>> = null;
  for (let phase = 0; phase < 20; phase++) {
    state = await runNormalUpdateStep(f);
    if (state?.status === "succeeded") break;
  }
  return state;
}

// Original factory/Engine/crypto/memorySQLite; only original process and raw
// HTTP syscall models are intercepted. Assertions remain outside Engine hooks.
test("normal-repeated-update original CREATE UPDATE UPDATE DELETE preserves historical close scope", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: normalUpdateAlternateTopology(),
  });
  await f.sql.batch(V2_CONTAINER_OWNER_HISTORICAL_DELETE_EXPAND.statements);
  const health = acceptedRawHttp();
  const beforeHealth: ReturnType<typeof f.sql.query>[] = [];
  health.onEnd(() => {
    beforeHealth.push(f.sql.query("SELECT serving_generation FROM tf_v2_container_instances"));
    health.reply();
    health.join();
  });
  try {
    const first = await update(f, accepted.resourceUid, 1);
    expect(await settle(f)).toMatchObject({
      id: first.id,
      status: "succeeded",
      effect: "complete",
    });
    const old = (
      await f.sql.query(
        "SELECT application_io_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
      )
    )[0]?.application_io_cleanup;
    if (typeof old !== "string") throw Error("NONSECRET original close absent");
    expect(JSON.parse(old).scope.operation.operationId).toBe(first.id);
    const firstHealthCalls = health.calls.length;
    const actualQuery = f.sql.query.bind(f.sql);
    let originalCloseReads = 0,
      historicalReads = 0;
    const historyRead = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await actualQuery(sql, params);
      if (
        sql.startsWith("SELECT allocation_cleanup,application_io_cleanup") &&
        params?.[1] === 1 &&
        rows[0]?.allocation_cleanup === "closed" &&
        rows[0]?.application_io_cleanup === old
      )
        originalCloseReads++;
      if (sql.startsWith("SELECT ha.") && params?.[0] === first.id) historicalReads++;
      return rows;
    });
    const second = await update(f, accepted.resourceUid, 2);
    const repeated = await settle(f);
    historyRead.mockRestore();
    expect(originalCloseReads).toBeGreaterThan(0);
    expect(historicalReads).toBeGreaterThan(0);
    expect(repeated).toMatchObject({ id: second.id, status: "succeeded", effect: "complete" });
    expect(await beforeHealth[0]).toEqual([{ serving_generation: 1 }]);
    expect(await beforeHealth[firstHealthCalls]).toEqual([{ serving_generation: 2 }]);
    expect(firstHealthCalls).toBeGreaterThan(0);
    expect(health.calls.length).toBeGreaterThan(firstHealthCalls);
    expect(
      health.calls
        .slice(0, firstHealthCalls)
        .every(
          (call) =>
            isJsonObject(call) && call.hostname === normalUpdateAlternateTopology().peerIpv4Guest,
        ),
    ).toBe(true);
    expect(
      health.calls
        .slice(firstHealthCalls)
        .every(
          (call) =>
            isJsonObject(call) &&
            call.hostname === acceptedHttpSelection().hostTopology.peerIpv4Guest,
        ),
    ).toBe(true);
    expect(
      (
        await f.sql.query(
          "SELECT application_io_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
        )
      )[0]?.application_io_cleanup,
    ).toBe(old);
    expect(
      await f.sql.query(
        "SELECT generation,state,allocation_cleanup FROM tf_v2_container_create_claims ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, state: "removed", allocation_cleanup: "closed" },
      { generation: 2, state: "removed", allocation_cleanup: "closed" },
      { generation: 3, state: "bound", allocation_cleanup: "untouched" },
    ]);
    const removal = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 3,
    });
    expect(await settle(f)).toMatchObject({
      id: removal.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await f.sql.query(
        "SELECT generation,state,allocation_cleanup FROM tf_v2_container_create_claims ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, state: "removed", allocation_cleanup: "closed" },
      { generation: 2, state: "removed", allocation_cleanup: "closed" },
      { generation: 3, state: "removed", allocation_cleanup: "closed" },
    ]);
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
    ).toHaveLength(3);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-start@1")).toHaveLength(3);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(3);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    health.restore();
    await f.cleanup();
  }
}, 30000);

async function pendingRepeated() {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: normalUpdateAlternateTopology(),
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_HISTORICAL_DELETE_EXPAND.statements);
    const first = await update(f, accepted.resourceUid, 1);
    expect(await settle(f)).toMatchObject({
      id: first.id,
      status: "succeeded",
      effect: "complete",
    });
    const second = await update(f, accepted.resourceUid, 2);
    return {
      f,
      accepted,
      health,
      first,
      second,
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
async function unchangedServing(f: Fixture) {
  expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
    { serving_generation: 2 },
  ]);
  expect(
    await f.sql.query(
      "SELECT generation,state,allocation_cleanup FROM tf_v2_container_create_claims ORDER BY generation",
    ),
  ).toEqual([
    { generation: 1, state: "removed", allocation_cleanup: "closed" },
    { generation: 2, state: "bound", allocation_cleanup: "untouched" },
    { generation: 3, state: "pending", allocation_cleanup: null },
  ]);
  expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1")).toHaveLength(
    2,
  );
  expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-start@1")).toHaveLength(2);
  expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
  expect(f.network).not.toHaveBeenCalled();
}
for (const fault of ["lease-lost", "cancelled", "history-withdrawn"] as const) {
  test(`normal-repeated-update refusal ${fault} after original historical SELECT`, async () => {
    const x = await pendingRepeated(),
      f = x.f,
      actual = f.sql.query.bind(f.sql),
      run = f.sql.run.bind(f.sql);
    let reads = 0,
      closing: Promise<void> | undefined;
    const query = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await actual(sql, params);
      if (sql.startsWith("SELECT ha.") && params?.[0] === x.first.id && ++reads === 1) {
        if (fault === "lease-lost")
          await run(
            "UPDATE tf_v2_operations SET lease_token='NONSECRET-replaced-current-update-lease' WHERE id=?",
            [x.second.id],
          );
        if (fault === "history-withdrawn")
          await run("UPDATE tf_v2_operations SET status='failed',effect='none' WHERE id=?", [
            x.first.id,
          ]);
        if (fault === "cancelled") {
          closing = f.composition.close();
          void closing.catch(() => undefined);
        }
      }
      return rows;
    });
    try {
      expect(await runNormalUpdateStep(f)).toMatchObject({ id: x.second.id, effect: "unknown" });
      expect(reads).toBeGreaterThan(0);
      await unchangedServing(f);
    } finally {
      query.mockRestore();
      await closing?.catch(() => undefined);
      await x.cleanup();
    }
  }, 15000);
}

test("normal-repeated-update refusal key revoked after historical decrypt on fresh original creator", async () => {
  const x = await pendingRepeated(),
    f = x.f,
    actual = f.sql.query.bind(f.sql);
  const lookup = f.configuredInputs.keyring.keyForDecryption.bind(f.configuredInputs.keyring);
  let live = true,
    reads = 0;
  const key = spyOn(f.configuredInputs.keyring, "keyForDecryption").mockImplementation((id) =>
    live ? lookup(id) : undefined,
  );
  const query = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await actual(sql, params);
    if (sql.startsWith("SELECT ha.") && params?.[0] === x.first.id && ++reads === 2) live = false;
    return rows;
  });
  const fresh = f.reconstructNormal();
  try {
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({ id: x.second.id, effect: "unknown" });
    expect(reads).toBe(2);
    expect(live).toBe(false);
    await unchangedServing(f);
  } finally {
    query.mockRestore();
    key.mockRestore();
    await fresh.close();
    await x.cleanup();
  }
}, 15000);

test("normal-repeated-update failed new health keeps prior serving and its original pending I/O", async () => {
  const x = await pendingRepeated(),
    f = x.f;
  x.health.restore();
  const io = ownedRawHttp();
  const response = f.composition.fetchServingHttp(
    f.recordedCreate(),
    new Request("http://ignored.invalid/NONSECRET-second-generation-stream"),
  );
  for (let tick = 0; tick < 100 && io.counts().calls === 0; tick++) await rawTick();
  expect(io.counts().calls).toBe(1);
  io.head();
  expect((await response).status).toBe(200);
  const health = acceptedRawHttp();
  Reflect.set(health.response, "statusCode", 503);
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    expect(await runNormalUpdateStep(f)).toMatchObject({ id: x.second.id, effect: "unknown" });
    expect(health.calls[0]).toMatchObject({
      hostname: acceptedHttpSelection().hostTopology.peerIpv4Guest,
    });
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 2 },
    ]);
    expect(
      (
        await f.sql.query(
          "SELECT state,allocation_cleanup FROM tf_v2_container_create_claims WHERE generation=2",
        )
      )[0],
    ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
    expect(io.counts().requestDestroy).toBe(0);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    io.closeResponse();
    io.closeRequest();
    health.restore();
    io.restore();
    await x.cleanup();
  }
}, 15000);
