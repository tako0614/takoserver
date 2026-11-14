import { expect, spyOn, test } from "bun:test";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import {
  inspectV2ContainerOwnerControlSchema,
  inspectV2ContainerOwnerSchema,
  V2_CONTAINER_CONTROL_RESERVED,
  V2_CONTAINER_OWNER_CONTROL_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { originalOwnedOciFixture } from "./linux-oci-owned-bundle.test.ts";

// Explicit NONSECRET test-only key/capability/nonce bytes. All native spawn and
// streams are the original closed fixture, never actual umoci/P/H/AF_UNIX.
async function keys() {
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
  return { key, comparison };
}
function nonsecretRandom() {
  let byte = 0x30;
  return spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(value: T): T => {
      if (!(value instanceof Uint8Array)) throw new Error("unexpected test random shape");
      value.fill(++byte);
      return value;
    },
  );
}
async function fixture(parentControl = true, parentFault?: "foreign-claim" | "foreign-generation") {
  const random = nonsecretRandom();
  try {
    const f = await originalOwnedOciFixture(false, {
      parentControl,
      ...(parentControl ? { nativeMode: "stopped" as const } : {}),
      ...(parentFault ? { parentFault } : {}),
      fixedKeys: await keys(),
    });
    return Object.assign(f, {
      async cleanup() {
        try {
          await f.close();
        } catch {
          /* Raw fixture disposal only, never product success after retained P. */
        } finally {
          random.mockRestore();
        }
      },
    });
  } catch (error) {
    random.mockRestore();
    throw error;
  }
}
async function run(f: Awaited<ReturnType<typeof fixture>>) {
  await f.create();
  const result = await f.engine.runNext();
  if (f.failures[0] !== undefined) throw f.failures[0];
  return result;
}
function pauseSave(f: Awaited<ReturnType<typeof fixture>>) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.sql.run.bind(f.sql);
  const spy = spyOn(f.sql, "run").mockImplementation(async (sql, params) => {
    if (sql.startsWith("UPDATE tf_v2_container_create_claims SET native_control=")) {
      enter();
      await hold;
    }
    return original(sql, params);
  });
  return { entered, release, spy };
}
async function enteredOrFinished(
  f: Awaited<ReturnType<typeof fixture>>,
  entered: Promise<void>,
  running: Promise<unknown>,
) {
  const reached = await Promise.race([entered.then(() => true), running.then(() => false)]);
  if (!reached) throw f.failures[0] ?? new Error("original save not reached");
}

test("claim-bound P canonical CREATE follows real expanded schema, original seal, guard and bindNative", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.sql.query(
          "SELECT sql FROM sqlite_schema WHERE name='tf_v2_container_create_claims'",
        )
      )[0]?.sql,
    ).toBe(
      V2_CONTAINER_OWNER_CONTROL_EXPAND.objects.find(
        (item) => item.name === "tf_v2_container_create_claims",
      )?.sql,
    );
    expect(await inspectV2ContainerOwnerControlSchema(f.sql)).toBe(true);
    expect(await inspectV2ContainerOwnerSchema(f.sql)).toBe(false); // explicit shape/window, no silent old-ready rewrite
    await run(f);
    const rows = await f.sql.query(
      "SELECT claim_id,state,native_id,native_control FROM tf_v2_container_create_claims",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row || typeof row.native_control !== "string")
      throw new Error("sealed original claim absent");
    expect(row.state).toBe("bound");
    expect(row.native_id).toBe(row.claim_id);
    const envelope = JSON.parse(row.native_control);
    expect(envelope.kind).toBe("linux-oci-sealed-control@1");
    expect(envelope.scope.purpose).toBe("takoserver.linux-oci-parent-control@1");
    expect(envelope.scope.claimId).toBe(row.claim_id);
    expect(envelope.scope.artifact.claimId).toBe(row.claim_id);
    expect(envelope.scope.operationId).toBe(f.execution?.operationId);
    expect(envelope.scope.backendId).toBe("synthetic-oci-backend");
    expect(envelope.scope.targetKey).toBe("synthetic-oci-target");
    expect(Object.hasOwn(envelope.scope, "createDigest")).toBe(false);
    const plaintext = await decryptContainerSecretBytes(
      f.configuredInputs.keyring.current.key,
      decodeContainerSecretBytes(envelope.nonce),
      decodeContainerSecretBytes(envelope.ciphertext),
      new TextEncoder().encode(canonicalJson(envelope.scope)),
    );
    const binding = JSON.parse(new TextDecoder().decode(plaintext));
    plaintext.fill(0);
    for (const changed of [
      { ...envelope.scope, claimId: "f".repeat(64) },
      { ...envelope.scope, purpose: "tenant-envelope-wrong-purpose" },
    ]) {
      const refused = await decryptContainerSecretBytes(
        f.configuredInputs.keyring.current.key,
        decodeContainerSecretBytes(envelope.nonce),
        decodeContainerSecretBytes(envelope.ciphertext),
        new TextEncoder().encode(canonicalJson(changed)),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(Error);
    }
    expect(binding.kind).toBe("linux-oci-original-control@1");
    expect(binding.claimId).toBe(row.claim_id);
    expect(binding.generation).toBe(1);
    expect(binding.createDigest).toBe(
      await canonicalDigest({ kind: "linux-oci-create-stopped@1", ...f.recordedCreate() }),
    );
    // recordedCreate reads the JSON captured from actual raw stdin, not an expected request.
    expect(row.native_control.includes(binding.createDigest)).toBe(false);
    expect(binding.listenerCookie).toBe(0xfedcba9876543210n.toString());
    expect(decodeContainerSecretBytes(binding.capability)).toHaveLength(32);
    expect(binding.executable.path).toBe(f.physicalBinary);
    expect(row.native_control.includes('"capability"')).toBe(false);
    expect(f.nativeCounts()).toEqual({
      processes: 1,
      requests: ["linux-oci-parent-bootstrap@1", "linux-oci-create-stopped@1"],
    });
    expect(f.stopped).toHaveLength(1);
    expect(f.nativeExits()).toBe(0);
    const retry = await f.composition.createAcceptedStopped(f.execution!).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(retry).toBeInstanceOf(Error);
    expect(f.nativeCounts().processes).toBe(1);
    const immutable = await f.sql
      .run("UPDATE tf_v2_container_create_claims SET native_control=?", [row.native_control + " "])
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(immutable).toBeInstanceOf(Error);
  } finally {
    await f.cleanup();
  }
});

test("claim-bound P waits durable save and sends no CREATE during the await window", async () => {
  const f = await fixture();
  const pause = pauseSave(f);
  try {
    await f.create();
    const running = f.engine.runNext();
    await enteredOrFinished(f, pause.entered, running);
    expect(f.nativeCounts()).toEqual({ processes: 1, requests: ["linux-oci-parent-bootstrap@1"] });
    expect(
      (await f.sql.query("SELECT native_control,state FROM tf_v2_container_create_claims"))[0],
    ).toEqual({ native_control: V2_CONTAINER_CONTROL_RESERVED, state: "pending" });
    pause.release();
    await running;
    if (f.failures[0]) throw f.failures[0];
    expect(f.nativeCounts().requests).toEqual([
      "linux-oci-parent-bootstrap@1",
      "linux-oci-create-stopped@1",
    ]);
  } finally {
    pause.release();
    pause.spy.mockRestore();
    await f.cleanup();
  }
});

test("claim-bound P save failure retains original reserved claim without CREATE or replay", async () => {
  const f = await fixture();
  const original = f.sql.run.bind(f.sql);
  const spy = spyOn(f.sql, "run").mockImplementation((sql, params) =>
    sql.startsWith("UPDATE tf_v2_container_create_claims SET native_control=")
      ? Promise.reject(new Error("raw save failure"))
      : original(sql, params),
  );
  try {
    await f.create();
    await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.nativeCounts()).toEqual({ processes: 1, requests: ["linux-oci-parent-bootstrap@1"] });
    expect(
      (await f.sql.query("SELECT native_control,state FROM tf_v2_container_create_claims"))[0],
    ).toEqual({ native_control: V2_CONTAINER_CONTROL_RESERVED, state: "pending" });
    const retry = await f.composition.createAcceptedStopped(f.execution!).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(retry).toBeInstanceOf(Error);
    expect(f.nativeCounts().processes).toBe(1);
  } finally {
    spy.mockRestore();
    await f.cleanup();
  }
});

test("claim-bound P fresh guard refuses cancellation and mutated accepted scope after save awaits", async () => {
  for (const fault of ["cancel", "scope"]) {
    const f = await fixture();
    const pause = pauseSave(f);
    let closing: Promise<void> | undefined;
    try {
      await f.create();
      const running = f.engine.runNext();
      await enteredOrFinished(f, pause.entered, running);
      if (fault === "cancel") {
        closing = f.composition.close();
        void closing.catch(() => undefined);
      } else if (f.execution) f.execution.principal = "foreign-original-scope";
      pause.release();
      await running;
      expect(f.failures.length).toBeGreaterThan(0);
      expect(f.nativeCounts()).toEqual({
        processes: 1,
        requests: ["linux-oci-parent-bootstrap@1"],
      });
    } finally {
      pause.release();
      pause.spy.mockRestore();
      await closing?.catch(() => undefined);
      await f.cleanup();
    }
  }
});

test("claim-bound P foreign bootstrap identity cannot seal a claim or send CREATE", async () => {
  for (const fault of ["foreign-claim", "foreign-generation"] as const) {
    const f = await fixture(true, fault);
    try {
      await f.create();
      await f.engine.runNext();
      expect(f.failures).toHaveLength(1);
      expect(f.nativeCounts()).toEqual({
        processes: 1,
        requests: ["linux-oci-parent-bootstrap@1"],
      });
      expect(
        (await f.sql.query("SELECT native_control,state FROM tf_v2_container_create_claims"))[0],
      ).toEqual({ native_control: V2_CONTAINER_CONTROL_RESERVED, state: "pending" });
    } finally {
      await f.cleanup();
    }
  }
});

test("claim-bound P additive candidate preserves old NULL claims and rejects retrofitted reservation", async () => {
  const f = await fixture(false);
  try {
    expect(await inspectV2ContainerOwnerSchema(f.sql)).toBe(true);
    await run(f);
    await f.sql.batch(V2_CONTAINER_OWNER_CONTROL_EXPAND.statements.map((sql) => ({ sql })));
    expect(await inspectV2ContainerOwnerControlSchema(f.sql)).toBe(true);
    const rows = await f.sql.query(
      "SELECT claim_id,state,native_control FROM tf_v2_container_create_claims",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.native_control).toBeNull();
    expect(rows[0]?.state).toBe("pending");
    const retrofit = await f.sql
      .run("UPDATE tf_v2_container_create_claims SET native_control=?", [
        V2_CONTAINER_CONTROL_RESERVED,
      ])
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(retrofit).toBeInstanceOf(Error);
    expect(f.nativeCounts().processes).toBe(0);
  } finally {
    await f.cleanup();
  }
});
