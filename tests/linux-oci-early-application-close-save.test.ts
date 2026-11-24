import { expect, spyOn, test } from "bun:test";
import { canonicalJson, isJsonObject } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import * as originalBundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  v2ConfiguredUpdateDiscardTransition,
  v2FinalDeleteConfiguredUpdateDiscardTransition,
} from "../src/takoform-v2/configured-update-inputs-schema.ts";
import {
  V2_CONTAINER_APPLICATION_IO_RESERVED,
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import {
  observeRawPromise,
  ownedRawHttp,
  rawTick,
} from "./helpers/container-http-transport-fixture.ts";
import { qualifiedNormalDeleteFixture } from "./helpers/linux-oci-normal-delete-fixture.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

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

const trackedCloseCases = ["complete START", "incomplete START", "stale lease"] as const;
for (const fault of trackedCloseCases) {
  test(
    `early-application-close-save tracked pre-STOP recovery with ${fault}`,
    () => trackedPreStopClose(fault),
    20000,
  );
}

async function trackedPreStopClose(fault: (typeof trackedCloseCases)[number]) {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
    ...(fault === "incomplete START" ? { managementFault: "incomplete" as const } : {}),
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  const count = (kind: string) => f.nativeCounts().requests.filter((k) => k === kind).length;
  const stop = "linux-oci-stop-init@1";
  let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    await f.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    await f.sql.batch(v2FinalDeleteConfiguredUpdateDiscardTransition());
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(count("linux-oci-parent-bootstrap@6")).toBe(1);
    health.restore();

    // Join the actual serving exchange before DELETE so the original
    // application's close can fulfill before any native stop is needed.
    const io = ownedRawHttp();
    try {
      const response = f.composition.fetchServingHttp(
        f.recordedCreate(),
        new Request("http://ignored.invalid/NONSECRET-joined-response"),
      );
      await waitFor(() => io.counts().calls === 1);
      io.head();
      const serving = await response;
      expect(serving.status).toBe(200);
      io.incoming.end("NONSECRET joined body");
      expect(await serving.text()).toBe("NONSECRET joined body");
    } finally {
      io.closeResponse();
      io.closeRequest();
      io.restore();
    }
    const removal = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    await untouched(f);
    const actualRun = f.sql.run.bind(f.sql);
    const actualQuery = f.sql.query.bind(f.sql);
    let saves = 0,
      changedLease = 0;
    let stopsAtCommit: number | undefined;
    const saving = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
      const result = await actualRun(statement, params);
      if (savesIo(statement) && ++saves === 1 && result.changes === 1) {
        stopsAtCommit = count(stop);
        if (fault !== "stale lease")
          throw Error("NONSECRET close CAS acknowledgement lost after commit");
      }
      return result;
    });
    const reading =
      fault === "stale lease"
        ? spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
            if (
              !changedLease &&
              statement.startsWith("SELECT 1 FROM tf_v2_container_create_claims") &&
              statement.includes("AND EXISTS (SELECT 1 FROM tf_v2_container_start_attempts") &&
              statement.includes("AND EXISTS (SELECT 1 FROM tf_v2_operations")
            ) {
              const replaced = await actualRun(
                "UPDATE tf_v2_operations SET lease_token=? WHERE id=? AND lease_token IS NOT NULL",
                ["NONSECRET-replaced-lease", removal.id],
              );
              changedLease = replaced.changes;
            }
            return actualQuery(statement, params);
          })
        : undefined;
    try {
      expect(await f.engine.runNext()).toMatchObject({
        id: removal.id,
        status: "reconciling",
        effect: "unknown",
      });
    } finally {
      reading?.mockRestore();
      saving.mockRestore();
    }
    expect(saves).toBe(1);
    expect(stopsAtCommit).toBe(0);
    expect(count(stop)).toBe(0);
    const document = await closeDocument(f);
    if (typeof document !== "string") throw Error("NONSECRET committed close fact missing");
    expect(JSON.parse(document)).toMatchObject({
      kind: "linux-oci-sealed-application-io-close@1",
      scope: { operation: { operationId: removal.id, action: "delete", generation: 2 } },
    });
    if (fault === "stale lease") {
      expect(changedLease).toBe(1);
      expect(
        await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"),
      ).toEqual([{ state: "bound", allocation_cleanup: "untouched" }]);
      expect(f.network).not.toHaveBeenCalled();
      return;
    }

    fresh = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    const beforeRead = count("linux-oci-parent-read-outcome@2");
    let state = await fresh.engine.runNext();
    expect(state).toMatchObject({ id: removal.id, status: "reconciling", effect: "unknown" });
    expect(count("linux-oci-parent-read-outcome@2")).toBe(beforeRead + 1);
    if (fault === "incomplete START") {
      expect(count(stop)).toBe(0);
      expect(await closeDocument(f)).toBe(document);
      expect(
        await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"),
      ).toEqual([{ state: "bound", allocation_cleanup: "untouched" }]);
      expect(f.network).not.toHaveBeenCalled();
      return;
    }
    expect(count(stop)).toBe(1);
    for (let phase = 0; phase < 20 && state?.status !== "succeeded"; phase++) {
      f.advanceNormalClock(61_000);
      state = await fresh.engine.runNext();
    }
    expect(state).toMatchObject({ id: removal.id, status: "succeeded", effect: "complete" });
    expect(
      (
        await f.sql.query(
          "SELECT state,allocation_cleanup,removed_at_ms FROM tf_v2_container_create_claims",
        )
      )[0],
    ).toMatchObject({
      state: "removed",
      allocation_cleanup: "closed",
      removed_at_ms: expect.any(Number),
    });
    expect(await closeDocument(f)).toBe(document);
    for (const kind of [
      "linux-oci-parent-bootstrap@6",
      "linux-oci-create-stopped@1",
      "linux-oci-start@1",
      stop,
      "linux-oci-read-tracked-join@1",
    ])
      expect(count(kind)).toBe(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    health.restore();
    await fresh?.close().catch(() => undefined);
    await f.cleanup();
  }
}

test("early-application-close-save cold recovery stops when cleanup advances after the parent read", async () => {
  const { f, io, removal } = await pendingIo();
  const requestCount = (kind: string) => f.nativeCounts().requests.filter((k) => k === kind).length;
  const parentRead = "linux-oci-parent-read-outcome@2";
  f.holdPeerManagementReply("linux-oci-stop-init@1");
  const running = observeRawPromise(f.engine.runNext());
  const query = f.sql.query.bind(f.sql);
  let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
  let initialReads: number | undefined;
  let observedCleanupAdvance = false;
  let changed = 0;
  const reader = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
    const rows = await query(statement, params);
    if (
      initialReads !== undefined &&
      !observedCleanupAdvance &&
      requestCount(parentRead) > initialReads &&
      statement.startsWith("SELECT op.accepted_spec_json FROM tf_v2_operations op")
    ) {
      observedCleanupAdvance = true;
      // Another lifecycle step has already consumed this allocation's cleanup slot.
      const result = await f.sql.run(
        "UPDATE tf_v2_container_create_claims SET allocation_cleanup='consumed' WHERE resource_uid=? AND state='bound' AND allocation_cleanup='untouched'",
        [removal.resourceUid],
      );
      changed = result.changes;
    }
    return rows;
  });
  try {
    await waitFor(() => requestCount("linux-oci-stop-init@1") === 1);
    io.closeResponse();
    io.closeRequest();
    await waitFor(async () => {
      const document = await closeDocument(f);
      return typeof document === "string" && document !== V2_CONTAINER_APPLICATION_IO_RESERVED;
    });
    f.releasePeerManagementReply();
    const first = await running.value;
    if ("error" in first) throw first.error;
    expect(first.result).toMatchObject({ id: removal.id, effect: "unknown" });
    initialReads = requestCount(parentRead);
    fresh = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    expect(await fresh.engine.runNext()).toMatchObject({
      id: removal.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(changed).toBe(1);
    expect(requestCount(parentRead)).toBe(initialReads + 1);
    expect(requestCount("linux-oci-stop-init@1")).toBe(1);
    expect(requestCount("linux-oci-join-init@1")).toBe(0);
    expect(
      await query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"),
    ).toEqual([{ state: "bound", allocation_cleanup: "consumed" }]);
    expect(f.network).not.toHaveBeenCalled();
    await expect(fresh.close()).rejects.toThrow("linux_oci_physical_session_parent_peer_retained");
  } finally {
    f.releasePeerManagementReply();
    io.closeResponse();
    io.closeRequest();
    await running.value;
    await fresh?.close().catch(() => undefined);
    reader.mockRestore();
    io.restore();
    await f.cleanup();
  }
}, 20000);

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
