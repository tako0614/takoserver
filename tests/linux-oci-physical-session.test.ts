import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createLinuxOciPhysicalSession,
  type LinuxOciCancelObservation,
  type LinuxOciCreateStoppedRequest,
  type LinuxOciStoppedObservation,
} from "../src/providers/linux-oci-physical-session.ts";

// Only raw spawn/stdio are doubled. These observations never qualify an
// accepted artifact, original claim, namespace, native binding or readiness.
const claim = "a".repeat(64);
const request: LinuxOciCreateStoppedRequest = {
  allocationRoot: "/owned/allocation",
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
  args: ["/app", "日本語"],
  env: ["UNIT_VALUE=fixture-only"],
  cwd: "/",
  uid: 0,
  gid: 0,
  memoryBytes: 1024,
  nanoCpus: 10_000_000,
  pidsLimit: 32,
};
const created = (
  kind:
    | "linux-oci-created-stopped@1"
    | "linux-oci-stopped-observation@1" = "linux-oci-created-stopped@1",
): LinuxOciStoppedObservation => ({
  kind,
  nativeId: claim,
  namespaceDevice: 7,
  namespaceInode: 11,
  barrier: "unproven",
});
const cancelled = (custody: "retained" | "released-uncreated"): LinuxOciCancelObservation => ({
  kind: "linux-oci-cancel-observation@1",
  stage: "cancel",
  errno: 0,
  custody,
  barrier: "unproven",
});
function frame(body: string | Uint8Array): Buffer {
  const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  const output = Buffer.alloc(bytes.length + 4);
  output.writeUInt32BE(bytes.length);
  bytes.copy(output, 4);
  return output;
}
function fixture(timeoutMs = 40) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "linux-oci-raw-"));
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
  let exitOnEnd = false;
  stdin.on("data", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
    action?.(chunk);
  });
  stdin.on("finish", () => {
    ended++;
    if (exitOnEnd) {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }
  });
  const raw = spyOn(childProcess, "spawn").mockReturnValue(child);
  return {
    root,
    binary,
    child,
    writes,
    raw,
    counts: () => ({ kills, unrefs, ended }),
    onWrite(callback: (data: Buffer) => void) {
      action = callback;
    },
    exitOnEnd() {
      exitOnEnd = true;
    },
    reply(value: unknown) {
      stdout.write(frame(JSON.stringify(value)));
    },
    bytes(value: Uint8Array) {
      stdout.write(value);
    },
    open() {
      return createLinuxOciPhysicalSession({ binary, timeoutMs });
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
const signal = () => new AbortController().signal;

test("OCI raw session binds canonical framed CREATE and OBSERVE to the original child and namespace", async () => {
  const f = fixture();
  try {
    const session = f.open();
    expect(f.raw).toHaveBeenCalledWith(f.binary, [], {
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    f.onWrite(() => {
      const body = frame(JSON.stringify(created()));
      f.bytes(body.subarray(0, 2));
      f.bytes(body.subarray(2, 13));
      f.bytes(body.subarray(13));
    });
    expect(await session.createStopped(request, signal())).toEqual(created());
    const wire = f.writes[0];
    if (!wire) throw new Error("raw CREATE absent");
    expect(wire.readUInt32BE(0)).toBe(wire.length - 4);
    expect(wire.subarray(4).toString()).toBe(
      JSON.stringify({ kind: "linux-oci-create-stopped@1", ...request }),
    );
    f.onWrite(() => f.reply(created("linux-oci-stopped-observation@1")));
    expect(await session.observeStopped(signal())).toEqual(
      created("linux-oci-stopped-observation@1"),
    );
    await expect(session.createStopped(request, signal())).rejects.toThrow("one_use");
    f.onWrite(() => f.reply(cancelled("retained")));
    expect(await session.cancel()).toEqual(cancelled("retained"));
    await expect(session.close()).rejects.toThrow("custody_retained");
    await expect(session.observeStopped(signal())).rejects.toThrow("linux_oci_physical_session");
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(3);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 1 });
  } finally {
    f.cleanup();
  }
});

test("OCI raw session permits one outstanding request and consumes CREATE before write failure", async () => {
  const f = fixture();
  try {
    const session = f.open();
    const first = session.createStopped(request, signal());
    await expect(session.observeStopped(signal())).rejects.toThrow("linux_oci_physical_session");
    await expect(session.createStopped(request, signal())).rejects.toThrow("one_use");
    f.reply(created());
    await first;
    const observation = session.observeStopped(signal());
    await expect(session.observeStopped(signal())).rejects.toThrow("linux_oci_physical_session");
    f.reply(created("linux-oci-stopped-observation@1"));
    await observation;
    f.onWrite(() => f.reply(cancelled("retained")));
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts().kills).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("OCI raw session retains the original CREATE after EOF, timeout, abort, malformed or oversized reply", async () => {
  const cases = [
    "eof",
    "timeout",
    "abort",
    "utf8",
    "length",
    "overflow",
    "write-error",
    "stderr",
  ] as const;
  for (const mode of cases) {
    const f = fixture();
    try {
      const controller = new AbortController(),
        session = f.open();
      const pending = session.createStopped(request, controller.signal);
      const rejection = pending.then(
        () => null,
        (error: unknown) => error,
      );
      if (mode === "eof") f.child.stdout.end();
      if (mode === "abort") controller.abort();
      if (mode === "utf8") f.bytes(frame(new Uint8Array([0xff])));
      if (mode === "length") f.bytes(Buffer.from([0, 0x10, 0, 1]));
      if (mode === "overflow") f.bytes(Buffer.alloc(1_048_581));
      if (mode === "write-error")
        f.child.stdin.emit("error", new Error("synthetic raw write failed"));
      if (mode === "stderr") f.child.stderr.write(Buffer.alloc(65_537));
      expect(await rejection).toBeInstanceOf(Error);
      await expect(session.createStopped(request, signal())).rejects.toThrow("one_use");
      await expect(session.observeStopped(signal())).rejects.toThrow("linux_oci_physical_session");
      await expect(session.close()).rejects.toThrow("custody_retained");
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveLength(1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 0 });
    } finally {
      f.cleanup();
    }
  }
});

test("OCI raw session rejects noncanonical, foreign or unsafe stopped replies without recreation", async () => {
  const valid = JSON.stringify(created());
  const wires = [
    `${valid}\n`,
    valid.replace('"namespaceDevice":7', '"namespaceDevice":7.0'),
    valid.replace('"namespaceDevice":7', '"namespaceDevice":7,"namespaceDevice":7'),
    valid.replace('"namespaceDevice":7', '"namespaceDevice":9007199254740993'),
    JSON.stringify({ ...created(), nativeId: "b".repeat(64) }),
    JSON.stringify({ ...created(), extra: true }),
    JSON.stringify({ ...created(), namespaceInode: 0 }),
    JSON.stringify({ ...created(), barrier: "ready" }),
    JSON.stringify(created("linux-oci-stopped-observation@1")),
  ];
  for (const wire of wires) {
    const f = fixture();
    try {
      const session = f.open();
      f.onWrite(() => f.bytes(frame(wire)));
      await expect(session.createStopped(request, signal())).rejects.toThrow(
        "linux_oci_physical_session",
      );
      await expect(session.close()).rejects.toThrow("custody_retained");
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveLength(1);
      expect(f.counts().kills).toBe(0);
    } finally {
      f.cleanup();
    }
  }
});

test("OCI raw OBSERVE refuses a changed namespace and keeps the same created reference", async () => {
  const f = fixture();
  try {
    const session = f.open();
    f.onWrite(() => f.reply(created()));
    await session.createStopped(request, signal());
    f.onWrite(() => f.reply({ ...created("linux-oci-stopped-observation@1"), namespaceInode: 12 }));
    await expect(session.observeStopped(signal())).rejects.toThrow("linux_oci_physical_session");
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts().kills).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("OCI raw close joins only a real released-uncreated reply and observed helper exit", async () => {
  const f = fixture();
  try {
    f.exitOnEnd();
    const session = f.open();
    f.onWrite(() => f.reply(cancelled("released-uncreated")));
    const closed = session.close();
    await expect(session.createStopped(request, signal())).rejects.toThrow(
      "linux_oci_physical_session",
    );
    await closed;
    await session.close();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.subarray(4).toString()).toBe('{"kind":"linux-oci-cancel@1"}');
    expect(f.counts().kills).toBe(0);
  } finally {
    f.cleanup();
  }
  const live = fixture();
  try {
    const session = live.open();
    live.onWrite(() => live.reply(cancelled("released-uncreated")));
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(live.raw).toHaveBeenCalledTimes(1);
    expect(live.counts().kills).toBe(0);
  } finally {
    live.cleanup();
  }
});

test("OCI raw released-uncreated refusal cannot retry CREATE and needs actual exit to close", async () => {
  const f = fixture();
  try {
    f.exitOnEnd();
    const session = f.open();
    f.onWrite(() =>
      f.reply({
        kind: "linux-oci-refused@1",
        stage: "create",
        errno: 22,
        custody: "released-uncreated",
        barrier: "unproven",
      }),
    );
    await expect(session.createStopped(request, signal())).rejects.toThrow(
      "linux_oci_physical_session",
    );
    await expect(session.createStopped(request, signal())).rejects.toThrow("one_use");
    await session.close();
    expect(f.writes).toHaveLength(1);
    expect(f.counts().kills).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("OCI raw close during CREATE revokes admissions and cancels only after the original reply", async () => {
  const f = fixture();
  try {
    const session = f.open();
    const pending = session.createStopped(request, signal());
    const rejected = pending.then(
      () => null,
      (error: unknown) => error,
    );
    const closed = session.close().then(
      () => null,
      (error: unknown) => error,
    );
    expect(f.writes).toHaveLength(1);
    f.reply(created());
    f.onWrite(() => f.reply(cancelled("retained")));
    expect(await rejected).toBeInstanceOf(Error);
    expect(await closed).toMatchObject({ message: "linux_oci_physical_session_custody_retained" });
    expect(f.writes).toHaveLength(2);
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts().kills).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("OCI raw CREATE guards closed original data and is one-use even before a refused write", async () => {
  const invalid = [
    { ...request, generation: 0 },
    { ...request, args: [] },
    { ...request, args: ["/app", "\ud800"] },
    { ...request, env: ["A=1", "A=2"] },
    { ...request, env: ["missing-equals"] },
    { ...request, uid: 0x1_0000_0000 },
    { ...request, nanoCpus: 9_999_999 },
    { ...request, pidsLimit: 0 },
    { ...request, cwd: "relative" },
    { ...request, claimId: "foreign" },
    { ...request, sourceDigest: "sha256:short" },
    { ...request, extra: true },
    { ...request, args: ["/app", ...Array<string>(5).fill("x".repeat(131071))] },
  ];
  for (const value of invalid) {
    const f = fixture();
    try {
      f.exitOnEnd();
      const session = f.open();
      await expect(session.createStopped(value, signal())).rejects.toThrow("request");
      expect(f.writes).toHaveLength(0);
      await expect(session.createStopped(request, signal())).rejects.toThrow("one_use");
      f.onWrite(() => f.reply(cancelled("released-uncreated")));
      await session.close();
      expect(f.raw).toHaveBeenCalledTimes(1);
    } finally {
      f.cleanup();
    }
  }
});

test("OCI raw helper rejects symlink, writable ancestor/file and nonexecutable file before spawn", () => {
  const f = fixture();
  try {
    chmodSync(f.binary, 0o600);
    expect(() => f.open()).toThrow();
    chmodSync(f.binary, 0o722);
    expect(() => f.open()).toThrow();
    chmodSync(f.binary, 0o700);
    chmodSync(f.root, 0o722);
    expect(() => f.open()).toThrow();
    chmodSync(f.root, 0o700);
    const alias = join(f.root, "alias");
    symlinkSync(f.binary, alias);
    expect(() => createLinuxOciPhysicalSession({ binary: alias })).toThrow();
    expect(() => createLinuxOciPhysicalSession({ binary: f.root })).toThrow();
    expect(() => createLinuxOciPhysicalSession({ binary: "relative" })).toThrow();
    expect(f.raw).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
