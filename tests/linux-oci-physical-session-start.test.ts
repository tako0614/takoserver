import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createLinuxOciPhysicalSession,
  type LinuxOciCancelObservation,
  type LinuxOciCreateStoppedRequest,
  type LinuxOciStartedObservation,
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
  const root = mkdtempSync(join(tmpdir(), "linux-oci-start-raw-"));
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

const started = (
  kind: LinuxOciStartedObservation["kind"] = "linux-oci-started@1",
): LinuxOciStartedObservation => ({
  kind,
  nativeId: claim,
  namespaceDevice: 7,
  namespaceInode: 11,
  barrier: "unproven",
});
const wireKind = (data: Buffer): unknown => JSON.parse(data.subarray(4).toString()).kind;

test("START and fresh started observation stay on the original CREATE child and exact namespace", async () => {
  const f = fixture();
  try {
    const session = f.open();
    f.onWrite((data) => {
      const kind = wireKind(data);
      f.reply(
        kind === "linux-oci-create-stopped@1"
          ? created()
          : kind === "linux-oci-start@1"
            ? started()
            : kind === "linux-oci-observe-started@1"
              ? started("linux-oci-started-observation@1")
              : cancelled("retained"),
      );
    });
    await session.createStopped(request, signal());
    expect(await session.startStopped(signal())).toEqual(started());
    expect(await session.observeStarted(signal())).toEqual(
      started("linux-oci-started-observation@1"),
    );
    const before = f.writes.length;
    await expect(session.observeStopped(signal())).rejects.toThrow();
    await expect(session.startStopped(signal())).rejects.toThrow("one_use");
    expect(f.writes).toHaveLength(before);
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.writes.map((x) => x.subarray(4).toString())).toEqual([
      JSON.stringify({ kind: "linux-oci-create-stopped@1", ...request }),
      '{"kind":"linux-oci-start@1"}',
      '{"kind":"linux-oci-observe-started@1"}',
      '{"kind":"linux-oci-cancel@1"}',
    ]);
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 1 });
  } finally {
    f.cleanup();
  }
});

test("START refuses before CREATE and an aborted invocation consumes START without a wire effect", async () => {
  const f = fixture();
  try {
    const session = f.open();
    await expect(session.startStopped(signal())).rejects.toThrow();
    await expect(session.observeStarted(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
    f.onWrite(() => f.reply(created()));
    await session.createStopped(request, signal());
    const abort = new AbortController();
    abort.abort();
    await expect(session.startStopped(abort.signal)).rejects.toThrow();
    await expect(session.startStopped(signal())).rejects.toThrow("one_use");
    await expect(session.observeStarted(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(1);
    f.onWrite(() => f.reply(cancelled("retained")));
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.raw).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

for (const fault of ["foreign-id", "foreign-ns", "wrong-kind", "extra-field"] as const) {
  test(`START raw ${fault} cannot be accepted or authorize replay or release`, async () => {
    const f = fixture();
    try {
      const session = f.open();
      f.onWrite(() => f.reply(created()));
      await session.createStopped(request, signal());
      f.onWrite(() =>
        f.reply(
          fault === "foreign-id"
            ? { ...started(), nativeId: "f".repeat(64) }
            : fault === "foreign-ns"
              ? { ...started(), namespaceInode: 12 }
              : fault === "wrong-kind"
                ? created()
                : { ...started(), ready: true },
        ),
      );
      await expect(session.startStopped(signal())).rejects.toThrow();
      await expect(session.startStopped(signal())).rejects.toThrow("one_use");
      await expect(session.close()).rejects.toThrow("custody_retained");
      expect(f.writes).toHaveLength(2);
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.counts().kills).toBe(0);
      expect(f.counts().unrefs).toBe(0);
    } finally {
      f.cleanup();
    }
  });
}

test("an outstanding original START cannot overlap another operation or be replayed after timeout", async () => {
  const f = fixture(10);
  try {
    const session = f.open();
    f.onWrite(() => f.reply(created()));
    await session.createStopped(request, signal());
    f.onWrite(() => undefined);
    const starting = session.startStopped(signal());
    await expect(session.startStopped(signal())).rejects.toThrow("one_use");
    await expect(session.observeStarted(signal())).rejects.toThrow();
    await expect(starting).rejects.toThrow();
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.writes).toHaveLength(2);
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 0 });
  } finally {
    f.cleanup();
  }
});
