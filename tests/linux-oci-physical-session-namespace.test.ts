import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createLinuxOciPhysicalSession,
  type LinuxOciCreateStoppedRequest,
} from "../src/providers/linux-oci-physical-session.ts";

// Only spawn/stdio are modeled. No helper is executed and none of these raw
// observations qualifies original accepted ownership, kernel coverage or DELETE.
const claim = "b".repeat(64);
const maximum = "18446744073709551615";
const operations = [
  [
    "releaseNamespace",
    "linux-oci-release-namespace@1",
    "linux-oci-namespace-release-observation@1",
  ],
  [
    "continueNamespaceRelease",
    "linux-oci-continue-namespace-release@1",
    "linux-oci-namespace-release-continuation@1",
  ],
  [
    "observeNamespaceLifetime",
    "linux-oci-observe-namespace-lifetime@1",
    "linux-oci-namespace-lifetime-observation@1",
  ],
] as const;
const keys = [
  "kind",
  "nativeId",
  "namespaceDevice",
  "namespaceInode",
  "netCookie",
  "fullIpSockets",
  "requests",
  "timewait",
  "packetGroups",
  "born",
  "releaseAttempted",
  "referenceReleased",
  "netGone",
  "poisoned",
  "barrier",
] as const;
const request: LinuxOciCreateStoppedRequest = {
  allocationRoot: "/owned/namespace-unit",
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
  args: ["/unit"],
  env: [],
  cwd: "/",
  uid: 0,
  gid: 0,
  memoryBytes: 1024,
  nanoCpus: 10_000_000,
  pidsLimit: 4,
};
const signal = () => new AbortController().signal;
function stopped(kind = "linux-oci-created-stopped@1") {
  return { kind, nativeId: claim, namespaceDevice: 7, namespaceInode: 11, barrier: "unproven" };
}
function reaped(kind = "linux-oci-init-reaped@1") {
  return {
    kind,
    nativeId: claim,
    namespaceDevice: 7,
    namespaceInode: 11,
    pidNamespaceDevice: 13,
    pidNamespaceInode: 17,
    barrier: "unproven",
  };
}
function lifetime(kind: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind,
    nativeId: claim,
    namespaceDevice: 7,
    namespaceInode: 11,
    netCookie: maximum,
    fullIpSockets: "0",
    requests: "0",
    timewait: "0",
    packetGroups: "0",
    born: 1,
    releaseAttempted: 1,
    referenceReleased: 0,
    netGone: 0,
    poisoned: 0,
    barrier: "unproven",
    ...fields,
  };
}
function refused(stage: string, custody = "retained") {
  return { kind: "linux-oci-refused@1", stage, errno: 110, custody, barrier: "unproven" };
}
function frame(value: string | Uint8Array): Buffer {
  const body = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  const result = Buffer.alloc(body.length + 4);
  result.writeUInt32BE(body.length);
  body.copy(result, 4);
  return result;
}
function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "oci-namespace-raw-"));
  chmodSync(root, 0o700);
  const binary = join(root, "helper");
  writeFileSync(binary, "raw fixture; never executed", { mode: 0o700 });
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
  const transport = Object.defineProperties(new childProcess.ChildProcess(), {
    stdin: { value: stdin, writable: true },
    stdout: { value: stdout, writable: true },
    stderr: { value: stderr, writable: true },
    stdio: { value: stdio, writable: true },
  });
  let kills = 0,
    unrefs = 0;
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
  const raw = spyOn(childProcess, "spawn").mockReturnValue(child);
  const reply = (value: unknown) => stdout.write(frame(JSON.stringify(value)));
  const standard = (kind: string) => {
    if (kind === "linux-oci-create-stopped@1") reply(stopped());
    else if (kind === "linux-oci-stop-init@1") reply(reaped());
    else if (kind === "linux-oci-join-init@1") reply(reaped("linux-oci-init-reaped-observation@1"));
    else if (kind === "linux-oci-cancel@1")
      reply({
        kind: "linux-oci-cancel-observation@1",
        stage: "cancel",
        errno: 0,
        custody: "retained",
        barrier: "unproven",
      });
    else {
      const selected = operations.find(([, requestKind]) => requestKind === kind);
      if (!selected) throw new Error("unexpected unit request");
      reply(lifetime(selected[2]));
    }
  };
  let action = standard;
  stdin.on("data", (chunk: Buffer) => {
    const wire = Buffer.from(chunk);
    writes.push(wire);
    if (wire.readUInt32BE(0) !== wire.length - 4) throw new Error("invalid request frame");
    const decoded: unknown = JSON.parse(wire.subarray(4).toString());
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("kind" in decoded) ||
      typeof decoded.kind !== "string"
    )
      throw new Error("invalid request kind");
    action(decoded.kind);
  });
  return {
    child,
    writes,
    raw,
    reply,
    standard,
    counts: () => ({ kills, unrefs }),
    onRequest(callback: (kind: string) => void) {
      action = callback;
    },
    bytes(bytes: Uint8Array) {
      stdout.write(bytes);
    },
    json(body: string) {
      stdout.write(frame(body));
    },
    open() {
      return createLinuxOciPhysicalSession({ binary, timeoutMs: 40 });
    },
    async ready() {
      const session = this.open();
      await session.createStopped(request, signal());
      await session.stopInit(signal());
      return session;
    },
    kinds() {
      return writes.map((wire) => JSON.parse(wire.subarray(4).toString()).kind);
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

test("namespace wire uses the same reaped child and three nofield requests, preserving uint64 strings without terminal grant", async () => {
  const f = fixture();
  try {
    const session = await f.ready();
    f.onRequest((kind) => {
      const selected = operations.find(([, requestKind]) => requestKind === kind);
      if (!selected) return f.standard(kind);
      f.reply(
        lifetime(selected[2], {
          fullIpSockets: kind === operations[0][1] ? maximum : "0",
          requests: kind === operations[1][1] ? maximum : "0",
          timewait: "18446744073709551614",
          packetGroups: "0",
          // The C contract does not imply referenceReleased from netGone.
          netGone: 1,
          referenceReleased: kind === operations[2][1] ? 1 : 0,
        }),
      );
    });
    for (const [method, requestKind, replyKind] of operations) {
      const observed = await session[method](signal());
      expect<unknown>(observed).toEqual(
        lifetime(replyKind, {
          fullIpSockets: requestKind === operations[0][1] ? maximum : "0",
          requests: requestKind === operations[1][1] ? maximum : "0",
          timewait: "18446744073709551614",
          packetGroups: "0",
          netGone: 1,
          referenceReleased: requestKind === operations[2][1] ? 1 : 0,
        }),
      );
      expect<unknown>(Object.keys(observed)).toEqual(keys);
      expect(Object.isFrozen(observed)).toBe(true);
      expect(typeof observed.netCookie).toBe("string");
      const wire = f.writes.at(-1);
      expect(wire?.subarray(4).toString()).toBe(JSON.stringify({ kind: requestKind }));
    }
    await expect(session.releaseNamespace(signal())).rejects.toThrow("one_use");
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
  } finally {
    f.cleanup();
  }
});

test("namespace release needs the original CREATE and positive same-session STOP or JOIN before any namespace IO", async () => {
  const f = fixture();
  try {
    const session = f.open();
    await expect(session.releaseNamespace(signal())).rejects.toThrow();
    await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
    await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
    await session.createStopped(request, signal());
    await expect(session.releaseNamespace(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(1);
    f.onRequest((kind) =>
      kind === "linux-oci-stop-init@1" ? f.reply(refused("stop-init")) : f.standard(kind),
    );
    await expect(session.stopInit(signal())).rejects.toThrow();
    await expect(session.releaseNamespace(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(2);
    await session.joinInit(signal());
    await session.releaseNamespace(signal());
    expect(f.kinds()).toEqual([
      "linux-oci-create-stopped@1",
      "linux-oci-stop-init@1",
      "linux-oci-join-init@1",
      operations[0][1],
    ]);
    await expect(session.close()).rejects.toThrow("custody_retained");
  } finally {
    f.cleanup();
  }
});

test("namespace release is spent before abort or effect and concurrent requests cannot replay it", async () => {
  for (const mode of ["pre-abort", "outstanding"] as const) {
    const f = fixture();
    try {
      const session = await f.ready();
      const controller = new AbortController();
      const before = f.writes.length;
      if (mode === "pre-abort") {
        controller.abort();
        await expect(session.releaseNamespace(controller.signal)).rejects.toThrow();
        expect(f.writes).toHaveLength(before);
        await expect(session.releaseNamespace(signal())).rejects.toThrow("one_use");
        await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
        await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
        expect(f.writes).toHaveLength(before);
      } else {
        f.onRequest(() => {});
        const pending = session.releaseNamespace(controller.signal);
        await expect(session.releaseNamespace(signal())).rejects.toThrow("one_use");
        await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
        await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
        expect(f.writes).toHaveLength(before + 1);
        f.reply(lifetime(operations[0][2]));
        await pending;
        f.onRequest(f.standard);
        await session.continueNamespaceRelease(signal());
      }
      await expect(session.close()).rejects.toThrow("custody_retained");
      expect(f.raw).toHaveBeenCalledTimes(1);
    } finally {
      f.cleanup();
    }
  }
});

test("namespace exact-operation retained refusals permit only same-child continuation and read, never another release", async () => {
  const f = fixture();
  try {
    const session = await f.ready();
    for (const [method, requestKind] of operations) {
      f.onRequest((kind) =>
        kind === requestKind
          ? f.reply(refused(kind.slice("linux-oci-".length, -"@1".length)))
          : f.standard(kind),
      );
      await expect(session[method](signal())).rejects.toThrow();
    }
    f.onRequest(f.standard);
    await session.continueNamespaceRelease(signal());
    await session.observeNamespaceLifetime(signal());
    const before = f.writes.length;
    await expect(session.releaseNamespace(signal())).rejects.toThrow("one_use");
    expect(f.writes).toHaveLength(before);
    expect(f.kinds().filter((kind) => kind === operations[0][1])).toHaveLength(1);
    expect(f.raw).toHaveBeenCalledTimes(1);
    await expect(session.close()).rejects.toThrow("custody_retained");
  } finally {
    f.cleanup();
  }
});

test("namespace replies require the closed ordered fifteen-field canonical ABI and canonical uint64 or flag domains", async () => {
  const valid = lifetime(operations[0][2]);
  const malformed: string[] = keys.map((key) => {
    const missing = { ...valid };
    delete missing[key];
    return JSON.stringify(missing);
  });
  for (const fields of [
    { extra: 0 },
    { netCookie: "0" },
    { netCookie: 1 },
    { born: 0 },
    { born: true },
    { releaseAttempted: "1" },
    { referenceReleased: 2 },
    { netGone: -1 },
    { poisoned: false },
    { releaseAttempted: 0, referenceReleased: 1 },
    { releaseAttempted: 0, netGone: 1 },
    { fullIpSockets: "01" },
    { requests: "-1" },
    { timewait: "1.0" },
    { packetGroups: "1e2" },
    { fullIpSockets: "+1" },
    { requests: " 1" },
    { timewait: "18446744073709551616" },
    { packetGroups: "999999999999999999999" },
    { fullIpSockets: 0 },
    { barrier: "proven" },
  ])
    malformed.push(JSON.stringify(lifetime(operations[0][2], fields)));
  const canonical = JSON.stringify(valid);
  malformed.push(` ${canonical}`, canonical.replace('"born":1', '"born":1.0'));
  malformed.push(canonical.replace('"kind":', '"duplicate":0,"kind":'));
  malformed.push(canonical.replace('"born":1', '"born":1,"born":1'));
  malformed.push(JSON.stringify({ ...valid, kind: undefined, kindFirst: valid.kind }));
  const reordered = { nativeId: valid.nativeId, ...valid };
  malformed.push(JSON.stringify(reordered));
  for (const body of malformed) {
    const f = fixture();
    try {
      const session = await f.ready();
      f.onRequest(() => f.json(body));
      await expect(session.releaseNamespace(signal())).rejects.toThrow();
      const sent = f.writes.length;
      f.reply(valid); // A later valid frame cannot resynchronize the broken stream.
      await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
      await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
      await expect(session.close()).rejects.toThrow("custody_retained");
      expect(f.raw).toHaveBeenCalledTimes(1);
    } finally {
      f.cleanup();
    }
  }
});

test("namespace cookie, original native/ns and irreversible flags cannot be replaced or regressed", async () => {
  for (const changed of [
    { netCookie: "1" },
    { nativeId: "c".repeat(64) },
    { namespaceDevice: 8 },
    { namespaceInode: 12 },
    { releaseAttempted: 0, referenceReleased: 0, netGone: 0 },
    { referenceReleased: 0 },
    { netGone: 0 },
    { poisoned: 0 },
  ]) {
    const f = fixture();
    try {
      const session = await f.ready();
      const flags = { referenceReleased: 1, netGone: 1, poisoned: 1 };
      f.onRequest(() => f.reply(lifetime(operations[0][2], flags)));
      await session.releaseNamespace(signal());
      f.onRequest(() => f.reply(lifetime(operations[2][2], { ...flags, ...changed })));
      await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
      const sent = f.writes.length;
      f.reply(lifetime(operations[2][2], flags));
      await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
      await expect(session.close()).rejects.toThrow("custody_retained");
      expect(f.raw).toHaveBeenCalledTimes(1);
    } finally {
      f.cleanup();
    }
  }
});

test("namespace frame/request/wrong-operation or uncreated refusal seals instead of granting retained recovery", async () => {
  for (const reply of [
    refused("frame"),
    refused("request"),
    refused("continue-namespace-release"),
    refused("release-namespace", "released-uncreated"),
    lifetime(operations[1][2]),
  ]) {
    const f = fixture();
    try {
      const session = await f.ready();
      f.onRequest(() => f.reply(reply));
      await expect(session.releaseNamespace(signal())).rejects.toThrow();
      const sent = f.writes.length;
      f.onRequest(f.standard);
      await expect(session.releaseNamespace(signal())).rejects.toThrow("one_use");
      await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
      await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
      await expect(session.close()).rejects.toThrow("custody_retained");
    } finally {
      f.cleanup();
    }
  }
});

test("namespace unknown reply, EOF, framing, abort or timeout never retransmits RELEASE or reconnects", async () => {
  for (const mode of ["eof", "truncated", "utf8", "length", "abort", "timeout"] as const) {
    const f = fixture();
    try {
      const session = await f.ready(),
        controller = new AbortController();
      f.onRequest(() => {
        if (mode === "eof") f.child.stdout.end();
        if (mode === "truncated") {
          f.bytes(frame(JSON.stringify(lifetime(operations[0][2]))).subarray(0, 9));
          f.child.stdout.end();
        }
        if (mode === "utf8") f.bytes(frame(new Uint8Array([0xff])));
        if (mode === "length") f.bytes(Buffer.from([0, 0x10, 0, 1]));
        if (mode === "abort") controller.abort();
      });
      await expect(session.releaseNamespace(controller.signal)).rejects.toThrow();
      const sent = f.writes.length;
      f.onRequest(f.standard);
      await expect(session.releaseNamespace(signal())).rejects.toThrow("one_use");
      await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
      await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
      expect(f.kinds().filter((kind) => kind === operations[0][1])).toHaveLength(1);
      await expect(session.close()).rejects.toThrow("custody_retained");
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
    } finally {
      f.cleanup();
    }
  }
});

for (const [method, requestKind, replyKind] of operations) {
  test(`namespace ${method} checks cancellation after its last reply await without stream reuse`, async () => {
    const f = fixture();
    try {
      const session = await f.ready(),
        controller = new AbortController();
      if (method !== "releaseNamespace") await session.releaseNamespace(signal());
      f.onRequest((kind) => {
        if (kind !== requestKind) return f.standard(kind);
        f.reply(lifetime(replyKind));
        // Reply resolves the actual pending raw request synchronously. Its
        // signal listener is gone; abort before the public async continuation.
        queueMicrotask(() => controller.abort());
      });
      await expect(session[method](controller.signal)).rejects.toThrow();
      const sent = f.writes.length;
      f.onRequest(f.standard);
      await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
      await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
      await expect(session.close()).rejects.toThrow("custody_retained");
    } finally {
      f.cleanup();
    }
  });
}

test("namespace zero counts and all release flags do not turn a born owner into released-uncreated close success", async () => {
  const f = fixture();
  try {
    const session = await f.ready();
    f.onRequest((kind) =>
      kind === operations[0][1]
        ? f.reply(lifetime(operations[0][2], { referenceReleased: 1, netGone: 1 }))
        : f.reply({
            kind: "linux-oci-cancel-observation@1",
            stage: "cancel",
            errno: 0,
            custody: "released-uncreated",
            barrier: "unproven",
          }),
    );
    expect(await session.releaseNamespace(signal())).toMatchObject({
      fullIpSockets: "0",
      requests: "0",
      timewait: "0",
      packetGroups: "0",
      referenceReleased: 1,
      netGone: 1,
      barrier: "unproven",
    });
    await expect(session.close()).rejects.toThrow("custody_retained");
    f.child.emit("exit", 0, null);
    f.child.emit("close", 0, null);
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
  } finally {
    f.cleanup();
  }
});

test("namespace physical spawn uses an empty environment with no own or inherited fields", async () => {
  const f = fixture();
  try {
    const session = await f.ready();
    const environment = f.raw.mock.calls[0]?.[2]?.env;
    if (environment === undefined) throw new Error("original spawn environment absent");
    // Inspect spawn options only; never enumerate or copy host environment values.
    expect(Reflect.ownKeys(environment)).toEqual([]);
    expect(Object.getPrototypeOf(environment)).toBeNull();
    expect(f.raw).toHaveBeenCalledTimes(1);
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
  } finally {
    f.cleanup();
  }
});
