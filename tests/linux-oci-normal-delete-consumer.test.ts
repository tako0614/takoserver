import { expect, spyOn, test } from "bun:test";
import { isJsonObject } from "../src/json.ts";
import * as originalBundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  v2ConfiguredUpdateDiscardTransition,
  v2FinalDeleteConfiguredUpdateDiscardTransition,
} from "../src/takoform-v2/configured-update-inputs-schema.ts";
import {
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import * as hostAcceptance from "../src/takoform-v2/host-acceptance.ts";
import { observeRawPromise, ownedRawHttp, rawTick } from "./container-http-transport.test.ts";
import { acceptedRawHttp } from "./linux-oci-owned-bundle.test.ts";
import { originalPeerDeleteFixture } from "./linux-oci-peer-reconstruction.test.ts";

// Explicit NONSECRET bytes inside the original factory; actual normal Engine,
// Core, crypto, atomic memorySQLite and closed raw P/H/HTTP model. Old registered
// cases are filtered. All assertions are outside Engine backend callbacks.
async function live(
  options: {
    producerRevision?: "missing";
    producerDigest?: "missing" | "wrong";
    localCleanup?: boolean;
  } = {},
) {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    allocationSchema: true,
    qualifiedProducer: true,
    ...options,
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    await f.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    await f.sql.batch(v2FinalDeleteConfiguredUpdateDiscardTransition());
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    return { f, accepted };
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}

test("normal-delete-consumer canonical runtime3 original completion reaches normal DELETE settlement", async () => {
  const { f, accepted } = await live();
  try {
    const deleting = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    let final: Awaited<ReturnType<typeof f.engine.runNext>> = null;
    let closed = false;
    for (let phase = 0; phase < 16; phase++) {
      f.advanceNormalClock(61_000);
      final = await f.engine.runNext();
      const claims = await f.sql.query("SELECT * FROM tf_v2_container_create_claims");
      expect(claims).toHaveLength(1);
      closed = claims[0]?.allocation_cleanup === "closed";
      if (final?.status === "succeeded" || closed) break;
    }
    expect(closed).toBe(true);
    expect(final).toMatchObject({ id: deleting.id, status: "succeeded", effect: "complete" });
    const claim = (await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
    expect(claim).toMatchObject({ state: "removed", allocation_cleanup: "closed" });
    expect(typeof claim?.removed_at_ms).toBe("number");
    expect(await f.sql.query("SELECT * FROM tf_v2_configured_private_inputs")).toHaveLength(0);
    expect(
      await f.sql.query("SELECT * FROM tf_v2_operation_configured_private_inputs"),
    ).toHaveLength(0);
    expect(
      await f.sql.query(
        "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
      ),
    ).toHaveLength(0);
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-read-tracked-join@1"),
    ).toHaveLength(1);
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-parent-bootstrap@3"),
    ).toHaveLength(1);
    expect(
      f.nativeCounts().requests.filter((k) => k === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-start@1")).toHaveLength(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

type Fixture = Awaited<ReturnType<typeof live>>["f"];
async function deleting(f: Fixture, uid: string) {
  return f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid,
    expectedGeneration: 1,
  });
}
async function step(f: Fixture, engine = f.engine) {
  f.advanceNormalClock(61_000);
  return engine.runNext();
}
async function through(f: Fixture, predicate: () => Promise<boolean>) {
  for (let phase = 0; phase < 16; phase++) {
    const result = await step(f);
    if (await predicate()) return result;
  }
  throw Error("NONSECRET retirement boundary not reached");
}

for (const loss of ["native-CAS", "payload-batch"] as const) {
  test(`normal-delete-consumer ${loss} lost ACK resumes same-operation finalization without a second native read/effect`, async () => {
    const { f, accepted } = await live();
    const actualRun = f.sql.run.bind(f.sql),
      actualBatch = f.sql.batch.bind(f.sql);
    let lost = false,
      fresh: ReturnType<typeof f.reconstructNormal> | undefined;
    const run = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
      const result = await actualRun(statement, params);
      if (
        !lost &&
        loss === "native-CAS" &&
        statement.startsWith("UPDATE tf_v2_container_create_claims SET state='removed'") &&
        result.changes === 1
      ) {
        lost = true;
        throw Error("NONSECRET native CAS ACK lost after commit");
      }
      return result;
    });
    const batch = spyOn(f.sql, "batch").mockImplementation(async (statements) => {
      const result = await actualBatch(statements);
      if (
        !lost &&
        loss === "payload-batch" &&
        statements[0]?.sql.startsWith(
          "INSERT INTO tf_v2_configured_update_discard_gate(operation_id) SELECT NULL",
        )
      ) {
        lost = true;
        throw Error("NONSECRET payload ACK lost after commit");
      }
      return result;
    });
    try {
      const removal = await deleting(f, accepted.resourceUid);
      expect(await through(f, async () => lost)).toMatchObject({
        id: removal.id,
        effect: "unknown",
        status: "reconciling",
      });
      expect(lost).toBe(true);
      expect((await f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
        "removed",
      );
      const before = f.nativeCounts();
      run.mockRestore();
      batch.mockRestore();
      fresh = f.reconstructNormal();
      expect(await step(f, fresh.engine)).toMatchObject({
        id: removal.id,
        effect: "complete",
        status: "succeeded",
      });
      expect(f.nativeCounts()).toEqual(before);
      expect(await f.sql.query("SELECT * FROM tf_v2_configured_private_inputs")).toHaveLength(0);
      expect(
        await f.sql.query(
          "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
        ),
      ).toHaveLength(0);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
      batch.mockRestore();
      await fresh?.close();
      await f.cleanup();
    }
  });
}

for (const fault of ["old-producer", "missing-build", "wrong-build", "local4"] as const) {
  test(`normal-delete-consumer ${fault} never upgrades historical/local facts into removal`, async () => {
    const { f, accepted } = await live(
      fault === "old-producer"
        ? { producerRevision: "missing" }
        : fault === "local4"
          ? { localCleanup: true }
          : { producerDigest: fault === "missing-build" ? "missing" : "wrong" },
    );
    try {
      const removal = await deleting(f, accepted.resourceUid);
      expect(
        await through(
          f,
          async () =>
            (await f.sql.query("SELECT allocation_cleanup FROM tf_v2_container_create_claims"))[0]
              ?.allocation_cleanup === "closed",
        ),
      ).toMatchObject({ id: removal.id, effect: "unknown", status: "reconciling" });
      expect((await f.sql.query("SELECT state FROM tf_v2_container_create_claims"))[0]?.state).toBe(
        "bound",
      );
      expect(await f.sql.query("SELECT * FROM tf_v2_configured_private_inputs")).toHaveLength(1);
      expect(
        await f.sql.query(
          "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
        ),
      ).toHaveLength(1);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
}

for (const fault of ["lease", "operation", "cancel", "key"] as const) {
  test(`normal-delete-consumer final awaited ${fault} loss refuses cipherpayload erasure under fresh same-operation recovery`, async () => {
    const { f, accepted } = await live();
    const actualRun = f.sql.run.bind(f.sql),
      actualQuery = f.sql.query.bind(f.sql);
    let staged = false,
      materialRead = false,
      hit = false,
      revoked = false;
    let fresh: ReturnType<typeof f.reconstructNormal> | undefined;
    const staging = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
      const result = await actualRun(statement, params);
      if (
        !staged &&
        statement.startsWith("UPDATE tf_v2_container_create_claims SET state='removed'") &&
        result.changes === 1
      ) {
        staged = true;
        throw Error("NONSECRET Native commit before finalizer");
      }
      return result;
    });
    const lookup = f.configuredInputs.keyring.keyForDecryption.bind(f.configuredInputs.keyring);
    const key = spyOn(f.configuredInputs.keyring, "keyForDecryption").mockImplementation((id) =>
      revoked ? undefined : lookup(id),
    );
    const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
      const rows = await actualQuery(statement, params);
      if (
        statement.startsWith(
          "SELECT operation_id,generation FROM tf_v2_operation_configured_private_inputs",
        )
      )
        materialRead = true;
      if (materialRead && !hit && statement.startsWith("SELECT op.accepted_spec_json")) {
        hit = true;
        if (fault === "lease")
          await actualRun("UPDATE tf_v2_operations SET lease_token=? WHERE id=?", [
            "NONSECRET-foreign-lease",
            f.execution?.operationId ?? "",
          ]);
        else if (fault === "operation")
          Object.defineProperty(f.execution, "operationId", {
            value: "NONSECRET-foreign-operation",
          });
        else if (fault === "cancel") void fresh?.close().catch(() => undefined);
        else revoked = true;
      }
      return rows;
    });
    try {
      const removal = await deleting(f, accepted.resourceUid);
      expect(await through(f, async () => staged)).toMatchObject({
        id: removal.id,
        effect: "unknown",
        status: "reconciling",
      });
      staging.mockRestore();
      const before = f.nativeCounts();
      fresh = f.reconstructNormal(); // the real Core captures the already installed key lookup
      expect(await step(f, fresh.engine)).toMatchObject({
        id: removal.id,
        effect: "unknown",
        status: "reconciling",
      });
      expect(materialRead).toBe(true);
      expect(hit).toBe(true);
      expect(f.nativeCounts()).toEqual(before);
      expect(
        await actualQuery(
          "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
        ),
      ).toHaveLength(1);
      expect(await actualQuery("SELECT * FROM tf_v2_configured_private_inputs")).toHaveLength(1);
    } finally {
      staging.mockRestore();
      query.mockRestore();
      key.mockRestore();
      await fresh?.close();
      await f.cleanup();
    }
  });
}

test("normal-delete-consumer expanded acceptance history still refuses active sanitization and identity rewrite", async () => {
  const { f } = await live();
  try {
    for (const statement of [
      "UPDATE tf_v2_container_acceptances SET configured_private_inputs_json=NULL",
      "UPDATE tf_v2_container_acceptances SET fingerprint='NONSECRET-foreign'",
    ]) {
      const outcome = await f.sql.run(statement).then(
        () => ({ refused: false }),
        () => ({ refused: true }),
      );
      expect(outcome.refused).toBe(true);
    }
    expect(
      await f.sql.query(
        "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
      ),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("normal-delete-consumer actual HTTP terminal gates erasure then evicts only same-Resource original contexts", async () => {
  const { f, accepted } = await live(),
    io = ownedRawHttp();
  const actualSource = originalBundle.originalLinuxOciHttpRetirementSource;
  let sourceCalls = 0;
  const source = spyOn(originalBundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (...args) => {
      sourceCalls++;
      return actualSource(...args);
    },
  );
  const deleted: { owner: Map<unknown, unknown>; key: unknown }[] = [];
  const actualDelete = Map.prototype.delete;
  const deletion = spyOn(Map.prototype, "delete").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
  ) {
    const value: unknown = this.get(key);
    if (
      typeof value === "object" &&
      value !== null &&
      "resourceUid" in value &&
      value.resourceUid === accepted.resourceUid &&
      "specJson" in value &&
      "fingerprint" in value
    )
      deleted.push({ owner: this, key });
    return actualDelete.call(this, key);
  });
  try {
    const response = f.composition.fetchServingHttp(
      f.recordedCreate(),
      new Request("http://ignored.invalid/NONSECRET-owned"),
    );
    for (let tick = 0; tick < 50 && !io.counts().calls; tick++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    await response;
    const removal = await deleting(f, accepted.resourceUid);
    const pendingStep = () => observeRawPromise(step(f));
    let waiting: ReturnType<typeof pendingStep> | undefined;
    for (let phase = 0; phase < 16; phase++) {
      const pending = pendingStep();
      for (let tick = 0; tick < 100 && pending.state() === "pending" && !sourceCalls; tick++)
        await rawTick();
      if (sourceCalls) {
        waiting = pending;
        break;
      }
      expect(await pending.value).toHaveProperty("result");
    }
    if (!waiting) throw Error("NONSECRET actual Core application handoff not reached");
    expect(waiting.state()).toBe("pending");
    expect(
      (await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"))[0],
    ).toEqual({ state: "bound", allocation_cleanup: "untouched" });
    expect(
      await f.sql.query(
        "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE configured_private_inputs_json IS NOT NULL",
      ),
    ).toHaveLength(1);
    const row = (
      await f.sql.query("SELECT spec_json,form_url FROM tf_v2_resources WHERE uid=?", [
        accepted.resourceUid,
      ])
    )[0];
    if (typeof row?.spec_json !== "string" || typeof row.form_url !== "string")
      throw Error("NONSECRET accepted input absent");
    const spec: unknown = JSON.parse(row.spec_json);
    if (!isJsonObject(spec)) throw Error("NONSECRET accepted spec invalid");
    const other = await f.engine.acceptCreate({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      input: {
        form: row.form_url,
        space: "synthetic-space",
        name: "NONSECRET-other-resource",
        spec,
        privateInputs: { SECRET: "NONSECRET-other-value" },
      },
    });
    io.closeResponse();
    await rawTick();
    expect(waiting.state()).toBe("pending");
    expect(deleted).toHaveLength(0);
    io.closeRequest();
    expect(await waiting.value).toMatchObject({
      result: { id: removal.id, effect: "complete", status: "succeeded" },
    });
    const owner = deleted.find((item) => item.key === accepted.id)?.owner;
    expect(owner).toBeDefined();
    expect(deleted.some((item) => item.owner === owner && item.key === removal.id)).toBe(true);
    expect(owner?.has(accepted.id)).toBe(false);
    expect(owner?.has(removal.id)).toBe(false);
    expect(owner?.get(other.id)).toHaveProperty("resourceUid", other.resourceUid);
    expect(
      await f.sql.query("SELECT * FROM tf_v2_configured_private_inputs WHERE resource_uid=?", [
        accepted.resourceUid,
      ]),
    ).toHaveLength(0);
    expect(
      await f.sql.query("SELECT * FROM tf_v2_configured_private_inputs WHERE resource_uid=?", [
        other.resourceUid,
      ]),
    ).toHaveLength(1);
    expect(io.counts().calls).toBe(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    deletion.mockRestore();
    source.mockRestore();
    io.closeResponse();
    io.closeRequest();
    io.restore();
    await f.cleanup();
  }
});

test("normal-delete-consumer delayed original UPDATE prepare cannot recapture secrets or cancel the final DELETE while another Resource is retained", async () => {
  const { f, accepted } = await live();
  const originalBuilder = hostAcceptance.prepareV2HostAcceptance;
  const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
  if (!descriptor) throw Error("NONSECRET original Promise descriptor absent");
  const originalThen = Promise.prototype.then,
    originalSet = Map.prototype.set;
  let captured: Parameters<typeof originalBuilder>[1] | undefined;
  let otherContext: Parameters<typeof originalBuilder>[1] | undefined;
  let otherOwner: Map<unknown, unknown> | undefined;
  const capturedContext = (): Parameters<typeof originalBuilder>[1] | undefined => captured;
  const retainedOwner = (): Map<unknown, unknown> | undefined => otherOwner;
  let interceptNext = false,
    delayed = false,
    callbackCalls = 0,
    retained = 0,
    finalAwait = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const builder = spyOn(hostAcceptance, "prepareV2HostAcceptance").mockImplementation((...args) => {
    const original = originalBuilder(...args);
    if (args[1].action === "update" && args[1].resourceUid === accepted.resourceUid) {
      captured = args[1];
      interceptNext = true;
    }
    if (args[1].action === "create" && args[1].resourceUid !== accepted.resourceUid)
      otherContext = args[1];
    return original; // same opaque prepared acceptance; never a replacement grant
  });
  // biome-ignore lint/suspicious/noThenProperty: Raw fixture delays the actual Promise continuation.
  Object.defineProperty(Promise.prototype, "then", {
    ...descriptor,
    value: function (this: Promise<unknown>, fulfilled: unknown, rejected: unknown) {
      if (!interceptNext) return Reflect.apply(originalThen, this, [fulfilled, rejected]);
      interceptNext = false;
      if (typeof fulfilled !== "function" || !String(fulfilled).includes("capture(context)"))
        throw Error("NONSECRET original Core capture callback not visited");
      delayed = true;
      return Reflect.apply(originalThen, this, [
        (value: unknown) =>
          Reflect.apply(originalThen, gate, [
            () => {
              callbackCalls++;
              return fulfilled(value);
            },
          ]),
        rejected,
      ]);
    },
  });
  const retaining = spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    if (captured !== undefined && value === captured) retained++;
    if (otherContext !== undefined && value === otherContext) otherOwner = this;
    return originalSet.call(this, key, value);
  });
  let update:
    | ReturnType<typeof observeRawPromise<Awaited<ReturnType<typeof f.engine.acceptUpdate>>>>
    | undefined;
  const originalBatch = f.sql.batch.bind(f.sql);
  const batch = spyOn(f.sql, "batch").mockImplementation(async (statements) => {
    const result = await originalBatch(statements);
    if (
      statements.some((statement) =>
        statement.sql.startsWith(
          "UPDATE tf_v2_container_acceptances SET configured_private_inputs_json=NULL",
        ),
      )
    ) {
      finalAwait = true;
      release();
      if (!update) throw Error("NONSECRET original UPDATE missing at final batch");
      await update.value;
    }
    return result;
  });
  try {
    const row = (
      await f.sql.query("SELECT spec_json,form_url FROM tf_v2_resources WHERE uid=?", [
        accepted.resourceUid,
      ])
    )[0];
    if (typeof row?.spec_json !== "string" || typeof row.form_url !== "string")
      throw Error("NONSECRET accepted spec absent");
    const spec: unknown = JSON.parse(row.spec_json);
    if (!isJsonObject(spec)) throw Error("NONSECRET accepted spec invalid");
    update = observeRawPromise(
      f.engine.acceptUpdate({
        principal: "synthetic-oci-parent",
        key: crypto.randomUUID(),
        uid: accepted.resourceUid,
        expectedGeneration: 1,
        spec,
        privateInputs: { SECRET: "NONSECRET-delayed-value" },
      }),
    );
    for (let tick = 0; tick < 100 && !delayed; tick++) await rawTick();
    expect(delayed).toBe(true);
    expect(capturedContext()?.action).toBe("update");
    expect(update.state()).toBe("pending");
    const removal = await deleting(f, accepted.resourceUid);
    expect(
      await through(
        f,
        async () =>
          (await f.sql.query("SELECT status FROM tf_v2_operations WHERE id=?", [removal.id]))[0]
            ?.status === "succeeded",
      ),
    ).toMatchObject({ id: removal.id, effect: "complete", status: "succeeded" });
    expect(finalAwait).toBe(true);
    expect(await update.value).toHaveProperty("error");
    expect(callbackCalls).toBe(1);
    expect(retained).toBe(0);
    expect(
      await f.sql.query("SELECT * FROM tf_v2_operation_configured_private_inputs"),
    ).toHaveLength(0);
    expect(
      f.nativeCounts().requests.filter((kind) => kind === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
    const other = await f.engine.acceptCreate({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      input: {
        form: row.form_url,
        space: "synthetic-space",
        name: "NONSECRET-other-after-final-DELETE",
        spec,
        privateInputs: { SECRET: "NONSECRET-other-retained-value" },
      },
    });
    expect(otherContext).toHaveProperty("resourceUid", other.resourceUid);
    expect(retainedOwner()?.get(other.id)).toBe(otherContext);
    expect(
      await f.sql.query("SELECT * FROM tf_v2_configured_private_inputs WHERE resource_uid=?", [
        other.resourceUid,
      ]),
    ).toHaveLength(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    release();
    if (update) await update.value;
    // biome-ignore lint/suspicious/noThenProperty: Restore the original Promise descriptor exactly.
    Object.defineProperty(Promise.prototype, "then", descriptor);
    batch.mockRestore();
    retaining.mockRestore();
    builder.mockRestore();
    captured = undefined;
    otherContext = undefined;
    await f.cleanup();
  }
});
