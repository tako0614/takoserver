import { expect, spyOn, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import * as bundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  inspectV2ContainerOwnerAllocationSchema,
  inspectV2ContainerOwnerApplicationIoSchema,
  inspectV2ContainerOwnerControlSchema,
  V2_CONTAINER_APPLICATION_IO_RESERVED,
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import {
  observeRawPromise,
  ownedRawHttp,
  rawTick,
} from "./helpers/container-http-transport-fixture.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

// NONSECRET memorySQL/raw streams only. The explicit durable-application prefix
// is selected; imported prior cases are registered but never invoked.
async function live(expanded = true) {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    allocationSchema: true,
  });
  if (expanded)
    await f.sql.batch(
      V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({
        sql,
      })),
    );
  expect(await inspectV2ContainerOwnerApplicationIoSchema(f.sql)).toBe(expanded);
  expect(await inspectV2ContainerOwnerAllocationSchema(f.sql)).toBe(true);
  expect(await inspectV2ContainerOwnerControlSchema(f.sql)).toBe(true);
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    return { f, accepted };
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}
type Live = Awaited<ReturnType<typeof live>>;
function sourceObserver() {
  const original = bundle.originalLinuxOciHttpRetirementSource;
  const values: ReturnType<typeof original>[] = [];
  const spy = spyOn(bundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (...args) => {
      const actual = original(...args);
      values.push(actual);
      return actual;
    },
  );
  return { values, restore: () => spy.mockRestore() };
}
async function reach(x: Live, source: ReturnType<typeof sourceObserver>) {
  for (let pass = 0; pass < 16; pass++) {
    x.f.advanceNormalClock(61_000);
    const pending = observeRawPromise(x.f.engine.runNext());
    for (let tick = 0; tick < 100 && pending.state() === "pending" && !source.values.length; tick++)
      await rawTick();
    if (source.values.length) return pending;
    expect(await pending.value).toHaveProperty("result");
  }
  throw Error("actual original application consumer not reached");
}
const count = (x: Live, kind: string) =>
  x.f.nativeCounts().requests.filter((k) => k === `linux-oci-${kind}@1`).length;
async function deleting(x: Live) {
  await x.f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid: x.accepted.resourceUid,
    expectedGeneration: 1,
  });
}

test("durable-application live terminal close seals same claim before allocation", async () => {
  const x = await live(),
    io = ownedRawHttp(),
    source = sourceObserver();
  try {
    const response = x.f.composition.fetchServingHttp(
      x.f.recordedCreate(),
      new Request("http://ignored.invalid/durable"),
    );
    for (let i = 0; i < 30 && !io.counts().calls; i++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    await response;
    await deleting(x);
    expect(await x.f.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(count(x, "stop-init")).toBe(1);
    const pending = await reach(x, source);
    expect(source.values[0]).toBeDefined();
    expect(pending.state()).toBe("pending");
    expect(
      (
        await x.f.sql.query(
          "SELECT application_io_cleanup,allocation_cleanup FROM tf_v2_container_create_claims",
        )
      )[0],
    ).toEqual({
      application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
      allocation_cleanup: "untouched",
    });
    io.closeResponse();
    await rawTick();
    expect(pending.state()).toBe("pending");
    io.closeRequest();
    expect(await pending.value).toHaveProperty("result");
    const row = (await x.f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
    expect(row).toMatchObject({ state: "bound", removed_at_ms: null });
    expect(typeof row?.application_io_cleanup).toBe("string");
    expect(JSON.parse(String(row?.application_io_cleanup)).kind).toBe(
      "linux-oci-sealed-application-io-close@1",
    );
    expect(io.counts().calls).toBe(1);
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    source.restore();
    io.closeResponse();
    io.closeRequest();
    io.restore();
    await x.f.cleanup();
  }
});

async function toResult(x: Live, engine = x.f.engine) {
  const before = count(x, "parent-read-result");
  for (let pass = 0; pass < 16; pass++) {
    x.f.advanceNormalClock(61_000);
    expect(await engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    if (count(x, "parent-read-result") > before) return;
  }
  throw Error("original H result reader not reached");
}
const ioSave = (sql: string) =>
  sql.startsWith("UPDATE tf_v2_container_create_claims SET application_io_cleanup=?");
async function claim(x: Live) {
  const row = (await x.f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
  if (!row) throw Error("original claim absent");
  return row;
}

// A real commit followed by lost delivery deliberately stops the original
// caller before allocation. Fresh authority can read that same committed fact.
async function savedWithLostAck() {
  const x = await live(),
    run = x.f.sql.run.bind(x.f.sql);
  let saves = 0;
  const spy = spyOn(x.f.sql, "run").mockImplementation(async (sql, params) => {
    const result = await run(sql, params);
    if (ioSave(sql)) {
      saves++;
      expect(result.changes).toBe(1);
      throw Error("NONSECRET lost application save receipt");
    }
    return result;
  });
  try {
    await deleting(x);
    await toResult(x);
    expect(saves).toBe(1);
    expect(await claim(x)).toMatchObject({
      allocation_cleanup: "untouched",
      state: "bound",
      removed_at_ms: null,
    });
    expect(typeof (await claim(x)).application_io_cleanup).toBe("string");
    return x;
  } catch (error) {
    await x.f.cleanup();
    throw error;
  } finally {
    spy.mockRestore();
  }
}

test("durable-application fresh same-operation consumer recovers actual committed lost ACK without old runtime or reclose", async () => {
  const x = await savedWithLostAck(),
    source = sourceObserver(),
    fresh = x.f.reconstructNormal();
  try {
    const before = x.f.nativeCounts(),
      document = (await claim(x)).application_io_cleanup;
    await toResult(x, fresh.engine);
    expect(source.values.length).toBeGreaterThan(0);
    expect(source.values.every((v) => v === undefined)).toBe(true);
    expect(await claim(x)).toMatchObject({
      application_io_cleanup: document,
      allocation_cleanup: "closed",
      state: "bound",
      removed_at_ms: null,
    });
    for (const effect of [
      "create-stopped",
      "start",
      "stop-init",
      "begin-tracked-join",
      "delete-born",
      "dispose-born",
    ])
      expect(count(x, effect)).toBe(1);
    expect(
      x.f.nativeCounts().requests.filter((v) => v === "linux-oci-parent-bootstrap@2"),
    ).toHaveLength(1);
    expect(x.f.nativeCounts().processes).toBe(before.processes + 1); // fixed connector only
    expect(x.f.network).not.toHaveBeenCalled();
    for (const value of [null, V2_CONTAINER_APPLICATION_IO_RESERVED, '{"kind":"foreign"}']) {
      const rejected = observeRawPromise(
        x.f.sql.run("UPDATE tf_v2_container_create_claims SET application_io_cleanup=?", [value]),
      );
      expect(await rejected.value).toHaveProperty("error");
    }
    expect((await claim(x)).application_io_cleanup).toBe(document);
  } finally {
    source.restore();
    await fresh.close().catch(() => undefined);
    await x.f.cleanup();
  }
});

test("durable-application historical bound NULL cannot backfill and fresh reserved without saved source stays unknown", async () => {
  const old = await live(false);
  try {
    await old.f.sql.batch(
      V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({
        sql,
      })),
    );
    expect(await inspectV2ContainerOwnerApplicationIoSchema(old.f.sql)).toBe(true);
    expect((await claim(old)).application_io_cleanup).toBeNull();
    const update = observeRawPromise(
      old.f.sql.run("UPDATE tf_v2_container_create_claims SET application_io_cleanup=?", [
        V2_CONTAINER_APPLICATION_IO_RESERVED,
      ]),
    );
    expect(await update.value).toHaveProperty("error");
    await deleting(old);
    const fresh = old.f.reconstructNormal();
    try {
      await toResult(old, fresh.engine);
      expect(await claim(old)).toMatchObject({
        application_io_cleanup: null,
        allocation_cleanup: "untouched",
        removed_at_ms: null,
      });
    } finally {
      await fresh.close().catch(() => undefined);
    }
  } finally {
    await old.f.cleanup();
  }
  const x = await live(),
    source = sourceObserver();
  try {
    await deleting(x);
    expect(await x.f.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    const fresh = x.f.reconstructNormal();
    try {
      await toResult(x, fresh.engine);
      expect(source.values.every((v) => v === undefined)).toBe(true);
      expect(source.values.length).toBeGreaterThan(0);
      expect(await claim(x)).toMatchObject({
        application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
        allocation_cleanup: "untouched",
        removed_at_ms: null,
      });
    } finally {
      await fresh.close().catch(() => undefined);
    }
  } finally {
    source.restore();
    await x.f.cleanup();
  }
});

test("durable-application lost save before commit cannot be recovered by fresh empty runtime", async () => {
  const x = await live(),
    run = x.f.sql.run.bind(x.f.sql);
  let saves = 0;
  const spy = spyOn(x.f.sql, "run").mockImplementation(async (sql, params) => {
    if (ioSave(sql)) {
      saves++;
      throw Error("NONSECRET application save not committed");
    }
    return run(sql, params);
  });
  try {
    await deleting(x);
    await toResult(x);
    spy.mockRestore();
    expect(saves).toBe(1);
    const fresh = x.f.reconstructNormal();
    try {
      await toResult(x, fresh.engine);
      expect(saves).toBe(1);
    } finally {
      await fresh.close().catch(() => undefined);
    }
    expect(await claim(x)).toMatchObject({
      application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
      allocation_cleanup: "untouched",
      removed_at_ms: null,
    });
    expect(count(x, "stop-init")).toBe(1);
  } finally {
    spy.mockRestore();
    await x.f.cleanup();
  }
});

test("durable-application actual native close UNKNOWN never seals or lets a fresh creator infer closure", async () => {
  const x = await live(),
    io = ownedRawHttp();
  let destroys = 0;
  const destroy = spyOn(io.request, "destroy").mockImplementation(() => {
    destroys++;
    throw Error("NONSECRET raw close unknown");
  });
  try {
    const response = x.f.composition.fetchServingHttp(
      x.f.recordedCreate(),
      new Request("http://ignored.invalid/unknown"),
    );
    for (let tick = 0; tick < 30 && !io.counts().calls; tick++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    await response;
    await deleting(x);
    expect(await x.f.engine.runNext()).toMatchObject({
      status: "reconciling",
      effect: "unknown",
    });
    expect(destroys).toBe(1);
    io.closeResponse();
    io.closeRequest();
    await toResult(x);
    const fresh = x.f.reconstructNormal();
    try {
      await toResult(x, fresh.engine);
    } finally {
      await fresh.close().catch(() => undefined);
    }
    expect(await claim(x)).toMatchObject({
      application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
      allocation_cleanup: "untouched",
      removed_at_ms: null,
    });
    expect(destroys).toBe(1);
    expect(count(x, "stop-init")).toBe(1);
  } finally {
    destroy.mockRestore();
    io.closeResponse();
    io.closeRequest();
    io.restore();
    await x.f.cleanup();
  }
});

for (const fault of ["lease", "execution", "cancel"] as const) {
  test(`durable-application ${fault} in final awaited save window refuses before fact CAS`, async () => {
    const x = await live(),
      encrypt = crypto.subtle.encrypt.bind(crypto.subtle),
      query = x.f.sql.query.bind(x.f.sql),
      run = x.f.sql.run.bind(x.f.sql);
    let armed = false,
      reads = 0,
      reached = false;
    const sealing = spyOn(crypto.subtle, "encrypt").mockImplementation(
      async (algorithm, key, bytes) => {
        const result = await encrypt(algorithm, key, bytes);
        if (
          typeof algorithm === "object" &&
          "additionalData" in algorithm &&
          algorithm.additionalData instanceof Uint8Array
        ) {
          const scope = JSON.parse(new TextDecoder().decode(algorithm.additionalData));
          if (scope.purpose === "takoserver.linux-oci-application-io-close@1") armed = true;
        }
        return result;
      },
    );
    const querying = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      if (
        armed &&
        !reached &&
        sql.includes(" WHERE i.resource_uid=? AND v.generation=?") &&
        ++reads === 3
      ) {
        reached = true;
        const execution = x.f.execution;
        if (!execution) throw Error("original execution absent");
        if (fault === "lease")
          await run("UPDATE tf_v2_operations SET lease_token=? WHERE id=?", [
            "NONSECRET-replaced-lease",
            execution.operationId,
          ]);
        else if (fault === "execution")
          Reflect.set(execution, "leaseToken", "NONSECRET-changed-execution");
        else void x.f.composition.close().catch(() => undefined);
      }
      return rows;
    });
    try {
      await deleting(x);
      await toResult(x);
      expect(armed).toBe(true);
      expect(reached).toBe(true);
      expect(reads).toBe(3);
      expect(await claim(x)).toMatchObject({
        application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
        allocation_cleanup: "untouched",
        removed_at_ms: null,
      });
      expect(count(x, "stop-init")).toBe(1);
    } finally {
      querying.mockRestore();
      sealing.mockRestore();
      await x.f.cleanup();
    }
  });
}

test("durable-application authenticated envelope rejects foreign binding and actually decrypted wrong plaintext", async () => {
  const x = await savedWithLostAck(),
    row = await claim(x);
  if (typeof row.application_io_cleanup !== "string") throw Error("original saved fact absent");
  const original = JSON.parse(row.application_io_cleanup),
    query = x.f.sql.query.bind(x.f.sql);
  try {
    for (const fault of ["claim", "native", "control", "operation", "plaintext", "ciphertext"]) {
      const changed = structuredClone(original);
      if (fault === "claim") changed.scope.original.claimId = "f".repeat(64);
      if (fault === "native") changed.scope.nativeId = "f".repeat(64);
      if (fault === "control") changed.scope.controlDigest = "sha256:" + "f".repeat(64);
      if (fault === "operation") changed.scope.operation.operationId = "NONSECRET-other-operation";
      const plain = new TextEncoder().encode(
        fault === "plaintext"
          ? '{"kind":"NONSECRET-not-original-close"}'
          : '{"kind":"linux-oci-original-application-io-closed@1"}',
      );
      changed.ciphertext = encodeContainerSecretBytes(
        new Uint8Array(
          await encryptContainerSecretBytes(
            x.f.configuredInputs.keyring.current.key,
            decodeContainerSecretBytes(changed.nonce),
            plain,
            new TextEncoder().encode(canonicalJson(changed.scope)),
          ),
        ),
      );
      expect(changed.ciphertext.length).toBeGreaterThan(16);
      const decoded = await decryptContainerSecretBytes(
        x.f.configuredInputs.keyring.current.key,
        decodeContainerSecretBytes(changed.nonce),
        decodeContainerSecretBytes(changed.ciphertext),
        new TextEncoder().encode(canonicalJson(changed.scope)),
      );
      expect(new TextDecoder().decode(decoded)).toBe(new TextDecoder().decode(plain));
      decoded.fill(0);
      plain.fill(0);
      if (fault === "ciphertext") changed.ciphertext = "AAAA";
      const encoded = canonicalJson(changed);
      let reached = false;
      const spy = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
        const rows = await query(sql, params);
        if (
          sql.startsWith(
            "SELECT native_control,application_io_cleanup FROM tf_v2_container_create_claims",
          )
        ) {
          reached = true;
          return rows.map((r) => ({ ...r, application_io_cleanup: encoded }));
        }
        return rows;
      });
      const fresh = x.f.reconstructNormal();
      try {
        await toResult(x, fresh.engine);
        expect(reached).toBe(true);
        expect(await claim(x)).toMatchObject({
          allocation_cleanup: "untouched",
          removed_at_ms: null,
        });
      } finally {
        spy.mockRestore();
        await fresh.close().catch(() => undefined);
      }
    }
    expect((await claim(x)).application_io_cleanup).toBe(row.application_io_cleanup);
    expect(count(x, "stop-init")).toBe(1);
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    await x.f.cleanup();
  }
});

test("durable-application exact schema refuses a missing third transition guard", async () => {
  const x = await live();
  try {
    await x.f.sql.run("DROP TRIGGER tf_v2_container_application_io_cleanup_transition");
    expect(await inspectV2ContainerOwnerApplicationIoSchema(x.f.sql)).toBe(false);
    expect(await inspectV2ContainerOwnerAllocationSchema(x.f.sql)).toBe(false);
    expect(await inspectV2ContainerOwnerControlSchema(x.f.sql)).toBe(false);
  } finally {
    await x.f.cleanup();
  }
});

test("durable-application key revoked after actual fact decryption refuses before allocation", async () => {
  const x = await savedWithLostAck(),
    ring = x.f.configuredInputs.keyring,
    originalKey = ring.keyForDecryption.bind(ring),
    decrypt = crypto.subtle.decrypt.bind(crypto.subtle),
    query = x.f.sql.query.bind(x.f.sql);
  let revoked = false,
    decrypted = false,
    reached = false,
    allocation = false,
    lastReads = 0;
  // Install before fresh Core captures its bound lookup; no module/getter
  // interception is treated as proof of reachability without the flags below.
  const keys = spyOn(ring, "keyForDecryption").mockImplementation((id) =>
    revoked ? undefined : originalKey(id),
  );
  const fresh = x.f.reconstructNormal();
  const decryption = spyOn(crypto.subtle, "decrypt").mockImplementation(
    async (algorithm, key, bytes) => {
      const result = await decrypt(algorithm, key, bytes);
      if (
        typeof algorithm === "object" &&
        "additionalData" in algorithm &&
        algorithm.additionalData instanceof Uint8Array
      ) {
        const scope = JSON.parse(new TextDecoder().decode(algorithm.additionalData));
        if (scope.purpose === "takoserver.linux-oci-application-io-close@1") decrypted = true;
      }
      return result;
    },
  );
  const reading = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await query(sql, params);
    if (decrypted && sql.startsWith("SELECT allocation_cleanup FROM tf_v2_container_create_claims"))
      allocation = true;
    if (
      allocation &&
      !reached &&
      sql.includes(" WHERE i.resource_uid=? AND v.generation=?") &&
      ++lastReads === 2
    )
      revoked = reached = true;
    return rows;
  });
  try {
    await toResult(x, fresh.engine);
    expect(decrypted).toBe(true);
    expect(allocation).toBe(true);
    expect(lastReads).toBe(2);
    expect(reached).toBe(true);
    expect(revoked).toBe(true);
    expect(await claim(x)).toMatchObject({
      allocation_cleanup: "untouched",
      removed_at_ms: null,
    });
    expect(count(x, "stop-init")).toBe(1);
    expect(x.f.network).not.toHaveBeenCalled();
  } finally {
    reading.mockRestore();
    decryption.mockRestore();
    keys.mockRestore();
    await fresh.close().catch(() => undefined);
    await x.f.cleanup();
  }
});

test("durable-application save key revoked in final awaited window refuses before fact CAS", async () => {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    allocationSchema: true,
  });
  const ring = f.configuredInputs.keyring,
    originalKey = ring.keyForDecryption.bind(ring),
    encrypt = crypto.subtle.encrypt.bind(crypto.subtle),
    query = f.sql.query.bind(f.sql),
    run = f.sql.run.bind(f.sql);
  let revoked = false,
    armed = false,
    reads = 0,
    checkedBeforeRevocation = 0,
    checkedAfterRevocation = 0,
    reached = false,
    saves = 0;
  // The actual Core captures this lookup at construction. Construct that same
  // normal creator before its first CREATE; do not replace a captured method.
  const keys = spyOn(ring, "keyForDecryption").mockImplementation((id) => {
    if (armed) {
      if (revoked) checkedAfterRevocation++;
      else checkedBeforeRevocation++;
    }
    return revoked ? undefined : originalKey(id);
  });
  const current = f.reconstructNormal(),
    health = acceptedRawHttp(),
    source = sourceObserver();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  const sealing = spyOn(crypto.subtle, "encrypt").mockImplementation(
    async (algorithm, key, bytes) => {
      const result = await encrypt(algorithm, key, bytes);
      if (
        typeof algorithm === "object" &&
        "additionalData" in algorithm &&
        algorithm.additionalData instanceof Uint8Array
      ) {
        const scope = JSON.parse(new TextDecoder().decode(algorithm.additionalData));
        if (scope.purpose === "takoserver.linux-oci-application-io-close@1") armed = true;
      }
      return result;
    },
  );
  const reading = spyOn(f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await query(sql, params);
    if (
      armed &&
      !reached &&
      sql.includes(" WHERE i.resource_uid=? AND v.generation=?") &&
      ++reads === 3
    ) {
      expect(checkedBeforeRevocation).toBeGreaterThan(0);
      revoked = reached = true;
    }
    return rows;
  });
  const saving = spyOn(f.sql, "run").mockImplementation((sql, params) => {
    if (ioSave(sql)) saves++;
    return run(sql, params);
  });
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    const accepted = await f.create(),
      x = { f, accepted };
    expect(await current.engine.runNext()).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    await current.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    await toResult(x, current.engine);
    expect(armed).toBe(true); // genuine application close passed before real AES
    expect(reached).toBe(true);
    expect(reads).toBe(3); // actual final load after the earlier same-key check
    expect(checkedAfterRevocation).toBeGreaterThan(0); // same bound lookup is used
    expect(source.values.length).toBeGreaterThan(0);
    expect(source.values.every((value) => value !== undefined)).toBe(true);
    expect(saves).toBe(0);
    expect(await claim(x)).toMatchObject({
      application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
      allocation_cleanup: "untouched",
      removed_at_ms: null,
    });
    for (const effect of ["create-stopped", "start", "stop-init"]) expect(count(x, effect)).toBe(1);
    expect(
      f.nativeCounts().requests.filter((kind) => kind === "linux-oci-parent-bootstrap@2"),
    ).toHaveLength(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    saving.mockRestore();
    reading.mockRestore();
    sealing.mockRestore();
    keys.mockRestore();
    source.restore();
    health.restore();
    await current.close().catch(() => undefined);
    await f.cleanup();
  }
});
