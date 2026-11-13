import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createLinuxOciPhysicalSession,
  type LinuxOciCancelObservation,
  type LinuxOciCreateStoppedRequest,
  type LinuxOciInitReapedObservation,
  type LinuxOciPhysicalSession,
  type LinuxOciStartedObservation,
  type LinuxOciStoppedObservation,
} from "../src/providers/linux-oci-physical-session.ts";

// Only raw spawn/stdio/events are doubled. No actual helper runs, and these
// private protocol samples establish no artifact/claim/namespace authority,
// actual init reap, network terminal, runtime deletion, readiness or serving.
const claim = "a".repeat(64);
const request: LinuxOciCreateStoppedRequest = {
  allocationRoot: "/synthetic/allocation",
  claimId: claim,
  installationId: "installation",
  resourceUid: "resource",
  incarnationId: "incarnation",
  generation: 1,
  revision: "revision",
  sourceDigest: `sha256:${"1".repeat(64)}`,
  manifestDigest: `sha256:${"2".repeat(64)}`,
  configDigest: `sha256:${"3".repeat(64)}`,
  archiveDigest: `sha256:${"4".repeat(64)}`,
  args: ["/app"],
  env: [],
  cwd: "/",
  uid: 0,
  gid: 0,
  memoryBytes: 1024,
  nanoCpus: 10_000_000,
  pidsLimit: 32,
};
const signal = () => new AbortController().signal;
const created = (namespaceDevice = 7, namespaceInode = 11): LinuxOciStoppedObservation => ({
  kind: "linux-oci-created-stopped@1",
  nativeId: claim,
  namespaceDevice,
  namespaceInode,
  barrier: "unproven",
});
const started = (): LinuxOciStartedObservation => ({
  kind: "linux-oci-started@1",
  nativeId: claim,
  namespaceDevice: 7,
  namespaceInode: 11,
  barrier: "unproven",
});
const reaped = (
  kind: LinuxOciInitReapedObservation["kind"] = "linux-oci-init-reaped@1",
): LinuxOciInitReapedObservation => ({
  kind,
  nativeId: claim,
  namespaceDevice: 7,
  namespaceInode: 11,
  pidNamespaceDevice: 13,
  pidNamespaceInode: 17,
  barrier: "unproven",
});
const cancelled = (): LinuxOciCancelObservation => ({
  kind: "linux-oci-cancel-observation@1",
  stage: "cancel",
  errno: 0,
  custody: "retained",
  barrier: "unproven",
});
const refused = (stage: "stop-init" | "join-init", errno = 11) => ({
  kind: "linux-oci-refused@1",
  stage,
  errno,
  custody: "retained",
  barrier: "unproven",
});
function frame(body: string | Uint8Array): Buffer {
  const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  const framed = Buffer.alloc(bytes.length + 4);
  framed.writeUInt32BE(bytes.length);
  bytes.copy(framed, 4);
  return framed;
}
function wireKind(data: Buffer): unknown {
  expect(data.readUInt32BE(0)).toBe(data.length - 4);
  return JSON.parse(data.subarray(4).toString()).kind;
}
function fixture(timeoutMs?: number) {
  const root = mkdtempSync("/root/dev/tmp/linux-oci-pidns-raw-");
  chmodSync(root, 0o700);
  const binary = join(root, "helper");
  writeFileSync(binary, "fixture never executed", { mode: 0o700 });
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const stdio: childProcess.ChildProcessWithoutNullStreams["stdio"] = [
    stdin,
    stdout,
    stderr,
    undefined,
    undefined,
  ];
  let kills = 0,
    unrefs = 0,
    ended = 0;
  const transport = Object.defineProperties(new childProcess.ChildProcess(), {
    stdin: { value: stdin, writable: true },
    stdout: { value: stdout, writable: true },
    stderr: { value: stderr, writable: true },
    stdio: { value: stdio, writable: true },
  });
  const child = Object.assign(transport, {
    stdin,
    stdout,
    stderr,
    stdio,
    kill() {
      kills++;
      return true;
    },
    unref() {
      unrefs++;
    },
  });
  const writes: Buffer[] = [];
  let action: ((data: Buffer) => void) | undefined;
  stdin.on("data", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
    action?.(chunk);
  });
  stdin.on("finish", () => ended++);
  const raw = spyOn(childProcess, "spawn").mockReturnValue(child);
  return {
    binary,
    child,
    writes,
    raw,
    counts: () => ({ kills, unrefs, ended }),
    onWrite(callback: (data: Buffer) => void) {
      action = callback;
    },
    reply(value: unknown) {
      stdout.write(frame(JSON.stringify(value)));
    },
    bytes(value: Uint8Array) {
      stdout.write(value);
    },
    eof() {
      stdout.end();
    },
    open() {
      return createLinuxOciPhysicalSession({
        binary,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
    cleanup() {
      raw.mockRestore();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function create(f: ReturnType<typeof fixture>, session: LinuxOciPhysicalSession) {
  f.onWrite(() => f.reply(created()));
  await session.createStopped(request, signal());
}
async function broken(
  f: ReturnType<typeof fixture>,
  session: LinuxOciPhysicalSession,
  lateFrame = true,
) {
  const count = f.writes.length;
  await expect(session.stopInit(signal())).rejects.toThrow("one_use");
  await expect(session.joinInit(signal())).rejects.toThrow();
  await expect(session.startStopped(signal())).rejects.toThrow();
  await expect(session.observeStopped(signal())).rejects.toThrow();
  await expect(session.observeStarted(signal())).rejects.toThrow();
  await expect(session.createStopped(request, signal())).rejects.toThrow("one_use");
  if (lateFrame) {
    f.reply(reaped("linux-oci-init-reaped-observation@1"));
    await expect(session.joinInit(signal())).rejects.toThrow();
  }
  await expect(session.close()).rejects.toThrow("custody_retained");
  expect(f.writes).toHaveLength(count);
  expect(f.raw).toHaveBeenCalledTimes(1);
  expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 0 });
}

test("PIDNS STOP once and repeat JOIN facts stay on the original child and exact seven-field identity", async () => {
  const f = fixture(); // Default transport budget is not an end-to-end deadline proof.
  try {
    const session = f.open();
    f.onWrite((data) => {
      const kind = wireKind(data);
      f.reply(
        kind === "linux-oci-create-stopped@1"
          ? created()
          : kind === "linux-oci-stop-init@1"
            ? reaped()
            : kind === "linux-oci-join-init@1"
              ? reaped("linux-oci-init-reaped-observation@1")
              : cancelled(),
      );
    });
    await session.createStopped(request, signal());
    expect(await session.stopInit(signal())).toEqual(reaped());
    for (let i = 0; i < 2; i++)
      expect(await session.joinInit(signal())).toEqual(
        reaped("linux-oci-init-reaped-observation@1"),
      );
    const before = f.writes.length;
    await expect(session.stopInit(signal())).rejects.toThrow("one_use");
    await expect(session.startStopped(signal())).rejects.toThrow();
    await expect(session.observeStopped(signal())).rejects.toThrow();
    await expect(session.observeStarted(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(before);
    expect(Object.keys(reaped())).toEqual([
      "kind",
      "nativeId",
      "namespaceDevice",
      "namespaceInode",
      "pidNamespaceDevice",
      "pidNamespaceInode",
      "barrier",
    ]);
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.writes.slice(1).map((data) => data.subarray(4).toString())).toEqual([
      '{"kind":"linux-oci-stop-init@1"}',
      '{"kind":"linux-oci-join-init@1"}',
      '{"kind":"linux-oci-join-init@1"}',
      '{"kind":"linux-oci-cancel@1"}',
    ]);
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.raw).toHaveBeenCalledWith(f.binary, [], {
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 1 });
  } finally {
    f.cleanup();
  }
});

test("PIDNS decoded STOP and JOIN refusals allow only same-child JOIN and never treat ECHILD as success", async () => {
  const f = fixture();
  try {
    const session = f.open();
    await create(f, session);
    f.onWrite(() => f.reply(started()));
    await session.startStopped(signal());
    f.onWrite(() => f.reply(refused("stop-init")));
    await expect(session.stopInit(signal())).rejects.toThrow();
    const before = f.writes.length;
    await expect(session.stopInit(signal())).rejects.toThrow("one_use");
    await expect(session.observeStarted(signal())).rejects.toThrow();
    await expect(session.observeStopped(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(before);
    f.onWrite(() => f.reply(refused("join-init", 10)));
    await expect(session.joinInit(signal())).rejects.toThrow();
    f.onWrite(() => f.reply(reaped("linux-oci-init-reaped-observation@1")));
    expect(await session.joinInit(signal())).toEqual(reaped("linux-oci-init-reaped-observation@1"));
    f.onWrite(() => f.reply(cancelled()));
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.writes.map(wireKind)).toEqual([
      "linux-oci-create-stopped@1",
      "linux-oci-start@1",
      "linux-oci-stop-init@1",
      "linux-oci-join-init@1",
      "linux-oci-join-init@1",
      "linux-oci-cancel@1",
    ]);
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 1 });
  } finally {
    f.cleanup();
  }
});

test("PIDNS JOIN before STOP and aborted-before-write STOP emit no stop or join request", async () => {
  const f = fixture();
  try {
    const session = f.open();
    await expect(session.joinInit(signal())).rejects.toThrow();
    await expect(session.stopInit(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
    await create(f, session);
    await expect(session.joinInit(signal())).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(session.stopInit(abort.signal)).rejects.toThrow();
    await expect(session.stopInit(signal())).rejects.toThrow("one_use");
    await expect(session.joinInit(signal())).rejects.toThrow();
    await expect(session.startStopped(signal())).rejects.toThrow();
    await expect(session.observeStopped(signal())).rejects.toThrow();
    expect(f.writes.map(wireKind)).toEqual(["linux-oci-create-stopped@1"]);
    f.onWrite(() => f.reply(cancelled()));
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts().kills).toBe(0);
    expect(f.counts().unrefs).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("PIDNS only one same-child JOIN can be outstanding without disturbing its response", async () => {
  const f = fixture();
  try {
    const session = f.open();
    await create(f, session);
    f.onWrite(() => f.reply(reaped()));
    await session.stopInit(signal());
    f.onWrite(() => undefined);
    const joining = session.joinInit(signal()).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const count = f.writes.length;
    await expect(session.joinInit(signal())).rejects.toThrow();
    await expect(session.stopInit(signal())).rejects.toThrow("one_use");
    expect(f.writes).toHaveLength(count);
    f.reply(reaped("linux-oci-init-reaped-observation@1"));
    expect(await joining).toEqual({ value: reaped("linux-oci-init-reaped-observation@1") });
    f.onWrite(() => f.reply(cancelled()));
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.raw).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

test("PIDNS cancellation during STOP fences admission and retains the original born process", async () => {
  const f = fixture();
  try {
    const session = f.open();
    await create(f, session);
    f.onWrite((data) => {
      if (wireKind(data) === "linux-oci-cancel@1") f.reply(cancelled());
    });
    const stopping = session.stopInit(signal()).then(
      () => undefined,
      (error: unknown) => error,
    );
    const cancelling = session.cancel();
    await expect(session.joinInit(signal())).rejects.toThrow();
    f.reply(reaped());
    expect(await stopping).toBeInstanceOf(Error);
    expect(await cancelling).toEqual(cancelled());
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.writes.map(wireKind)).toEqual([
      "linux-oci-create-stopped@1",
      "linux-oci-stop-init@1",
      "linux-oci-cancel@1",
    ]);
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 1 });
  } finally {
    f.cleanup();
  }
});

for (const operation of ["stop", "join"] as const) {
  test(`PIDNS ${operation} refuses abort after a decoded raw reply before its async continuation`, async () => {
    const f = fixture();
    try {
      const session = f.open();
      await create(f, session);
      if (operation === "join") {
        f.onWrite(() => f.reply(reaped()));
        await session.stopInit(signal());
      }
      const abort = new AbortController();
      const count = f.writes.length;
      f.onWrite(() => {
        // PassThrough emits this complete reply synchronously, resolving the
        // request and removing its abort listener before this write returns.
        f.reply(
          reaped(
            operation === "stop"
              ? "linux-oci-init-reaped@1"
              : "linux-oci-init-reaped-observation@1",
          ),
        );
        abort.abort();
      });
      await expect(
        operation === "stop" ? session.stopInit(abort.signal) : session.joinInit(abort.signal),
      ).rejects.toThrow();
      expect(abort.signal.aborted).toBe(true);
      expect(f.writes).toHaveLength(count + 1);
      await expect(session.stopInit(signal())).rejects.toThrow("one_use");
      await expect(session.createStopped(request, signal())).rejects.toThrow("one_use");
      expect(f.writes).toHaveLength(count + 1);
      f.onWrite(() => f.reply(cancelled()));
      await expect(session.close()).rejects.toThrow("custody_retained");
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 1 });
    } finally {
      f.cleanup();
    }
  });
}

test("PIDNS exact nonzero safe-integer upper bounds remain protocol data on the original net identity", async () => {
  const f = fixture();
  try {
    const session = f.open();
    const maximum = Number.MAX_SAFE_INTEGER;
    f.onWrite(() => f.reply(created(maximum, maximum)));
    await session.createStopped(request, signal());
    const observed: LinuxOciInitReapedObservation = {
      ...reaped(),
      namespaceDevice: maximum,
      namespaceInode: maximum,
      pidNamespaceDevice: maximum,
      pidNamespaceInode: maximum,
    };
    f.onWrite(() => f.reply(observed));
    expect(await session.stopInit(signal())).toEqual(observed);
    f.onWrite(() => f.reply({ ...observed, kind: "linux-oci-init-reaped-observation@1" }));
    expect(await session.joinInit(signal())).toEqual({
      ...observed,
      kind: "linux-oci-init-reaped-observation@1",
    });
    f.onWrite(() => f.reply(cancelled()));
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.raw).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

for (const field of [
  "namespaceDevice",
  "namespaceInode",
  "pidNamespaceDevice",
  "pidNamespaceInode",
] as const) {
  for (const [label, value] of [
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["string", "7"],
    ["null", null],
  ] as const) {
    test(`PIDNS STOP refuses ${field} ${label} without same-child replay or resynchronization`, async () => {
      const f = fixture();
      try {
        const session = f.open();
        await create(f, session);
        f.onWrite(() => f.reply({ ...reaped(), [field]: value }));
        await expect(session.stopInit(signal())).rejects.toThrow();
        expect(f.writes).toHaveLength(2);
        await broken(f, session);
      } finally {
        f.cleanup();
      }
    });
  }
}

for (const fault of [
  "foreign-native",
  "foreign-net-device",
  "foreign-net-inode",
  "wrong-kind",
  "extra-field",
  "field-order",
  "whitespace",
  "duplicate-field",
  "invalid-utf8",
  "zero-frame",
  "oversized-frame",
  "released-born-refusal",
] as const) {
  test(`PIDNS STOP ${fault} seals UNKNOWN and cannot authorize JOIN or another process`, async () => {
    const f = fixture();
    try {
      const session = f.open();
      await create(f, session);
      f.onWrite(() => {
        if (fault === "foreign-native") f.reply({ ...reaped(), nativeId: "b".repeat(64) });
        else if (fault === "foreign-net-device") f.reply({ ...reaped(), namespaceDevice: 8 });
        else if (fault === "foreign-net-inode") f.reply({ ...reaped(), namespaceInode: 12 });
        else if (fault === "wrong-kind") f.reply(reaped("linux-oci-init-reaped-observation@1"));
        else if (fault === "extra-field") f.reply({ ...reaped(), terminal: true });
        else if (fault === "field-order") {
          const { kind, ...rest } = reaped();
          f.reply({ ...rest, kind });
        } else if (fault === "whitespace") f.bytes(frame(`${JSON.stringify(reaped())}\n`));
        else if (fault === "duplicate-field")
          f.bytes(frame(JSON.stringify(reaped()).replace(/}$/, ',"barrier":"unproven"}')));
        else if (fault === "invalid-utf8") f.bytes(frame(Uint8Array.of(0xff)));
        else if (fault === "zero-frame") f.bytes(Buffer.alloc(4));
        else if (fault === "oversized-frame") {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(1_048_577);
          f.bytes(size);
        } else f.reply({ ...refused("stop-init"), custody: "released-uncreated" });
      });
      await expect(session.stopInit(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(2);
      await broken(f, session);
    } finally {
      f.cleanup();
    }
  });
}

for (const field of ["pidNamespaceDevice", "pidNamespaceInode"] as const) {
  test(`PIDNS JOIN refuses foreign ${field} after the original STOP fact`, async () => {
    const f = fixture();
    try {
      const session = f.open();
      await create(f, session);
      f.onWrite(() => f.reply(reaped()));
      await session.stopInit(signal());
      f.onWrite(() => f.reply({ ...reaped("linux-oci-init-reaped-observation@1"), [field]: 19 }));
      await expect(session.joinInit(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(3);
      await broken(f, session);
    } finally {
      f.cleanup();
    }
  });
}

for (const fault of ["timeout", "abort", "eof", "partial-frame"] as const) {
  test(`PIDNS STOP ${fault} retains the same child as UNKNOWN without replay or late-frame adoption`, async () => {
    const f = fixture(15); // Raw test budget only; no actual helper/deadline qualification.
    try {
      const session = f.open();
      await create(f, session);
      f.onWrite(() => undefined);
      const abort = new AbortController();
      const stopping = session.stopInit(abort.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (fault === "abort") abort.abort();
      else if (fault === "eof") f.eof();
      else if (fault === "partial-frame") f.bytes(frame(JSON.stringify(reaped())).subarray(0, 9));
      expect(await stopping).toBeInstanceOf(Error);
      expect(f.writes).toHaveLength(2);
      await broken(f, session, fault !== "eof");
    } finally {
      f.cleanup();
    }
  });
}

for (const operation of ["stop-init", "join-init"] as const) {
  for (const stage of ["frame", "request"] as const) {
    test(`PIDNS generic ${stage} refusal during ${operation} seals JOIN before any further raw write`, async () => {
      const f = fixture();
      try {
        const session = f.open();
        await create(f, session);
        if (operation === "join-init") {
          f.onWrite(() => f.reply(reaped()));
          await session.stopInit(signal());
        }
        f.onWrite(() => f.reply({ ...refused(operation), stage }));
        await expect(
          operation === "stop-init" ? session.stopInit(signal()) : session.joinInit(signal()),
        ).rejects.toThrow();
        const before = f.writes.length;
        // Supply a valid same-child reply if JOIN is incorrectly emitted. Its
        // absence must be checked before a later mismatch/EOF could mask it.
        f.onWrite(() => f.reply(reaped("linux-oci-init-reaped-observation@1")));
        const joining = session.joinInit(signal()).then(
          () => false,
          () => true,
        );
        expect(f.writes.length).toBe(before);
        expect(await joining).toBe(true);
        await broken(f, session);
      } finally {
        f.cleanup();
      }
    });
  }
}
