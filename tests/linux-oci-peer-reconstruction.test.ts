import { expect, spyOn, test } from "bun:test";
import { lstat, rename, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import { originalOwnedOciFixture } from "./linux-oci-owned-bundle.test.ts";

// NONSECRET fixture keys/capabilities; actual memorySql/Core/creator and raw
// spawn streams only. Imported old cases are filtered and never called.
async function fixture(options: { pending?: boolean; v1?: boolean } = {}) {
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
      ...(options.pending === undefined ? {} : { peerPending: options.pending }),
      nativeMode: "retire-pending",
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
