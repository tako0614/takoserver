import { expect, test } from "bun:test";
import {
  type ControlEvidence,
  pendingStartFixture,
} from "./helpers/docker-container-pending-start-observation.ts";

// PROBE (proposal-only): can a pending (never-confirmed) start attempt be resolved by a fresh,
// exact-native-ID, positive Running=true observation made under the held remove authority,
// recorded as the schema's own pending -> running WITHOUT publishing serving, so that the
// delivered observed-stop exit (stop -> Running=false -> confirmStopped -> DELETE ->
// confirmRemoved) can then complete?
//
// Contract trace (source, read-only):
// - Schema. start_transition allows pending -> running -> exited and nothing else; its WHERE has
//   no phase, retention or serving condition. The CHECK needs confirmed_running_at_ms before an
//   attempt can be exited, so a pending attempt can NEVER go to exited directly: running is the
//   schema's mandatory intermediate fact. instance_transition makes a running attempt the
//   precondition of serving_generation, i.e. running is a precondition of serving, not serving.
//   The owner-schema tests record running for a generation before it serves and for a draining
//   generation.
// - Owner. Only publishServing writes pending -> running today, in the same batch that switches
//   the serving generation, and only for the desired, non-retired generation; the remove
//   authority needs a retired instance or a non-desired, non-serving, draining/retired revision,
//   so the two are disjoint: nothing a remove-phase recording writes can ever be consumed by
//   publishServing. Nothing reads running as "healthy": the readers are the removal blocker
//   (create_transition), startState (running -> "claimed", pending -> "unknown", which every
//   runtime preparation treats the same: readback, never a START) and the serving generation's
//   own confirmed time in readAcceptedExecution.
// - Facts the test cannot invent: a pending attempt whose object never ran (Running=false at
//   every observation) or is absent has no positive running fact and stays refused.
//
// The only product write of this file's control is the schema-legal transition itself, executed
// by TEST code at the moment the custody sends the stop, and only after the custody's own
// exact-ID inspect of that ID returned Running=true. It is a diagnostic control, not producer
// authority; the current product API cannot do it.

const claimedOf = (evidence: ControlEvidence | undefined) => evidence?.claimedAtMs ?? -1;

test("same input WITHOUT the control: a physically running, health-failed pending attempt is refused (RED)", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("pending-running-red");
    // Physically running (the daemon started it) while the START is still only claimed and
    // serving was never published.
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
    expect(ctx.containerStates()).toEqual([true]);
    expect(ctx.instance()).toMatchObject({ desired: 1, serving: null, retired: 0 });
    await ctx.acceptDelete(created.resourceUid);

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = ctx.seam.log;
    // The custody observed the exact ID running, stopped it, saw it stopped, and the owner
    // refused to record an exit for an attempt that was never confirmed running.
    expect(
      log.filter((entry) => entry.phase === "observation.exactID").map((e) => e.state),
    ).toEqual(["Running=true", "Running=false"]);
    expect(log.find((entry) => entry.phase === "owner.confirmStopped")).toMatchObject({
      ok: false,
      thrown: { name: "TypeError", message: "Docker Core owner authority refused" },
    });
    expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
    expect(ctx.claims()).toEqual([{ generation: 1, state: "bound" }]);
    expect(ctx.docker.containers.size).toBe(1);
  } finally {
    ctx.fx.database.close();
  }
});

test("same input WITH the control (a positive Running=true observation recorded as pending -> running before the stop): the delivered exit and removal complete and serving is never published (PASS)", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("pending-running-pass");
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
    expect(ctx.containerStates()).toEqual([true]);
    await ctx.acceptDelete(created.resourceUid);
    const effectsBefore = {
      creates: ctx.docker.creates().length,
      starts: ctx.docker.starts().length,
    };
    ctx.armRunningRecordingControl();

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "succeeded", effect: "complete" });
    // The control fired once, after the positive observation, and wrote only the attempt.
    expect(ctx.evidence.control).toMatchObject({ changes: 1, othersUnchanged: true });
    expect(ctx.evidence.controlRefusal).toBeUndefined();
    // Order under the real held remove authority: granted, positive observation, the control,
    // the stop, the second observation (stopped), the owner's exit record, the DELETE, the
    // exact-ID absence and the claim removal.
    const steps = ctx.seam.log
      .filter((entry) =>
        [
          "owner.withAuthority:granted",
          "observation.exactID",
          "control.runningRecordedByTest",
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
            : entry.phase === "owner.confirmStopped" || entry.phase === "owner.confirmRemoved"
              ? `${entry.phase}:${entry.ok}`
              : entry.phase,
      );
    expect(steps).toEqual([
      "granted:remove",
      "observed:Running=true",
      "control.runningRecordedByTest",
      "engine.POST",
      "observed:Running=false",
      "owner.confirmStopped:true",
      "engine.DELETE",
      "owner.confirmRemoved:true",
    ]);
    const [row] = ctx.attemptRows();
    expect(ctx.attemptRows()).toHaveLength(1);
    expect(row?.state).toBe("exited");
    // Monotonic: claimed <= running (the observation time) <= exited (the stopped observation).
    expect(row?.running as number).toBeGreaterThanOrEqual(claimedOf(ctx.evidence.control));
    expect(row?.exited as number).toBeGreaterThanOrEqual(row?.running as number);
    // Serving was never published and nothing was started or created again.
    expect(ctx.instance()).toMatchObject({ desired: 2, serving: null, retired: 1 });
    expect(ctx.retention()).toEqual(["retired"]);
    expect(ctx.claims()).toEqual([{ generation: 1, state: "removed" }]);
    expect(ctx.docker.containers.size).toBe(0);
    expect({ creates: ctx.docker.creates().length, starts: ctx.docker.starts().length }).toEqual(
      effectsBefore,
    );
    expect(ctx.resource()).toEqual([{ phase: "idle", deleted: 1, busy: 0 }]);
  } finally {
    ctx.fx.database.close();
  }
});

test("never observed running: a pending attempt whose object never ran has no positive fact and stays refused (the control refuses to write)", async () => {
  const ctx = await pendingStartFixture({ startRefused: true });
  try {
    const created = await ctx.createFailedResource("pending-never-ran");
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
    expect(ctx.containerStates()).toEqual([false]);
    await ctx.acceptDelete(created.resourceUid);
    ctx.armRunningRecordingControl();

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = ctx.seam.log;
    // Every exact-ID observation says Running=false: there is no stop to send and the control
    // never even gets its moment.
    expect(
      log
        .filter((entry) => entry.phase === "observation.exactID")
        .every((e) => e.state === "Running=false"),
    ).toBe(true);
    expect(log.some((entry) => entry.phase === "engine.POST")).toBe(false);
    expect(ctx.evidence.control).toBeUndefined();
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

test("not covered by a Running=true observation: a pending attempt whose process ran and then exited looks like never-ran at the port and stays refused", async () => {
  const ctx = await pendingStartFixture();
  try {
    const created = await ctx.createFailedResource("pending-ran-then-exited");
    expect(ctx.containerStates()).toEqual([true]);
    // The process exits on its own before anyone looks (test-side): the daemon now reports
    // Running=false. The current inspect carries only State.Running, so nothing distinguishes
    // this from an object that never ran; a real daemon also reports StartedAt/Status, which no
    // port in this change set reads.
    for (const [name, container] of ctx.docker.containers)
      ctx.docker.containers.set(name, { ...container, State: { Running: false } });
    expect(ctx.containerStates()).toEqual([false]);
    await ctx.acceptDelete(created.resourceUid);
    ctx.armRunningRecordingControl();

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = ctx.seam.log;
    expect(
      log
        .filter((entry) => entry.phase === "observation.exactID")
        .every((entry) => entry.state === "Running=false"),
    ).toBe(true);
    expect(ctx.evidence.control).toBeUndefined();
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

test("never observed running: a pending attempt whose object is already absent has no positive fact and stays refused", async () => {
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
    ctx.armRunningRecordingControl();

    const result = await ctx.runDeleteOnce();

    expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    const log = ctx.seam.log;
    expect(log.some((entry) => entry.phase === "observation.exactID")).toBe(false);
    expect(ctx.evidence.control).toBeUndefined();
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

for (const stopOutcome of ["not-found", "timeout"] as const) {
  test(`a recorded running is not an exit: after the control, a stop that ends in ${stopOutcome} leaves the attempt running and refused`, async () => {
    const ctx = await pendingStartFixture();
    try {
      const created = await ctx.createFailedResource(`pending-${stopOutcome}`);
      await ctx.acceptDelete(created.resourceUid);
      ctx.armRunningRecordingControl(stopOutcome);

      const result = await ctx.runDeleteOnce();

      expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
      // The positive observation was made and recorded as running; the stop gave no positive
      // Running=false, so no exit is recorded and nothing is deleted.
      expect(ctx.evidence.control).toMatchObject({ changes: 1, othersUnchanged: true });
      const log = ctx.seam.log;
      expect(log.some((entry) => entry.phase === "owner.confirmStopped")).toBe(false);
      expect(log.some((entry) => entry.phase === "engine.DELETE")).toBe(false);
      expect(ctx.attemptRows().map((row) => [row.state, row.exited])).toEqual([["running", null]]);
      expect(ctx.claims()).toEqual([{ generation: 1, state: "bound" }]);
      if (stopOutcome === "not-found")
        expect(log.find((entry) => entry.phase === "owner.confirmRemoved")).toMatchObject({
          ok: false,
          thrown: { name: "SqlError", message: "container_owner_invariant" },
        });
    } finally {
      ctx.fx.database.close();
    }
  });
}

test("a remove authority exists only for a retired or drained generation: the failed, not deleted CREATE gets observe but not remove", async () => {
  const ctx = await pendingStartFixture();
  try {
    await ctx.createFailedResource("pending-lease-contrast");

    // Asked inside a real execution of the failed CREATE, after its failure.
    expect(ctx.evidence.grants).toEqual({
      observe: "granted",
      remove: "refused:Docker Core owner authority refused",
    });
    // So a recorder that needs the held REMOVE authority cannot resolve an ordinary failed
    // CREATE; it is reachable only once a DELETE (or a cutover) has retired the generation.
    expect(ctx.attemptRows().map((row) => row.state)).toEqual(["pending"]);
  } finally {
    ctx.fx.database.close();
  }
});
