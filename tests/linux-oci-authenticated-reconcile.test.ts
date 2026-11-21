import { expect, spyOn, test } from "bun:test";
import { rename, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import { V2_CONTAINER_CONTROL_RESERVED } from "../src/takoform-v2/container-owner-schema.ts";
import { originalOwnedOciFixture } from "./helpers/linux-oci-owned-bundle-fixture.ts";

// Explicit NONSECRET keys/random bytes, real fresh memorySQLite/engine/owner,
// existing raw spawn+streams. No actual P/H/net/runc/AF_UNIX effects. The old
// imported tests are registered but filtered, never invoked by this new cohort.
async function fixture() {
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
      if (!(value instanceof Uint8Array)) throw new Error("raw random shape");
      value.fill(++byte);
      return value;
    },
  );
  const network = spyOn(net, "createConnection").mockImplementation(() => {
    throw new Error("unexpected actual socket path");
  });
  try {
    const f = await originalOwnedOciFixture(false, {
      parentControl: true,
      nativeMode: "retire-pending",
      fixedKeys: { key, comparison },
    });
    return Object.assign(f, {
      network,
      async cleanup() {
        try {
          await f.close();
        } catch {
          /* Test teardown only; retained P is not a product success. */
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
  if (typeof row?.native_control !== "string") throw new Error("original sealed claim absent");
  return JSON.parse(row.native_control);
}
function controlRead(sql: string) {
  return sql.startsWith(
    "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=",
  );
}

test("authenticated reconcile same original Sql decrypts and compares genuine retained P without CREATE replay", async () => {
  const f = await fixture();
  let reads = 0;
  f.beforeStart(async (execution) => {
    const before = f.nativeCounts();
    await f.composition.readRetainedParentControls(execution);
    await f.composition.readRetainedParentControls(execution);
    reads += 2;
    expect(f.nativeCounts()).toEqual(before);
  });
  try {
    await run(f);
    expect(reads).toBe(2);
    expect(f.nativeCounts()).toEqual({
      processes: 1,
      requests: ["linux-oci-parent-bootstrap@1", "linux-oci-create-stopped@1"],
    });
    expect(f.network).not.toHaveBeenCalled();
    expect((await document(f)).scope.purpose).toBe("takoserver.linux-oci-parent-control@1");
  } finally {
    await f.cleanup();
  }
});

test("authenticated reconcile rejects foreign scope and validly encrypted wrong P binding without stranding original reader", async () => {
  const f = await fixture();
  let refused = 0;
  f.beforeStart(async (execution) => {
    const saved = await document(f),
      rawQuery = f.sql.query.bind(f.sql),
      before = f.nativeCounts();
    const plain = await decryptContainerSecretBytes(
      f.configuredInputs.keyring.current.key,
      decodeContainerSecretBytes(saved.nonce),
      decodeContainerSecretBytes(saved.ciphertext),
      new TextEncoder().encode(canonicalJson(saved.scope)),
    );
    const actual = JSON.parse(new TextDecoder().decode(plain));
    plain.fill(0);
    for (const fault of ["purpose", "claim", "ciphertext", "capability", "executable"]) {
      const altered = structuredClone(saved);
      if (fault === "purpose") altered.scope.purpose = "tenant-envelope-wrong-purpose";
      else if (fault === "claim") altered.scope.claimId = "f".repeat(64);
      else if (fault === "ciphertext")
        altered.ciphertext = encodeContainerSecretBytes(new Uint8Array(32).fill(0x22));
      else {
        const body = structuredClone(actual),
          nonce = new Uint8Array(12).fill(fault === "capability" ? 0x21 : 0x22);
        if (fault === "capability")
          body.capability = encodeContainerSecretBytes(new Uint8Array(32).fill(0x7a));
        else body.executable.ino += 1;
        altered.nonce = encodeContainerSecretBytes(nonce);
        altered.ciphertext = encodeContainerSecretBytes(
          new Uint8Array(
            await encryptContainerSecretBytes(
              f.configuredInputs.keyring.current.key,
              nonce,
              new TextEncoder().encode(JSON.stringify(body)),
              new TextEncoder().encode(canonicalJson(saved.scope)),
            ),
          ),
        );
        expect(altered.ciphertext.length).toBeGreaterThan(0);
        const roundtrip = await decryptContainerSecretBytes(
          f.configuredInputs.keyring.current.key,
          nonce,
          decodeContainerSecretBytes(altered.ciphertext),
          new TextEncoder().encode(canonicalJson(saved.scope)),
        );
        try {
          expect(new TextDecoder().decode(roundtrip)).toBe(JSON.stringify(body));
        } finally {
          roundtrip.fill(0);
        }
      }
      const spy = spyOn(f.sql, "query").mockImplementation((sql, params) =>
        controlRead(sql)
          ? Promise.resolve([{ native_control: canonicalJson(altered) }])
          : rawQuery(sql, params),
      );
      try {
        const error = await f.composition.readRetainedParentControls(execution).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(Error);
        if (fault === "capability" || fault === "executable")
          expect(error).toHaveProperty("message", "linux_oci_physical_session_parent_binding");
        refused++;
      } finally {
        spy.mockRestore();
      }
    }
    await f.composition.readRetainedParentControls(execution);
    expect(f.nativeCounts()).toEqual(before);
  });
  try {
    await run(f);
    expect(refused).toBe(5);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("authenticated reconcile original a binding survives latest DELETE while ordinary dispatch rejects foreign operation before effects", async () => {
  const f = await fixture();
  let checked = false;
  let restore = () => {};
  f.beforeRetire(async (execution) => {
    await f.composition.readRetainedParentControls(execution);
    const saved = await document(f);
    expect(saved.scope.action).toBe("create");
    expect(saved.scope.operationId).not.toBe(execution.operationId);
    const changed = { ...saved, scope: { ...saved.scope, operationId: execution.operationId } },
      original = f.sql.query.bind(f.sql);
    const spy = spyOn(f.sql, "query").mockImplementation((sql, params) =>
      controlRead(sql)
        ? Promise.resolve([{ native_control: canonicalJson(changed) }])
        : original(sql, params),
    );
    restore = () => spy.mockRestore();
    checked = true;
  });
  try {
    await run(f);
    const created = f.execution;
    if (!created) throw new Error("original execution absent");
    const before = f.nativeCounts();
    await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
    });
    const outcome = await f.engine.runNext();
    expect(checked).toBe(true);
    expect(outcome?.effect).toBe("unknown");
    expect(f.nativeCounts()).toEqual(before);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    restore();
    await f.cleanup();
  }
});

test("authenticated reconcile cancels across final Sql await and permits only a later fresh read", async () => {
  const f = await fixture();
  let checked = false;
  f.beforeStart(async (execution) => {
    let enter!: () => void,
      release!: () => void,
      count = 0;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    const original = f.sql.query.bind(f.sql),
      cancel = new AbortController();
    const spy = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
      if (controlRead(sql) && ++count === 2) {
        enter();
        await hold;
      }
      return original(sql, params);
    });
    try {
      const pending = f.composition.readRetainedParentControls(execution, cancel.signal).then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
      const first = await Promise.race([
        entered.then(() => "entered"),
        pending.then(() => "settled"),
      ]);
      expect(first).toBe("entered");
      cancel.abort();
      release();
      expect((await pending).ok).toBe(false);
      checked = true;
    } finally {
      release();
      spy.mockRestore();
    }
    await f.composition.readRetainedParentControls(execution);
  });
  try {
    await run(f);
    expect(checked).toBe(true);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("authenticated reconcile refuses missing reservation stale execution and fresh creator without rebuilding P", async () => {
  const f = await fixture();
  let checked = 0;
  f.beforeStart(async (execution) => {
    const before = f.nativeCounts(),
      original = f.sql.query.bind(f.sql);
    for (const value of [null, V2_CONTAINER_CONTROL_RESERVED]) {
      const spy = spyOn(f.sql, "query").mockImplementation((sql, params) =>
        controlRead(sql) ? Promise.resolve([{ native_control: value }]) : original(sql, params),
      );
      try {
        const error = await f.composition.readRetainedParentControls(execution).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(Error);
        checked++;
      } finally {
        spy.mockRestore();
      }
    }
    const stale = await f.composition
      .readRetainedParentControls({ ...execution, principal: "foreign" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(stale).toBeInstanceOf(Error);
    checked++;
    const restarted = f.reconstructParent();
    try {
      const error = await restarted.readRetainedParentControls(execution).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      checked++;
      expect(f.nativeCounts()).toEqual(before);
    } finally {
      await restarted.close();
    }
  });
  try {
    await run(f);
    expect(checked).toBe(4);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("authenticated reconcile rejects changed original executable identity", async () => {
  const f = await fixture();
  let checked = false;
  f.beforeStart(async (execution) => {
    await rename(f.physicalBinary, `${f.physicalBinary}.original`);
    await writeFile(f.physicalBinary, "NONSECRET replacement model", { mode: 0o700 });
    const error = await f.composition.readRetainedParentControls(execution).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    checked = true;
  });
  try {
    await run(f);
    expect(checked).toBe(true);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
