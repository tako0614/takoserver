import { expect, spyOn, test } from "bun:test";
import { canonicalJson, isJsonObject } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import * as originalBundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  V2_CONTAINER_APPLICATION_IO_RESERVED,
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { observeRawPromise, ownedRawHttp, rawTick } from "./container-http-transport.test.ts";
import { qualifiedNormalDeleteFixture } from "./linux-oci-normal-delete-consumer.test.ts";
import { acceptedRawHttp } from "./linux-oci-owned-bundle.test.ts";
import { originalPeerDeleteFixture } from "./linux-oci-peer-reconstruction.test.ts";

// Original normal creator/Engine, real AEAD and atomic owned memorySQLite.
// Hold only the existing raw H reply; all assertions escape Engine callbacks.
test("early-application-close-save actual I/O close commits before pending H and fresh same-operation resumes", async () => {
  const { f, accepted } = await qualifiedNormalDeleteFixture();
  const io = ownedRawHttp();
  const response = f.composition.fetchServingHttp(
    f.recordedCreate(),
    new Request("http://ignored.invalid/NONSECRET-live-upload-response"),
  );
  for (let tick = 0; tick < 100 && !io.counts().calls; tick++) await rawTick();
  expect(io.counts().calls).toBe(1);
  io.head();
  expect((await response).status).toBe(200);
  const removal = await f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid: accepted.resourceUid,
    expectedGeneration: 1,
  });
  f.holdPeerManagementReply("linux-oci-stop-init@1");
  const running = observeRawPromise(f.engine.runNext());
  let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    for (
      let tick = 0;
      tick < 200 && !f.nativeCounts().requests.includes("linux-oci-stop-init@1");
      tick++
    )
      await rawTick();
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(running.state()).toBe("pending");
    expect(io.counts().requestDestroy).toBe(1);
    io.closeResponse();
    io.closeRequest();
    let document: unknown;
    for (let tick = 0; tick < 200; tick++) {
      document = (
        await f.sql.query("SELECT application_io_cleanup FROM tf_v2_container_create_claims")
      )[0]?.application_io_cleanup;
      if (typeof document === "string" && document !== V2_CONTAINER_APPLICATION_IO_RESERVED) break;
      await rawTick();
    }
    expect(typeof document === "string" && document !== V2_CONTAINER_APPLICATION_IO_RESERVED).toBe(
      true,
    );
    expect(running.state()).toBe("pending");
    expect(
      (await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"))[0],
    ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
    if (typeof document !== "string") throw Error("NONSECRET close fact missing");
    const sealed: unknown = JSON.parse(document);
    if (
      !isJsonObject(sealed) ||
      !isJsonObject(sealed.scope) ||
      !isJsonObject(sealed.scope.operation) ||
      typeof sealed.nonce !== "string" ||
      typeof sealed.ciphertext !== "string"
    )
      throw Error("NONSECRET close fact shape");
    expect(sealed.scope.operation).toMatchObject({
      operationId: removal.id,
      action: "delete",
      generation: 2,
    });
    const closed = await decryptContainerSecretBytes(
      f.configuredInputs.keyring.current.key,
      decodeContainerSecretBytes(sealed.nonce),
      decodeContainerSecretBytes(sealed.ciphertext),
      new TextEncoder().encode(canonicalJson(sealed.scope)),
    );
    expect(new TextDecoder().decode(closed)).toBe(
      '{"kind":"linux-oci-original-application-io-closed@1"}',
    );
    closed.fill(0);
    f.releasePeerManagementReply();
    const first = await running.value;
    if ("error" in first) throw first.error;
    expect(first.result).toMatchObject({ id: removal.id, effect: "unknown" });
    fresh = f.reconstructNormal();
    let state: Awaited<ReturnType<typeof fresh.engine.runNext>> = null;
    for (let phase = 0; phase < 20; phase++) {
      f.advanceNormalClock(61_000);
      state = await fresh.engine.runNext();
      if (state?.status === "succeeded") break;
    }
    expect(state).toMatchObject({ id: removal.id, status: "succeeded", effect: "complete" });
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@3"),
    ).toHaveLength(1);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(io.counts().calls).toBe(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    f.releasePeerManagementReply();
    io.closeResponse();
    io.closeRequest();
    await running.value;
    await fresh?.close();
    io.restore();
    await f.cleanup();
  }
}, 20000);

async function pendingIo() {
  const { f, accepted } = await qualifiedNormalDeleteFixture();
  const io = ownedRawHttp();
  try {
    const response = f.composition.fetchServingHttp(
      f.recordedCreate(),
      new Request("http://ignored.invalid/NONSECRET-pending"),
    );
    for (let tick = 0; tick < 100 && !io.counts().calls; tick++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    expect((await response).status).toBe(200);
    const removal = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    return { f, io, removal };
  } catch (error) {
    io.closeResponse();
    io.closeRequest();
    io.restore();
    await f.cleanup();
    throw error;
  }
}
type PendingIo = Awaited<ReturnType<typeof pendingIo>>;
type Running = ReturnType<
  typeof observeRawPromise<Awaited<ReturnType<PendingIo["f"]["engine"]["runNext"]>>>
>;
async function closeDocument(f: PendingIo["f"]) {
  return (await f.sql.query("SELECT application_io_cleanup FROM tf_v2_container_create_claims"))[0]
    ?.application_io_cleanup;
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let tick = 0; tick < 200; tick++) {
    if (await check()) return;
    await rawTick();
  }
  throw Error("NONSECRET expected raw boundary not reached");
}
async function untouched(f: PendingIo["f"]) {
  expect(await closeDocument(f)).toBe(V2_CONTAINER_APPLICATION_IO_RESERVED);
  expect(
    (
      await f.sql.query(
        "SELECT state,allocation_cleanup,removed_at_ms FROM tf_v2_container_create_claims",
      )
    )[0],
  ).toEqual({ state: "bound", allocation_cleanup: "untouched", removed_at_ms: null });
}
const savesIo = (statement: string) =>
  statement.startsWith("UPDATE tf_v2_container_create_claims SET application_io_cleanup=");

test("early-application-close-save started save stays joined after H stage reply", async () => {
  const { f, io, removal } = await pendingIo();
  const actualRun = f.sql.run.bind(f.sql);
  let reached = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
    if (savesIo(statement)) {
      reached++;
      await gate;
    }
    return actualRun(statement, params);
  });
  f.holdPeerManagementReply("linux-oci-stop-init@1");
  const running = observeRawPromise(f.engine.runNext());
  try {
    await waitFor(() => f.nativeCounts().requests.includes("linux-oci-stop-init@1"));
    io.closeResponse();
    io.closeRequest();
    await waitFor(() => reached === 1);
    f.releasePeerManagementReply();
    for (let tick = 0; tick < 10; tick++) await rawTick();
    expect(running.state()).toBe("pending");
    await untouched(f);
    release();
    const result = await running.value;
    if ("error" in result) throw result.error;
    expect(result.result).toMatchObject({ id: removal.id, effect: "unknown" });
    const document = await closeDocument(f);
    expect(typeof document === "string" && document !== V2_CONTAINER_APPLICATION_IO_RESERVED).toBe(
      true,
    );
    expect(reached).toBe(1);
    expect(
      (await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"))[0],
    ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
  } finally {
    release();
    f.releasePeerManagementReply();
    io.closeResponse();
    io.closeRequest();
    await running.value;
    saving.mockRestore();
    io.restore();
    await f.cleanup();
  }
}, 20000);

test("early-application-close-save pending stage disarms before later close and next JOIN rearms", async () => {
  const { f, io, removal } = await pendingIo();
  let running: Running | undefined;
  try {
    expect(await f.engine.runNext()).toMatchObject({ id: removal.id, effect: "unknown" });
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(io.counts().requestDestroy).toBe(1);
    await untouched(f);
    io.closeResponse();
    io.closeRequest();
    for (let tick = 0; tick < 10; tick++) await rawTick();
    await untouched(f); // disarmed stage cannot start detached SQL
    f.holdPeerManagementReply("linux-oci-join-init@1");
    f.advanceNormalClock(61_000);
    running = observeRawPromise(f.engine.runNext());
    await waitFor(async () => (await closeDocument(f)) !== V2_CONTAINER_APPLICATION_IO_RESERVED);
    expect(running.state()).toBe("pending");
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(1);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(
      (await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"))[0],
    ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
    f.releasePeerManagementReply();
    const result = await running.value;
    if ("error" in result) throw result.error;
    expect(result.result).toMatchObject({ id: removal.id, effect: "unknown" });
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    f.releasePeerManagementReply();
    io.closeResponse();
    io.closeRequest();
    await running?.value;
    io.restore();
    await f.cleanup();
  }
}, 20000);

test("early-application-close-save actual raw close UNKNOWN never initializes fact", async () => {
  const { f, io, removal } = await pendingIo();
  let destroys = 0,
    saves = 0;
  const destroy = spyOn(io.request, "destroy").mockImplementation(() => {
    destroys++;
    throw Error("NONSECRET actual native close unknown");
  });
  const actualRun = f.sql.run.bind(f.sql);
  const saving = spyOn(f.sql, "run").mockImplementation((statement, params) => {
    if (savesIo(statement)) saves++;
    return actualRun(statement, params);
  });
  f.holdPeerManagementReply("linux-oci-stop-init@1");
  const running = observeRawPromise(f.engine.runNext());
  try {
    await waitFor(() => f.nativeCounts().requests.includes("linux-oci-stop-init@1"));
    expect(destroys).toBe(1);
    expect(running.state()).toBe("pending");
    io.closeResponse();
    io.closeRequest();
    for (let tick = 0; tick < 10; tick++) await rawTick();
    expect(saves).toBe(0);
    await untouched(f);
    f.releasePeerManagementReply();
    const result = await running.value;
    if ("error" in result) throw result.error;
    expect(result.result).toMatchObject({ id: removal.id, effect: "unknown" });
    expect(saves).toBe(0);
    await untouched(f);
  } finally {
    f.releasePeerManagementReply();
    io.closeResponse();
    io.closeRequest();
    await running.value;
    saving.mockRestore();
    destroy.mockRestore();
    io.restore();
    await f.cleanup();
  }
}, 20000);

test("early-application-close-save failed SQL save is joined without fact or native grant", async () => {
  const { f, io, removal } = await pendingIo();
  let saves = 0;
  const actualRun = f.sql.run.bind(f.sql);
  const saving = spyOn(f.sql, "run").mockImplementation((statement, params) => {
    if (savesIo(statement)) {
      saves++;
      throw Error("NONSECRET save refused");
    }
    return actualRun(statement, params);
  });
  f.holdPeerManagementReply("linux-oci-stop-init@1");
  const running = observeRawPromise(f.engine.runNext());
  try {
    await waitFor(() => f.nativeCounts().requests.includes("linux-oci-stop-init@1"));
    io.closeResponse();
    io.closeRequest();
    await waitFor(() => saves === 1);
    expect(running.state()).toBe("pending");
    await untouched(f);
    f.releasePeerManagementReply();
    const result = await running.value;
    if ("error" in result) throw result.error;
    expect(result.result).toMatchObject({ id: removal.id, effect: "unknown" });
    for (let tick = 0; tick < 5; tick++) await rawTick();
    expect(saves).toBe(1);
    await untouched(f);
  } finally {
    f.releasePeerManagementReply();
    io.closeResponse();
    io.closeRequest();
    await running.value;
    saving.mockRestore();
    io.restore();
    await f.cleanup();
  }
}, 20000);

test("early-application-close-save committed lost ACK recovers same fact without resave", async () => {
  const { f, io, removal } = await pendingIo();
  let saves = 0;
  const actualRun = f.sql.run.bind(f.sql);
  const saving = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
    const result = await actualRun(statement, params);
    if (savesIo(statement)) {
      saves++;
      if (result.changes === 1) throw Error("NONSECRET save ACK lost after commit");
    }
    return result;
  });
  f.holdPeerManagementReply("linux-oci-stop-init@1");
  const running = observeRawPromise(f.engine.runNext());
  let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    await waitFor(() => f.nativeCounts().requests.includes("linux-oci-stop-init@1"));
    io.closeResponse();
    io.closeRequest();
    await waitFor(() => saves === 1);
    const document = await closeDocument(f);
    expect(typeof document === "string" && document !== V2_CONTAINER_APPLICATION_IO_RESERVED).toBe(
      true,
    );
    expect(running.state()).toBe("pending");
    f.releasePeerManagementReply();
    const result = await running.value;
    if ("error" in result) throw result.error;
    expect(result.result).toMatchObject({ id: removal.id, effect: "unknown" });
    fresh = f.reconstructNormal();
    let state: Awaited<ReturnType<typeof fresh.engine.runNext>> = null;
    for (let phase = 0; phase < 20; phase++) {
      f.advanceNormalClock(61_000);
      state = await fresh.engine.runNext();
      if (state?.status === "succeeded") break;
    }
    expect(state).toMatchObject({ id: removal.id, status: "succeeded", effect: "complete" });
    expect(await closeDocument(f)).toBe(document);
    expect(saves).toBe(1);
    for (const kind of [
      "linux-oci-create-stopped@1",
      "linux-oci-parent-bootstrap@3",
      "linux-oci-stop-init@1",
    ])
      expect(f.nativeCounts().requests.filter((k) => k === kind)).toHaveLength(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    f.releasePeerManagementReply();
    io.closeResponse();
    io.closeRequest();
    await running.value;
    saving.mockRestore();
    await fresh?.close();
    io.restore();
    await f.cleanup();
  }
}, 20000);

for (const fault of ["lease", "operation", "cancel"] as const) {
  test(`early-application-close-save final awaited ${fault} loss refuses early fact CAS`, async () => {
    const { f, io, removal } = await pendingIo();
    const actualQuery = f.sql.query.bind(f.sql),
      actualRun = f.sql.run.bind(f.sql),
      encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let armed = false,
      reads = 0,
      reached = false,
      saves = 0;
    let closing: Promise<void> | undefined;
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
    const reading = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
      const rows = await actualQuery(statement, params);
      if (
        armed &&
        !reached &&
        statement.includes(" WHERE i.resource_uid=? AND v.generation=?") &&
        ++reads === 3
      ) {
        reached = true;
        if (fault === "lease")
          await actualRun("UPDATE tf_v2_operations SET lease_token=? WHERE id=?", [
            "NONSECRET-replaced-lease",
            removal.id,
          ]);
        else if (fault === "operation")
          Object.defineProperty(f.execution, "operationId", {
            value: "NONSECRET-foreign-operation",
          });
        else {
          closing = f.composition.close();
          void closing.catch(() => undefined);
        }
      }
      return rows;
    });
    const saving = spyOn(f.sql, "run").mockImplementation((statement, params) => {
      if (savesIo(statement)) saves++;
      return actualRun(statement, params);
    });
    f.holdPeerManagementReply("linux-oci-stop-init@1");
    const running = observeRawPromise(f.engine.runNext());
    try {
      await waitFor(() => f.nativeCounts().requests.includes("linux-oci-stop-init@1"));
      io.closeResponse();
      io.closeRequest();
      await waitFor(() => reached);
      f.releasePeerManagementReply();
      const result = await running.value;
      if ("error" in result) throw result.error;
      expect(result.result).toMatchObject({ id: removal.id, effect: "unknown" });
      expect(armed).toBe(true);
      expect(reads).toBe(3);
      if (fault !== "lease") expect(saves).toBe(0);
      else expect(saves).toBe(1); // actual CAS rejects the replaced SQL lease
      await untouched(f);
      expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(
        1,
      );
    } finally {
      f.releasePeerManagementReply();
      io.closeResponse();
      io.closeRequest();
      await running.value;
      reading.mockRestore();
      saving.mockRestore();
      sealing.mockRestore();
      await closing?.catch(() => undefined);
      io.restore();
      await f.cleanup();
    }
  }, 20000);
}

test("early-application-close-save foreign original custody refuses without native retry", async () => {
  const { f, io, removal } = await pendingIo();
  const original = originalBundle.originalLinuxOciHttpRetirementSource;
  let reads = 0,
    refused = false;
  const source = spyOn(originalBundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (_custody, core, record, signal) => {
      reads++;
      try {
        return original({}, core, record, signal);
      } catch (error) {
        refused = error instanceof Error && error.message.includes("http_custody");
        throw error;
      }
    },
  );
  try {
    expect(await f.engine.runNext()).toMatchObject({ id: removal.id, effect: "unknown" });
    expect(reads).toBe(1);
    expect(refused).toBe(true);
    await untouched(f);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(0);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    io.closeResponse();
    io.closeRequest();
    source.mockRestore();
    io.restore();
    await f.cleanup();
  }
}, 20000);

test("early-application-close-save final save window key revocation uses original captured lookup", async () => {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    allocationSchema: true,
    qualifiedProducer: true,
  });
  const ring = f.configuredInputs.keyring,
    lookup = ring.keyForDecryption.bind(ring),
    encrypt = crypto.subtle.encrypt.bind(crypto.subtle),
    actualQuery = f.sql.query.bind(f.sql),
    actualRun = f.sql.run.bind(f.sql);
  let revoked = false,
    armed = false,
    reads = 0,
    reached = false,
    checkedAfter = 0,
    saves = 0;
  const keys = spyOn(ring, "keyForDecryption").mockImplementation((id) => {
    if (revoked) checkedAfter++;
    return revoked ? undefined : lookup(id);
  });
  const current = f.reconstructNormal(); // captures the genuine lookup before first CREATE
  const health = acceptedRawHttp();
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
  const reading = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
    const rows = await actualQuery(statement, params);
    if (
      armed &&
      !reached &&
      statement.includes(" WHERE i.resource_uid=? AND v.generation=?") &&
      ++reads === 3
    )
      revoked = reached = true;
    return rows;
  });
  const saving = spyOn(f.sql, "run").mockImplementation((statement, params) => {
    if (savesIo(statement)) saves++;
    return actualRun(statement, params);
  });
  let running: Running | undefined;
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    const accepted = await f.create();
    expect(await current.engine.runNext()).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    health.restore();
    const removal = await current.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    f.holdPeerManagementReply("linux-oci-stop-init@1");
    running = observeRawPromise(current.engine.runNext());
    await waitFor(() => reached);
    expect(running.state()).toBe("pending");
    f.releasePeerManagementReply();
    const result = await running.value;
    if ("error" in result) throw result.error;
    expect(result.result).toMatchObject({ id: removal.id, effect: "unknown" });
    expect(armed).toBe(true);
    expect(reads).toBe(3);
    expect(checkedAfter).toBeGreaterThan(0);
    expect(saves).toBe(0);
    await untouched(f);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    f.releasePeerManagementReply();
    await running?.value;
    reading.mockRestore();
    saving.mockRestore();
    sealing.mockRestore();
    keys.mockRestore();
    health.restore();
    await current.close().catch(() => undefined);
    await f.cleanup();
  }
}, 20000);
