import { expect, spyOn, test } from "bun:test";
import { V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import {
  linuxOciGenerationTopology,
  linuxOciPeerNetworksDisjoint,
  snapshotLinuxOciTopologyPair,
} from "../src/providers/linux-oci-host-topology.ts";
import * as originalBundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  observeRawPromise,
  ownedRawHttp,
  rawTick,
} from "./helpers/container-http-transport-fixture.ts";
import { qualifiedNormalDeleteFixture } from "./helpers/linux-oci-normal-delete-fixture.ts";
import {
  normalUpdateAlternateTopology as alternate,
  type NormalUpdateFixture as Fixture,
  specOf,
  runNormalUpdateStep as step,
  acceptNormalUpdate as update,
} from "./helpers/linux-oci-normal-update-fixture.ts";
import {
  acceptedHttpSelection,
  acceptedRawHttp,
} from "./helpers/linux-oci-owned-bundle-fixture.ts";

// Original normal creator/Engine, real crypto and atomic memorySQLite. Native
// processes/HTTP syscalls alone are intercepted. All assertions escape Engine.
async function oldIo(f: Fixture) {
  const io = ownedRawHttp();
  const response = f.composition.fetchServingHttp(
    f.recordedCreate(),
    new Request("http://ignored.invalid/NONSECRET-original-stream"),
  );
  for (let tick = 0; tick < 100 && io.counts().calls === 0; tick++) await rawTick();
  expect(io.counts().calls).toBe(1);
  io.head();
  expect((await response).status).toBe(200);
  return io;
}

test("normal-update-history healthy new slot precedes cutover and original I/O terminal gates old retirement", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: alternate(),
  });
  const io = await oldIo(f),
    health = acceptedRawHttp();
  const beforeHealth: {
    stops: number;
    destroy: number;
    serving: ReturnType<typeof f.sql.query>;
  }[] = [];
  health.onEnd(() => {
    beforeHealth.push({
      stops: f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1").length,
      destroy: io.counts().requestDestroy,
      serving: f.sql.query("SELECT serving_generation FROM tf_v2_container_instances"),
    });
    health.reply();
    health.join();
  });
  let sourceCalls = 0;
  const original = originalBundle.originalLinuxOciHttpRetirementSource;
  const getter = spyOn(originalBundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (...args) => {
      sourceCalls++;
      return original(...args);
    },
  );
  let ioJoined = false;
  try {
    const changed = await update(f, accepted.resourceUid);
    let final: Awaited<ReturnType<typeof step>> = null;
    for (let phase = 0; phase < 20; phase++) {
      const running = observeRawPromise(step(f));
      for (let tick = 0; tick < 100 && running.state() === "pending" && !sourceCalls; tick++)
        await rawTick();
      if (sourceCalls && !ioJoined) {
        expect(running.state()).toBe("pending");
        expect(
          (await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances"))[0],
        ).toEqual({ serving_generation: 2 });
        expect(
          (
            await f.sql.query(
              "SELECT state,allocation_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
            )
          )[0],
        ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
        expect(io.counts().requestDestroy).toBeGreaterThan(0);
        io.closeResponse();
        await rawTick();
        expect(running.state()).toBe("pending");
        io.closeRequest();
        ioJoined = true;
      }
      const settled = await running.value;
      if ("error" in settled) throw settled.error;
      final = settled.result;
      if (final?.status === "succeeded") break;
    }
    expect(final).toMatchObject({ id: changed.id, status: "succeeded", effect: "complete" });
    expect(ioJoined).toBe(true);
    expect(sourceCalls).toBeGreaterThan(0);
    expect(beforeHealth[0]?.stops).toBe(0);
    expect(beforeHealth[0]?.destroy).toBe(0);
    expect(await beforeHealth[0]?.serving).toEqual([{ serving_generation: 1 }]);
    expect(health.calls[0]).toMatchObject({ hostname: "10.240.0.5" });
    expect(
      await f.sql.query(
        "SELECT generation,state,allocation_cleanup FROM tf_v2_container_create_claims ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, state: "removed", allocation_cleanup: "closed" },
      { generation: 2, state: "bound", allocation_cleanup: "untouched" },
    ]);
    const rows = await f.sql.query(
      "SELECT application_io_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
    );
    if (typeof rows[0]?.application_io_cleanup !== "string")
      throw Error("NONSECRET genuine UPDATE close absent");
    expect(JSON.parse(rows[0].application_io_cleanup).scope.operation).toMatchObject({
      operationId: changed.id,
      action: "update",
      generation: 2,
    });
    expect(
      await f.sql.query(
        "SELECT operation_id,generation FROM tf_v2_operation_configured_private_inputs",
      ),
    ).toEqual([{ operation_id: changed.id, generation: 2 }]);
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1"),
    ).toHaveLength(2);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-start@1")).toHaveLength(2);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    getter.mockRestore();
    io.closeResponse();
    io.closeRequest();
    health.restore();
    io.restore();
    await f.cleanup();
  }
}, 15000);

test("normal-update-history failed new health preserves old serving and original pending I/O", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: alternate(),
  });
  const io = await oldIo(f),
    health = acceptedRawHttp();
  Reflect.set(health.response, "statusCode", 503);
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    const changed = await update(f, accepted.resourceUid);
    expect(await step(f)).toMatchObject({ id: changed.id, effect: "unknown" });
    expect(health.calls[0]).toMatchObject({ hostname: "10.240.0.5" });
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 1 },
    ]);
    expect(
      (
        await f.sql.query(
          "SELECT state,allocation_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
        )
      )[0],
    ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
    expect(io.counts()).toMatchObject({ requestDestroy: 0, responseDestroy: 0 });
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(0);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    io.closeResponse();
    io.closeRequest();
    health.restore();
    io.restore();
    await f.cleanup();
  }
}, 10000);

for (const scenario of ["continuation-retained", "lost", "foreign", "unhealthy"] as const) {
  test(`normal-update-history runtime cadence for ${scenario}`, async () => {
    const { f, accepted } = await qualifiedNormalDeleteFixture({
      runtimeApplicationOwner: true,
      alternateHostTopology: alternate(),
      ...(scenario === "unhealthy" ? {} : { namespaceFault: scenario }),
    });
    const health = acceptedRawHttp();
    if (scenario === "unhealthy") Reflect.set(health.response, "statusCode", 503);
    health.onEnd(() => {
      health.reply();
      health.join();
    });
    try {
      const changed = await update(f, accepted.resourceUid);
      const checkpoint = async () => {
        const [row] = await f.sql.query(
          "SELECT next_attempt_at_ms,updated_at,error_code,dispatch_possible FROM tf_v2_operations WHERE id=?",
          [changed.id],
        );
        const delay = Number(row?.next_attempt_at_ms) - Date.parse(String(row?.updated_at));
        expect(row?.dispatch_possible).toBe(1);
        return { delay, error: row?.error_code };
      };
      const expectUnknownLater = async () => {
        expect(await checkpoint()).toEqual({ delay: 60_000, error: "outcome_unconfirmed" });
        const requests = f.nativeCounts().requests;
        f.advanceNormalClock(1_000);
        expect(await f.engine.runNext()).toBeNull();
        expect(f.nativeCounts().requests).toEqual(requests);
      };
      const serving = () => f.sql.query("SELECT serving_generation FROM tf_v2_container_instances");
      const claims = () =>
        f.sql.query(
          "SELECT generation,state,allocation_cleanup FROM tf_v2_container_create_claims ORDER BY generation",
        );
      const stop = "linux-oci-stop-init@1";
      const release = "linux-oci-release-namespace@1";
      const continueRelease = "linux-oci-continue-namespace-release@1";
      const first = await f.engine.runNext();
      expect(first).toMatchObject({ id: changed.id, status: "reconciling", effect: "unknown" });
      expect(f.nativeCounts().requests).not.toContain(stop);
      if (scenario === "unhealthy") {
        expect(await serving()).toEqual([{ serving_generation: 1 }]);
        await expectUnknownLater();
        return;
      }
      expect(await serving()).toEqual([{ serving_generation: 2 }]);
      expect(await checkpoint()).toEqual({ delay: 1_000, error: null });
      let final = first;
      let pendingRelease = 0;
      for (let phase = 0; phase < 20; phase++) {
        const before = f.nativeCounts().requests.length;
        f.advanceNormalClock(1_000);
        final = await f.engine.runNext();
        expect(final?.id).toBe(changed.id);
        const requests = f.nativeCounts().requests.slice(before);
        if (scenario !== "continuation-retained" && requests.includes(release)) {
          expect(await claims()).toEqual([
            { generation: 1, state: "bound", allocation_cleanup: "untouched" },
            { generation: 2, state: "bound", allocation_cleanup: "untouched" },
          ]);
          await expectUnknownLater();
          return;
        }
        if (final?.status === "succeeded") break;
        expect(final).toMatchObject({ status: "reconciling", effect: "unknown" });
        expect(await checkpoint()).toEqual({ delay: 1_000, error: null });
        if (requests.includes(release) || requests.includes(continueRelease)) pendingRelease++;
      }
      expect(final).toMatchObject({ status: "succeeded", effect: "complete" });
      expect(pendingRelease).toBe(3);
      expect(await serving()).toEqual([{ serving_generation: 2 }]);
      expect(await claims()).toEqual([
        { generation: 1, state: "removed", allocation_cleanup: "closed" },
        { generation: 2, state: "bound", allocation_cleanup: "untouched" },
      ]);
      const requests = f.nativeCounts().requests;
      expect(requests.filter((kind) => kind === "linux-oci-create-stopped@1")).toHaveLength(2);
      expect(requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(2);
      expect(requests.filter((kind) => kind === stop)).toHaveLength(1);
      expect(requests.filter((kind) => kind === release)).toHaveLength(1);
      expect(requests.filter((kind) => kind === continueRelease)).toHaveLength(2);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      health.restore();
      await f.cleanup();
    }
  }, 15_000);
}

test("normal-update-history absent alternate retains original singleton refusal without old STOP", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture();
  try {
    const before = f.nativeCounts();
    const changed = await update(f, accepted.resourceUid);
    expect(await step(f)).toMatchObject({ id: changed.id, effect: "unknown" });
    expect(f.nativeCounts()).toEqual(before);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 1 },
    ]);
    expect(
      (
        await f.sql.query(
          "SELECT state,allocation_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
        )
      )[0],
    ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
  } finally {
    await f.cleanup();
  }
});

test("normal-update-history another Resource cannot adopt either original slot", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: alternate(),
  });
  try {
    const before = f.nativeCounts();
    const created = await f.engine.acceptCreate({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: "synthetic-space",
        name: "synthetic-other-resource",
        spec: await specOf(f, accepted.resourceUid),
        privateInputs: { SECRET: "NONSECRET-other-resource" },
      },
    });
    expect(await step(f)).toMatchObject({ id: created.id, effect: "unknown" });
    expect(f.nativeCounts()).toEqual(before);
    expect(
      await f.sql.query(
        "SELECT serving_generation FROM tf_v2_container_instances WHERE resource_uid=?",
        [accepted.resourceUid],
      ),
    ).toEqual([{ serving_generation: 1 }]);
  } finally {
    await f.cleanup();
  }
});

test("normal-update-history numeric slot validation rejects overlap and generation parity cannot grant reuse", () => {
  const primary = acceptedHttpSelection().hostTopology,
    other = alternate(),
    pair = snapshotLinuxOciTopologyPair(primary, other);
  if (!pair) throw Error("NONSECRET expected pair missing");
  expect(Object.isFrozen(pair.primary)).toBe(true);
  expect(Object.isFrozen(pair.alternate)).toBe(true);
  expect(linuxOciGenerationTopology(pair, 1)).toBe(pair.primary);
  expect<ReturnType<typeof linuxOciGenerationTopology> | undefined>(
    linuxOciGenerationTopology(pair, 2),
  ).toBe(pair.alternate);
  expect(
    linuxOciPeerNetworksDisjoint(
      linuxOciGenerationTopology(pair, 1),
      linuxOciGenerationTopology(pair, 3),
    ),
  ).toBe(false);
  for (const bad of [
    { ...other, peerIpv4Host: primary.peerIpv4Host, peerIpv4Guest: primary.peerIpv4Guest },
    { ...other, peerIpv6Host: primary.peerIpv6Host, peerIpv6Guest: primary.peerIpv6Guest },
    { ...other, interfaceIndex: primary.interfaceIndex + 1 },
    { ...other, peerIpv6Host: "fd60:1234:0:0:0:0:0:4" },
  ])
    expect(() => snapshotLinuxOciTopologyPair(primary, bad)).toThrow();
  expect(() => snapshotLinuxOciTopologyPair(undefined, other)).toThrow();
});

test("normal-update-history failed UPDATE gap preserves the earlier nonretired-generation refusal", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: alternate(),
  });
  const health = acceptedRawHttp();
  Reflect.set(health.response, "statusCode", 503);
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    const failed = await update(f, accepted.resourceUid);
    expect(await step(f)).toMatchObject({ id: failed.id, effect: "unknown" });
    // Adverse memory-SQL history only: a failed operation leaves both actual
    // native generations alive. This supplies no readiness/retirement fact.
    await f.sql.batch([
      {
        sql: "UPDATE tf_v2_operations SET status='failed',effect='none',lease_token=NULL,lease_until_ms=NULL WHERE id=?",
        params: [failed.id],
      },
      {
        sql: "UPDATE tf_v2_resources SET busy_operation=NULL,phase='error' WHERE uid=? AND busy_operation=?",
        params: [accepted.resourceUid, failed.id],
      },
    ]);
    const before = f.nativeCounts(),
      next = await update(f, accepted.resourceUid, 2);
    expect(await step(f)).toMatchObject({ id: next.id, effect: "unknown" });
    expect(f.nativeCounts()).toEqual(before);
    // The original accepted-read refuses inactive but nonretired generation 2
    // before a generation-3 claim exists. This does not visit the parity fence.
    expect(
      await f.sql.query(
        "SELECT generation,state,allocation_cleanup FROM tf_v2_container_create_claims ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, state: "bound", allocation_cleanup: "untouched" },
      { generation: 2, state: "bound", allocation_cleanup: "untouched" },
    ]);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 1 },
    ]);
  } finally {
    health.restore();
    await f.cleanup();
  }
}, 10000);

test("normal-update-history lease lost during original coordinate read refuses new P before bootstrap", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture({
    alternateHostTopology: alternate(),
  });
  const actualQuery = f.sql.query.bind(f.sql),
    actualRun = f.sql.run.bind(f.sql);
  let lost = false;
  const query = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await actualQuery(sql, params),
      execution = f.execution;
    if (
      !lost &&
      execution?.action === "update" &&
      sql.startsWith("SELECT native_control FROM tf_v2_container_create_claims") &&
      params?.[1] === 1
    ) {
      lost = true;
      await actualRun(
        "UPDATE tf_v2_operations SET lease_token='NONSECRET-replaced-lease' WHERE id=?",
        [execution.operationId],
      );
    }
    return rows;
  });
  try {
    const before = f.nativeCounts(),
      changed = await update(f, accepted.resourceUid);
    expect(await step(f)).toMatchObject({ id: changed.id, effect: "unknown" });
    expect(lost).toBe(true);
    expect(f.nativeCounts()).toEqual(before);
    expect(
      (
        await actualQuery(
          "SELECT state,allocation_cleanup FROM tf_v2_container_create_claims WHERE generation=1",
        )
      )[0],
    ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
  } finally {
    query.mockRestore();
    await f.cleanup();
  }
});
