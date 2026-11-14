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

// New explicit profile only. Original cases above remain registered/filtered;
// all native peer checks live in the separate actual-C syscall model.
const PEER_BOOT = "11111111-1111-4111-8111-111111111111";
const PEER_INODE = 0x1000000000000123n;
function peerInfo() {
  const bytes = Buffer.alloc(144);
  bytes.writeUInt32BE(140);
  bytes.write("TKOINFO2", 4);
  bytes.write(CLAIM, 12);
  bytes.writeBigUInt64BE(1n, 76);
  bytes.writeBigUInt64BE(COOKIE, 84);
  bytes.writeBigUInt64BE(42n, 92);
  bytes.writeBigUInt64BE(PEER_INODE, 100);
  bytes.write(PEER_BOOT, 108);
  return bytes;
}
function peerOpen(f: ReturnType<typeof fixture>) {
  return createLinuxOciParentBootstrap({
    binary: f.binary,
    claimId: CLAIM,
    generation: 1,
    capability: fixtureCapability(),
    timeoutMs: 200,
    peerProfile: "pidfs64@1",
  });
}
async function readyPeer(f: ReturnType<typeof fixture>) {
  const parent = peerOpen(f),
    pending = parent.bootstrap(signal());
  await wrote();
  for (const byte of peerInfo()) f.stdout.write(Buffer.from([byte]));
  const observed = await pending;
  return { parent, observed };
}
function connectorStreams() {
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
    unrefs = 0;
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
  stdin.on("data", (bytes: Buffer) => writes.push(Buffer.from(bytes)));
  return {
    child: concrete,
    stdin,
    stdout,
    stderr,
    writes,
    counts: () => ({ kills, unrefs }),
    close() {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}
function resultFrame(error = 0) {
  const body = Buffer.from(
    JSON.stringify({
      kind: error ? "linux-oci-parent-h-result-refused@1" : "linux-oci-parent-h-exited@1",
      error,
      barrier: "unproven",
    }),
  );
  const bytes = Buffer.alloc(body.length + 4);
  bytes.writeUInt32BE(body.length);
  body.copy(bytes, 4);
  return bytes;
}

test("peer instance bootstrap captures original lossless pidfs/boot before H and purpose seal keeps it", async () => {
  const f = fixture();
  try {
    const { parent, observed } = await readyPeer(f);
    expect(f.raw).toHaveBeenCalledWith(f.binary, ["--persistent-parent-peer"], {
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.subarray(4, 12).equals(Buffer.from("TKOBIND2"))).toBe(true);
    expect(observed.kind).toBe("linux-oci-parent-bootstrap@2");
    expect(observed.peer).toEqual({
      kind: "linux-oci-parent-peer@1",
      device: "42",
      inode: PEER_INODE.toString(),
      bootId: PEER_BOOT,
    });
    expect(Object.isFrozen(observed.peer)).toBe(true);
    const codec = await import("../src/providers/container-secret-codec.ts");
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(0xa5),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const other = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(0x5a),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const selected = { id: "NONSECRET-original", key };
    const request = {
      allocationRoot: "/owned/allocation",
      claimId: CLAIM,
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
      env: ["NONSECRET=fixture"],
      cwd: "/",
      uid: 0,
      gid: 0,
      memoryBytes: 1024,
      nanoCpus: 10000000,
      pidsLimit: 32,
    };
    const scope = JSON.stringify({
      purpose: "takoserver.linux-oci-parent-peer-control@1",
      claimId: CLAIM,
    });
    const pending = parent.sealPeerControlBinding(selected, scope, signal(), request);
    selected.id = "NONSECRET-changed";
    selected.key = other;
    const sealed = await pending;
    expect(sealed.keyId).toBe("NONSECRET-original");
    const plaintext = await codec.decryptContainerSecretBytes(
      key,
      codec.decodeContainerSecretBytes(sealed.nonce),
      codec.decodeContainerSecretBytes(sealed.ciphertext),
      new TextEncoder().encode(scope),
    );
    try {
      const value = JSON.parse(new TextDecoder().decode(plaintext));
      expect(value.peer).toEqual(observed.peer);
      expect(value.kind).toBe("linux-oci-original-peer-control@1");
      expect(value.capability).toBe(codec.encodeContainerSecretBytes(fixtureCapability()));
    } finally {
      plaintext.fill(0);
    }
    expect(f.writes).toHaveLength(1);
    expect(f.raw).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

test("peer instance rejects malformed boot/inode/version and original P loss without replacement", async () => {
  const bad: Buffer[] = [];
  const zero = peerInfo();
  zero.writeBigUInt64BE(0n, 100);
  bad.push(zero);
  const boot = peerInfo();
  boot[108] = (boot[108] ?? 0) | 0x80;
  bad.push(boot);
  const version = peerInfo();
  version.write("TKOINFO1", 4);
  bad.push(version);
  const length = peerInfo();
  length.writeUInt32BE(88);
  bad.push(length);
  for (const bytes of bad) {
    const f = fixture();
    try {
      const parent = peerOpen(f);
      const pending = parent.bootstrap(signal()).then(
        () => undefined,
        (e: unknown) => e,
      );
      f.stdout.write(bytes);
      await wrote();
      expect(await pending).toBeInstanceOf(Error);
      const refused = await parent.readPeerHResult(signal()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(Error);
      expect(f.raw).toHaveBeenCalledTimes(1);
    } finally {
      f.cleanup();
    }
  }
  const f = fixture();
  try {
    const { parent } = await readyPeer(f);
    f.child.emit("exit", 0, null);
    expect(
      await parent.readPeerHResult(signal()).then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toBeInstanceOf(Error);
    expect(f.raw).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

test("peer instance readonly consumer preserves original H result independently of connector exit and two EOF", async () => {
  for (const pendingH of [false, true]) {
    const f = fixture(),
      c = connectorStreams();
    try {
      const { parent } = await readyPeer(f);
      f.stdout.emit("end"); // original Host channel loss, not P death
      f.raw.mockReturnValue(c.child);
      let settled = false;
      const pending = parent.readPeerHResult(signal()).then((value) => {
        settled = true;
        return value;
      });
      await wrote();
      expect(f.raw).toHaveBeenLastCalledWith(f.binary, ["--parent-peer-read-result"], {
        env: {},
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(c.writes).toHaveLength(1);
      const request = c.writes[0];
      if (!request) throw new Error("raw private connector input absent");
      expect(request.length).toBe(176);
      expect(request.subarray(4, 12).equals(Buffer.from("TKOPEER2"))).toBe(true);
      expect(request.readBigUInt64BE(132)).toBe(PEER_INODE);
      expect(request.subarray(140).toString()).toBe(PEER_BOOT);
      expect(request.subarray(92, 124).equals(Buffer.from(fixtureCapability()))).toBe(true);
      const frame = resultFrame(pendingH ? 11 : 0);
      for (const byte of frame) c.stdout.write(Buffer.from([byte]));
      c.child.emit("exit", 0, null);
      c.stdout.emit("end");
      await wrote();
      expect(settled).toBe(false);
      c.stderr.emit("end");
      await wrote();
      expect(settled).toBe(false);
      c.child.emit("close", 0, null);
      const result = await pending;
      expect(result).toEqual({
        kind: pendingH ? "linux-oci-parent-h-result-refused@1" : "linux-oci-parent-h-exited@1",
        error: pendingH ? 11 : 0,
        barrier: "unproven",
      });
      expect(f.writes).toHaveLength(1);
      expect(f.raw).toHaveBeenCalledTimes(2);
      expect(c.counts()).toEqual({ kills: 0, unrefs: 0 });
    } finally {
      c.close();
      f.cleanup();
    }
  }
});

test("peer instance connector malformed loss nonzero cancel and late bytes stay UNKNOWN without respawn", async () => {
  for (const fault of ["bad-json", "nonzero", "signal", "error", "abort", "timeout", "late-byte"]) {
    const f = fixture(),
      c = connectorStreams();
    try {
      const { parent } = await readyPeer(f);
      f.raw.mockReturnValue(c.child);
      const controller = new AbortController();
      const pending = parent.readPeerHResult(controller.signal).then(
        () => undefined,
        (e: unknown) => e,
      );
      await wrote();
      if (fault === "abort") controller.abort();
      else if (fault === "error") c.child.emit("error", new Error("raw failure"));
      else if (fault !== "timeout") {
        c.stdout.write(fault === "bad-json" ? Buffer.from([0, 0, 0, 2, 123, 125]) : resultFrame());
        c.stdout.emit("end");
        c.stderr.emit("end");
        c.child.emit(
          "exit",
          fault === "nonzero" ? 1 : fault === "signal" ? null : 0,
          fault === "signal" ? "SIGTERM" : null,
        );
        c.child.emit(
          "close",
          fault === "nonzero" ? 1 : fault === "signal" ? null : 0,
          fault === "signal" ? "SIGTERM" : null,
        );
        if (fault === "late-byte") c.stdout.emit("data", Buffer.from([0]));
      }
      expect(await pending).toBeInstanceOf(Error);
      expect(
        await parent.readPeerHResult(signal()).then(
          () => undefined,
          (e: unknown) => e,
        ),
      ).toBeInstanceOf(Error);
      expect(f.raw).toHaveBeenCalledTimes(2);
      expect(c.counts()).toEqual({ kills: 0, unrefs: 0 });
      expect(f.writes).toHaveLength(1);
      expect(c.writes).toHaveLength(1);
    } finally {
      c.close();
      f.cleanup();
    }
  }
});
