import { expect, spyOn, test } from "bun:test";
import { isJsonObject } from "../src/json.ts";
import * as coreOwner from "../src/providers/docker-container-core-owner.ts";
import type {
  DockerContainerCreateHeldAuthority,
  DockerContainerCreateRecord,
} from "../src/providers/docker-container-create-custody.ts";
import * as originalBundle from "../src/providers/linux-oci-owned-bundle.ts";
import * as containerOwnerSchema from "../src/takoform-v2/container-owner-schema.ts";
import {
  observeRawPromise,
  ownedRawHttp,
  rawTick,
} from "./helpers/container-http-transport-fixture.ts";
import { qualifiedNormalDeleteFixture as live } from "./helpers/linux-oci-normal-delete-fixture.ts";

const { V2_CONTAINER_APPLICATION_IO_RESERVED } = containerOwnerSchema;

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

test("normal-delete-consumer runtime application owner settles the same DELETE after verified STOP", async () => {
  const { f, accepted } = await live({ runtimeApplicationOwner: true });
  try {
    const removal = await deleting(f, accepted.resourceUid);
    let final = await f.engine.runNext();
    expect(final).toMatchObject({ id: removal.id, status: "reconciling", effect: "unknown" });
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
    expect(f.nativeCounts().requests).toContain("linux-oci-stop-init@1");
    expect(f.nativeCounts().requests).not.toContain("linux-oci-join-init@1");
    const expectContinuation = async () => {
      const [checkpoint] = await f.sql.query(
        "SELECT dispatch_possible,error_code,next_attempt_at_ms,updated_at FROM tf_v2_operations WHERE id=?",
        [removal.id],
      );
      expect(checkpoint).toMatchObject({ dispatch_possible: 1, error_code: null });
      expect(
        Number(checkpoint?.next_attempt_at_ms) - Date.parse(String(checkpoint?.updated_at)),
      ).toBe(1_000);
    };
    await expectContinuation();
    const claim = async () =>
      (await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"))[0];
    expect(await claim()).toMatchObject({ state: "bound", allocation_cleanup: "untouched" });
    for (let phase = 0; phase < 16 && final?.status !== "succeeded"; phase++) {
      f.advanceNormalClock(1_000);
      final = await f.engine.runNext();
      expect(final?.id).toBe(removal.id);
      if (final?.status !== "succeeded") await expectContinuation();
    }
    expect(final).toMatchObject({ id: removal.id, status: "succeeded", effect: "complete" });
    expect(await claim()).toMatchObject({ state: "removed", allocation_cleanup: "closed" });
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("normal-delete-consumer runtime application owner keeps lost STOP unconfirmed and never resends it", async () => {
  const { f, accepted } = await live({
    runtimeApplicationOwner: true,
    managementFault: "lost-reply",
  });
  try {
    const removal = await deleting(f, accepted.resourceUid);
    expect(await f.engine.runNext()).toMatchObject({
      id: removal.id,
      status: "reconciling",
      effect: "unknown",
    });
    const [checkpoint] = await f.sql.query(
      "SELECT dispatch_possible,error_code,next_attempt_at_ms,updated_at FROM tf_v2_operations WHERE id=?",
      [removal.id],
    );
    expect(checkpoint).toMatchObject({ dispatch_possible: 1, error_code: "outcome_unconfirmed" });
    expect(
      Number(checkpoint?.next_attempt_at_ms) - Date.parse(String(checkpoint?.updated_at)),
    ).toBe(60_000);
    f.advanceNormalClock(1_000);
    expect(await f.engine.runNext()).toBeNull();
    expect(f.nativeCounts().requests).not.toContain("linux-oci-join-init@1");
    f.advanceNormalClock(59_000);
    expect(await f.engine.runNext()).toMatchObject({
      id: removal.id,
      status: "reconciling",
      effect: "unknown",
    });
    const requests = f.nativeCounts().requests;
    expect(requests.filter((kind) => kind === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(
      await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"),
    ).toEqual([{ state: "bound", allocation_cleanup: "untouched" }]);
  } finally {
    await f.cleanup();
  }
});

for (const namespaceFault of ["retained", "lost", "unreleased"] as const) {
  test(`normal-delete-consumer runtime application owner keeps namespace ${namespaceFault} outcomes unconfirmed`, async () => {
    const { f, accepted } = await live({ runtimeApplicationOwner: true, namespaceFault });
    try {
      const removal = await deleting(f, accepted.resourceUid);
      await through(
        f,
        async () =>
          (await f.sql.query("SELECT state FROM tf_v2_container_start_attempts"))[0]?.state ===
          "exited",
      );
      f.advanceNormalClock(1_000);
      expect(await f.engine.runNext()).toMatchObject({
        id: removal.id,
        status: "reconciling",
        effect: "unknown",
      });
      const [checkpoint] = await f.sql.query(
        "SELECT dispatch_possible,error_code,next_attempt_at_ms,updated_at FROM tf_v2_operations WHERE id=?",
        [removal.id],
      );
      expect(checkpoint).toMatchObject({ dispatch_possible: 1, error_code: "outcome_unconfirmed" });
      expect(
        Number(checkpoint?.next_attempt_at_ms) - Date.parse(String(checkpoint?.updated_at)),
      ).toBe(60_000);
      expect(
        await f.sql.query("SELECT state,allocation_cleanup FROM tf_v2_container_create_claims"),
      ).toEqual([{ state: "bound", allocation_cleanup: "untouched" }]);
      const requests = f.nativeCounts().requests;
      expect(requests.filter((kind) => kind === "linux-oci-release-namespace@1")).toHaveLength(1);
      expect(requests).not.toContain("linux-oci-delete-born@1");
      expect(requests).not.toContain("linux-oci-parent-read-result@1");
    } finally {
      await f.cleanup();
    }
  });
}

test("normal-delete-consumer revokes management only on accepted original dispatch", async () => {
  const createCore = coreOwner.createDockerContainerCoreOwner;
  let core: ReturnType<typeof createCore> | undefined;
  const rejected = new Error("NONSECRET modeled DELETE acceptance batch refusal");
  let refuseBatch = false;
  let prepared = false;
  let restoreBatch = () => {};
  const inspect = spyOn(coreOwner, "createDockerContainerCoreOwner").mockImplementation(
    (...args) => {
      // Install the dormant fault before the original Engine captures its batch.
      const { sql } = args[0];
      const batch = sql.batch.bind(sql);
      const spy = spyOn(sql, "batch").mockImplementation(async (statements) => {
        if (
          refuseBatch &&
          statements.at(-1)?.sql.includes("INSERT OR ABORT INTO main.tf_v2_container_acceptances")
        ) {
          prepared = true;
          throw rejected;
        }
        return batch(statements);
      });
      restoreBatch = () => spy.mockRestore();
      core = createCore(...args);
      return core;
    },
  );
  const started = await live()
    .catch((error: unknown) => {
      restoreBatch();
      throw error;
    })
    .finally(() => inspect.mockRestore());
  const { f, accepted } = started;
  const release = Promise.withResolvers<void>();
  let management: ReturnType<typeof observeRawPromise<void>> | undefined;
  try {
    if (!core) throw new Error("missing original OCI Core");
    const rows = await f.sql.query(
      "SELECT v.intent_json,q.claim_id,q.native_id FROM tf_v2_container_revisions v " +
        "JOIN tf_v2_container_create_claims q ON q.resource_uid=v.resource_uid AND q.generation=v.generation " +
        "WHERE v.resource_uid=? AND v.retention='serving' AND q.state='bound'",
      [accepted.resourceUid],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      typeof row?.intent_json !== "string" ||
      typeof row.claim_id !== "string" ||
      typeof row.native_id !== "string"
    )
      throw new Error("missing original serving claim");
    const record: DockerContainerCreateRecord = {
      claimId: row.claim_id,
      nativeId: row.native_id,
      intent: JSON.parse(row.intent_json),
      state: "bound",
    };
    const original = Promise.withResolvers<DockerContainerCreateHeldAuthority>();
    const managementRun = core.owner.withAuthority(record, "observe", async (authority) => {
      original.resolve(authority);
      await release.promise;
    });
    management = observeRawPromise(managementRun);
    const held = await Promise.race([
      original.promise,
      managementRun.then(() => {
        throw new Error("missing original management scope");
      }),
    ]);
    refuseBatch = true;
    await expect(deleting(f, accepted.resourceUid)).rejects.toThrow(rejected);
    expect(prepared).toBe(true);
    expect(held.revocation.aborted).toBe(false);
    expect(await held.stillCurrent()).toBe(true);
    refuseBatch = false;

    const deletion = await deleting(f, accepted.resourceUid);
    expect(held.revocation.aborted).toBe(false);
    let result = await step(f);
    expect(held.revocation.aborted).toBe(true);
    if (result?.status !== "succeeded") {
      result = await through(
        f,
        async () =>
          (await f.sql.query("SELECT status FROM tf_v2_operations WHERE id=?", [deletion.id]))[0]
            ?.status === "succeeded",
      );
    }
    expect(result).toMatchObject({ id: deletion.id, status: "succeeded", effect: "complete" });
    release.resolve();
    expect(await management.value).toHaveProperty("error");
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    restoreBatch();
    release.resolve();
    try {
      await management?.value;
    } finally {
      await f.cleanup();
    }
  }
});

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
  let applicationClose: ReturnType<typeof observeRawPromise<void>> | undefined;
  const source = spyOn(originalBundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (...args) => {
      const runtime = actualSource(...args);
      if (runtime && !applicationClose) applicationClose = observeRawPromise(runtime.close());
      return runtime;
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
      for (let tick = 0; tick < 100 && pending.state() === "pending" && !applicationClose; tick++)
        await rawTick();
      if (applicationClose) {
        waiting = pending;
        break;
      }
      expect(await pending.value).toHaveProperty("result");
    }
    if (!waiting || !applicationClose)
      throw Error("NONSECRET actual Core application handoff not reached");
    expect(applicationClose.state()).toBe("pending");
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
    expect(applicationClose.state()).toBe("pending");
    expect(deleted).toHaveLength(0);
    io.closeRequest();
    expect(await applicationClose.value).toHaveProperty("result");
    const first = await waiting.value;
    if ("error" in first) throw first.error;
    // STOP/JOIN can finish their own pass independently of the application close.
    const final =
      first.result?.status === "succeeded"
        ? first.result
        : await through(f, async () => {
            const [claim] = await f.sql.query(
              "SELECT state FROM tf_v2_container_create_claims WHERE resource_uid=?",
              [accepted.resourceUid],
            );
            return claim?.state === "removed";
          });
    expect(final).toMatchObject({ id: removal.id, effect: "complete", status: "succeeded" });
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

test("normal-delete-consumer reports unknown at the deadline and resumes the same DELETE after late HTTP close", async () => {
  const { f, accepted } = await live();
  const io = ownedRawHttp();
  const originalSource = originalBundle.originalLinuxOciHttpRetirementSource;
  let originalClose: ReturnType<typeof observeRawPromise<void>> | undefined;
  let restoreCloseThen: (() => void) | undefined;
  let closeObserversRemaining: (() => number) | undefined;
  let restoreCloseObservers: (() => void) | undefined;
  let pendingCloseSubscriptions = 0;
  const source = spyOn(originalBundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (...args) => {
      const runtime = originalSource(...args);
      if (runtime && !originalClose) {
        const pending = runtime.close();
        originalClose = observeRawPromise(pending);
        const originalThen = pending.then;
        // biome-ignore lint/suspicious/noThenProperty: Count subscriptions on this original pending promise without replacing it.
        Object.defineProperty(pending, "then", {
          configurable: true,
          value: (...thenArgs: Parameters<typeof pending.then>) => {
            pendingCloseSubscriptions++;
            return Reflect.apply(originalThen, pending, thenArgs);
          },
        });
        restoreCloseThen = () => {
          Reflect.deleteProperty(pending, "then");
        };
        const add = spyOn(runtime.closeFinished, "addEventListener");
        const remove = spyOn(runtime.closeFinished, "removeEventListener");
        closeObserversRemaining = () =>
          add.mock.calls.filter(
            ([event, listener]) =>
              !remove.mock.calls.some(([kind, removed]) => kind === event && removed === listener),
          ).length;
        restoreCloseObservers = () => {
          add.mockRestore();
          remove.mockRestore();
        };
      }
      return runtime;
    },
  );
  const claim = async () =>
    (
      await f.sql.query(
        "SELECT state,allocation_cleanup,application_io_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=?",
        [accepted.resourceUid],
      )
    )[0];
  let pending: ReturnType<typeof observeRawPromise<Awaited<ReturnType<typeof step>>>> | undefined;
  try {
    const response = f.composition.fetchServingHttp(
      f.recordedCreate(),
      new Request("http://ignored.invalid/NONSECRET-still-open"),
    );
    for (let tick = 0; tick < 50 && !io.counts().calls; tick++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    await response;
    const removal = await deleting(f, accepted.resourceUid);
    const beyondDeadline = Symbol("still awaiting original HTTP close");
    let deadlineReached = false;
    for (let phase = 0; phase < 16; phase++) {
      const started = performance.now();
      pending = observeRawPromise(step(f));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          pending.value,
          new Promise<typeof beyondDeadline>((resolve) => {
            timer = setTimeout(() => resolve(beyondDeadline), 6500);
          }),
        ]);
        expect(result).not.toBe(beyondDeadline);
        expect(result).toMatchObject({ result: { id: removal.id, effect: "unknown" } });
        if (performance.now() - started >= 4900) {
          deadlineReached = true;
          break;
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    expect(deadlineReached).toBe(true);
    expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
    expect(io.counts().requestDestroy).toBe(1);
    expect(await claim()).toEqual({
      state: "bound",
      allocation_cleanup: "untouched",
      application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
    });
    if (!originalClose) throw Error("NONSECRET original application close was not observed");
    expect(originalClose.state()).toBe("pending");
    expect(pendingCloseSubscriptions).toBe(0);
    expect(closeObserversRemaining?.()).toBe(0);
    restoreCloseThen?.();
    io.closeResponse();
    io.closeRequest();
    expect(await originalClose.value).toHaveProperty("result");
    // The expired stage must not write a late completion under its old lease.
    expect(await claim()).toEqual({
      state: "bound",
      allocation_cleanup: "untouched",
      application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
    });
    const final = await through(f, async () => (await claim())?.state === "removed");
    expect(final).toMatchObject({ id: removal.id, effect: "complete", status: "succeeded" });
    expect(await claim()).toMatchObject({ state: "removed", allocation_cleanup: "closed" });
    const requests = f.nativeCounts().requests;
    for (const kind of [
      "linux-oci-create-stopped@1",
      "linux-oci-start@1",
      "linux-oci-stop-init@1",
      "linux-oci-delete-born@1",
    ]) {
      expect(requests.filter((request) => request === kind)).toHaveLength(1);
    }
    expect(io.counts().calls).toBe(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    io.closeResponse();
    io.closeRequest();
    await pending?.value;
    restoreCloseThen?.();
    restoreCloseObservers?.();
    source.mockRestore();
    io.restore();
    await f.cleanup();
  }
}, 20000);

test("normal-delete-consumer delayed original UPDATE prepare cannot recapture secrets or cancel the final DELETE while another Resource is retained", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
  if (!descriptor) throw Error("NONSECRET original Promise descriptor absent");
  const originalThen = Promise.prototype.then,
    originalSet = Map.prototype.set;
  const originalFactory = containerOwnerSchema.createV2ContainerHostAcceptance;
  type Prepare = ReturnType<typeof originalFactory>["prepare"];
  type Context = Parameters<Prepare>[0];
  type Prepared = NonNullable<ReturnType<Prepare>>;
  let observePrepare: ((context: Context, prepared: Prepared) => void) | undefined;
  const factory = spyOn(containerOwnerSchema, "createV2ContainerHostAcceptance").mockImplementation(
    (options) => {
      const original = originalFactory(options);
      return Object.freeze({
        ...original,
        prepare(context: Context) {
          const prepared = original.prepare(context);
          if (prepared !== undefined) observePrepare?.(context, prepared);
          return prepared;
        },
      });
    },
  );
  const { f, accepted } = await live().finally(() => factory.mockRestore());
  let captured: Context | undefined;
  let otherContext: Context | undefined;
  let otherOwner: Map<unknown, unknown> | undefined;
  const capturedContext = (): Context | undefined => captured;
  const retainedOwner = (): Map<unknown, unknown> | undefined => otherOwner;
  let updatePrepare: Prepared | undefined;
  let delayed = false,
    callbackCalls = 0,
    retained = 0,
    finalAwait = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  observePrepare = (context, prepared) => {
    if (context.action === "update" && context.resourceUid === accepted.resourceUid) {
      captured = context;
      updatePrepare = prepared;
    }
    if (context.action === "create" && context.resourceUid !== accepted.resourceUid)
      otherContext = context;
  };
  // biome-ignore lint/suspicious/noThenProperty: Raw fixture delays the actual Promise continuation.
  Object.defineProperty(Promise.prototype, "then", {
    ...descriptor,
    value: function (this: Promise<unknown>, fulfilled: unknown, rejected: unknown) {
      if (updatePrepare === undefined || this !== updatePrepare)
        return Reflect.apply(originalThen, this, [fulfilled, rejected]);
      updatePrepare = undefined;
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
    observePrepare = undefined;
    updatePrepare = undefined;
    captured = undefined;
    otherContext = undefined;
    await f.cleanup();
  }
});
