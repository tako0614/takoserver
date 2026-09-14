import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/ports.ts";
import {
  createWorkerdWorkflowExecutionHost,
  type PreparedWorkerdWorkflow,
} from "../src/selfhost-workflow-execution-host.ts";
import type {
  WorkerdExecutionGuard,
  WorkerdExecutionRegistration,
  WorkerdExecutionServiceGateway,
} from "../src/workerd-execution-guard.ts";
import type {
  WorkflowApplicationOutcome,
  WorkflowDriver,
  WorkflowRunIdentity,
} from "../src/workflow-execution.ts";

const identity: WorkflowRunIdentity = {
  scope: { tenantId: "tenant", workflowResourceUid: "workflow" },
  instanceId: "instance",
  executionId: "execution",
  createdAt: 10,
  epoch: 1,
  owner: "owner",
  deadlineAt: 1_000,
};
const driver: WorkflowDriver = {
  do: async () => undefined,
  sleep: async () => {},
  waitForEvent: async () => undefined,
  definitionMismatch: () => new Promise<never>(() => {}),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type WorkflowTransportChannel = {
  readonly journalToken: string;
  readonly recordPayload: (sequence: number, payload: string) => void;
};

/** Lifecycle proof only: no process or transport isolation is claimed here. */
function fixture(
  options: {
    capacity?: number;
    registered?: Promise<void>;
    exited?: Promise<number>;
    spawn?: () => void;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
    extend?: (until: number) => Promise<void>;
    prepare?: (
      id: WorkflowRunIdentity,
      input: JsonObject | undefined,
      signal: AbortSignal,
      channel: WorkflowTransportChannel,
    ) => Promise<PreparedWorkerdWorkflow>;
    acceptFrame?: (sequence: number, payload: string) => void;
    run?: () => Promise<WorkflowApplicationOutcome>;
    serviceGateways?: readonly WorkerdExecutionServiceGateway[];
    drain?: () => Promise<void>;
    dispose?: () => Promise<void>;
  } = {},
) {
  let time = 20;
  const events: string[] = [];
  const registrations: WorkerdExecutionRegistration[] = [];
  const journalMarkers: Array<(sequence: number) => void> = [];
  const channels: WorkflowTransportChannel[] = [];
  const preparedStarted = deferred<void>();
  const guardStarted = deferred<void>();
  const guardStopped = deferred<void>();
  const startedGateways: Array<readonly WorkerdExecutionServiceGateway[]> = [];
  const prepared: PreparedWorkerdWorkflow = {
    configPath: "/retained/execution.capnp",
    ...(options.serviceGateways === undefined ? {} : { serviceGateways: options.serviceGateways }),
    acceptFrame(sequence, payload) {
      options.acceptFrame?.(sequence, payload);
    },
    async run(actualDriver) {
      expect(actualDriver).toBe(driver);
      events.push("run");
      return options.run ? options.run() : { kind: "complete", output: { ok: true } };
    },
    async drainAfterStop() {
      events.push("drain");
      await options.drain?.();
    },
    async dispose() {
      events.push("dispose");
      await options.dispose?.();
    },
  };
  const host = createWorkerdWorkflowExecutionHost({
    guardBinary: "/retained/guard",
    workerdBinary: "/retained/workerd",
    maximumRegistrations: options.capacity ?? 4,
    clock: () => time,
    spawnGuard(registration, onJournalMarker): WorkerdExecutionGuard {
      options.spawn?.();
      events.push("register");
      registrations.push(registration);
      journalMarkers.push(onJournalMarker);
      return {
        registered: options.registered ?? Promise.resolve(),
        exited: options.exited ?? new Promise<number>(() => {}),
        async start(path, gateways) {
          expect(path).toBe(prepared.configPath);
          startedGateways.push(gateways ?? []);
          events.push("start");
          guardStarted.resolve();
          await options.start?.();
        },
        async extendDeadline(until) {
          events.push(`extend:${until}`);
          await options.extend?.(until);
        },
        async stop() {
          events.push("stop");
          guardStopped.resolve();
          await options.stop?.();
        },
      };
    },
    async prepare(id, input, signal, channel) {
      events.push("prepare");
      channels.push(channel);
      preparedStarted.resolve();
      return options.prepare ? options.prepare(id, input, signal, channel) : prepared;
    },
  });
  return {
    host,
    events,
    registrations,
    journalMarkers,
    channels,
    prepared,
    preparedStarted: preparedStarted.promise,
    guardStarted: guardStarted.promise,
    guardStopped: guardStopped.promise,
    startedGateways,
    time(value: number) {
      time = value;
    },
  };
}

describe("private guarded Workflow lifecycle", () => {
  test("forwards private service gateways to the guard before START and preserves disposal order", async () => {
    const gateway: WorkerdExecutionServiceGateway = {
      listenPath: "/tmp/workflow-service-listen.sock",
      upstreamPath: "/tmp/workflow-service-upstream.sock",
      unavailableToken: "b".repeat(64),
    };
    const f = fixture({ serviceGateways: [gateway] });
    const session = await f.host.openPaused(identity, undefined, 100);
    await expect(session.run(driver)).resolves.toEqual({
      kind: "complete",
      output: { ok: true },
    });
    expect(f.startedGateways).toEqual([[gateway]]);
    expect(await f.host.stop(identity, "complete")).toBe("stopped");
    expect(f.events).toEqual(["register", "prepare", "start", "run", "stop", "drain", "dispose"]);
  });

  test("registration is paused; selection/preparation happens only at run", async () => {
    const f = fixture();
    const session = await f.host.openPaused(identity, undefined, 100);
    expect(f.events).toEqual(["register"]);
    expect(f.registrations[0]).toMatchObject({ deadlineAt: 1_000, until: 100 });
    expect(f.registrations[0]?.identity).toMatch(/^[a-f0-9]{64}$/u);
    expect(await session.run(driver)).toEqual({ kind: "complete", output: { ok: true } });
    expect(await f.host.stop(identity, "complete")).toBe("stopped");
    expect(f.events).toEqual(["register", "prepare", "start", "run", "stop", "drain", "dispose"]);
    await expect(session.run(driver)).rejects.toThrow("stopped");
    await expect(session.extendDeadline(200)).rejects.toThrow("stopped");
    expect(await f.host.stop(identity, "complete")).toBe("stopped");
    expect(f.events.filter((event) => event === "stop")).toHaveLength(1);
  });

  test("binds one private token and accepts readiness frames before run", async () => {
    const start = deferred<void>();
    const accepted: Array<{ sequence: number; payload: string }> = [];
    const f = fixture({
      start: () => start.promise,
      acceptFrame: (sequence, payload) => accepted.push({ sequence, payload }),
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    const running = session.run(driver);
    await f.guardStarted;
    const registration = f.registrations[0];
    const channel = f.channels[0];
    expect(registration?.journalToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(channel?.journalToken).toBe(registration?.journalToken);
    f.journalMarkers[0]?.(1);
    channel?.recordPayload(1, "ready");
    expect(accepted).toEqual([{ sequence: 1, payload: "ready" }]);
    expect(f.events).not.toContain("run");
    start.resolve();
    await running;
    await expect(f.host.stop(identity, "complete")).resolves.toBe("stopped");
  });

  test("a marker without its companion rejects stop and prevents dispose", async () => {
    const f = fixture();
    const session = await f.host.openPaused(identity, undefined, 100);
    await session.run(driver);
    f.journalMarkers[0]?.(1);
    await expect(f.host.stop(identity, "complete")).rejects.toThrow("unpaired_frame");
    expect(f.events).not.toContain("dispose");
    expect(() => f.channels[0]?.recordPayload(1, "late")).toThrow("unpaired_frame");
  });

  test("a payload without its marker rejects stop and prevents dispose", async () => {
    const f = fixture();
    const session = await f.host.openPaused(identity, undefined, 100);
    await session.run(driver);
    f.channels[0]?.recordPayload(1, "orphan");
    await expect(f.host.stop(identity, "complete")).rejects.toThrow("unpaired_frame");
    expect(f.events).not.toContain("dispose");
    expect(() => f.journalMarkers[0]?.(1)).toThrow("unpaired_frame");
  });

  test("pre-start stop with no frames seals successfully without preparation", async () => {
    const f = fixture();
    await f.host.openPaused(identity, undefined, 100);
    await expect(f.host.stop(identity, "termination")).resolves.toBe("stopped");
    expect(f.events).toEqual(["register", "stop"]);
    expect(() => f.journalMarkers[0]?.(1)).toThrow("sealed");
  });

  test("preparation-time frame input fails closed before START", async () => {
    let observedChannel: WorkflowTransportChannel | undefined;
    const f = fixture({
      prepare: async (_id, _input, _signal, channel) => {
        observedChannel = channel;
        expect(() => channel.recordPayload(1, "too-early")).toThrow("invalid_frame");
        return f.prepared;
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    await expect(session.run(driver)).rejects.toThrow("invalid_frame");
    expect(observedChannel?.journalToken).toBe(f.registrations[0]?.journalToken);
    expect(f.events).not.toContain("start");
    expect(f.events).not.toContain("dispose");
  });

  test("stop observes opening registration and prevents application preparation", async () => {
    const registered = deferred<void>();
    const f = fixture({ registered: registered.promise });
    const opened = f.host.openPaused(identity, undefined, 100).catch((error: Error) => error);
    const stopped = f.host.stop(identity, "termination");
    await f.guardStopped;
    registered.resolve();
    expect(await stopped).toBe("stopped");
    expect(await opened).toMatchObject({ message: "stopped" });
    expect(f.events).toEqual(["register", "stop"]);
  });

  test("stop during preparation reaps immediately and never starts its late result", async () => {
    const preparation = deferred<PreparedWorkerdWorkflow>();
    let signal: AbortSignal | undefined;
    const f = fixture({
      prepare: async (_id, _input, value) => {
        signal = value;
        return preparation.promise;
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    const running = session.run(driver).catch((error: Error) => error);
    await f.preparedStarted;
    const stopped = f.host.stop(identity, "termination");
    await f.guardStopped;
    expect(signal?.aborted).toBe(true);
    expect(f.events).not.toContain("start");
    preparation.resolve(f.prepared);
    expect(await stopped).toBe("stopped");
    expect(await running).toMatchObject({ message: "stopped" });
    expect(f.events).toEqual(["register", "prepare", "stop", "drain", "dispose"]);
  });

  test("stop preempts unresolved START and a late start ACK cannot call run", async () => {
    const started = deferred<void>();
    const f = fixture({ start: () => started.promise });
    const session = await f.host.openPaused(identity, undefined, 100);
    const running = session.run(driver).catch((error: Error) => error);
    await f.guardStarted;
    expect(await f.host.stop(identity, "termination")).toBe("stopped");
    started.resolve();
    expect(await running).toMatchObject({ message: "stopped" });
    expect(f.events).not.toContain("run");
  });

  test("stop ACK waits for transport seal but never for a parked run promise", async () => {
    const drain = deferred<void>();
    const drainEntered = deferred<void>();
    const runEntered = deferred<void>();
    const f = fixture({
      run: () => {
        runEntered.resolve();
        return new Promise(() => {});
      },
      drain: () => {
        drainEntered.resolve();
        return drain.promise;
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    void session.run(driver);
    await runEntered.promise;
    let acknowledged = false;
    const stopped = f.host.stop(identity, "park").then(() => {
      acknowledged = true;
    });
    await drainEntered.promise;
    expect(acknowledged).toBe(false);
    expect(f.events).not.toContain("dispose");
    drain.resolve();
    await stopped;
    expect(acknowledged).toBe(true);
    expect(f.events.at(-1)).toBe("dispose");
  });

  test("failed physical stop preserves artifacts and never pretends to seal", async () => {
    const f = fixture({
      stop: async () => {
        throw new Error("no reap proof");
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    await session.run(driver);
    await expect(f.host.stop(identity, "complete")).rejects.toThrow("no reap proof");
    expect(f.events).not.toContain("drain");
    expect(f.events).not.toContain("dispose");
    await expect(session.run(driver)).rejects.toThrow("stopped");
  });

  test("failed seal retains artifacts; retry seals without restarting or reaping again", async () => {
    let attempts = 0;
    const f = fixture({
      drain: async () => {
        if (++attempts === 1) throw new Error("unaccounted frame");
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    await session.run(driver);
    await expect(f.host.stop(identity, "complete")).rejects.toThrow("unaccounted frame");
    expect(f.events).not.toContain("dispose");
    expect(await f.host.stop(identity, "complete")).toBe("stopped");
    expect(f.events.filter((event) => event === "stop")).toHaveLength(1);
    expect(f.events.filter((event) => event === "drain")).toHaveLength(2);
    expect(f.events.at(-1)).toBe("dispose");
  });

  test("cleanup retries after seal without reopening the sealed transport", async () => {
    let attempts = 0;
    const f = fixture({
      dispose: async () => {
        if (++attempts === 1) throw new Error("cleanup unavailable");
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    await session.run(driver);
    await expect(f.host.stop(identity, "complete")).rejects.toThrow("cleanup unavailable");
    expect(await f.host.stop(identity, "complete")).toBe("stopped");
    expect(f.events.filter((event) => event === "drain")).toHaveLength(1);
    expect(f.events.filter((event) => event === "dispose")).toHaveLength(2);
  });

  test("lost transport is an infrastructure rejection, not run_threw", async () => {
    const lost = new Error("transport lost");
    const f = fixture({
      run: async () => {
        throw lost;
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    await expect(session.run(driver)).rejects.toBe(lost);
    expect(await f.host.stop(identity, "run_failed")).toBe("stopped");
    expect(f.events.at(-1)).toBe("dispose");
  });

  test("input and full run identity are snapshotted before asynchronous registration", async () => {
    const input = { value: { selected: 1 } };
    const mutable = { ...identity, scope: { ...identity.scope } };
    let observed: unknown;
    const f = fixture({
      prepare: async (id, value) => {
        observed = { id, value };
        return f.prepared;
      },
    });
    const opening = f.host.openPaused(mutable, input, 100);
    mutable.owner = "changed";
    mutable.scope.tenantId = "changed";
    input.value = { selected: 2 };
    const session = await opening;
    await session.run(driver);
    expect(observed).toEqual({ id: identity, value: { value: { selected: 1 } } });
    expect(await f.host.stop(mutable, "termination")).toBe("not_registered");
    expect(await f.host.stop(identity, "termination")).toBe("stopped");
  });

  test("every incarnation/owner field participates in the registration identity", async () => {
    const f = fixture({ capacity: 10 });
    const variants = [
      identity,
      { ...identity, epoch: 2 },
      { ...identity, owner: "owner-2" },
      { ...identity, createdAt: 11 },
      { ...identity, executionId: "other-execution" },
      { ...identity, instanceId: "other-instance" },
      { ...identity, deadlineAt: 1_001 },
      { ...identity, scope: { ...identity.scope, tenantId: "other" } },
      { ...identity, scope: { ...identity.scope, workflowResourceUid: "other" } },
    ];
    for (const variant of variants) await f.host.openPaused(variant, undefined, 100);
    expect(new Set(f.registrations.map((item) => item.identity)).size).toBe(variants.length);
    await f.host.close();
  });

  test("a renewal ACK cannot resurrect a concurrent stop", async () => {
    const renewed = deferred<void>();
    const f = fixture({ extend: () => renewed.promise });
    const session = await f.host.openPaused(identity, undefined, 100);
    const renewing = session.extendDeadline(200).catch((error: Error) => error);
    expect(await f.host.stop(identity, "termination")).toBe("stopped");
    renewed.resolve();
    expect(await renewing).toMatchObject({ message: "stopped" });
    await expect(session.run(driver)).rejects.toThrow("stopped");
    await expect(f.host.openPaused(identity, undefined, 100)).rejects.toThrow("already_registered");
  });

  test("expired registrations refuse run/renew even before controller cleanup", async () => {
    const f = fixture();
    const session = await f.host.openPaused(identity, undefined, 100);
    f.time(100);
    await expect(session.run(driver)).rejects.toThrow("stopped");
    await expect(session.extendDeadline(200)).rejects.toThrow("stopped");
    expect(f.events).toEqual(["register"]);
    await f.host.close();
  });

  test("capacity is fail-closed; unknown identities alone return not_registered", async () => {
    const f = fixture({ capacity: 1 });
    await f.host.openPaused(identity, undefined, 100);
    const other = { ...identity, owner: "another-owner" };
    await expect(f.host.openPaused(other, undefined, 100)).rejects.toThrow("capacity");
    expect(await f.host.stop(other, "termination")).toBe("not_registered");
    await f.host.close();
    await expect(f.host.openPaused(other, undefined, 100)).rejects.toThrow("stopped");
  });

  test("a failed factory retains only a lease tombstone, not permanent capacity", async () => {
    let attempts = 0;
    const f = fixture({
      capacity: 1,
      spawn: () => {
        if (++attempts === 1) throw new Error("spawn failed before handle creation");
      },
    });
    await expect(f.host.openPaused(identity, undefined, 100)).rejects.toThrow("spawn failed");
    expect(await f.host.stop(identity, "lease_lost")).toBe("stopped");
    await expect(f.host.openPaused(identity, undefined, 100)).rejects.toThrow("already_registered");
    f.time(100);
    await f.host.openPaused({ ...identity, epoch: 2, owner: "new-claim" }, undefined, 200);
    expect(f.events).toEqual(["register"]);
    await f.host.close();
  });

  test("a never-started guard's observed exit can recover registration failure", async () => {
    const registered = deferred<void>();
    const exited = deferred<number>();
    const f = fixture({
      registered: registered.promise,
      exited: exited.promise,
      stop: async () => {
        throw new Error("guard unavailable");
      },
    });
    const opening = f.host.openPaused(identity, undefined, 100).catch((error: Error) => error);
    registered.reject(new Error("registration rejected"));
    expect(await opening).toMatchObject({ message: "registration rejected" });
    const stopped = f.host.stop(identity, "lease_lost");
    exited.resolve(1);
    expect(await stopped).toBe("stopped");
    expect(f.events).toEqual(["register", "stop"]);
  });

  test("guard exit after START never substitutes for reap/message proof", async () => {
    const f = fixture({
      exited: Promise.resolve(1),
      stop: async () => {
        throw new Error("child reap unknown");
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    await session.run(driver);
    await expect(f.host.stop(identity, "termination")).rejects.toThrow("child reap unknown");
    expect(f.events).not.toContain("drain");
    expect(f.events).not.toContain("dispose");
  });

  test("malformed preparation is rejected before application process start", async () => {
    const f = fixture({
      prepare: async () =>
        ({
          ...f.prepared,
          run: undefined,
        }) as unknown as PreparedWorkerdWorkflow,
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    await expect(session.run(driver)).rejects.toThrow("invalid_input");
    expect(await f.host.stop(identity, "run_failed")).toBe("stopped");
    expect(f.events).not.toContain("start");
    expect(f.events.at(-1)).toBe("dispose");
  });

  test("lost renewal ACK retains the tombstone through the requested deadline", async () => {
    const f = fixture({
      capacity: 1,
      extend: async () => {
        throw new Error("ACK lost");
      },
    });
    const session = await f.host.openPaused(identity, undefined, 100);
    await expect(session.extendDeadline(200)).rejects.toThrow("ACK lost");
    await f.host.stop(identity, "lease_lost");
    f.time(150);
    const successor = { ...identity, epoch: 2, owner: "new-claim" };
    await expect(f.host.openPaused(successor, undefined, 300)).rejects.toThrow("capacity");
    f.time(200);
    await f.host.openPaused(successor, undefined, 300);
    await f.host.close();
  });
});
