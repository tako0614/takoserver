import { expect, setSystemTime, test } from "bun:test";
import {
  type OwnerScope,
  pendingStartFixture,
} from "./helpers/docker-container-pending-start-observation.ts";

// Remove-phase positive observation of a start attempt.
//
// A start attempt stays `pending` when the object was started but never reported ready (serving
// is never published) or when the START outcome stayed unknown. The owner schema lets a claim go
// bound -> removed only once no attempt is pending or running, and lets an attempt reach
// `exited` only through `running`, so a pending attempt can never be exited directly.
//
// Owner decision recorded here: while the REMOVE authority is held, a fresh, exact-bound-native-ID,
// positive Running=true observed by the custody is recorded by the owner as the schema's own
// pending -> running BEFORE the stop. `confirmed_running_at_ms` then means "observed running no
// later than that owner time": it is NOT the native START time, NOT health and NOT serving. The
// owner never writes the instance, the serving generation or the retention for it, and a remove
// authority exists only for a retired instance or a non-desired, non-serving draining/retired
// revision, which publishServing (desired, not retired) can never consume.
//
// Not covered, and refused as before: a pending attempt whose object never ran, is absent, or ran
// and then exited (the port reads only State.Running, so those are indistinguishable from
// never-ran), and an Operation already stalled by the old code.
//
// Revocation seen only through the held authority's stillCurrent would need a currentness
// override and is not exercised; cancellation here is the removal's own signal, and a missing,
// ended or wrong-phase authority is exercised through the owner's own lawful paths.

const REFUSED = "TypeError:Docker Core owner authority refused";
const DIGEST = `sha256:${"e".repeat(64)}`;
const running = (scope: OwnerScope, overrides?: Record<string, unknown>) =>
  ({ native: scope.native(overrides), state: "running" }) as never;
const stopped = (scope: OwnerScope) => ({ native: scope.native(), state: "stopped" }) as never;
const errorName = (error: unknown) =>
  error instanceof Error ? `${error.name}:${error.message}` : String(error);

test("a pending attempt whose object is physically running is removed through the owner's own confirmRunning, confirmStopped and confirmRemoved, and serving is never published", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("pending-running");
    // Physically running (the daemon started it) while the START is still only claimed and
    // serving was never published.
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
    expect(ctx.containerStates()).toEqual([true]);
    expect(ctx.instance()).toMatchObject({ desired: 1, serving: null, retired: 0 });
    await ctx.acceptDelete(created.resourceUid);
    const effectsBefore = ctx.nativeEffects();

    const beforeRemoval = Date.now();
    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "succeeded", effect: "complete" });
    // Order under the real held remove authority: granted, the fresh exact-ID Running=true, the
    // owner records it, the stop, the second inspect (stopped), the owner records the exit, the
    // DELETE, the exact-ID absence and the claim removal.
    const steps = ctx.seam.log
      .filter((entry) =>
        [
          "owner.withAuthority:granted",
          "observation.exactID",
          "owner.confirmRunning",
          "engine.POST",
          "owner.confirmStopped",
          "engine.DELETE",
          "owner.confirmRemoved",
        ].includes(entry.phase),
      )
      .map((entry) =>
        entry.phase === "owner.withAuthority:granted"
          ? `granted:${entry.authorityPhase}`
          : entry.phase === "observation.exactID"
            ? `observed:${entry.state}`
            : entry.phase.startsWith("owner.")
              ? `${entry.phase}:${entry.ok}`
              : entry.phase,
      );
    expect(steps).toEqual([
      "granted:remove",
      "observed:Running=true",
      "owner.confirmRunning:true",
      "engine.POST",
      "observed:Running=false",
      "owner.confirmStopped:true",
      "engine.DELETE",
      "owner.confirmRemoved:true",
    ]);
    // confirmRunning wrote the attempt and nothing else: at the stop the attempt was already
    // running and the instance, revision, acceptance and claim rows were byte-identical to the
    // first Running=true inspect.
    expect(ctx.evidence.atStop).toEqual({
      attemptBefore: "pending",
      attemptAtStop: "running",
      othersUnchanged: true,
    });
    expect(
      ctx.seam.log.filter((entry) => entry.phase === "engine.DELETE").map((entry) => entry.state),
    ).toEqual(["1.1:exited"]);
    const rows = ctx.attemptRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.state).toBe("exited");
    // Monotonic: claimed <= running (the owner time of the observation) <= exited, and the
    // running time is the time of THIS removal's observation, not the claim time.
    expect(row?.running as number).toBeGreaterThanOrEqual(row?.claimed as number);
    expect(row?.running as number).toBeGreaterThanOrEqual(beforeRemoval);
    expect(row?.exited as number).toBeGreaterThanOrEqual(row?.running as number);
    // Serving was never published and nothing was created or started again.
    expect(ctx.instance()).toMatchObject({ desired: 2, serving: null, retired: 1 });
    expect(ctx.retention()).toEqual(["retired"]);
    expect(ctx.claims()).toEqual([{ generation: 1, state: "removed" }]);
    expect(ctx.docker.containers.size).toBe(0);
    expect(ctx.nativeEffects()).toEqual(effectsBefore);
    expect(ctx.resource()).toEqual([{ phase: "idle", deleted: 1, busy: 0 }]);
  } finally {
    ctx.fx.database.close();
  }
});

test("a served running attempt: confirmRunning is an idempotent no-op and its confirmed time is untouched", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createServedResource("served-running");
    const [before] = ctx.attemptRows();
    expect(before?.state).toBe("running");
    await ctx.acceptDelete(created.resourceUid);

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(
      ctx.seam.log
        .filter((entry) => entry.phase === "owner.confirmRunning")
        .map((entry) => entry.ok),
    ).toEqual([true]);
    const [after] = ctx.attemptRows();
    expect(after?.state).toBe("exited");
    expect(after?.running).toBe(before?.running as number);
  } finally {
    ctx.fx.database.close();
  }
});

test("never ran: a pending attempt whose START the daemon refused has no positive fact and stays refused", async () => {
  const ctx = await pendingStartFixture({ startRefused: true });
  try {
    const created = await ctx.createFailedResource("pending-never-ran");
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
    expect(ctx.containerStates()).toEqual([false]);
    await ctx.acceptDelete(created.resourceUid);

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = ctx.seam.log;
    // Every exact-ID observation says Running=false: no confirmRunning, no stop, no exit.
    expect(
      log
        .filter((entry) => entry.phase === "observation.exactID")
        .every((entry) => entry.state === "Running=false"),
    ).toBe(true);
    expect(log.some((entry) => entry.phase === "owner.confirmRunning")).toBe(false);
    expect(log.some((entry) => entry.phase === "engine.POST")).toBe(false);
    expect(log.find((entry) => entry.phase === "owner.confirmStopped")).toMatchObject({
      ok: false,
      thrown: { message: "Docker Core owner authority refused" },
    });
    expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
    expect(ctx.docker.containers.size).toBe(1);
  } finally {
    ctx.fx.database.close();
  }
});

test("ran and exited: a pending attempt whose process exited on its own looks like never-ran at the port and stays refused", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("pending-ran-then-exited");
    expect(ctx.containerStates()).toEqual([true]);
    // The process exits before anyone looks (test-side). The inspect carries only State.Running;
    // a real daemon also reports StartedAt/Status, which no port in this change set reads.
    ctx.exitExternally();
    expect(ctx.containerStates()).toEqual([false]);
    await ctx.acceptDelete(created.resourceUid);

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = ctx.seam.log;
    expect(
      log
        .filter((entry) => entry.phase === "observation.exactID")
        .every((entry) => entry.state === "Running=false"),
    ).toBe(true);
    expect(log.some((entry) => entry.phase === "owner.confirmRunning")).toBe(false);
    expect(log.find((entry) => entry.phase === "owner.confirmStopped")).toMatchObject({
      ok: false,
      thrown: { message: "Docker Core owner authority refused" },
    });
    expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
  } finally {
    ctx.fx.database.close();
  }
});

test("absent: a pending attempt whose object is already gone has no positive fact and stays refused", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("pending-absent");
    const id = (
      ctx.fx.database.query("SELECT native_id AS id FROM tf_v2_container_create_claims").get() as {
        id: string;
      }
    ).id;
    // The object disappears outside this system (test-side).
    ctx.dropContainer(id);
    expect(ctx.docker.containers.size).toBe(0);
    await ctx.acceptDelete(created.resourceUid);

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = ctx.seam.log;
    expect(log.some((entry) => entry.phase === "observation.exactID")).toBe(false);
    expect(log.some((entry) => entry.phase === "owner.confirmRunning")).toBe(false);
    expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
    expect(log.find((entry) => entry.phase === "owner.confirmRemoved")).toMatchObject({
      ok: false,
      thrown: { name: "SqlError", message: "container_owner_invariant" },
    });
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
  } finally {
    ctx.fx.database.close();
  }
});

for (const fault of ["not-found", "timeout"] as const) {
  test(`a recorded running is not an exit: a stop that ends in ${fault} leaves the attempt running and refused`, async () => {
    const ctx = await pendingStartFixture();
    try {
      const created = await ctx.createFailedResource(`pending-${fault}`);
      await ctx.acceptDelete(created.resourceUid);
      ctx.armStopFault(fault);

      const result = await ctx.runDeleteOnce();

      expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
      // The positive observation was recorded as running; the stop gave no positive
      // Running=false, so no exit is recorded and nothing is deleted.
      const log = ctx.seam.log;
      expect(
        log.filter((entry) => entry.phase === "owner.confirmRunning").map((entry) => entry.ok),
      ).toEqual([true]);
      expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
      expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
      expect(ctx.attemptRows().map((row) => [row.state, row.exited])).toEqual([["running", null]]);
      expect(ctx.claims()).toEqual([{ generation: 1, state: "bound" }]);
      if (fault === "not-found")
        expect(log.find((entry) => entry.phase === "owner.confirmRemoved")).toMatchObject({
          ok: false,
          thrown: { name: "SqlError", message: "container_owner_invariant" },
        });
    } finally {
      ctx.fx.database.close();
    }
  });
}

test("a removal cancelled after the stop keeps the recorded running and records no exit", async () => {
  const ctx = await pendingStartFixture({ lifecycle: { abortAfterStop: true } });
  try {
    const created = await ctx.createFailedResource("pending-cancelled");
    await ctx.acceptDelete(created.resourceUid);

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = ctx.seam.log;
    expect(
      log.filter((entry) => entry.phase === "owner.confirmRunning").map((entry) => entry.ok),
    ).toEqual([true]);
    expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
    expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
    expect(ctx.attemptRows().map((row) => [row.state, row.exited])).toEqual([["running", null]]);
    expect(ctx.claims()).toEqual([{ generation: 1, state: "bound" }]);
  } finally {
    ctx.fx.database.close();
  }
});

test("a removal cancelled right after the running was recorded sends no stop, records no exit and deletes nothing", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("pending-cancelled-before-stop");

    const outcome = await ctx.inDeleteExecution(created.resourceUid, async (scope) => {
      const failure = await scope.removeCancelledAfterConfirmRunning();
      return { failure, rows: ctx.attemptRows() };
    });

    // The owner recorded the observation; the cancellation then stopped the custody before it
    // sent the stop (the daemon double does not look at signals, so a stop would show).
    expect(outcome.failure).toBeDefined();
    expect(outcome.rows.map((row) => [row.state, row.exited])).toEqual([["running", null]]);
    const log = ctx.seam.log;
    expect(
      log.filter((entry) => entry.phase === "owner.confirmRunning").map((entry) => entry.ok),
    ).toEqual([true]);
    expect(log.some((entry) => entry.phase === "engine.POST")).toBe(false);
    expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
    expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
    expect(ctx.containerStates()).toEqual([true]);
    expect(ctx.claims()).toEqual([{ generation: 1, state: "bound" }]);
  } finally {
    ctx.fx.database.close();
  }
});

test("an exit already recorded, then an external restart: the retry completes without a START, and confirmRunning never un-exits the attempt", async () => {
  const ctx = await pendingStartFixture({ lifecycle: { deleteFault: "refused" } });
  try {
    const created = await ctx.createFailedResource("pending-restarted");
    const accepted = await ctx.acceptDelete(created.resourceUid);
    const effectsBefore = ctx.nativeEffects();

    const first = await ctx.runDeleteOnce();

    // confirmRunning, the stop and the exit were recorded; the first DELETE never reached the daemon.
    expect(first).toMatchObject({ status: "reconciling", effect: "unknown" });
    const [recorded] = ctx.attemptRows();
    expect(recorded?.state).toBe("exited");
    expect(ctx.docker.containers.size).toBe(1);
    // Outside this system the object is started again (no START is sent by this system).
    ctx.restartExternally();
    expect(ctx.containerStates()).toEqual([true]);
    ctx.waitForRetry(accepted.id);

    const second = await ctx.runDeleteOnce();

    expect(second).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(ctx.attemptRows()[0]).toEqual(recorded as NonNullable<typeof recorded>);
    expect(ctx.claims()).toEqual([{ generation: 1, state: "removed" }]);
    expect(ctx.docker.containers.size).toBe(0);
    expect(ctx.nativeEffects()).toEqual(effectsBefore);
  } finally {
    ctx.fx.database.close();
  }
});

test("the owner refuses forged confirmRunning observations under a real held remove authority, then accepts a well-formed one once and idempotently", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("owner-forged");
    const forgeries: readonly [string, (scope: OwnerScope) => unknown][] = [
      ["another native ID", (s) => running(s, { nativeId: "f".repeat(64) })],
      ["identity label", (s) => running(s, { identityLabel: DIGEST })],
      ["revision label", (s) => running(s, { revisionLabel: DIGEST })],
      ["incarnation", (s) => running(s, { incarnationId: "other-incarnation" })],
      ["revision", (s) => running(s, { revision: `1-${"f".repeat(64)}` })],
      ["installation", (s) => running(s, { installationId: "other-installation" })],
      ["resource", (s) => running(s, { resourceUid: "00000000-0000-4000-8000-000000000000" })],
      ["native with an extra key", (s) => running(s, { extra: 1 })],
      ["stopped state", (s) => ({ native: s.native(), state: "stopped" })],
      ["extra key", (s) => ({ native: s.native(), state: "running", granted: true })],
      ["no native", () => ({ state: "running" })],
      ["not an object", () => null],
    ];

    const outcome = await ctx.inDeleteExecution(created.resourceUid, (scope) =>
      scope.held(async () => {
        const refused: Record<string, string> = {};
        for (const [name, forge] of forgeries) {
          try {
            await scope.owner.confirmRunning(scope.record, forge(scope) as never);
            refused[name] = "accepted";
          } catch (error) {
            refused[name] = errorName(error);
          }
        }
        const afterForgeries = ctx.attemptRows().map((row) => [row.state, row.running]);
        const beforeCall = Date.now();
        await scope.owner.confirmRunning(scope.record, running(scope));
        const [recorded] = ctx.attemptRows();
        await scope.owner.confirmRunning(scope.record, running(scope));
        const [repeated] = ctx.attemptRows();
        return {
          refused,
          afterForgeries,
          recorded,
          repeated,
          claimed: scope.claimedAtMs,
          beforeCall,
        };
      }),
    );

    expect(outcome.refused).toEqual(Object.fromEntries(forgeries.map(([name]) => [name, REFUSED])));
    expect(outcome.afterForgeries).toEqual([["pending", null]]);
    expect(outcome.recorded?.state).toBe("running");
    expect(outcome.recorded?.running as number).toBeGreaterThanOrEqual(outcome.claimed as number);
    // The recorded time is the owner time of the observation, not the claim time.
    expect(outcome.recorded?.running as number).toBeGreaterThanOrEqual(outcome.beforeCall);
    expect(outcome.recorded?.exited).toBeNull();
    // The exact observation again changes nothing (not even the confirmed time).
    expect(outcome.repeated).toEqual(outcome.recorded as NonNullable<typeof outcome.recorded>);
    expect(ctx.instance()).toMatchObject({ serving: null });
  } finally {
    ctx.fx.database.close();
  }
});

test("the owner refuses confirmRunning without its own held remove authority: none, ended, or the wrong phase", async () => {
  const ctx = await pendingStartFixture();
  try {
    let duringCreate: Record<string, string> | undefined;
    const created = await ctx.createFailedResource("owner-authority", async (scope) => {
      // Lawful OBSERVE authority on the failed, not deleted generation: not a remove authority.
      const result: Record<string, string> = {};
      try {
        await scope.owner.withAuthority(scope.record, "observe", async () =>
          scope.owner.confirmRunning(scope.record, running(scope)),
        );
        result.observe = "accepted";
      } catch (error) {
        result.observe = errorName(error);
      }
      try {
        await scope.owner.confirmRunning(scope.record, running(scope));
        result.none = "accepted";
      } catch (error) {
        result.none = errorName(error);
      }
      duringCreate = result;
    });
    expect(duringCreate).toEqual({ observe: REFUSED, none: REFUSED });
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);

    const outcome = await ctx.inDeleteExecution(created.resourceUid, async (scope) => {
      const result: Record<string, string> = {};
      try {
        await scope.owner.confirmRunning(scope.record, running(scope));
        result.outside = "accepted";
      } catch (error) {
        result.outside = errorName(error);
      }
      await scope.held(async () => undefined);
      try {
        await scope.owner.confirmRunning(scope.record, running(scope));
        result.ended = "accepted";
      } catch (error) {
        result.ended = errorName(error);
      }
      return result;
    });

    expect(outcome).toEqual({ outside: REFUSED, ended: REFUSED });
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
  } finally {
    ctx.fx.database.close();
  }
});

test("the attempt only moves forward: running, exited, and a later running observation never un-exits it", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("owner-forward-only");

    const outcome = await ctx.inDeleteExecution(created.resourceUid, (scope) =>
      scope.held(async () => {
        const beforeCall = Date.now();
        await scope.owner.confirmRunning(scope.record, running(scope));
        const [first] = ctx.attemptRows();
        await scope.owner.confirmStopped(scope.record, stopped(scope));
        const [exited] = ctx.attemptRows();
        await scope.owner.confirmRunning(scope.record, running(scope));
        const [afterRunning] = ctx.attemptRows();
        await scope.owner.confirmStopped(scope.record, stopped(scope));
        const [afterStopped] = ctx.attemptRows();
        return { first, exited, afterRunning, afterStopped, beforeCall };
      }),
    );

    expect(outcome.first?.state).toBe("running");
    expect(outcome.first?.running as number).toBeGreaterThanOrEqual(outcome.beforeCall);
    expect(outcome.exited?.state).toBe("exited");
    expect(outcome.exited?.running).toBe(outcome.first?.running as number);
    expect(outcome.exited?.exited as number).toBeGreaterThanOrEqual(
      outcome.first?.running as number,
    );
    // An exited attempt contradicts a running object only as a restart, which is not this
    // attempt's fact: the observation is not recorded and the exit stays as it was.
    expect(outcome.afterRunning).toEqual(outcome.exited as NonNullable<typeof outcome.exited>);
    expect(outcome.afterStopped).toEqual(outcome.exited as NonNullable<typeof outcome.exited>);
  } finally {
    ctx.fx.database.close();
  }
});

test("a clock behind the claim time cannot record a running time before the claim", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("owner-clock-behind");

    const outcome = await ctx.inDeleteExecution(created.resourceUid, (scope) =>
      scope.held(async () => {
        const claimed = scope.claimedAtMs as number;
        // The owner's clock reads new Date(): move the system clock behind the claim.
        setSystemTime(new Date(claimed - 5_000));
        try {
          await scope.owner.confirmRunning(scope.record, running(scope));
        } finally {
          setSystemTime();
        }
        const [recorded] = ctx.attemptRows();
        await scope.owner.confirmStopped(scope.record, stopped(scope));
        const [exited] = ctx.attemptRows();
        return { claimed, recorded, exited };
      }),
    );

    // Clamped to the claim time: the schema's running >= claimed holds, and the exit follows it.
    expect(outcome.recorded?.state).toBe("running");
    expect(outcome.recorded?.running).toBe(outcome.claimed);
    expect(outcome.exited?.state).toBe("exited");
    expect(outcome.exited?.exited as number).toBeGreaterThanOrEqual(outcome.claimed);
  } finally {
    setSystemTime();
    ctx.fx.database.close();
  }
});

test("a running object with no START claim at all has no attempt to confirm: nothing is written", async () => {
  const ctx = await pendingStartFixture({ neverStarted: true });
  try {
    const created = await ctx.createFailedResource("owner-no-attempt");
    expect(ctx.attemptRows()).toEqual([]);

    const outcome = await ctx.inDeleteExecution(created.resourceUid, (scope) =>
      scope.held(async () => {
        await scope.owner.confirmRunning(scope.record, running(scope));
        return ctx.attemptRows();
      }),
    );

    expect(outcome).toEqual([]);
  } finally {
    ctx.fx.database.close();
  }
});

test("a remove authority exists only for a retired or drained generation: the failed, not deleted CREATE gets observe but not remove", async () => {
  const ctx = await pendingStartFixture();
  try {
    await ctx.createFailedResource("pending-lease-contrast");

    // Asked inside a real execution of the failed CREATE, after its failure.
    expect(ctx.evidence.grants).toEqual({
      observe: "granted",
      remove: "refused:Docker Core owner authority refused",
    });
    // So the remove-phase observation cannot resolve an ordinary failed CREATE; it is reachable
    // only once a DELETE (or a cutover) has retired the generation.
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
  } finally {
    ctx.fx.database.close();
  }
});
