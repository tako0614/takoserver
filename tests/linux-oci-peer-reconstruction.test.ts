import { expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { rm as importedRm, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import { V2_CONTAINER_OWNER_ALLOCATION_EXPAND } from "../src/takoform-v2/container-owner-schema.ts";
import {
  acceptedHttpSelection,
  acceptedRawHttp,
  originalOwnedOciFixture,
} from "./linux-oci-owned-bundle.test.ts";

// NONSECRET fixture keys/capabilities; actual memorySql/Core/creator and raw
// spawn streams only. Imported old cases are filtered and never called.
async function fixture(
  options: {
    pending?: boolean;
    v1?: boolean;
    normal?: boolean;
    runtimeFirst?: boolean;
    localCleanup?: boolean;
    configuredPeer?: boolean;
    joinFault?: "foreign" | "refused" | "unknown" | "pidns";
    namespaceFault?:
      | "retained"
      | "lost"
      | "foreign"
      | "malformed"
      | "unknown"
      | "cookie"
      | "regress";
    retirementFault?:
      | "begin-retained"
      | "delete-retained"
      | "dispose-retained"
      | "begin-lost"
      | "delete-lost"
      | "dispose-lost"
      | "missing"
      | "wrong-phase";
    hResultFault?: "stdout" | "stderr" | "nonzero" | "signal" | "unknown";
    allocationSchema?: boolean;
    managementFault?: "incomplete" | "missing-reply" | "lost-reply";
  } = {},
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0xa5),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const comparison = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0x5a),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  let byte = 0x30;
  const random = spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(value: T): T => {
      if (!(value instanceof Uint8Array)) throw Error("raw random shape");
      value.fill(++byte);
      return value;
    },
  );
  const network = spyOn(net, "createConnection").mockImplementation(() => {
    throw Error("unexpected OS socket");
  });
  try {
    const f = await originalOwnedOciFixture(false, {
      ...(options.v1 ? { parentControl: true } : { parentPeer: true }),
      ...(options.runtimeFirst ? { parentPeerRuntime: true } : {}),
      ...(options.localCleanup ? { parentPeerLocal: true } : {}),
      ...(options.pending === undefined ? {} : { peerPending: options.pending }),
      ...(options.normal === undefined ? {} : { normalBackend: options.normal }),
      ...(options.managementFault === undefined
        ? {}
        : { peerManagementFault: options.managementFault }),
      ...(options.joinFault === undefined ? {} : { peerJoinFault: options.joinFault }),
      ...(options.namespaceFault === undefined
        ? {}
        : { peerNamespaceFault: options.namespaceFault }),
      ...(options.retirementFault === undefined
        ? {}
        : { peerRetirementFault: options.retirementFault }),
      ...(options.hResultFault === undefined ? {} : { peerHResultFault: options.hResultFault }),
      ...(options.allocationSchema === undefined
        ? {}
        : { peerAllocationSchema: options.allocationSchema }),
      ...(options.configuredPeer
        ? acceptedHttpSelection()
        : { nativeMode: "retire-pending" as const }),
      fixedKeys: { key, comparison },
    });
    return Object.assign(f, {
      network,
      async cleanup() {
        try {
          await f.close();
        } catch {
          /* teardown only; no product completion */
        } finally {
          network.mockRestore();
          random.mockRestore();
        }
      },
    });
  } catch (error) {
    network.mockRestore();
    random.mockRestore();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(f: Fixture) {
  await f.create();
  await f.engine.runNext();
  if (f.failures[0]) throw f.failures[0];
}
async function document(f: Fixture) {
  const row = (await f.sql.query("SELECT native_control FROM tf_v2_container_create_claims"))[0];
  if (typeof row?.native_control !== "string") throw Error("sealed original absent");
  return JSON.parse(row.native_control);
}
async function plaintext(f: Fixture, d: Awaited<ReturnType<typeof document>>) {
  const bytes = await decryptContainerSecretBytes(
    f.configuredInputs.keyring.current.key,
    decodeContainerSecretBytes(d.nonce),
    decodeContainerSecretBytes(d.ciphertext),
    new TextEncoder().encode(canonicalJson(d.scope)),
  );
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
async function altered(
  f: Fixture,
  change: (body: {
    allocation: { root: { ino: string } };
    peer: { inode: string; bootId: string };
  }) => void,
) {
  const d = await document(f),
    body = await plaintext(f, d);
  change(body);
  const nonce = new Uint8Array(12).fill(0x67);
  d.nonce = encodeContainerSecretBytes(nonce);
  d.ciphertext = encodeContainerSecretBytes(
    new Uint8Array(
      await encryptContainerSecretBytes(
        f.configuredInputs.keyring.current.key,
        nonce,
        new TextEncoder().encode(JSON.stringify(body)),
        new TextEncoder().encode(canonicalJson(d.scope)),
      ),
    ),
  );
  expect(d.ciphertext.length).toBeGreaterThan(0);
  const roundtrip = await decryptContainerSecretBytes(
    f.configuredInputs.keyring.current.key,
    nonce,
    decodeContainerSecretBytes(d.ciphertext),
    new TextEncoder().encode(canonicalJson(d.scope)),
  );
  try {
    expect(new TextDecoder().decode(roundtrip)).toBe(JSON.stringify(body));
  } finally {
    roundtrip.fill(0);
  }
  return canonicalJson(d);
}
const controlRead = (sql: string) =>
  sql.startsWith("SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=");
const rejected = async (p: Promise<unknown>) => {
  const result = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(result).toBeInstanceOf(Error);
};

test("peer reconstruction fresh sameSql creator authenticates original capture and reads same P without replacement", async () => {
  const f = await fixture();
  let checked = false;
  f.beforeStart(async (execution) => {
    const d = await document(f),
      b = await plaintext(f, d),
      request = f.recordedCreate();
    expect(d.kind).toBe("linux-oci-sealed-control@1");
    expect(d.scope.purpose).toBe("takoserver.linux-oci-parent-peer-control@1");
    expect(d.scope).not.toHaveProperty("allocation");
    expect(d.scope).not.toHaveProperty("createDigest");
    expect(b.createDigest).toBe(
      await canonicalDigest({ kind: "linux-oci-create-stopped@1", ...request }),
    );
    const stat = await lstat(request.allocationRoot, { bigint: true });
    expect(b.allocation.root.ino).toBe(String(stat.ino));
    expect(b.allocation.root.dev).toBe(String(stat.dev));
    expect(canonicalJson(JSON.parse(b.allocation.receiptBytes))).toBe(
      canonicalJson(d.scope.artifact),
    );
    const fresh = f.reconstructParent(),
      before = f.nativeCounts();
    try {
      expect(await fresh.readRetainedPeerResults(execution)).toEqual([
        { kind: "linux-oci-parent-h-exited@1", error: 0, barrier: "unproven" },
      ]);
      await rejected(fresh.readRetainedPeerResults(execution));
      expect(f.nativeCounts()).toEqual({
        processes: before.processes + 1,
        requests: [...before.requests, "linux-oci-parent-read-result@2"],
      });
      checked = true;
    } finally {
      await fresh.close();
    }
  });
  try {
    await run(f);
    expect(checked).toBe(true);
    expect(f.network).not.toHaveBeenCalled();
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("peer reconstruction rejects tampered ciphertext crossaccepted artifact and authenticated wrong capture before connector", async () => {
  const f = await fixture();
  let checked = 0;
  f.beforeStart(async (execution) => {
    const d = await document(f),
      badCapture = await altered(f, (b) => {
        b.allocation.root.ino = String(BigInt(b.allocation.root.ino) + 1n);
      });
    for (const raw of [
      canonicalJson({
        ...d,
        ciphertext: encodeContainerSecretBytes(new Uint8Array(32).fill(0x55)),
      }),
      canonicalJson({
        ...d,
        scope: { ...d.scope, artifact: { ...d.scope.artifact, resourceUid: "foreign-resource" } },
      }),
      badCapture,
    ]) {
      const query = f.sql.query.bind(f.sql),
        spy = spyOn(f.sql, "query").mockImplementation((sql, params) =>
          controlRead(sql) ? Promise.resolve([{ native_control: raw }]) : query(sql, params),
        );
      const fresh = f.reconstructParent(),
        before = f.nativeCounts();
      try {
        await rejected(fresh.readRetainedPeerResults(execution));
        expect(f.nativeCounts()).toEqual(before);
        checked++;
      } finally {
        spy.mockRestore();
        await fresh.close();
      }
    }
  });
  try {
    await run(f);
    expect(checked).toBe(3);
  } finally {
    await f.cleanup();
  }
});

test("peer reconstruction compares actual receipt inode and exact row after awaited files before connector", async () => {
  const f = await fixture();
  let checked = 0;
  f.beforeStart(async (execution) => {
    const request = f.recordedCreate(),
      path = request.allocationRoot + "/.tako-oci-artifact.json",
      backup = path + ".saved",
      d = await document(f);
    await rename(path, backup);
    await writeFile(path, JSON.stringify(d.scope.artifact), { mode: 0o600 });
    const fresh = f.reconstructParent(),
      before = f.nativeCounts();
    try {
      await rejected(fresh.readRetainedPeerResults(execution));
      expect(f.nativeCounts()).toEqual(before);
      checked++;
    } finally {
      await rename(backup, path);
      await fresh.close();
    }
    let reads = 0;
    const query = f.sql.query.bind(f.sql),
      spy = spyOn(f.sql, "query").mockImplementation((sql, params) =>
        controlRead(sql) && ++reads >= 2
          ? Promise.resolve([{ native_control: null }])
          : query(sql, params),
      );
    const other = f.reconstructParent();
    try {
      await rejected(other.readRetainedPeerResults(execution));
      expect(f.nativeCounts()).toEqual(before);
      expect(reads).toBeGreaterThanOrEqual(2);
      checked++;
    } finally {
      spy.mockRestore();
      await other.close();
    }
  });
  try {
    await run(f);
    expect(checked).toBe(2);
  } finally {
    await f.cleanup();
  }
});

test("peer reconstruction wrong peer and boot retain connector unknown without resending or creating H", async () => {
  const f = await fixture();
  let checked = 0;
  f.beforeStart(async (execution) => {
    for (const fault of ["inode", "boot"]) {
      const raw = await altered(f, (b) => {
        if (fault === "inode") b.peer.inode = String(BigInt(b.peer.inode) + 1n);
        else b.peer.bootId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      });
      const query = f.sql.query.bind(f.sql),
        spy = spyOn(f.sql, "query").mockImplementation((sql, params) =>
          controlRead(sql) ? Promise.resolve([{ native_control: raw }]) : query(sql, params),
        );
      const fresh = f.reconstructParent(),
        before = f.nativeCounts();
      try {
        await rejected(fresh.readRetainedPeerResults(execution));
        const after = f.nativeCounts();
        expect(after.processes).toBe(before.processes + 1);
        await rejected(fresh.readRetainedPeerResults(execution));
        expect(f.nativeCounts()).toEqual(after);
        await rejected(fresh.close());
        await rejected(fresh.close());
        expect(f.nativeCounts()).toEqual(after);
        checked++;
      } finally {
        spy.mockRestore();
        try {
          await fresh.close();
        } catch {
          /* same UNKNOWN child retained by product */
        }
      }
    }
  });
  try {
    await run(f);
    expect(checked).toBe(2);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("peer reconstruction pending H fact remains refusal and cancellation NULL and old v1 do not bootstrap", async () => {
  const f = await fixture({ pending: true });
  let checked = false;
  f.beforeStart(async (execution) => {
    const fresh = f.reconstructParent();
    try {
      expect(await fresh.readRetainedPeerResults(execution)).toEqual([
        { kind: "linux-oci-parent-h-result-refused@1", error: 11, barrier: "unproven" },
      ]);
    } finally {
      await fresh.close();
    }
    const before = f.nativeCounts(),
      cancel = new AbortController();
    cancel.abort();
    const cancelled = f.reconstructParent();
    try {
      await rejected(cancelled.readRetainedPeerResults(execution, cancel.signal));
      expect(f.nativeCounts()).toEqual(before);
    } finally {
      await cancelled.close();
    }
    const query = f.sql.query.bind(f.sql),
      spy = spyOn(f.sql, "query").mockImplementation((sql, params) =>
        controlRead(sql) ? Promise.resolve([{ native_control: null }]) : query(sql, params),
      );
    const missing = f.reconstructParent();
    try {
      await rejected(missing.readRetainedPeerResults(execution));
      expect(f.nativeCounts()).toEqual(before);
    } finally {
      spy.mockRestore();
      await missing.close();
    }
    checked = true;
  });
  try {
    await run(f);
    expect(checked).toBe(true);
  } finally {
    await f.cleanup();
  }
  const v1 = await fixture({ v1: true });
  v1.beforeStart(async (execution) => {
    const fresh = v1.reconstructParent(),
      before = v1.nativeCounts();
    try {
      await rejected(fresh.readRetainedPeerResults(execution));
      expect(v1.nativeCounts()).toEqual(before);
    } finally {
      await fresh.close();
    }
  });
  try {
    await run(v1);
  } finally {
    await v1.cleanup();
  }
});

test("peer reconstruction refuses midawait cancellation and original execution mutation before fixed reader", async () => {
  const f = await fixture();
  let checked = 0;
  f.beforeStart(async (execution) => {
    const before = f.nativeCounts(),
      query = f.sql.query.bind(f.sql),
      cancel = new AbortController();
    const spy = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (controlRead(sql)) cancel.abort();
      return rows;
    });
    const first = f.reconstructParent();
    try {
      await rejected(first.readRetainedPeerResults(execution, cancel.signal));
      expect(cancel.signal.aborted).toBe(true);
      expect(f.nativeCounts()).toEqual(before);
      checked++;
    } finally {
      spy.mockRestore();
      await first.close();
    }
    const principal = execution.principal;
    const changed = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (controlRead(sql)) Reflect.set(execution, "principal", "synthetic-foreign");
      return rows;
    });
    const second = f.reconstructParent();
    try {
      await rejected(second.readRetainedPeerResults(execution));
      expect(f.nativeCounts()).toEqual(before);
      checked++;
    } finally {
      Reflect.set(execution, "principal", principal);
      changed.mockRestore();
      await second.close();
    }
  });
  try {
    await run(f);
    expect(checked).toBe(2);
  } finally {
    await f.cleanup();
  }
});

// New cohort only: existing reconstruction cases above are never selected.
async function normalCreate(f: Fixture) {
  await f.create();
  expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
  const row = (
    await f.sql.query("SELECT resource_uid,state FROM tf_v2_container_create_claims")
  )[0];
  if (typeof row?.resource_uid !== "string" || row.state !== "bound")
    throw Error("original bound CREATE absent");
  return row.resource_uid;
}
async function acceptNormalDelete(f: Fixture, uid: string) {
  const fresh = f.reconstructNormal();
  await fresh.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid,
    expectedGeneration: 1,
  });
  return fresh;
}
function stopCount(f: Fixture) {
  return f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1").length;
}

test("peer management ordinary fresh retained DELETE sends STOP then original JOIN only without P replacement or removed CAS", async () => {
  const f = await fixture({ normal: false });
  try {
    const uid = await normalCreate(f),
      before = f.nativeCounts(),
      first = await acceptNormalDelete(f, uid);
    try {
      await first.engine.runNext();
      expect(stopCount(f)).toBe(1);
      expect(f.nativeCounts().processes).toBe(before.processes + 1);
      await first.close();
    } finally {
      await first.close().catch(() => undefined);
    }
    f.advanceNormalClock(60_000);
    const second = f.reconstructNormal();
    try {
      await second.engine.runNext();
      expect(stopCount(f)).toBe(1);
      expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(
        1,
      );
      expect((await f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
        "bound",
      );
      expect(
        f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@2"),
      ).toHaveLength(1);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      await second.close().catch(() => undefined);
    }
  } finally {
    await f.cleanup();
  }
});

test("peer management fresh SQL row and cancellation after actual outcome fence H writes", async () => {
  for (const fault of ["row", "cancel", "execution"]) {
    const f = await fixture({ normal: false });
    try {
      const uid = await normalCreate(f),
        fresh = await acceptNormalDelete(f, uid),
        query = f.sql.query.bind(f.sql);
      let crossed = false,
        armed = false;
      const spy = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
        const rows = await query(sql, params);
        if (
          controlRead(sql) &&
          f.nativeCounts().requests.includes("linux-oci-parent-read-outcome@2")
        ) {
          if (fault === "execution") armed = true;
          else {
            crossed = true;
            if (fault === "row") return [{ native_control: null }];
            void fresh.close().catch(() => undefined);
          }
        } else if (armed && sql.includes(" WHERE i.resource_uid=? AND v.generation=?")) {
          armed = false;
          crossed = true;
          const execution = f.execution;
          if (!execution) throw Error("actual normal execution absent");
          Reflect.set(execution, "leaseToken", "synthetic-late-foreign-lease");
        }
        return rows;
      });
      try {
        await fresh.engine.runNext();
        expect(crossed).toBe(true);
        expect(stopCount(f)).toBe(0);
        expect(
          f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-read-outcome@2"),
        ).toHaveLength(1);
      } finally {
        spy.mockRestore();
        await fresh.close().catch(() => undefined);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test("peer management lost STOP reply reads original captured outcome and next fresh dispatch selects JOIN not resend", async () => {
  const f = await fixture({ normal: false, managementFault: "lost-reply" });
  try {
    const uid = await normalCreate(f),
      first = await acceptNormalDelete(f, uid);
    try {
      await first.engine.runNext();
      expect(stopCount(f)).toBe(1);
      await rejected(first.close());
    } finally {
      await first.close().catch(() => undefined);
    }
    f.advanceNormalClock(60_000);
    const second = f.reconstructNormal();
    try {
      await second.engine.runNext();
      expect(stopCount(f)).toBe(1);
      expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(
        1,
      );
      expect(
        f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@2"),
      ).toHaveLength(1);
      expect((await f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
        "bound",
      );
    } finally {
      await second.close().catch(() => undefined);
    }
  } finally {
    await f.cleanup();
  }
});

test("peer management incomplete original request or missing captured reply cannot issue any STOP or CREATE", async () => {
  for (const managementFault of ["incomplete", "missing-reply"] as const) {
    const f = await fixture({ normal: false, managementFault });
    try {
      const uid = await normalCreate(f),
        fresh = await acceptNormalDelete(f, uid);
      try {
        await fresh.engine.runNext();
        expect(stopCount(f)).toBe(0);
        expect(
          f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-read-outcome@2"),
        ).toHaveLength(1);
        expect(
          f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1"),
        ).toHaveLength(1);
      } finally {
        await fresh.close().catch(() => undefined);
      }
    } finally {
      await f.cleanup();
    }
  }
});

// New configured-peer cohort only. Original HTTP helper is a raw transport
// model; actual installed P/H/kernel/traffic and full retirement are unproved.
test("peer normal configured CREATE reaches original START HTTP publisher complete then fresh DELETE same P", async () => {
  const f = await fixture({ normal: true, configuredPeer: true }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(f.nativeCounts().processes).toBe(1);
    const requests = f.nativeCounts().requests;
    for (const kind of [
      "linux-oci-parent-bootstrap@2",
      "linux-oci-create-stopped@1",
      "linux-oci-start@1",
    ])
      expect(requests.filter((k) => k === kind)).toHaveLength(1);
    expect(
      requests.filter((k) => k === "linux-oci-observe-started@1").length,
    ).toBeGreaterThanOrEqual(3);
    expect(raw.calls).toHaveLength(1);
    expect(
      await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: 1, runtime_epoch: 1 }]);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
    expect((await f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
      "bound",
    );
    const fresh = await acceptNormalDelete(f, accepted.resourceUid);
    try {
      expect(await fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(stopCount(f)).toBe(1);
      expect(f.nativeCounts().processes).toBe(2);
      expect(
        f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-read-outcome@2"),
      ).toHaveLength(1);
      expect(
        f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@2"),
      ).toHaveLength(1);
      expect(
        f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1"),
      ).toHaveLength(1);
      expect((await f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
        "bound",
      );
      await fresh.close();
    } finally {
      await fresh.close().catch(() => undefined);
    }
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    raw.join();
    raw.restore();
    await f.cleanup();
  }
});

// New same-P JOIN cohort only. These observations are produced by the actual
// private connector closure; modeled H frames do not qualify native/kernel flow.
async function originalConfiguredPeerForJoin(
  joinFault?: "foreign" | "refused" | "unknown" | "pidns",
  namespaceFault?: "retained" | "lost" | "foreign" | "malformed" | "unknown" | "cookie" | "regress",
  retirement?: Pick<
    NonNullable<Parameters<typeof fixture>[0]>,
    "retirementFault" | "hResultFault" | "allocationSchema"
  >,
) {
  const f = await fixture({
      normal: true,
      configuredPeer: true,
      ...(joinFault === undefined ? {} : { joinFault }),
      ...(namespaceFault === undefined ? {} : { namespaceFault }),
      ...retirement,
    }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    const stop = await acceptNormalDelete(f, accepted.resourceUid);
    try {
      expect(await stop.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(stopCount(f)).toBe(1);
      await stop.close();
    } finally {
      await stop.close().catch(() => undefined);
    }
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
    f.advanceNormalClock(61_000);
    return {
      f,
      raw,
      fresh: f.reconstructNormal(),
      async close() {
        raw.join();
        raw.restore();
        await f.cleanup();
      },
    };
  } catch (error) {
    raw.join();
    raw.restore();
    await f.cleanup();
    throw error;
  }
}

test("peer JOIN original consuming observation records exact stopped attempt without removed permission", async () => {
  const x = await originalConfiguredPeerForJoin();
  try {
    expect(await x.fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(stopCount(x.f)).toBe(1);
    expect(x.f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(
      1,
    );
    const row = (
      await x.f.sql.query(
        "SELECT state,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts",
      )
    )[0];
    expect(row?.state).toBe("exited");
    expect(typeof row?.confirmed_exited_at_ms).toBe("number");
    expect(Number(row?.confirmed_exited_at_ms)).toBeGreaterThanOrEqual(
      Number(row?.confirmed_running_at_ms),
    );
    expect((await x.f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
      "bound",
    );
    expect((await x.f.sql.query("SELECT phase FROM tf_v2_resources"))[0]?.phase).toBe("deleting");
    expect(
      x.f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@2"),
    ).toHaveLength(1);
    expect(x.f.network).not.toHaveBeenCalled();
    await x.fresh.close();
  } finally {
    await x.fresh.close().catch(() => undefined);
    await x.close();
  }
});

test("peer JOIN foreign retained or unknown original frame never records stopped or resends STOP", async () => {
  for (const fault of ["foreign", "refused", "unknown"] as const) {
    const x = await originalConfiguredPeerForJoin(fault);
    try {
      expect(await x.fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(
        await x.f.sql.query(
          "SELECT state,confirmed_exited_at_ms FROM tf_v2_container_start_attempts",
        ),
      ).toEqual([{ state: "running", confirmed_exited_at_ms: null }]);
      expect(stopCount(x.f)).toBe(1);
      expect(x.f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(
        1,
      );
      expect(
        x.f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@2"),
      ).toHaveLength(1);
    } finally {
      await x.fresh.close().catch(() => undefined);
      await x.close();
    }
  }
});

test("peer JOIN fresh row cancellation and last SELECT execution scope fence stopped SQL", async () => {
  for (const fault of ["row", "cancel", "execution"]) {
    const x = await originalConfiguredPeerForJoin(),
      query = x.f.sql.query.bind(x.f.sql);
    let reached = false;
    const spy = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (!reached && x.f.nativeCounts().requests.includes("linux-oci-join-init@1")) {
        if (fault === "row" && controlRead(sql)) {
          reached = true;
          return [{ native_control: null }];
        }
        if (
          fault !== "row" &&
          sql.startsWith(
            "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts",
          )
        ) {
          reached = true;
          if (fault === "cancel") void x.fresh.close().catch(() => undefined);
          else {
            const execution = x.f.execution;
            if (!execution) throw Error("actual original execution absent");
            Reflect.set(execution, "leaseToken", "synthetic-late-changed-lease");
          }
        }
      }
      return rows;
    });
    try {
      expect(await x.fresh.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(reached).toBe(true);
      expect(stopCount(x.f)).toBe(1);
      expect(
        await query("SELECT state,confirmed_exited_at_ms FROM tf_v2_container_start_attempts"),
      ).toEqual([{ state: "running", confirmed_exited_at_ms: null }]);
    } finally {
      spy.mockRestore();
      await x.fresh.close().catch(() => undefined);
      await x.close();
    }
  }
});

test("peer JOIN changed captured PIDNS cannot supply a stopped record", async () => {
  const x = await originalConfiguredPeerForJoin("pidns");
  try {
    expect(await x.fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(x.f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(
      1,
    );
    expect(
      await x.f.sql.query(
        "SELECT state,confirmed_exited_at_ms FROM tf_v2_container_start_attempts",
      ),
    ).toEqual([{ state: "running", confirmed_exited_at_ms: null }]);
    expect(stopCount(x.f)).toBe(1);
  } finally {
    await x.fresh.close().catch(() => undefined);
    await x.close();
  }
});

// New namespace cohort uses actual configured CREATE/STOP/JOIN and memorySQL.
// No old case is invoked and raw H frames are not native namespace execution.
async function originalJoinedPeer(
  namespaceFault?: Parameters<typeof originalConfiguredPeerForJoin>[1],
  retirement?: Parameters<typeof originalConfiguredPeerForJoin>[2],
) {
  const x = await originalConfiguredPeerForJoin(undefined, namespaceFault, retirement);
  try {
    expect(await x.fresh.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(await x.f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "exited" },
    ]);
    await x.fresh.close();
    x.f.advanceNormalClock(61_000);
    return { ...x, next: x.f.reconstructNormal() };
  } catch (e) {
    await x.fresh.close().catch(() => undefined);
    await x.close();
    throw e;
  }
}
const releaseCount = (f: Fixture) =>
  f.nativeCounts().requests.filter((k) => k === "linux-oci-release-namespace@1").length;
const continueCount = (f: Fixture) =>
  f.nativeCounts().requests.filter((k) => k === "linux-oci-continue-namespace-release@1").length;
async function nextNamespace(x: Awaited<ReturnType<typeof originalJoinedPeer>>) {
  await x.next.close().catch(() => undefined);
  x.f.advanceNormalClock(61_000);
  return x.f.reconstructNormal();
}
test("peer namespace exact original JOIN and SQL exited route RELEASE then same P CONTINUE only", async () => {
  const x = await originalJoinedPeer();
  try {
    expect(await x.next.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(releaseCount(x.f)).toBe(1);
    expect(continueCount(x.f)).toBe(0);
    const later = await nextNamespace(x);
    try {
      expect(await later.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(releaseCount(x.f)).toBe(1);
      expect(continueCount(x.f)).toBe(1);
      expect(stopCount(x.f)).toBe(1);
      expect(x.f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(
        1,
      );
      expect(
        x.f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@2"),
      ).toHaveLength(1);
      expect(
        (await x.f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state,
      ).toBe("bound");
      expect((await x.f.sql.query("SELECT phase FROM tf_v2_resources"))[0]?.phase).toBe("deleting");
      expect(x.f.network).not.toHaveBeenCalled();
      await later.close();
    } finally {
      await later.close().catch(() => undefined);
    }
  } finally {
    await x.next.close().catch(() => undefined);
    await x.close();
  }
});
test("peer namespace retained refusal or lost delivery continues captured original phase without RELEASE replay", async () => {
  for (const fault of ["retained", "lost"] as const) {
    const x = await originalJoinedPeer(fault);
    try {
      expect(await x.next.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(releaseCount(x.f)).toBe(1);
      const later = await nextNamespace(x);
      try {
        expect(await later.engine.runNext()).toMatchObject({
          status: "reconciling",
          effect: "unknown",
        });
        expect(releaseCount(x.f)).toBe(1);
        expect(continueCount(x.f)).toBe(1);
        expect(stopCount(x.f)).toBe(1);
      } finally {
        await later.close().catch(() => undefined);
      }
    } finally {
      await x.next.close().catch(() => undefined);
      await x.close();
    }
  }
});
for (const fault of ["unknown", "foreign", "malformed", "cookie", "regress"] as const) {
  test(`peer namespace rejects ${fault} original namespace facts`, async () => {
    const x = await originalJoinedPeer(fault);
    try {
      expect(await x.next.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(releaseCount(x.f)).toBe(1);
      const later = await nextNamespace(x);
      try {
        expect(await later.engine.runNext()).toMatchObject({
          status: "reconciling",
          effect: "unknown",
        });
        expect(releaseCount(x.f)).toBe(1);
        expect(continueCount(x.f)).toBe(fault === "cookie" || fault === "regress" ? 1 : 0);
        // Rejected connector custody cannot make close a success.
        await expect(later.close()).rejects.toThrow();
      } finally {
        await later.close().catch(() => undefined);
      }
    } finally {
      await x.next.close().catch(() => undefined);
      await x.close();
    }
  });
}
test("peer namespace fresh SQL cancel and final awaited execution fence issue no RELEASE", async () => {
  for (const fault of ["row", "cancel", "execution"]) {
    const x = await originalJoinedPeer(),
      query = x.f.sql.query.bind(x.f.sql);
    let seen = false,
      armed = false;
    const spy = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (
        !seen &&
        controlRead(sql) &&
        x.f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-read-outcome@2").length >=
          3
      ) {
        if (fault === "row") {
          seen = true;
          return [{ native_control: null }];
        }
        armed = true;
      } else if (armed && !seen && sql.includes(" WHERE i.resource_uid=? AND v.generation=?")) {
        armed = false;
        seen = true;
        if (fault === "cancel") void x.next.close().catch(() => undefined);
        else {
          const e = x.f.execution;
          if (!e) throw Error("original execution absent");
          Reflect.set(e, "leaseToken", "synthetic-namespace-late-lease");
        }
      }
      return rows;
    });
    try {
      expect(await x.next.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(seen).toBe(true);
      expect(releaseCount(x.f)).toBe(0);
      expect(stopCount(x.f)).toBe(1);
      expect(await query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
        { state: "exited" },
      ]);
    } finally {
      spy.mockRestore();
      await x.next.close().catch(() => undefined);
      await x.close();
    }
  }
});

// New closed retirement-family cohort; all prefix operations use the original
// normal selfhost/Engine and fresh memorySQL. No prior test case is invoked.
async function originalNamespaceForRetirement(
  options?: Parameters<typeof originalConfiguredPeerForJoin>[2],
) {
  const x = await originalJoinedPeer(undefined, options);
  let current = x.next;
  try {
    for (let i = 0; i < 2; i++) {
      expect(await current.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      await current.close();
      x.f.advanceNormalClock(61_000);
      current = x.f.reconstructNormal();
    }
    expect(releaseCount(x.f)).toBe(1);
    expect(continueCount(x.f)).toBe(1);
    return { ...x, current };
  } catch (e) {
    await current.close().catch(() => undefined);
    await x.close();
    throw e;
  }
}
async function retirementStep(
  x: Awaited<ReturnType<typeof originalNamespaceForRetirement>>,
  kind: string,
) {
  const prior = x.f.nativeCounts().requests.length;
  expect(await x.current.engine.runNext()).toMatchObject({
    status: "reconciling",
    effect: "unknown",
  });
  expect(x.f.nativeCounts().requests.slice(prior)).toContain(`linux-oci-${kind}@1`);
  await x.current.close().catch(() => undefined);
  x.f.advanceNormalClock(61_000);
  x.current = x.f.reconstructNormal();
}
const retirementCount = (f: Fixture, op: string) =>
  f.nativeCounts().requests.filter((k) => k === `linux-oci-${op}@1`).length;
async function helperResultStep(
  x: Awaited<ReturnType<typeof originalNamespaceForRetirement>>,
  known: boolean,
) {
  const query = x.f.sql.query.bind(x.f.sql),
    before = retirementCount(x.f, "parent-read-result");
  let postResultRows = 0;
  const spy = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await query(sql, params);
    if (controlRead(sql) && retirementCount(x.f, "parent-read-result") > before) postResultRows++;
    return rows;
  });
  try {
    await retirementStep(x, "parent-read-result");
    // The actual private H getter fences this Core continuation. UNKNOWN alone
    // could not distinguish a refused P fact from a falsely accepted H result.
    expect(postResultRows > 0).toBe(known);
  } finally {
    spy.mockRestore();
  }
}
test("peer retirement original whole family and independent P H-result keep ordinary DELETE unknown", async () => {
  const x = await originalNamespaceForRetirement();
  try {
    for (const op of [
      "begin-tracked-join",
      "read-tracked-join",
      "delete-born",
      "join-born-delete",
      "dispose-born",
    ])
      await retirementStep(x, op);
    await helperResultStep(x, true);
    expect(
      x.f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@2"),
    ).toHaveLength(1);
    expect(stopCount(x.f)).toBe(1);
    expect(releaseCount(x.f)).toBe(1);
    for (const op of ["begin-tracked-join", "delete-born", "dispose-born"])
      expect(retirementCount(x.f, op)).toBe(1);
    expect((await x.f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
      "bound",
    );
    expect((await x.f.sql.query("SELECT phase FROM tf_v2_resources"))[0]?.phase).toBe("deleting");
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await x.current.close().catch(() => undefined);
    await x.close();
  }
});
for (const fault of [
  "begin-retained",
  "delete-retained",
  "dispose-retained",
  "begin-lost",
  "delete-lost",
  "dispose-lost",
] as const) {
  test(`peer retirement ${fault} selects only original read join or continuation`, async () => {
    const x = await originalNamespaceForRetirement({ retirementFault: fault });
    try {
      for (const op of [
        "begin-tracked-join",
        "read-tracked-join",
        "delete-born",
        "join-born-delete",
        "dispose-born",
      ])
        await retirementStep(x, op);
      if (fault === "dispose-retained") await retirementStep(x, "continue-born-disposal");
      await helperResultStep(x, true);
      for (const op of ["begin-tracked-join", "delete-born", "dispose-born"])
        expect(retirementCount(x.f, op)).toBe(1);
    } finally {
      await x.current.close().catch(() => undefined);
      await x.close();
    }
  });
}
for (const fault of ["missing", "wrong-phase"] as const) {
  test(`peer retirement ${fault} captured original phase refuses new effects`, async () => {
    const x = await originalNamespaceForRetirement({ retirementFault: fault });
    try {
      await retirementStep(x, "begin-tracked-join");
      expect(await x.current.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(retirementCount(x.f, "begin-tracked-join")).toBe(1);
      expect(retirementCount(x.f, "read-tracked-join")).toBe(0);
      expect(retirementCount(x.f, "delete-born")).toBe(0);
    } finally {
      await x.current.close().catch(() => undefined);
      await x.close();
    }
  });
}
for (const hResultFault of ["stdout", "stderr", "nonzero", "signal", "unknown"] as const) {
  test(`peer retirement H result ${hResultFault} is not connector exit or removed permission`, async () => {
    const x = await originalNamespaceForRetirement({ hResultFault });
    try {
      for (const op of [
        "begin-tracked-join",
        "read-tracked-join",
        "delete-born",
        "join-born-delete",
        "dispose-born",
      ])
        await retirementStep(x, op);
      await helperResultStep(x, false);
      expect(retirementCount(x.f, "parent-read-result")).toBe(1);
      expect((await x.f.sql.query("SELECT phase FROM tf_v2_resources"))[0]?.phase).toBe("deleting");
      expect(
        (await x.f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state,
      ).toBe("bound");
    } finally {
      await x.current.close().catch(() => undefined);
      await x.close();
    }
  });
}

for (const fault of ["row", "cancel", "execution"] as const) {
  test(`peer retirement fresh ${fault} fence after namespace records emits no BEGIN`, async () => {
    const x = await originalNamespaceForRetirement(),
      query = x.f.sql.query.bind(x.f.sql);
    const before = x.f
      .nativeCounts()
      .requests.filter((k) => k === "linux-oci-parent-read-outcome@2").length;
    let armed = false,
      crossed = false;
    const spy = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (
        !crossed &&
        controlRead(sql) &&
        x.f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-read-outcome@2").length >
          before
      ) {
        if (fault === "row") {
          crossed = true;
          return [{ native_control: null }];
        }
        armed = true;
      } else if (armed && !crossed && sql.includes(" WHERE i.resource_uid=? AND v.generation=?")) {
        crossed = true;
        if (fault === "cancel") void x.current.close().catch(() => undefined);
        else {
          const e = x.f.execution;
          if (!e) throw Error("original execution absent");
          Reflect.set(e, "leaseToken", "synthetic-retirement-late-lease");
        }
      }
      return rows;
    });
    try {
      expect(await x.current.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(crossed).toBe(true);
      expect(retirementCount(x.f, "begin-tracked-join")).toBe(0);
    } finally {
      spy.mockRestore();
      await x.current.close().catch(() => undefined);
      await x.close();
    }
  });
}

// New allocation handoff only: real owning CREATE save/capture, current original
// P result and memorySQL consume-before-rm, with isolated nonsecret files.
async function originalPeerForAllocation(allocationSchema = true) {
  const x = await originalNamespaceForRetirement({ allocationSchema });
  try {
    for (const op of [
      "begin-tracked-join",
      "read-tracked-join",
      "delete-born",
      "join-born-delete",
      "dispose-born",
    ])
      await retirementStep(x, op);
    return x;
  } catch (e) {
    await x.current.close().catch(() => undefined);
    await x.close();
    throw e;
  }
}
async function allocationState(f: Fixture) {
  return (await f.sql.query("SELECT allocation_cleanup FROM tf_v2_container_create_claims"))[0]
    ?.allocation_cleanup;
}
const noPath = async (path: string) => {
  try {
    await lstat(path);
    return false;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return true;
    throw e;
  }
};
test("peer allocation actual sealed fresh source consumes before one local rm without removed permission", async () => {
  const x = await originalPeerForAllocation(),
    root = x.f.recordedCreate().allocationRoot,
    actualRm = fsPromises.rm;
  let effects = 0;
  const spy = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
    if (path === root) {
      effects++;
      expect(await allocationState(x.f)).toBe("consumed");
      expect(options).toEqual({ recursive: true, force: false });
    }
    return actualRm(path, options);
  });
  expect(Object.is(importedRm, spy)).toBe(true);
  try {
    expect(await allocationState(x.f)).toBe("untouched");
    await helperResultStep(x, true);
    expect(effects).toBe(1);
    expect(await noPath(root)).toBe(true);
    expect(await allocationState(x.f)).toBe("closed");
    expect((await x.f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
      "bound",
    );
    expect((await x.f.sql.query("SELECT phase FROM tf_v2_resources"))[0]?.phase).toBe("deleting");
    expect(await x.current.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(effects).toBe(1);
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    await x.current.close().catch(() => undefined);
    await x.close();
  }
});
for (const fault of ["before", "after", "cancel", "consume-ack", "execution"] as const) {
  test(`peer allocation ${fault} uncertainty survives fresh creator without rm replay`, async () => {
    const x = await originalPeerForAllocation(),
      root = x.f.recordedCreate().allocationRoot,
      actualRm = fsPromises.rm,
      run = x.f.sql.run.bind(x.f.sql);
    let effects = 0,
      consumed = false;
    const rmSpy = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
      if (path !== root) return actualRm(path, options);
      effects++;
      expect(await allocationState(x.f)).toBe("consumed");
      if (fault === "before") throw Error("synthetic no-effect rm error");
      await actualRm(path, options);
      if (fault === "cancel") void x.current.close().catch(() => undefined);
      if (fault === "after") throw Error("synthetic lost rm completion");
    });
    const runSpy = spyOn(x.f.sql, "run").mockImplementation(async (sql, params) => {
      const result = await run(sql, params);
      if (
        sql.startsWith("UPDATE tf_v2_container_create_claims SET allocation_cleanup='consumed'")
      ) {
        consumed = true;
        if (fault === "consume-ack") throw Error("synthetic persisted consume receipt lost");
        if (fault === "execution") {
          const e = x.f.execution;
          if (!e) throw Error("original execution absent");
          Reflect.set(e, "leaseToken", "synthetic-after-consume-lease");
        }
      }
      return result;
    });
    try {
      expect(await x.current.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(consumed).toBe(true);
      expect(await allocationState(x.f)).toBe("consumed");
      const calls = effects;
      expect(calls).toBe(fault === "consume-ack" || fault === "execution" ? 0 : 1);
      await x.current.close().catch(() => undefined);
      x.f.advanceNormalClock(61_000);
      x.current = x.f.reconstructNormal();
      expect(await x.current.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(effects).toBe(calls);
      expect(await allocationState(x.f)).toBe("consumed");
      expect(retirementCount(x.f, "dispose-born")).toBe(1);
    } finally {
      runSpy.mockRestore();
      rmSpy.mockRestore();
      await x.current.close().catch(() => undefined);
      await x.close();
    }
  });
}
for (const fault of ["rootfs", "receipt", "parent"] as const) {
  test(`peer allocation changed actual ${fault} identity refuses before consume or rm`, async () => {
    const x = await originalPeerForAllocation(),
      root = x.f.recordedCreate().allocationRoot,
      actualRm = fsPromises.rm;
    let effects = 0;
    const spy = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
      if (path === root) effects++;
      return actualRm(path, options);
    });
    try {
      if (fault === "receipt")
        await writeFile(root + "/.tako-oci-artifact.json", "synthetic altered receipt", {
          mode: 0o600,
        });
      else if (fault === "rootfs") {
        await rename(root + "/rootfs", root + "/rootfs.saved");
        await mkdir(root + "/rootfs", { mode: 0o700 });
      } else {
        await rename(x.f.artifactRoot, x.f.artifactRoot + ".saved");
        await mkdir(x.f.artifactRoot, { mode: 0o700 });
      }
      expect(await x.current.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(await allocationState(x.f)).toBe("untouched");
      expect(effects).toBe(0);
    } finally {
      spy.mockRestore();
      await x.current.close().catch(() => undefined);
      await x.close();
    }
  });
}
test("peer allocation historical sealed NULL never becomes fresh untouched after additive expand", async () => {
  const x = await originalPeerForAllocation(false),
    root = x.f.recordedCreate().allocationRoot,
    actualRm = fsPromises.rm;
  let effects = 0;
  const spy = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
    if (path === root) effects++;
    return actualRm(path, options);
  });
  try {
    await x.f.sql.batch(V2_CONTAINER_OWNER_ALLOCATION_EXPAND.statements.map((sql) => ({ sql })));
    expect(await allocationState(x.f)).toBe(null);
    await retirementStep(x, "parent-read-result");
    expect(effects).toBe(0);
    expect(await allocationState(x.f)).toBe(null);
    expect(await noPath(root)).toBe(false);
  } finally {
    spy.mockRestore();
    await x.current.close().catch(() => undefined);
    await x.close();
  }
});

// Original closed raw sources reused by the same-creator DELETE regression.
export { fixture as originalPeerDeleteFixture, normalCreate, acceptNormalDelete };
