import { expect, test } from "bun:test";
import { revision } from "./helpers/docker-container-configured-source-selection.ts";
import {
  deleteLifecycleFixture,
  type Observation,
} from "./helpers/docker-container-owner-delete-lifecycle.ts";

// Why does a DELETE stop after one Docker DELETE?
//
// Flow: a real Core CREATE, an explicit full-map PUT and an omitted PUT are executed and served
// through the real Docker Core owner (serving is the helper's call of the owner's publishServing,
// see the helper of the snapshot tests); then a DELETE is accepted and its backend removes every
// retained generation through the production DockerHTTP revision runtime and create-custody.
//
// Finding: native removal succeeds (stop, DELETE 204, exact-ID GET 404) but the owner's
// confirmRemoved is refused by the owner schema (container_owner_invariant): a claim cannot go
// bound -> removed while any of its start attempts is pending or running, and the owner has no
// API that moves a start attempt running -> exited. This is not probe wiring: the same input with
// the schema-legal transition written by the test (the CONTROL, because the owner has no API for
// it) completes the DELETE.
//
// The characterization test pins the open finding and is meant to be removed or replaced when
// the owner gains an exit confirmation. The tripwire starts to FAIL (as a failing-expected test)
// when the DELETE backend of the helper completes through the owner's own APIs. That happens
// without any change here only if the fix lives inside confirmRemoved; a fix that adds a new owner
// method called by a runtime or observer needs the helper's DELETE backend to call it first.
// The controls write the exit themselves: that state is not reachable by product code.

const NAMES = ["OTHER", "SECRET"];
const PRINCIPAL = "synthetic-source-principal";

type Fixture = Awaited<ReturnType<typeof deleteLifecycleFixture>>;

/** Three served generations: CREATE, an explicit full-map PUT and an omitted PUT. */
async function servedGenerations(ctx: Fixture) {
  const { fx } = ctx;
  fx.dispatch(ctx.dispatch);
  const created = await fx.create("owner-delete", { OTHER: "o-A", SECRET: "s-A" }, NAMES);
  expect(await fx.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
  const explicit = await fx.update(
    created.resourceUid,
    1,
    revision("2"),
    { OTHER: "o-B", SECRET: "s-B" },
    NAMES,
  );
  expect(await fx.engine.runNext()).toMatchObject({ id: explicit.id, status: "succeeded" });
  const omitted = await fx.update(created.resourceUid, 2, revision("3"), undefined, NAMES);
  expect(await fx.engine.runNext()).toMatchObject({ id: omitted.id, status: "succeeded" });
  expect(ctx.startAttempts()).toEqual(["1.1:running", "2.1:running", "3.1:running"]);
  return created;
}

async function runDelete(ctx: Fixture, uid: string) {
  const { fx, seam } = ctx;
  seam.log.length = 0;
  const accepted = await fx.engine.acceptDelete({
    principal: PRINCIPAL,
    key: crypto.randomUUID(),
    uid,
    expectedGeneration: 3,
  });
  const result = await fx.engine.runNext();
  seam.add({
    phase: "engine.completion",
    ok: result?.status === "succeeded",
    state: `${result?.status}/${result?.effect}${result?.error ? `/${result.error.code}` : ""}`,
  });
  // DL_LOG=1 prints the raw fixed-field log, timestamps included, for evidence runs.
  if (process.env.DL_LOG) for (const entry of seam.log) console.error("OBS", JSON.stringify(entry));
  return { accepted, result };
}

/** The fixed fields that matter, without timings. */
function phases(log: readonly Observation[]) {
  return log.map((entry) => ({
    phase: entry.phase,
    ok: entry.ok,
    ...(entry.generation === undefined ? {} : { generation: entry.generation }),
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(entry.thrown ? { thrown: `${entry.thrown.name}:${entry.thrown.message}` } : {}),
  }));
}

function claims(ctx: Fixture) {
  return ctx.fx.database
    .query("SELECT generation, state FROM tf_v2_container_create_claims ORDER BY generation")
    .all();
}

function resource(ctx: Fixture) {
  return ctx.fx.database
    .query(
      "SELECT phase, deleted_at IS NOT NULL AS deleted, busy_operation IS NOT NULL AS busy FROM tf_v2_resources",
    )
    .all();
}

test("characterization: the DELETE stops at the owner's confirmRemoved of the first started generation", async () => {
  const ctx = await deleteLifecycleFixture();
  try {
    const created = await servedGenerations(ctx);

    const { accepted, result } = await runDelete(ctx, created.resourceUid);

    expect(accepted.generation).toBe(4);
    expect(result).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
      error: { code: "outcome_unconfirmed" },
    });
    const log = phases(ctx.seam.log);
    // The owner grants the remove authority, the native object is stopped, deleted (204) and
    // absent (404), then the owner schema refuses to mark the claim removed.
    expect(log.map((entry) => entry.phase)).toEqual([
      "owner.readAcceptedExecution:delete",
      "test.startAttempts:before",
      "owner.read",
      "owner.withAuthority:granted",
      "engine.GET",
      "engine.GET",
      "engine.GET",
      "engine.POST",
      "engine.DELETE",
      "engine.GET",
      "owner.confirmRemoved",
      "custody.use",
      "runtime.remove",
      "engine.completion",
    ]);
    const delivered = log.filter((entry) => entry.phase === "engine.DELETE");
    expect(delivered).toEqual([{ phase: "engine.DELETE", ok: true, status: 204 }]);
    expect(log.find((entry) => entry.phase === "owner.confirmRemoved")).toEqual({
      phase: "owner.confirmRemoved",
      ok: false,
      generation: 1,
      thrown: "SqlError:container_owner_invariant",
    });
    expect(log.find((entry) => entry.phase === "test.startAttempts:before")).toMatchObject({
      ok: true,
    });
    expect(ctx.seam.log.find((entry) => entry.phase === "test.startAttempts:before")?.state).toBe(
      "1.1:running,2.1:running,3.1:running",
    );
    // One native DELETE is not completion: nothing is recorded as removed, the Resource is
    // still deleting and busy, and two native objects remain.
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "bound" },
      { generation: 2, state: "bound" },
      { generation: 3, state: "bound" },
    ]);
    expect(resource(ctx)).toEqual([{ phase: "deleting", deleted: 0, busy: 1 }]);
    expect(ctx.docker.containers.size).toBe(2);
    expect(ctx.outcome.removed).toEqual([]);
  } finally {
    ctx.fx.database.close();
  }
});

test.failing("tripwire: the DELETE completes through the owner's own APIs (fails today: the owner cannot record an exit)", async () => {
  const ctx = await deleteLifecycleFixture();
  try {
    const created = await servedGenerations(ctx);

    const { result } = await runDelete(ctx, created.resourceUid);

    expect(result).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "removed" },
      { generation: 2, state: "removed" },
      { generation: 3, state: "removed" },
    ]);
    expect(resource(ctx)).toEqual([{ phase: "idle", deleted: 1, busy: 0 }]);
    expect(ctx.docker.containers.size).toBe(0);
  } finally {
    ctx.fx.database.close();
  }
});

test("control: with the schema-legal exit written by the test for every generation, the DELETE retires all of them", async () => {
  const ctx = await deleteLifecycleFixture({ exitConfirmedFor: [1, 2, 3] });
  try {
    const created = await servedGenerations(ctx);

    const { accepted, result } = await runDelete(ctx, created.resourceUid);

    expect(result).toMatchObject({ id: accepted.id, status: "succeeded", effect: "complete" });
    const log = phases(ctx.seam.log);
    expect(log.filter((entry) => entry.phase === "owner.confirmRemoved")).toEqual([
      { phase: "owner.confirmRemoved", ok: true, generation: 1 },
      { phase: "owner.confirmRemoved", ok: true, generation: 2 },
      { phase: "owner.confirmRemoved", ok: true, generation: 3 },
    ]);
    expect(
      log.filter((entry) => entry.phase === "runtime.remove").map((entry) => entry.ok),
    ).toEqual([true, true, true]);
    expect(log.filter((entry) => entry.phase === "engine.DELETE")).toHaveLength(3);
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "removed" },
      { generation: 2, state: "removed" },
      { generation: 3, state: "removed" },
    ]);
    expect(ctx.startAttempts()).toEqual(["1.1:exited", "2.1:exited", "3.1:exited"]);
    expect(resource(ctx)).toEqual([{ phase: "idle", deleted: 1, busy: 0 }]);
    expect(ctx.docker.containers.size).toBe(0);
    expect(ctx.outcome.removed).toEqual([1, 2, 3]);
  } finally {
    ctx.fx.database.close();
  }
});

test("control: with the exit written for generation 1 only, generation 1 is removed and generation 2 stops with the same refusal", async () => {
  const ctx = await deleteLifecycleFixture({ exitConfirmedFor: [1] });
  try {
    const created = await servedGenerations(ctx);

    const { result } = await runDelete(ctx, created.resourceUid);

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const confirmations = phases(ctx.seam.log).filter(
      (entry) => entry.phase === "owner.confirmRemoved",
    );
    expect(confirmations).toEqual([
      { phase: "owner.confirmRemoved", ok: true, generation: 1 },
      {
        phase: "owner.confirmRemoved",
        ok: false,
        generation: 2,
        thrown: "SqlError:container_owner_invariant",
      },
    ]);
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "removed" },
      { generation: 2, state: "bound" },
      { generation: 3, state: "bound" },
    ]);
    expect(ctx.docker.containers.size).toBe(1);
    expect(ctx.outcome.removed).toEqual([1]);
  } finally {
    ctx.fx.database.close();
  }
});
