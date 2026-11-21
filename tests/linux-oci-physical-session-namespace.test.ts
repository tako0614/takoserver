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

// C28's kind-only facts never certify original accepted custody or full traffic.
// The original initialized class, framing, stdin and stdout remain under test.
const retirementOperations = [
  [
    "beginTrackedJoin",
    "linux-oci-begin-tracked-join@1",
    "linux-oci-tracked-join-handoff@1",
    "begin-tracked-join",
  ],
  [
    "readTrackedJoin",
    "linux-oci-read-tracked-join@1",
    "linux-oci-tracked-owner-destruction@1",
    "read-tracked-join",
  ],
  ["deleteBorn", "linux-oci-delete-born@1", "linux-oci-born-delete-observation@1", "delete-born"],
  [
    "joinBornDelete",
    "linux-oci-join-born-delete@1",
    "linux-oci-born-delete-join-observation@1",
    "join-born-delete",
  ],
  ["disposeBorn", "linux-oci-dispose-born@1", "linux-oci-local-disposal@1", "dispose-born"],
  [
    "continueBornDisposal",
    "linux-oci-continue-born-disposal@1",
    "linux-oci-local-disposal-continuation@1",
    "continue-born-disposal",
  ],
] as const;
function retirementFact(kind: string) {
  return { kind, barrier: "unproven" };
}
function retirementReplies(f: ReturnType<typeof fixture>) {
  f.onRequest((kind) => {
    const op = retirementOperations.find(([, requestKind]) => requestKind === kind);
    if (op) f.reply(retirementFact(op[2]));
    else f.standard(kind);
  });
}
async function retirementReady(f: ReturnType<typeof fixture>, index: number) {
  const session = await f.ready();
  await session.releaseNamespace(signal());
  retirementReplies(f);
  for (let step = 0; step < index; step++) {
    const op = retirementOperations[step];
    if (!op) throw new Error("missing operation");
    if (step === 4) {
      // Only an exact retained initial DISPOSE refusal leaves continuation.
      f.onRequest(() => f.reply(refused(op[3])));
      await expect(session[op[0]](signal())).rejects.toThrow();
      retirementReplies(f);
    } else await session[op[0]](signal());
  }
  return session;
}

test("retirement wire uses six original nofield operations with exact two-field facts and no legacy close success", async () => {
  const f = fixture();
  try {
    const session = await retirementReady(f, 0);
    for (const [index, [method, requestKind, replyKind, stage]] of retirementOperations.entries()) {
      if (index === 4) {
        f.onRequest(() => f.reply(refused(stage)));
        await expect(session[method](signal())).rejects.toThrow();
        retirementReplies(f);
      } else {
        const observed = await session[method](signal());
        expect<unknown>(observed).toEqual(retirementFact(replyKind));
        expect(Object.keys(observed)).toEqual(["kind", "barrier"]);
        expect(Object.isFrozen(observed)).toBe(true);
      }
      expect(f.writes.at(-1)?.subarray(4).toString()).toBe(JSON.stringify({ kind: requestKind }));
    }
    const sent = f.writes.length;
    await expect(session.continueBornDisposal(signal())).rejects.toThrow();
    await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.writes).toHaveLength(sent);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
    expect(f.raw).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

test("retirement wire rejects missing original init or namespace phases and every unsent successor without IO", async () => {
  for (const initialized of [false, true]) {
    const f = fixture();
    try {
      const session = initialized ? await f.ready() : f.open();
      const sent = f.writes.length;
      for (const [method] of retirementOperations)
        await expect(session[method](signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
    } finally {
      f.cleanup();
    }
  }
  const f = fixture();
  try {
    const session = await retirementReady(f, 0);
    const sent = f.writes.length;
    for (const [method] of retirementOperations.slice(1))
      await expect(session[method](signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(sent);
  } finally {
    f.cleanup();
  }
});

test("retirement wire consumes BEGIN DELETE and DISPOSE once and blocks old observers after handoff", async () => {
  const f = fixture();
  try {
    const session = await retirementReady(f, 1);
    let sent = f.writes.length;
    await expect(session.beginTrackedJoin(signal())).rejects.toThrow("one_use");
    await expect(session.observeStopped(signal())).rejects.toThrow();
    await expect(session.observeStarted(signal())).rejects.toThrow();
    await expect(session.joinInit(signal())).rejects.toThrow();
    await expect(session.continueNamespaceRelease(signal())).rejects.toThrow();
    await expect(session.observeNamespaceLifetime(signal())).rejects.toThrow();
    await expect(session.deleteBorn(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(sent);
    await session.readTrackedJoin(signal());
    await session.deleteBorn(signal());
    sent = f.writes.length;
    await expect(session.deleteBorn(signal())).rejects.toThrow("one_use");
    await expect(session.readTrackedJoin(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(sent);
    f.onRequest(() => f.reply(refused("dispose-born")));
    await expect(session.disposeBorn(signal())).rejects.toThrow();
    sent = f.writes.length;
    await expect(session.disposeBorn(signal())).rejects.toThrow("one_use");
    await expect(session.joinBornDelete(signal())).rejects.toThrow();
    expect(f.writes).toHaveLength(sent);
  } finally {
    f.cleanup();
  }
});

test("retirement wire permits only same-stream READ JOIN or disposal continuation after exact retained refusal", async () => {
  for (const [index, successor] of [
    [0, 1],
    [2, 3],
    [4, 5],
  ] as const) {
    const f = fixture();
    try {
      const session = await retirementReady(f, index);
      const op = retirementOperations[index],
        next = retirementOperations[successor];
      f.onRequest(() => f.reply(refused(op[3])));
      await expect(session[op[0]](signal())).rejects.toThrow();
      const sent = f.writes.length;
      await expect(session[op[0]](signal())).rejects.toThrow("one_use");
      expect(f.writes).toHaveLength(sent);
      retirementReplies(f);
      expect<unknown>(await session[next[0]](signal())).toEqual(retirementFact(next[2]));
      expect(f.writes).toHaveLength(sent + 1);
      expect(f.raw).toHaveBeenCalledTimes(1);
    } finally {
      f.cleanup();
    }
  }
});

for (const [index, [method, , replyKind, stage]] of retirementOperations.entries()) {
  test(`retirement wire ${method} rejects malformed or foreign canonical replies without retry`, async () => {
    for (const mode of [
      "extra",
      "order",
      "barrier",
      "wrong-kind",
      "frame",
      "request",
      "foreign-stage",
      "uncreated",
    ]) {
      const f = fixture();
      try {
        const session = await retirementReady(f, index);
        f.onRequest(() => {
          if (mode === "extra") f.reply({ ...retirementFact(replyKind), nativeId: claim });
          if (mode === "order") f.json(JSON.stringify({ barrier: "unproven", kind: replyKind }));
          if (mode === "barrier") f.reply({ kind: replyKind, barrier: "complete" });
          if (mode === "wrong-kind")
            f.reply(retirementFact(retirementOperations[(index + 1) % 6]?.[2] ?? "unknown"));
          if (mode === "frame" || mode === "request") f.reply(refused(mode));
          if (mode === "foreign-stage") f.reply(refused("release-namespace"));
          if (mode === "uncreated") f.reply(refused(stage, "released-uncreated"));
        });
        await expect(session[method](signal())).rejects.toThrow();
        const sent = f.writes.length;
        retirementReplies(f);
        for (const [next] of retirementOperations)
          await expect(session[next](signal())).rejects.toThrow();
        expect(f.writes).toHaveLength(sent);
        await expect(session.close()).rejects.toThrow("custody_retained");
        expect(f.writes).toHaveLength(sent);
      } finally {
        f.cleanup();
      }
    }
  });

  test(`retirement wire ${method} seals cancellation after its last reply await`, async () => {
    const f = fixture();
    try {
      const session = await retirementReady(f, index),
        controller = new AbortController();
      f.onRequest(() => {
        f.reply(retirementFact(replyKind));
        queueMicrotask(() => controller.abort());
      });
      await expect(session[method](controller.signal)).rejects.toThrow();
      const sent = f.writes.length;
      retirementReplies(f);
      for (const [next] of retirementOperations)
        await expect(session[next](signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
      await expect(session.close()).rejects.toThrow("custody_retained");
    } finally {
      f.cleanup();
    }
  });
}

test("retirement wire loses framing EOF timeout or write failure without any resynchronization", async () => {
  for (const mode of ["partial", "eof", "timeout", "write-error", "double-frame"]) {
    const f = fixture();
    try {
      const session = await retirementReady(f, 0);
      f.onRequest(() => {
        if (mode === "partial") {
          f.bytes(Buffer.from([0, 0]));
          f.child.stdout.emit("end");
        }
        if (mode === "eof") f.child.stdout.emit("end");
        if (mode === "write-error") f.child.stdin.emit("error", new Error("raw write"));
        if (mode === "double-frame")
          f.bytes(
            Buffer.concat([
              frame(JSON.stringify(retirementFact(retirementOperations[0][2]))),
              frame("{}"),
            ]),
          );
      });
      await expect(session.beginTrackedJoin(signal())).rejects.toThrow();
      const sent = f.writes.length;
      retirementReplies(f);
      await expect(session.readTrackedJoin(signal())).rejects.toThrow();
      await expect(session.beginTrackedJoin(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
      expect(f.raw).toHaveBeenCalledTimes(1);
    } finally {
      f.cleanup();
    }
  }
});

test("retirement wire accepts the dedicated disposal reply followed by EOF or zero exit without legacy close success", async () => {
  for (const index of [4, 5])
    for (const end of ["eof", "exit", "close"]) {
      const f = fixture();
      try {
        const session = await retirementReady(f, index),
          op = retirementOperations[index];
        if (!op) throw new Error("missing operation");
        f.onRequest(() => {
          f.reply(retirementFact(op[2]));
          if (end === "eof") f.child.stdout.emit("end");
          if (end === "exit") f.child.emit("exit", 0, null);
          if (end === "close") f.child.emit("close", 0, null);
        });
        expect<unknown>(await session[op[0]](signal())).toEqual(retirementFact(op[2]));
        const sent = f.writes.length;
        await expect(session.close()).rejects.toThrow("custody_retained");
        expect(f.writes).toHaveLength(sent);
      } finally {
        f.cleanup();
      }
    }
});

test("retirement wire disposal reply cannot hide trailing data abnormal exit cancellation or close before resume", async () => {
  for (const mode of [
    "trailing",
    "exit-trailing",
    "eof-trailing",
    "close-trailing",
    "exit",
    "signal",
    "stdout-error",
    "abort",
    "close",
  ]) {
    const f = fixture();
    try {
      const session = await retirementReady(f, 4),
        controller = new AbortController();
      let closing: Promise<void> | undefined;
      f.onRequest(() => {
        f.reply(retirementFact(retirementOperations[4][2]));
        if (mode === "trailing") f.bytes(Buffer.from([0]));
        if (mode === "exit-trailing") {
          f.child.emit("exit", 0, null);
          f.bytes(Buffer.from([0]));
        }
        if (mode === "eof-trailing") {
          f.child.stdout.emit("end");
          f.bytes(Buffer.from([0]));
        }
        if (mode === "close-trailing") {
          f.child.emit("close", 0, null);
          f.bytes(Buffer.from([0]));
        }
        if (mode === "exit") f.child.emit("exit", 1, null);
        if (mode === "signal") f.child.emit("exit", null, "SIGTERM");
        if (mode === "stdout-error") f.child.stdout.emit("error", new Error("raw stream"));
        if (mode === "abort") {
          f.child.stdout.emit("end");
          queueMicrotask(() => controller.abort());
        }
        if (mode === "close") {
          closing = session.close();
          closing.catch(() => {});
        }
      });
      await expect(session.disposeBorn(controller.signal)).rejects.toThrow();
      if (closing) await expect(closing).rejects.toThrow("custody_retained");
      const sent = f.writes.length;
      await expect(session.continueBornDisposal(signal())).rejects.toThrow();
      expect(f.writes).toHaveLength(sent);
    } finally {
      f.cleanup();
    }
  }
});

test("retirement helper join waits for original zero exit AND close without another wire operation", async () => {
  const f = fixture();
  try {
    const session = await retirementReady(f, 4);
    await session.disposeBorn(signal());
    const sent = f.writes.length;
    let settled = false;
    const joined = session.joinDisposedHelper(signal());
    void joined.then(() => {
      settled = true;
    });
    f.child.stdout.emit("end");
    await Promise.resolve();
    expect(settled).toBe(false);
    f.child.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.child.emit("close", 0, null);
    expect(await joined).toEqual({ kind: "linux-oci-disposed-helper-exit@1", barrier: "unproven" });
    expect(f.writes).toHaveLength(sent);
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.writes).toHaveLength(sent);
  } finally {
    f.cleanup();
  }
});

test("retirement helper join timeout and wait cancellation only permit rejoining the same original handle", async () => {
  for (const mode of ["timeout", "abort"]) {
    const f = fixture();
    try {
      const session = await retirementReady(f, 4),
        controller = new AbortController();
      await session.disposeBorn(signal());
      const sent = f.writes.length;
      const joined = session.joinDisposedHelper(controller.signal);
      if (mode === "abort") controller.abort();
      await expect(joined).rejects.toThrow("custody_retained");
      f.child.emit("exit", 0, null);
      f.child.emit("close", 0, null);
      expect(await session.joinDisposedHelper(signal())).toEqual({
        kind: "linux-oci-disposed-helper-exit@1",
        barrier: "unproven",
      });
      expect(f.writes).toHaveLength(sent);
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
    } finally {
      f.cleanup();
    }
  }
});

test("retirement helper join refuses missing disposal and incomplete or failed child evidence", async () => {
  for (const mode of ["no-dispose", "no-exit", "nonzero", "signal", "stream-error"]) {
    const f = fixture();
    try {
      const session = await retirementReady(f, 4);
      if (mode !== "no-dispose") await session.disposeBorn(signal());
      const sent = f.writes.length;
      if (mode === "nonzero") f.child.emit("exit", 1, null);
      if (mode === "signal") f.child.emit("exit", null, "SIGTERM");
      if (mode === "stream-error") f.child.stdout.emit("error", new Error("raw stdout"));
      if (mode !== "no-dispose") f.child.emit("close", 0, null);
      await expect(session.joinDisposedHelper(signal())).rejects.toThrow("custody_retained");
      expect(f.writes).toHaveLength(sent);
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
    } finally {
      f.cleanup();
    }
  }
});

test("retirement helper join fences abort or legacy close after the actual close event before async resume", async () => {
  for (const mode of ["abort", "close"]) {
    const f = fixture();
    try {
      const session = await retirementReady(f, 4),
        controller = new AbortController();
      await session.disposeBorn(signal());
      let closing: Promise<void> | undefined;
      f.child.once("close", () => {
        if (mode === "abort") controller.abort();
        else {
          closing = session.close();
          closing.catch(() => {});
        }
      });
      const sent = f.writes.length;
      const joined = session.joinDisposedHelper(controller.signal);
      f.child.emit("exit", 0, null);
      f.child.emit("close", 0, null);
      await expect(joined).rejects.toThrow("custody_retained");
      if (closing) await expect(closing).rejects.toThrow("custody_retained");
      expect(f.writes).toHaveLength(sent);
    } finally {
      f.cleanup();
    }
  }
});

test("retirement helper join cannot consume a reply before the public disposal final cancellation fence", async () => {
  const f = fixture();
  try {
    const session = await retirementReady(f, 4);
    let premature: Promise<unknown> | undefined;
    f.onRequest(() => {
      f.reply(retirementFact(retirementOperations[4][2]));
      premature = session.joinDisposedHelper(signal());
      premature.catch(() => {});
      f.child.emit("exit", 0, null);
      f.child.emit("close", 0, null);
    });
    await session.disposeBorn(signal());
    if (!premature) throw new Error("no reentrant attempt");
    await expect(premature).rejects.toThrow("custody_retained");
    const sent = f.writes.length;
    expect(await session.joinDisposedHelper(signal())).toEqual({
      kind: "linux-oci-disposed-helper-exit@1",
      barrier: "unproven",
    });
    expect(f.writes).toHaveLength(sent);
    expect(f.raw).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

test("disposed local close reasserts the original successful child facts without any additional IO", async () => {
  const f = fixture();
  try {
    const session = await retirementReady(f, 4);
    await session.disposeBorn(signal());
    f.child.emit("exit", 0, null);
    f.child.emit("close", 0, null);
    await session.joinDisposedHelper(signal());
    const sent = f.writes.length;
    await session.closeDisposedHelper();
    await session.closeDisposedHelper();
    expect(f.writes).toHaveLength(sent);
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
    // The separate born-disposal API does not weaken the old close contract.
    await expect(session.close()).rejects.toThrow("custody_retained");
    expect(f.writes).toHaveLength(sent);
  } finally {
    f.cleanup();
  }
});

test("disposed local close rejects unjoined wrong or unknown same-child facts without IO", async () => {
  for (const mode of [
    "no-dispose",
    "no-exit-or-close",
    "exit-only",
    "close-only",
    "nonzero",
    "signal",
    "stream-error",
  ]) {
    const f = fixture();
    try {
      const session = await retirementReady(f, 4);
      if (mode !== "no-dispose") await session.disposeBorn(signal());
      if (mode !== "close-only" && mode !== "no-exit-or-close")
        f.child.emit(
          "exit",
          mode === "nonzero" ? 1 : mode === "signal" ? null : 0,
          mode === "signal" ? "SIGTERM" : null,
        );
      if (mode !== "exit-only" && mode !== "no-exit-or-close") f.child.emit("close", 0, null);
      if (mode === "stream-error") f.child.stdout.emit("error", new Error("raw stdout"));
      const sent = f.writes.length;
      await expect(session.closeDisposedHelper()).rejects.toThrow("custody_retained");
      expect(f.writes).toHaveLength(sent);
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
    } finally {
      f.cleanup();
    }
  }
});

test("disposed local close does not turn its own repeat seal into a fact after trailing bytes", async () => {
  const f = fixture();
  try {
    const session = await retirementReady(f, 4);
    await session.disposeBorn(signal());
    f.child.emit("exit", 0, null);
    f.child.emit("close", 0, null);
    await session.joinDisposedHelper(signal());
    await session.closeDisposedHelper();
    const sent = f.writes.length;
    f.child.stdout.emit("data", Buffer.from([0]));
    await expect(session.closeDisposedHelper()).rejects.toThrow("custody_retained");
    expect(f.writes).toHaveLength(sent);
    expect(f.counts()).toEqual({ kills: 0, unrefs: 0 });
  } finally {
    f.cleanup();
  }
});

test("disposed local close cannot precede the original disposal final observation", async () => {
  const f = fixture();
  try {
    const session = await retirementReady(f, 4);
    let premature: Promise<void> | undefined;
    f.onRequest(() => {
      f.reply(retirementFact(retirementOperations[4][2]));
      f.child.emit("exit", 0, null);
      f.child.emit("close", 0, null);
      premature = session.closeDisposedHelper();
      premature.catch(() => {});
    });
    await session.disposeBorn(signal());
    if (!premature) throw new Error("no raw reentrant close");
    await expect(premature).rejects.toThrow("custody_retained");
    const sent = f.writes.length;
    await session.closeDisposedHelper();
    expect(f.writes).toHaveLength(sent);
  } finally {
    f.cleanup();
  }
});

test("disposed local close preserves an earlier legacy-close admission refusal", async () => {
  const f = fixture();
  try {
    const session = await retirementReady(f, 4);
    await session.disposeBorn(signal());
    f.child.emit("exit", 0, null);
    f.child.emit("close", 0, null);
    const sent = f.writes.length;
    await expect(session.close()).rejects.toThrow("custody_retained");
    await expect(session.closeDisposedHelper()).rejects.toThrow("custody_retained");
    expect(f.writes).toHaveLength(sent);
  } finally {
    f.cleanup();
  }
});
