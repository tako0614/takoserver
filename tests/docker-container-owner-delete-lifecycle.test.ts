import { expect, test } from "bun:test";
import { V2_CONTAINER_F2_FORM } from "../src/takoform-v2/container-owner-schema.ts";
import {
  containerSpec,
  PRINCIPAL,
  revision,
  SPACE,
} from "./helpers/docker-container-configured-source-selection.ts";
import {
  deleteLifecycleFixture,
  type Observation,
} from "./helpers/docker-container-owner-delete-lifecycle.ts";

// A DELETE (and the deferred retirement of a drained generation) removes native objects through
// the production create-custody and the DockerHTTP revision runtime, over the real Docker Core
// owner and a real Core engine (serving is the helper's call of the owner's publishServing, see
// the helper of the snapshot tests).
//
// The owner schema refuses to mark a claim removed while one of its start attempts is pending or
// running. Before this change nothing recorded the end of a running attempt, so the native object
// was deleted and the claim stayed bound (the Operation stalled at outcome_unconfirmed).
//
// Now the custody inspects the exact bound native ID under the held remove authority, stops it if
// it is running, inspects it again and, only on a positive non-running observation, asks the owner
// to record the exit of the exact start attempt (running -> exited, the schema's own transition)
// BEFORE the native DELETE. The owner's confirmRemoved fence is unchanged and independent.
//
// Controls, faults and forgeries below are test-side. No success case writes or fabricates an exit.
// Cancellation here is the removal's own signal. A revocation seen only through the held
// authority's stillCurrent would need a currentness override and is not exercised.

const NAMES = ["OTHER", "SECRET"];

type Fixture = Awaited<ReturnType<typeof deleteLifecycleFixture>>;
type Options = NonNullable<Parameters<typeof deleteLifecycleFixture>[0]>;

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

async function acceptDelete(ctx: Fixture, uid: string, expectedGeneration = 3) {
  ctx.seam.log.length = 0;
  return ctx.fx.engine.acceptDelete({
    principal: PRINCIPAL,
    key: crypto.randomUUID(),
    uid,
    expectedGeneration,
  });
}

async function runDelete(ctx: Fixture, uid: string) {
  const accepted = await acceptDelete(ctx, uid);
  const result = await runExecution(ctx);
  return { accepted, result };
}

/** One reconcile pass of the accepted DELETE. */
async function runExecution(ctx: Fixture) {
  const { fx, seam } = ctx;
  const result = await fx.engine.runNext();
  seam.add({
    phase: "engine.completion",
    ok: result?.status === "succeeded",
    state: `${result?.status}/${result?.effect}${result?.error ? `/${result.error.code}` : ""}`,
  });
  // DL_LOG=1 prints the raw fixed-field log, timestamps included, for evidence runs.
  if (process.env.DL_LOG) for (const entry of seam.log) console.error("OBS", JSON.stringify(entry));
  return result;
}

/**
 * Time passes (test-side): the engine re-dispatches a reconciling Operation only once its retry
 * time has come, by its own rule (the lease is already released). Nothing else of the Operation
 * or the owner is touched.
 */
function waitForRetry(ctx: Fixture, operationId: string) {
  ctx.fx.database
    .query("UPDATE tf_v2_operations SET next_attempt_at_ms = 0 WHERE id = ?")
    .run(operationId);
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

function nativeIds(ctx: Fixture): Map<number, string> {
  const rows = ctx.fx.database
    .query("SELECT generation, native_id AS id FROM tf_v2_container_create_claims")
    .all() as { generation: number; id: string }[];
  return new Map(rows.map((row) => [row.generation, row.id]));
}

function attempts(ctx: Fixture) {
  return ctx.fx.database
    .query(
      "SELECT generation, state, confirmed_running_at_ms AS running, confirmed_exited_at_ms AS exited FROM tf_v2_container_start_attempts ORDER BY generation",
    )
    .all() as {
    generation: number;
    state: string;
    running: number | null;
    exited: number | null;
  }[];
}

function resource(ctx: Fixture) {
  return ctx.fx.database
    .query(
      "SELECT phase, deleted_at IS NOT NULL AS deleted, busy_operation IS NOT NULL AS busy FROM tf_v2_resources",
    )
    .all();
}

/** Native CREATE and START requests the Docker double has seen so far. */
function nativeEffects(ctx: Fixture) {
  return { creates: ctx.docker.creates().length, starts: ctx.docker.starts().length };
}

function nativeDeletes(ctx: Fixture) {
  return ctx.docker.calls.filter((call) => call.method === "DELETE").length;
}

const tail = (id: string | undefined) => (id ?? "").slice(-8);

/** A DELETE that stops before any native DELETE and records nothing. */
function expectRefusedBeforeDelete(ctx: Fixture, result: Awaited<ReturnType<typeof runExecution>>) {
  expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
  expect(ctx.seam.log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
  expect(nativeDeletes(ctx)).toBe(0);
  expect(claims(ctx)).toEqual([
    { generation: 1, state: "bound" },
    { generation: 2, state: "bound" },
    { generation: 3, state: "bound" },
  ]);
  expect(attempts(ctx).map((row) => row.state)).toEqual(["running", "running", "running"]);
  expect(ctx.docker.containers.size).toBe(3);
}

test("a DELETE of three served generations completes through the owner's own APIs", async () => {
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

test("each exit is recorded before its native DELETE, for the exact bound native ID, and nothing is created or started", async () => {
  const ctx = await deleteLifecycleFixture();
  try {
    const created = await servedGenerations(ctx);
    const natives = nativeIds(ctx);
    const effectsBefore = nativeEffects(ctx);

    const { accepted, result } = await runDelete(ctx, created.resourceUid);

    expect(result).toMatchObject({ id: accepted.id, status: "succeeded", effect: "complete" });
    const log = ctx.seam.log;
    // Per generation: the exact ID is inspected, stopped, inspected again, its exit is recorded,
    // and only then is it deleted, found absent, and the claim marked removed.
    const flow = log
      .filter((entry) =>
        [
          "engine.GET",
          "engine.POST",
          "engine.DELETE",
          "owner.confirmStopped",
          "owner.confirmRemoved",
        ].includes(entry.phase),
      )
      .map((entry) =>
        entry.phase.startsWith("engine.")
          ? `${entry.phase}${(entry.path ?? "").replace(/^\/containers/u, "")}`
          : `${entry.phase}:${entry.generation}`,
      );
    const forGeneration = (generation: number) => {
      const id = tail(natives.get(generation));
      return [
        `engine.GET/${id}/json`,
        `engine.POST/${id}/stop`,
        `engine.GET/${id}/json`,
        `owner.confirmStopped:${generation}`,
        `engine.DELETE/${id}`,
        `engine.GET/${id}/json`,
        `owner.confirmRemoved:${generation}`,
      ];
    };
    // The helper also reads each generation's owner record and name-bound GET before the first
    // inspect of the exact ID; compare only the exact-ID flow of each generation.
    for (const generation of [1, 2, 3]) {
      const id = tail(natives.get(generation));
      const own = flow.filter((step) => step.includes(`/${id}`) || step.endsWith(`:${generation}`));
      expect(own.slice(-forGeneration(generation).length)).toEqual(forGeneration(generation));
    }
    // At each native DELETE the exits of the generations before it and its own are durable.
    expect(
      log.filter((entry) => entry.phase === "engine.DELETE").map((entry) => entry.state),
    ).toEqual([
      "1.1:exited,2.1:running,3.1:running",
      "1.1:exited,2.1:exited,3.1:running",
      "1.1:exited,2.1:exited,3.1:exited",
    ]);
    const rows = attempts(ctx);
    expect(rows.map((row) => row.state)).toEqual(["exited", "exited", "exited"]);
    for (const row of rows)
      expect(row.exited as number).toBeGreaterThanOrEqual(row.running as number);
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "removed" },
      { generation: 2, state: "removed" },
      { generation: 3, state: "removed" },
    ]);
    expect(nativeEffects(ctx)).toEqual(effectsBefore);
    expect(ctx.outcome.removed).toEqual([1, 2, 3]);
  } finally {
    ctx.fx.database.close();
  }
});

test("control: with the exit not recorded, the owner's own confirmRemoved fence still refuses the removal", async () => {
  // The test-side owner tells the custody that the exit was recorded without writing it. The
  // custody then deletes the object, and the owner's independent fence refuses the claim removal
  // (this is the state every DELETE reached before the exit was recorded).
  const ctx = await deleteLifecycleFixture({ skipExitRecordingFor: [1] });
  try {
    const created = await servedGenerations(ctx);

    const { result } = await runDelete(ctx, created.resourceUid);

    expect(result).toMatchObject({
      status: "reconciling",
      effect: "unknown",
      error: { code: "outcome_unconfirmed" },
    });
    const log = phases(ctx.seam.log);
    expect(log.find((entry) => entry.phase === "control.exitRecordingSkippedByTest")).toBeDefined();
    expect(log.filter((entry) => entry.phase === "engine.DELETE")).toEqual([
      { phase: "engine.DELETE", ok: true, status: 204 },
    ]);
    expect(log.find((entry) => entry.phase === "owner.confirmRemoved")).toEqual({
      phase: "owner.confirmRemoved",
      ok: false,
      generation: 1,
      thrown: "SqlError:container_owner_invariant",
    });
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "bound" },
      { generation: 2, state: "bound" },
      { generation: 3, state: "bound" },
    ]);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["running", "running", "running"]);
    expect(resource(ctx)).toEqual([{ phase: "deleting", deleted: 0, busy: 1 }]);
  } finally {
    ctx.fx.database.close();
  }
});

test("a stop that leaves the object running records no exit and deletes nothing", async () => {
  const ctx = await deleteLifecycleFixture({ stopLeavesRunning: true });
  try {
    const created = await servedGenerations(ctx);

    const { result } = await runDelete(ctx, created.resourceUid);

    expectRefusedBeforeDelete(ctx, result);
    const log = phases(ctx.seam.log);
    expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
    expect(log.filter((entry) => entry.phase === "engine.POST")).toEqual([
      { phase: "engine.POST", ok: true, status: 204 },
    ]);
    expect(log.find((entry) => entry.phase === "custody.use")).toMatchObject({
      ok: false,
      thrown: "DockerContainerCreateCustodyError:unavailable",
    });
  } finally {
    ctx.fx.database.close();
  }
});

test("a cancelled removal between the stop and the exit records nothing and deletes nothing", async () => {
  const ctx = await deleteLifecycleFixture({ abortAfterStop: true });
  try {
    const created = await servedGenerations(ctx);

    const { result } = await runDelete(ctx, created.resourceUid);

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = phases(ctx.seam.log);
    expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
    expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
    expect(nativeDeletes(ctx)).toBe(0);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["running", "running", "running"]);
    expect(claims(ctx).map((row) => (row as { state: string }).state)).toEqual([
      "bound",
      "bound",
      "bound",
    ]);
  } finally {
    ctx.fx.database.close();
  }
});

test("a removal cancelled right after the exit was recorded sends no DELETE, and the retry completes without recreate or restart", async () => {
  const ctx = await deleteLifecycleFixture({ abortAfterExit: true });
  try {
    const created = await servedGenerations(ctx);
    const effectsBefore = nativeEffects(ctx);

    const accepted = await acceptDelete(ctx, created.resourceUid);
    const first = await runExecution(ctx);

    expect(first).toMatchObject({ status: "reconciling", effect: "unknown" });
    // The exit of generation 1 is durable; its object was not deleted and nothing else started.
    expect(attempts(ctx).map((row) => row.state)).toEqual(["exited", "running", "running"]);
    expect(nativeDeletes(ctx)).toBe(0);
    expect(ctx.docker.containers.size).toBe(3);
    expect(claims(ctx).map((row) => (row as { state: string }).state)).toEqual([
      "bound",
      "bound",
      "bound",
    ]);
    const exitedAt = attempts(ctx)[0]?.exited;

    waitForRetry(ctx, accepted.id);
    const second = await runExecution(ctx);

    expect(second).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(attempts(ctx)[0]?.exited).toBe(exitedAt);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["exited", "exited", "exited"]);
    expect(claims(ctx).map((row) => (row as { state: string }).state)).toEqual([
      "removed",
      "removed",
      "removed",
    ]);
    expect(ctx.docker.containers.size).toBe(0);
    expect(nativeEffects(ctx)).toEqual(effectsBefore);
    expect(nativeDeletes(ctx)).toBe(3);
  } finally {
    ctx.fx.database.close();
  }
});

for (const stopFault of ["not-found", "timeout", "vanishes"] as const) {
  test(`a stop that gives no positive stopped observation (${stopFault}) is never an exit`, async () => {
    const ctx = await deleteLifecycleFixture({ stopFault });
    try {
      const created = await servedGenerations(ctx);

      const { result } = await runDelete(ctx, created.resourceUid);

      expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
      const log = phases(ctx.seam.log);
      expect(log.some((entry) => entry.phase === `control.stopFault:${stopFault}`)).toBe(true);
      expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
      expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
      expect(nativeDeletes(ctx)).toBe(0);
      expect(attempts(ctx).map((row) => row.state)).toEqual(["running", "running", "running"]);
      expect(claims(ctx).map((row) => (row as { state: string }).state)).toEqual([
        "bound",
        "bound",
        "bound",
      ]);
      // A vanished object proves nothing either: the owner's own fence refuses the claim.
      if (stopFault !== "timeout")
        expect(log.find((entry) => entry.phase === "owner.confirmRemoved")).toEqual({
          phase: "owner.confirmRemoved",
          ok: false,
          generation: 1,
          thrown: "SqlError:container_owner_invariant",
        });
      expect(ctx.docker.containers.size).toBe(stopFault === "timeout" ? 3 : 2);
    } finally {
      ctx.fx.database.close();
    }
  });
}

const DIGEST = `sha256:${"e".repeat(64)}`;
const forgeries: readonly [
  string,
  (other: () => string) => NonNullable<Options["forgeObservation"]>,
][] = [
  [
    "another generation's native ID",
    (other) => (o) => ({ ...o, native: { ...(o.native as object), nativeId: other() } }),
  ],
  [
    "a changed identity label",
    () => (o) => ({ ...o, native: { ...(o.native as object), identityLabel: DIGEST } }),
  ],
  [
    "a changed revision label",
    () => (o) => ({ ...o, native: { ...(o.native as object), revisionLabel: DIGEST } }),
  ],
  [
    "another incarnation",
    () => (o) => ({
      ...o,
      native: { ...(o.native as object), incarnationId: "other-incarnation" },
    }),
  ],
  [
    "another revision",
    () => (o) => ({
      ...o,
      native: { ...(o.native as object), revision: `1-${"f".repeat(64)}` },
    }),
  ],
  [
    "another installation",
    () => (o) => ({
      ...o,
      native: { ...(o.native as object), installationId: "other-installation" },
    }),
  ],
  [
    "another resource",
    () => (o) => ({
      ...o,
      native: { ...(o.native as object), resourceUid: "00000000-0000-4000-8000-000000000000" },
    }),
  ],
  ["a running state", () => (o) => ({ ...o, state: "running" })],
  ["an extra key", () => (o) => ({ ...o, granted: true })],
  ["no native identity", () => (o) => ({ state: o.state })],
];

for (const [name, forge] of forgeries) {
  test(`the owner refuses a forged observation (${name}) under the real held authority`, async () => {
    let other = "";
    const ctx = await deleteLifecycleFixture({ forgeObservation: forge(() => other) });
    try {
      const created = await servedGenerations(ctx);
      other = nativeIds(ctx).get(2) as string;

      const { result } = await runDelete(ctx, created.resourceUid);

      expectRefusedBeforeDelete(ctx, result);
      expect(phases(ctx.seam.log).find((entry) => entry.phase === "owner.confirmStopped")).toEqual({
        phase: "owner.confirmStopped",
        ok: false,
        generation: 1,
        thrown: "TypeError:Docker Core owner authority refused",
      });
    } finally {
      ctx.fx.database.close();
    }
  });
}

test("an object that is already absent at the first inspect gets no synthetic exit and is refused", async () => {
  const ctx = await deleteLifecycleFixture();
  try {
    const created = await servedGenerations(ctx);
    const first = nativeIds(ctx).get(1);
    // The native object disappears outside this system (test-side). Nothing stored an exit.
    for (const [name, container] of ctx.docker.containers)
      if (container.Id === first) ctx.docker.containers.delete(name);
    expect(ctx.docker.containers.size).toBe(2);

    const { result } = await runDelete(ctx, created.resourceUid);

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = phases(ctx.seam.log);
    expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
    expect(log.find((entry) => entry.phase === "owner.confirmRemoved")).toEqual({
      phase: "owner.confirmRemoved",
      ok: false,
      generation: 1,
      thrown: "SqlError:container_owner_invariant",
    });
    expect(nativeDeletes(ctx)).toBe(0);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["running", "running", "running"]);
    expect(claims(ctx).map((row) => (row as { state: string }).state)).toEqual([
      "bound",
      "bound",
      "bound",
    ]);
  } finally {
    ctx.fx.database.close();
  }
});

test("a never-confirmed (pending) start attempt stays fail-closed: no exit, nothing deleted", async () => {
  const ctx = await deleteLifecycleFixture();
  const { fx } = ctx;
  try {
    // The daemon refuses the START: the object is created and the START is claimed, but it never
    // runs, so the attempt stays pending and no observation can say it ever ran. (An object that
    // IS running while its health never passes is resolved by the remove-phase confirmRunning:
    // see tests/docker-container-pending-start-observation.test.ts.) The backend then settles
    // the CREATE as failed.
    const engine = ctx.docker.engine;
    ctx.docker.engine = async (method, path, body, signal) =>
      method === "POST" && path.includes("/start")
        ? { status: 500, body: "" }
        : engine(method, path, body, signal);
    fx.dispatch(async (input) => {
      const result = await ctx.dispatch(input);
      return input.action === "create" && result.kind === "unknown"
        ? {
            kind: "no_effect" as const,
            code: "start_refused",
            message: "the daemon refused the START",
          }
        : result;
    });
    const created = await fx.engine.acceptCreate({
      principal: PRINCIPAL,
      key: crypto.randomUUID(),
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: SPACE,
        name: "owner-pending",
        spec: { ...containerSpec(revision("1"), NAMES), healthPath: "/unhealthy" },
        privateInputs: { OTHER: "o-A", SECRET: "s-A" },
      },
    });
    await fx.engine.runNext();
    expect(ctx.startAttempts()).toEqual(["1.1:pending"]);
    expect(ctx.docker.containers.size).toBe(1);
    await acceptDelete(ctx, created.resourceUid, 1);
    const effectsBefore = nativeEffects(ctx);

    const result = await runExecution(ctx);

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = phases(ctx.seam.log);
    expect(log.find((entry) => entry.phase === "owner.confirmStopped")).toEqual({
      phase: "owner.confirmStopped",
      ok: false,
      generation: 1,
      thrown: "TypeError:Docker Core owner authority refused",
    });
    // The refusal comes before the native DELETE: the object is kept, not deleted unconfirmed.
    expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
    expect(ctx.docker.containers.size).toBe(1);
    expect(claims(ctx)).toEqual([{ generation: 1, state: "bound" }]);
    expect(ctx.startAttempts()).toEqual(["1.1:pending"]);
    expect(nativeEffects(ctx)).toEqual(effectsBefore);
  } finally {
    fx.database.close();
  }
});

test("a claim whose native object never started has no attempt to end and is removed as before", async () => {
  const ctx = await deleteLifecycleFixture();
  const { fx } = ctx;
  try {
    // The CREATE binds its native object, then the daemon refuses the first readback by exact ID
    // (once), so the runtime stops before any START is claimed. The backend settles it as failed.
    const engine = ctx.docker.engine;
    let created = false;
    let refused = false;
    ctx.docker.engine = async (method, path, body, signal) => {
      const response = await engine(method, path, body, signal);
      if (method === "POST" && path.startsWith("/containers/create")) created = true;
      if (
        created &&
        !refused &&
        method === "GET" &&
        /^\/containers\/[a-f0-9]{64}\/json/u.test(path)
      ) {
        refused = true;
        return { status: 500, body: "" };
      }
      return response;
    };
    fx.dispatch(async (input) => {
      const result = await ctx.dispatch(input);
      return input.action === "create" && result.kind === "unknown"
        ? { kind: "no_effect" as const, code: "readback_refused", message: "the readback failed" }
        : result;
    });
    const created1 = await fx.engine.acceptCreate({
      principal: PRINCIPAL,
      key: crypto.randomUUID(),
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: SPACE,
        name: "owner-never-started",
        spec: containerSpec(revision("1"), NAMES),
        privateInputs: { OTHER: "o-A", SECRET: "s-A" },
      },
    });
    await fx.engine.runNext();
    expect(refused).toBe(true);
    expect(ctx.startAttempts()).toEqual([]);
    expect(claims(ctx)).toEqual([{ generation: 1, state: "bound" }]);
    expect(ctx.docker.containers.size).toBe(1);
    await acceptDelete(ctx, created1.resourceUid, 1);

    const result = await runExecution(ctx);

    expect(result).toMatchObject({ status: "succeeded", effect: "complete" });
    const log = phases(ctx.seam.log);
    expect(log.filter((entry) => entry.phase === "owner.confirmStopped")).toEqual([
      { phase: "owner.confirmStopped", ok: true, generation: 1 },
    ]);
    // Nothing was recorded: there was no attempt to end.
    expect(ctx.startAttempts()).toEqual([]);
    expect(claims(ctx)).toEqual([{ generation: 1, state: "removed" }]);
    expect(ctx.docker.containers.size).toBe(0);
    expect(ctx.docker.starts().length).toBe(0);
  } finally {
    fx.database.close();
  }
});

test("the Linux preparation forwards the owner's exit confirmation to its own custody", async () => {
  const ctx = await deleteLifecycleFixture({ custody: "linux" });
  try {
    const created = await servedGenerations(ctx);

    const { result } = await runDelete(ctx, created.resourceUid);

    expect(result).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(phases(ctx.seam.log).filter((entry) => entry.phase === "owner.confirmStopped")).toEqual([
      { phase: "owner.confirmStopped", ok: true, generation: 1 },
      { phase: "owner.confirmStopped", ok: true, generation: 2 },
      { phase: "owner.confirmStopped", ok: true, generation: 3 },
    ]);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["exited", "exited", "exited"]);
  } finally {
    ctx.fx.database.close();
  }
});

test("repeating the owner's exit confirmation is idempotent and writes nothing again", async () => {
  const ctx = await deleteLifecycleFixture({ repeatConfirmStopped: true });
  try {
    const created = await servedGenerations(ctx);

    const { result } = await runDelete(ctx, created.resourceUid);

    // A second confirmation would have to write again, and its running-only guard matches no row.
    expect(result).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(attempts(ctx).map((row) => row.state)).toEqual(["exited", "exited", "exited"]);
  } finally {
    ctx.fx.database.close();
  }
});

test("a lost DELETE ACK after the exit and the native removal completes on retry without recreate or restart", async () => {
  const ctx = await deleteLifecycleFixture({ deleteFault: "ack-lost" });
  try {
    const created = await servedGenerations(ctx);
    const effectsBefore = nativeEffects(ctx);

    const accepted = await acceptDelete(ctx, created.resourceUid);
    const first = await runExecution(ctx);

    expect(first).toMatchObject({ status: "reconciling", effect: "unknown" });
    // The daemon removed generation 1 and its exit is durable; the claim is still bound.
    expect(ctx.docker.containers.size).toBe(2);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["exited", "running", "running"]);
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "bound" },
      { generation: 2, state: "bound" },
      { generation: 3, state: "bound" },
    ]);
    const exitedAt = attempts(ctx)[0]?.exited;

    waitForRetry(ctx, accepted.id);
    const second = await runExecution(ctx);

    expect(second).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "removed" },
      { generation: 2, state: "removed" },
      { generation: 3, state: "removed" },
    ]);
    expect(attempts(ctx)[0]?.exited).toBe(exitedAt);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["exited", "exited", "exited"]);
    expect(ctx.docker.containers.size).toBe(0);
    expect(nativeEffects(ctx)).toEqual(effectsBefore);
    expect(nativeDeletes(ctx)).toBe(3);
  } finally {
    ctx.fx.database.close();
  }
});

test("a DELETE refused after the exit was recorded completes on retry with the same exit, without recreate or restart", async () => {
  const ctx = await deleteLifecycleFixture({ deleteFault: "refused" });
  try {
    const created = await servedGenerations(ctx);
    const effectsBefore = nativeEffects(ctx);

    const accepted = await acceptDelete(ctx, created.resourceUid);
    const first = await runExecution(ctx);

    expect(first).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(ctx.docker.containers.size).toBe(3);
    expect(nativeDeletes(ctx)).toBe(0);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["exited", "running", "running"]);
    const exitedAt = attempts(ctx)[0]?.exited;

    waitForRetry(ctx, accepted.id);
    const second = await runExecution(ctx);

    expect(second).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(attempts(ctx)[0]?.exited).toBe(exitedAt);
    expect(attempts(ctx).map((row) => row.state)).toEqual(["exited", "exited", "exited"]);
    expect(claims(ctx).map((row) => (row as { state: string }).state)).toEqual([
      "removed",
      "removed",
      "removed",
    ]);
    expect(ctx.docker.containers.size).toBe(0);
    expect(nativeEffects(ctx)).toEqual(effectsBefore);
  } finally {
    ctx.fx.database.close();
  }
});

test("retiring the drained generation after an explicit PUT records its exit and keeps the serving one", async () => {
  const ctx = await deleteLifecycleFixture();
  const { fx } = ctx;
  try {
    let retired: boolean | undefined;
    fx.dispatch(async (input) => {
      const result = await ctx.dispatch(input);
      if (input.action === "update" && result.kind === "complete") {
        // Deferred retirement of the previous generation, inside a registered execution of the
        // same Operation, through the same custody remove path.
        await fx.owner.withExecution(input, async () => {
          const accepted = await fx.owner.readAcceptedExecution(input);
          const drained = accepted.retained.find(
            (item) => item.record.intent.policy.generation === 1,
          );
          if (drained) retired = await ctx.removeGeneration(accepted, drained);
        });
      }
      return result;
    });
    const created = await fx.create("owner-drain", { OTHER: "o-A", SECRET: "s-A" }, NAMES);
    await fx.engine.runNext();
    expect(created.resourceUid).toBeDefined();
    const effectsBefore = nativeEffects(ctx);

    const second = await fx.update(
      created.resourceUid,
      1,
      revision("2"),
      { OTHER: "o-B", SECRET: "s-B" },
      NAMES,
    );
    const result = await fx.engine.runNext();

    expect(result).toMatchObject({ id: second.id, status: "succeeded" });
    expect(retired).toBe(true);
    expect(claims(ctx)).toEqual([
      { generation: 1, state: "removed" },
      { generation: 2, state: "bound" },
    ]);
    expect(ctx.startAttempts()).toEqual(["1.1:exited", "2.1:running"]);
    expect(ctx.docker.containers.size).toBe(1);
    // One more CREATE and START for the new generation only.
    expect(nativeEffects(ctx)).toEqual({
      creates: effectsBefore.creates + 1,
      starts: effectsBefore.starts + 1,
    });
  } finally {
    fx.database.close();
  }
});
