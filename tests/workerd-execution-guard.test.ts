import { expect, test } from "bun:test";
import {
  createWorkerdExecutionGuard,
  type WorkerdExecutionRegistration,
  type WorkerdExecutionServiceGateway,
  type WorkerdGuardProcess,
} from "../src/workerd-execution-guard.ts";

const registration: WorkerdExecutionRegistration = {
  identity: "a".repeat(64),
  deadlineAt: 30_000,
  until: 10_000,
};

const gateway = (index: number): WorkerdExecutionServiceGateway => ({
  listenPath: `/private/run/s${index}.sock`,
  upstreamPath: `/private/shared/${index.toString(16).padStart(64, "0")}.sock`,
  unavailableToken: "b".repeat(64),
});

function fixture(
  timeout = 1_000,
  journal?: { token: string; onMarker: (sequence: number) => void },
) {
  const frames: Record<string, unknown>[] = [];
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let ended = 0;
  let killed = 0;
  const waiting = new Map<number, (() => void)[]>();
  const process: WorkerdGuardProcess = {
    stdout: new ReadableStream({
      start(controller) {
        output = controller;
      },
    }),
    exited: new Promise((resolve) => {
      exit = resolve;
    }),
    write: async (frame) => {
      const value = JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>;
      frames.push(value);
      for (const resolve of waiting.get(value.id as number) ?? []) resolve();
      waiting.delete(value.id as number);
    },
    end: () => {
      ended += 1;
    },
    kill: () => {
      killed += 1;
    },
  };
  const guard = createWorkerdExecutionGuard({
    registration: { ...registration, ...(journal ? { journalToken: journal.token } : {}) },
    ...(journal ? { onJournalMarker: journal.onMarker } : {}),
    commandTimeoutMs: timeout,
    spawn: () => process,
  });
  const raw = (text: string) => output.enqueue(new TextEncoder().encode(text));
  const sent = (id: number) => {
    if (frames.some((frame) => frame.id === id)) return Promise.resolve();
    return new Promise<void>((resolve) => waiting.set(id, [...(waiting.get(id) ?? []), resolve]));
  };
  const reply = async (id: number, kind: string) => {
    await sent(id);
    raw(`${JSON.stringify({ id, kind })}\n`);
  };
  return {
    guard,
    frames,
    raw,
    reply,
    sent,
    exit,
    eof: () => output.close(),
    ended: () => ended,
    killed: () => killed,
  };
}

test("registration is paused; start, renewal and stop preserve ordered identity frames", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  expect(f.frames).toEqual([{ id: 1, op: "register", ...registration }]);

  const start = f.guard.start("/private/run.capnp");
  await Promise.resolve();
  await f.reply(2, "started");
  await start;
  const renew = f.guard.extendDeadline(20_000);
  await Promise.resolve();
  await f.reply(3, "extended");
  await renew;
  const stop = f.guard.stop();
  await Promise.resolve();
  expect(f.ended()).toBe(0);
  await f.reply(4, "stopped");
  await stop;
  expect(f.frames.map((frame) => frame.op)).toEqual(["register", "start", "extend", "stop"]);
  expect(f.frames.every((frame) => frame.identity === registration.identity)).toBe(true);
  expect(f.ended()).toBe(1);
  expect(f.killed()).toBe(0);
  f.exit(0);
  f.eof();
});

test("service gateways use bounded ordered frames before the unchanged START frame", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  const firstGateway = gateway(1);
  const secondGateway = gateway(2);
  const gateways = [firstGateway, secondGateway];
  const start = f.guard.start("/private/run/workerd.capnp", gateways);

  await f.sent(2);
  expect(f.frames).toHaveLength(2);
  expect(f.frames[1]).toEqual({
    id: 2,
    op: "gateway",
    identity: registration.identity,
    ...firstGateway,
  });
  await f.reply(2, "configured");
  await f.sent(3);
  expect(f.frames[2]).toEqual({
    id: 3,
    op: "gateway",
    identity: registration.identity,
    ...secondGateway,
  });
  await f.reply(3, "configured");
  await f.sent(4);
  expect(f.frames[3]).toEqual({
    id: 4,
    op: "start",
    identity: registration.identity,
    configPath: "/private/run/workerd.capnp",
  });
  await f.reply(4, "started");
  await start;
  const stop = f.guard.stop();
  await f.reply(5, "stopped");
  await stop;
  f.eof();
  f.exit(0);
});

test("the full 64-binding manifest stays below both frame and pending bounds", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  const gateways = Array.from({ length: 64 }, (_, index) => gateway(index));
  const start = f.guard.start("/private/run/workerd.capnp", gateways);
  for (let index = 0; index < gateways.length; index += 1) {
    const id = index + 2;
    await f.reply(id, "configured");
    expect(
      new TextEncoder().encode(`${JSON.stringify(f.frames[id - 1])}\n`).length,
    ).toBeLessThanOrEqual(16 * 1_024);
  }
  await f.reply(66, "started");
  await start;
  expect(f.frames.map((frame) => frame.op)).toEqual([
    "register",
    ...Array.from({ length: 64 }, () => "gateway"),
    "start",
  ]);
  const stop = f.guard.stop();
  await f.reply(67, "stopped");
  await stop;
  f.eof();
  f.exit(0);
});

test("STOP preempts pending gateway configuration without sending START", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  const start = f.guard
    .start("/private/run/workerd.capnp", [gateway(1), gateway(2)])
    .catch((error: Error) => error.message);
  await f.sent(2);
  const stop = f.guard.stop();
  await f.reply(3, "stopped");
  await stop;
  expect(await start).toBe("stopped");
  expect(f.frames.map((frame) => frame.op)).toEqual(["register", "gateway", "stop"]);
  expect(f.killed()).toBe(0);
  f.eof();
  f.exit(0);
});

test("every service gateway is validated before the first configuration frame", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  const valid = gateway(1);
  const invalidSets: readonly (readonly WorkerdExecutionServiceGateway[])[] = [
    [valid, { ...gateway(2), listenPath: valid.listenPath }],
    [{ ...valid, listenPath: "/private/run/run.sock" }],
    [{ ...valid, listenPath: "relative.sock" }],
    [{ ...valid, upstreamPath: "/private/shared/router.sock" }],
    [{ ...valid, unavailableToken: "B".repeat(64) }],
    [{ ...valid, listenPath: `/private/run/${"é".repeat(50)}.sock` }],
    Array.from({ length: 65 }, (_, index) => gateway(index)),
  ];
  for (const gateways of invalidSets) {
    await expect(f.guard.start("/private/run/workerd.capnp", gateways)).rejects.toThrow(
      "invalid_input",
    );
    expect(f.frames.map((frame) => frame.op)).toEqual(["register"]);
  }
  await expect(
    f.guard.start("/private/run/workerd.capnp", [
      { ...valid, extra: true } as WorkerdExecutionServiceGateway,
    ]),
  ).rejects.toThrow("invalid_input");
  expect(f.frames.map((frame) => frame.op)).toEqual(["register"]);
  const stop = f.guard.stop();
  await f.reply(2, "stopped");
  await stop;
  f.eof();
  f.exit(0);
});

test("stop during registration never permits a later start or renewal", async () => {
  const f = fixture();
  const stop = f.guard.stop();
  expect(f.guard.stop()).toBe(stop);
  await expect(f.guard.start("/private/run.capnp")).rejects.toThrow("stopped");
  await expect(f.guard.extendDeadline(20_000)).rejects.toThrow("stopped");
  await f.reply(1, "registered");
  await f.guard.registered;
  await f.reply(2, "stopped");
  await stop;
  expect(f.frames.map((frame) => frame.op)).toEqual(["register", "stop"]);
  f.eof();
  f.exit(0);
});

test("transport exit or EOF is not a stop acknowledgement", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  const stop = f.guard.stop();
  f.exit(0);
  f.eof();
  await expect(stop).rejects.toThrow("unavailable");
  expect(f.killed()).toBe(1);
});

test("buffered stopped ACK is accepted even when exit resolves before the reader", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  const stop = f.guard.stop();
  f.exit(0);
  await f.reply(2, "stopped");
  f.eof();
  await stop;
  expect(f.killed()).toBe(0);
});

test("stop reply before registration cannot clear a pending execution", async () => {
  const f = fixture();
  const stop = f.guard.stop();
  await f.reply(2, "stopped");
  await expect(stop).rejects.toThrow("protocol_failure");
  await expect(f.guard.registered).rejects.toThrow("protocol_failure");
  expect(f.killed()).toBe(1);
  f.eof();
  f.exit(1);
});

test("reaped STOP may overtake START and cancels its unresolved promise", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  const start = f.guard.start("/private/run.capnp").catch((error: Error) => error.message);
  const renewal = f.guard.extendDeadline(20_000).catch((error: Error) => error.message);
  const stop = f.guard.stop();
  await f.reply(4, "stopped");
  await stop;
  expect(await start).toBe("stopped");
  expect(await renewal).toBe("stopped");
  expect(f.killed()).toBe(0);
  f.eof();
  f.exit(0);
});

test("a rejected lease renewal is infrastructure failure, never a fresh deadline", async () => {
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  const renewal = f.guard.extendDeadline(20_000);
  await f.sent(2);
  f.raw('{"id":2,"kind":"error","code":"expired"}\n');
  await expect(renewal).rejects.toThrow("protocol_failure");
  await expect(f.guard.stop()).rejects.toThrow("protocol_failure");
  expect(f.killed()).toBe(1);
  f.eof();
  f.exit(1);
});

test("bounded decoder accepts fragmented and coalesced replies", async () => {
  const f = fixture();
  const stop = f.guard.stop();
  await f.sent(2);
  f.raw('{"id":1,"kind":"regis');
  f.raw('tered"}\n{"id":2,"kind":"stopped"}\n');
  await f.guard.registered;
  await stop;
  f.eof();
  f.exit(0);
});

test("oversized, newline-free protocol output fails closed", async () => {
  const f = fixture();
  f.raw("x".repeat(16 * 1_024 + 1));
  await expect(f.guard.registered).rejects.toThrow("protocol_failure");
  expect(f.killed()).toBe(1);
  f.eof();
  f.exit(1);
});

test("command timeout rejects instead of inventing stop proof", async () => {
  const f = fixture(20);
  await f.reply(1, "registered");
  await f.guard.registered;
  await expect(f.guard.stop()).rejects.toThrow("unavailable");
  expect(f.killed()).toBe(1);
  f.eof();
  f.exit(1);
});

test("input validation precedes spawn and invalid renewal is never sent", async () => {
  let spawns = 0;
  expect(() =>
    createWorkerdExecutionGuard({
      registration: { ...registration, identity: "wrong" },
      spawn: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    }),
  ).toThrow("invalid_input");
  expect(spawns).toBe(0);
  const f = fixture();
  await f.reply(1, "registered");
  await f.guard.registered;
  await expect(f.guard.extendDeadline(9_999)).rejects.toThrow("invalid_input");
  await expect(f.guard.extendDeadline(30_001)).rejects.toThrow("invalid_input");
  await expect(f.guard.start("relative.capnp")).rejects.toThrow("invalid_input");
  const stop = f.guard.stop();
  await f.reply(2, "stopped");
  await stop;
  expect(f.frames.map((frame) => frame.op)).toEqual(["register", "stop"]);
  f.eof();
  f.exit(0);
});

test("journal markers are synchronously latched before an overtaking STOP ACK", async () => {
  const markers: number[] = [];
  const f = fixture(1_000, {
    token: "b".repeat(64),
    onMarker: (sequence) => {
      markers.push(sequence);
    },
  });
  await f.reply(1, "registered");
  await f.guard.registered;
  expect(f.frames[0]?.journalToken).toBe("b".repeat(64));
  const start = f.guard.start("/private/run.capnp").catch((error: Error) => error.message);
  const stop = f.guard.stop();
  await f.sent(3);
  f.raw(
    '{"kind":"journal","sequence":1}\n{"kind":"journal","sequence":2}\n{"id":3,"kind":"stopped"}\n',
  );
  await stop;
  expect(markers).toEqual([1, 2]);
  expect(await start).toBe("stopped");
  expect(f.killed()).toBe(0);
  f.eof();
  f.exit(0);
});

test("a journal gap, duplicate, unrequested profile or malformed marker cannot acknowledge stop", async () => {
  for (const mode of ["gap", "duplicate", "extra", "unrequested", "before-start"] as const) {
    const f = fixture(
      1_000,
      mode === "unrequested" ? undefined : { token: "b".repeat(64), onMarker: () => {} },
    );
    await f.reply(1, "registered");
    await f.guard.registered;
    if (mode !== "before-start") {
      const start = f.guard.start("/private/run.capnp");
      await f.reply(2, "started");
      await start;
    }
    const stop = f.guard.stop();
    await f.sent(mode === "before-start" ? 2 : 3);
    if (mode === "duplicate") f.raw('{"kind":"journal","sequence":1}\n');
    f.raw(
      `${JSON.stringify({ kind: "journal", sequence: mode === "gap" ? 2 : 1, ...(mode === "extra" ? { id: 1 } : {}) })}\n`,
    );
    await expect(stop).rejects.toThrow("protocol_failure");
    expect(f.killed()).toBe(1);
    f.eof();
    f.exit(1);
  }
});

test("failed or asynchronous marker bookkeeping rejects the guard session", async () => {
  for (const onMarker of [
    () => {
      throw new Error("sink failed");
    },
    async () => {},
  ]) {
    const f = fixture(1_000, { token: "b".repeat(64), onMarker });
    await f.reply(1, "registered");
    await f.guard.registered;
    const start = f.guard.start("/private/run.capnp");
    await f.reply(2, "started");
    await start;
    const stop = f.guard.stop();
    await f.sent(3);
    f.raw('{"kind":"journal","sequence":1}\n');
    await expect(stop).rejects.toThrow("protocol_failure");
    f.eof();
    f.exit(1);
  }
});

test("journal token and synchronous observer must be selected together before spawn", () => {
  for (const option of [
    { registration: { ...registration, journalToken: "b".repeat(64) } },
    { registration, onJournalMarker: () => {} },
    { registration: { ...registration, journalToken: "invalid" }, onJournalMarker: () => {} },
  ]) {
    let spawned = false;
    expect(() =>
      createWorkerdExecutionGuard({
        ...option,
        spawn: () => {
          spawned = true;
          throw new Error("must not spawn");
        },
      }),
    ).toThrow("invalid_input");
    expect(spawned).toBe(false);
  }
});
