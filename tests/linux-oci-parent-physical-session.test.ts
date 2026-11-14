import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createLinuxOciParentBootstrap } from "../src/providers/linux-oci-physical-session.ts";

// Explicit NONSECRET fixture bytes only. All spawn/streams are raw doubles;
// no P/H, executable, AF_UNIX, key generator, database or provider is invoked.
const CLAIM = "a".repeat(64);
const COOKIE = 0xfedcba9876543210n;
const fixtureCapability = () => new Uint8Array(32).fill(0xa5);
function info(claim = CLAIM, generation = 1n, cookie = COOKIE): Buffer {
  const frame = Buffer.alloc(92);
  frame.writeUInt32BE(88);
  frame.write("TKOINFO1", 4, "ascii");
  frame.write(claim, 12, "ascii");
  frame.writeBigUInt64BE(generation, 76);
  frame.writeBigUInt64BE(cookie, 84);
  return frame;
}
function fixture(timeoutMs = 40) {
  const root = mkdtempSync(join(process.cwd(), ".oci-parent-raw-"));
  chmodSync(root, 0o700);
  const binary = join(root, "helper");
  writeFileSync(binary, "NONEXECUTED RAW FIXTURE", { mode: 0o700 });
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
  const child = Object.defineProperties(new childProcess.ChildProcess(), {
    stdin: { value: stdin, writable: true },
    stdout: { value: stdout, writable: true },
    stderr: { value: stderr, writable: true },
    stdio: { value: stdio, writable: true },
  });
  let kills = 0,
    unrefs = 0,
    ended = 0;
  const concrete = Object.assign(child, {
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
  stdin.on("data", (chunk: Buffer) => writes.push(Buffer.from(chunk)));
  stdin.on("finish", () => ended++);
  const raw = spyOn(childProcess, "spawn").mockReturnValue(concrete);
  return {
    binary,
    child,
    stdin,
    stdout,
    stderr,
    raw,
    writes,
    counts: () => ({ kills, unrefs, ended }),
    open(capability = fixtureCapability()) {
      return createLinuxOciParentBootstrap({
        binary,
        claimId: CLAIM,
        generation: 1,
        capability,
        timeoutMs,
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
async function wrote(): Promise<void> {
  // Yield to the modeled Writable's callback, never a native child/IO operation.
  await new Promise<void>((resolve) => setImmediate(resolve));
}
const signal = () => new AbortController().signal;

test("original P bootstrap leaves a save/fresh-guard window and never writes CREATE", async () => {
  const f = fixture();
  try {
    const capability = fixtureCapability();
    const parent = f.open(capability);
    capability.fill(0); // the private original snapshot is independent
    expect(f.raw).toHaveBeenCalledWith(f.binary, ["--persistent-parent"], {
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(Object.getPrototypeOf(f.raw.mock.calls[0]?.[2]?.env)).toBeNull();
    expect(() => parent.assertCurrent(signal())).toThrow("unprepared");
    const result = parent.bootstrap(signal());
    await wrote();
    const bytes = f.writes[0];
    if (!bytes) throw new Error("raw bootstrap absent");
    expect(bytes.length).toBe(116);
    expect(bytes.readUInt32BE(0)).toBe(112);
    expect(bytes.subarray(4, 12).equals(Buffer.from("TKOBIND1"))).toBe(true);
    expect(bytes.subarray(12, 76).toString()).toBe(CLAIM);
    expect(bytes.readBigUInt64BE(76)).toBe(1n);
    expect(bytes.subarray(84).equals(Buffer.from(fixtureCapability()))).toBe(true);
    const reply = info();
    for (const byte of reply) f.stdout.write(Buffer.from([byte]));
    const observed = await result;
    expect(observed).toEqual({
      kind: "linux-oci-parent-bootstrap@1",
      claimId: CLAIM,
      generation: 1,
      listenerCookie: COOKIE.toString(),
      barrier: "unproven",
    });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(BigInt(observed.listenerCookie)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    parent.assertCurrent(signal());
    await wrote(); // future durable-save await window; still no effect API
    parent.assertCurrent(signal());
    expect(f.writes).toHaveLength(1);
    expect(f.raw).toHaveBeenCalledTimes(1);
    await expect(parent.bootstrap(signal())).rejects.toThrow("one_use");
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 0 });
    f.child.emit("exit", 0, null); // P exit-zero is transport loss, never H success
    expect(() => parent.assertCurrent(signal())).toThrow("retained");
    expect(f.writes).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test("closed info frame rejects length, purpose, exact bytes, claim, generation, cookie and trailing data", async () => {
  const variants: Buffer[] = [];
  for (const length of [0, 87, 89, 1_048_577]) {
    const bytes = info();
    bytes.writeUInt32BE(length);
    variants.push(bytes);
  }
  const purpose = info();
  purpose[4] = 0;
  variants.push(purpose);
  const highPurpose = info();
  highPurpose[4] = (highPurpose[4] ?? 0) | 0x80;
  variants.push(highPurpose);
  const highClaim = info();
  highClaim[12] = (highClaim[12] ?? 0) | 0x80;
  variants.push(highClaim);
  variants.push(info("b".repeat(64)), info(CLAIM, 2n), info(CLAIM, 1n, 0n));
  variants.push(Buffer.concat([info(), Buffer.from([0])]), Buffer.concat([info(), info()]));
  for (const bytes of variants) {
    const f = fixture();
    try {
      const parent = f.open();
      const result = parent.bootstrap(signal());
      let settled = false;
      const rejected = result.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      f.stdout.write(bytes);
      await wrote();
      expect(settled).toBe(true); // actual parser rejection, before the 40ms timer
      expect(await rejected).toBeInstanceOf(Error);
      await expect(parent.bootstrap(signal())).rejects.toThrow("one_use");
      expect(() => parent.assertCurrent(signal())).toThrow();
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveLength(1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 0 });
    } finally {
      f.cleanup();
    }
  }
});

test("same-call trailing bytes, EOF, P events, abort and binary changes defeat the async final fence", async () => {
  const events = ["extra", "end", "stderr-end", "exit0", "signal", "close", "abort", "binary"];
  for (const event of events) {
    const f = fixture();
    try {
      const controller = new AbortController();
      const parent = f.open();
      const result = parent.bootstrap(controller.signal);
      let settled = false;
      const rejected = result.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await wrote();
      f.stdout.write(info());
      if (event === "extra") f.stdout.write(Buffer.from([0]));
      else if (event === "end") f.stdout.emit("end");
      else if (event === "stderr-end") f.stderr.emit("end");
      else if (event === "exit0") f.child.emit("exit", 0, null);
      else if (event === "signal") f.child.emit("exit", null, "SIGTERM");
      else if (event === "close") f.child.emit("close", 0, null);
      else if (event === "abort") controller.abort();
      else chmodSync(f.binary, 0o777);
      await wrote();
      expect(settled).toBe(true); // the late event/final fence, not a timeout
      expect(await rejected).toBeInstanceOf(Error);
      expect(() => parent.assertCurrent(signal())).toThrow();
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveLength(1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 0 });
    } finally {
      f.cleanup();
    }
  }
});

test("bootstrap retains original P on aborted, EOF, stream error, timeout and truncated reply", async () => {
  const events = [
    "aborted",
    "abort",
    "end",
    "error",
    "stdin-error",
    "stderr-error",
    "stderr-limit",
    "timeout",
    "truncated",
  ];
  for (const event of events) {
    const f = fixture(10);
    try {
      const controller = new AbortController();
      const parent = f.open();
      if (event === "aborted") controller.abort();
      const result = parent.bootstrap(controller.signal);
      let settled = false;
      const rejected = result.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      if (event === "abort") controller.abort();
      else if (event === "end") f.stdout.emit("end");
      else if (event === "error") f.child.emit("error", new Error("raw"));
      else if (event === "stdin-error") f.stdin.emit("error", new Error("raw"));
      else if (event === "stderr-error") f.stderr.emit("error", new Error("raw"));
      else if (event === "stderr-limit") f.stderr.write(Buffer.alloc(65_537));
      else if (event === "truncated") {
        f.stdout.write(info().subarray(0, 91));
        f.stdout.emit("end");
      }
      if (event !== "timeout") {
        await wrote();
        expect(settled).toBe(true); // injected event wins without waiting for timer
      }
      expect(await rejected).toBeInstanceOf(Error);
      await expect(parent.bootstrap(signal())).rejects.toThrow("one_use");
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveLength(event === "aborted" ? 0 : 1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 0 });
    } finally {
      f.cleanup();
    }
  }
});

test("binding validation and executable currentness refuse before bootstrap IO", async () => {
  const f = fixture();
  try {
    const options = {
      binary: f.binary,
      claimId: CLAIM,
      generation: 1,
      capability: fixtureCapability(),
    };
    for (const patch of [
      { claimId: "bad" },
      { generation: 0 },
      { generation: Number.MAX_SAFE_INTEGER + 1 },
      { capability: new Uint8Array(31) },
      { capability: new Uint8Array(32) },
      { timeoutMs: 0 },
    ]) {
      expect(() => createLinuxOciParentBootstrap({ ...options, ...patch })).toThrow();
    }
    expect(f.raw).not.toHaveBeenCalled();
    const parent = f.open();
    chmodSync(f.binary, 0o777);
    await expect(parent.bootstrap(signal())).rejects.toThrow("binary");
    expect(f.writes).toHaveLength(0);
    expect(f.raw).toHaveBeenCalledTimes(1);
    chmodSync(f.binary, 0o700);
    await expect(parent.bootstrap(signal())).rejects.toThrow("one_use");
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0, ended: 0 });
  } finally {
    f.cleanup();
  }
});
