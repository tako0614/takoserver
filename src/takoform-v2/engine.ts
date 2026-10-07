import { canonicalJson } from "../json.ts";
import { type JsonObject, SqlError } from "../ports.ts";
import { readV2ConfiguredPrivateInputs } from "./configured-private-inputs.ts";
import { isV2FormUrl } from "./identity.ts";
import {
  hasPrivateComparisonMaterial,
  matchesPrivateInputs,
  sealPrivateInputs,
  unsealPrivateInputs,
  type V2PrivateInputBinding,
  type V2PrivateInputMap,
  validatePrivateInputCustody,
} from "./private-inputs.ts";
import { prepareV2References } from "./references.ts";
import { type AcceptRecord, createV2Store, type OperationRow, type ResourceRow } from "./store.ts";
import {
  TakoformV2Error,
  type V2BackendResult,
  type V2CreateInput,
  type V2EngineOptions,
  type V2Execution,
  type V2Operation,
  type V2Resource,
} from "./types.ts";

const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function fail(code: string, status: number, operationId?: string): never {
  throw new TakoformV2Error(code, status, code, operationId);
}

function validName(value: string): boolean {
  return namePattern.test(value);
}

function referenceUnavailable(error: unknown): boolean {
  return (
    error instanceof SqlError &&
    (error.message.includes("tf_v2_reference_target_unavailable") ||
      error.message.includes("tf_v2_worker_invocation_live_reference"))
  );
}

function resource(row: ResourceRow): V2Resource {
  return {
    uid: row.uid,
    form: row.form_url,
    space: row.space,
    name: row.name,
    generation: row.generation,
    observedGeneration: row.observed_generation,
    observedAt: row.observed_at,
    phase: row.phase,
    spec: JSON.parse(row.spec_json) as JsonObject,
    observed: JSON.parse(row.observed_json) as JsonObject,
    output: JSON.parse(row.output_json) as JsonObject,
    lastOperation: row.last_operation,
  };
}

function operation(row: OperationRow): V2Operation {
  return {
    id: row.id,
    resourceUid: row.resource_uid,
    action: row.action,
    generation: row.generation,
    status: row.status,
    effect: row.effect,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retainUntil: row.retain_until,
    ...(row.error_code && row.error_message
      ? { error: { code: row.error_code, message: row.error_message } }
      : {}),
    ...(row.status === "waiting_input" && row.input_required_names_json && row.input_required_reason
      ? {
          inputRequired: {
            names: JSON.parse(row.input_required_names_json) as string[],
            reason: row.input_required_reason,
          },
        }
      : {}),
  };
}

function canonicalRequest(value: unknown): string {
  const encoded = canonicalJson(value);
  if (typeof encoded !== "string" || encoded.includes(":undefined")) {
    fail("invalid_request", 400);
  }
  return encoded;
}

/** Keep authorization, replay comparison and persistence on one owned request. */
function snapshotRequest<T>(request: T): T {
  try {
    return structuredClone(request);
  } catch {
    fail("invalid_request", 400);
  }
}

function snapshotPrivateInputs(
  inputs: V2PrivateInputMap | undefined,
): V2PrivateInputMap | undefined {
  if (inputs === undefined) return undefined;
  const snapshot: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(inputs)) {
    if (typeof value !== "string") fail("invalid_request", 400);
    snapshot[name] = value;
  }
  return Object.freeze(snapshot);
}

function replayBodyWithoutPrivateValues(body: Readonly<Record<string, unknown>>): JsonObject {
  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [field, field === "privateInputs" ? true : value]),
  ) as JsonObject;
}

export function createTakoformV2Engine(options: V2EngineOptions) {
  if (options.privateInputCustody) validatePrivateInputCustody(options.privateInputCustody);
  if (!Number.isSafeInteger(options.replayWindowSeconds) || options.replayWindowSeconds < 1) {
    throw new TypeError("replayWindowSeconds must be a positive safe integer");
  }
  const leaseMs = options.leaseMilliseconds ?? 60_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new TypeError("leaseMilliseconds must be a positive safe integer");
  }
  const now = options.now ?? (() => new Date());
  const retryMs = Math.max(1_000, leaseMs);
  const store = createV2Store(options.sql);
  const formUrls = Object.freeze(Object.keys(options.forms));
  const privateInputsCapability = options.privateInputCustody !== undefined;
  for (const selected of Object.values(options.forms)) {
    if (
      selected.privateInputs &&
      (typeof selected.privateInputs.validateCreate !== "function" ||
        typeof selected.privateInputs.validateUpdate !== "function")
    ) {
      throw new TypeError("incomplete v2 Form private input declaration");
    }
  }

  function privateBinding(
    row: Pick<OperationRow, "id" | "principal" | "resource_uid" | "generation">,
  ): V2PrivateInputBinding {
    return {
      operationId: row.id,
      principal: row.principal,
      resourceUid: row.resource_uid,
      generation: row.generation,
    };
  }

  async function seal(
    record: AcceptRecord,
    inputs: V2PrivateInputMap | undefined,
  ): Promise<AcceptRecord> {
    if (inputs === undefined) return record;
    if (!options.privateInputCustody) fail("capability_required", 422);
    return {
      ...record,
      privateInputs: await sealPrivateInputs(
        options.privateInputCustody,
        {
          operationId: record.id,
          principal: record.principal,
          resourceUid: record.resourceUid,
          generation: record.generation,
        },
        inputs,
        now().getTime(),
      ),
    };
  }

  async function storedOperation(id: string): Promise<OperationRow> {
    const row = await store.operation(id);
    if (!row) fail("temporarily_unavailable", 503);
    return row;
  }

  async function permitted(principal: string, space: string, access: "read" | "write") {
    if (!principal) fail("unauthenticated", 401);
    if (!(await options.authorize(principal, space, access))) fail("forbidden", 403);
  }

  async function ownedResource(principal: string, uid: string, access: "read" | "write") {
    const row = await store.resource(uid);
    if (!row || row.principal !== principal) fail("not_found", 404);
    await permitted(principal, row.space, access);
    return row;
  }

  async function comparePrivate(row: OperationRow, inputs: V2PrivateInputMap): Promise<boolean> {
    const held = await store.privateInputs(row.id);
    if (!held || !options.privateInputCustody) fail("private_inputs_unverifiable", 409, row.id);
    const matches = await matchesPrivateInputs(
      options.privateInputCustody,
      privateBinding(row),
      held.comparison_key_id,
      held.comparison_tag,
      inputs,
    );
    if (matches === null) fail("private_inputs_unverifiable", 409, row.id);
    return matches;
  }

  async function replay(
    principal: string,
    key: string,
    fingerprint: string,
    inputs?: V2PrivateInputMap,
  ) {
    const existing = await store.replay(principal, key);
    if (!existing) return null;
    await ownedResource(principal, existing.resource_uid, "write");
    if (existing.request_fingerprint !== fingerprint) fail("idempotency_conflict", 409);
    if (existing.private_inputs_present === 1) {
      if (inputs === undefined) fail("idempotency_conflict", 409);
      if (!(await comparePrivate(existing, inputs))) fail("idempotency_conflict", 409);
    }
    return operation(existing);
  }

  function form(formUrl: string) {
    const found = Object.hasOwn(options.forms, formUrl) ? options.forms[formUrl] : undefined;
    if (!found || (!privateInputsCapability && found.privateInputs?.requiredForEveryInstance)) {
      fail("unsupported_form", 422);
    }
    return found;
  }

  function existingForm(formUrl: string) {
    const found = Object.hasOwn(options.forms, formUrl) ? options.forms[formUrl] : undefined;
    if (!found) fail("temporarily_unavailable", 503);
    return found;
  }

  function boundForm(row: ResourceRow) {
    const selected = existingForm(row.form_url);
    if (selected.backend.id !== row.backend_id || selected.backend.targetKey !== row.target_key) {
      fail("temporarily_unavailable", 503);
    }
    return selected;
  }

  function accepted(
    action: AcceptRecord["action"],
    input: {
      principal: string;
      key: string;
      uid: string;
      generation: number;
      fingerprint: string;
      spec: JsonObject;
      formUrl: string;
    },
  ): AcceptRecord {
    const at = now();
    if (!Number.isFinite(at.getTime())) throw new TypeError("invalid clock");
    const expiry = new Date(at.getTime() + options.replayWindowSeconds * 1000);
    if (!Number.isFinite(expiry.getTime())) throw new TypeError("invalid retention duration");
    const selected = existingForm(input.formUrl).backend;
    if (!selected.id || !selected.targetKey) throw new TypeError("backend identity is required");
    return {
      id: crypto.randomUUID(),
      resourceUid: input.uid,
      principal: input.principal,
      key: input.key,
      fingerprint: input.fingerprint,
      action,
      generation: input.generation,
      at: at.toISOString(),
      retainUntil: expiry.toISOString(),
      backendId: selected.id,
      targetKey: selected.targetKey,
      specJson: canonicalRequest(input.spec),
    };
  }

  async function winnerAfterRace(
    principal: string,
    key: string,
    fingerprint: string,
    inputs?: V2PrivateInputMap,
  ) {
    return replay(principal, key, fingerprint, inputs);
  }

  async function nextRunnable() {
    let unavailable = false;
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const nowMs = now().getTime();
      const candidate = await store.nextCandidate(nowMs);
      if (!candidate) {
        if (unavailable) fail("temporarily_unavailable", 503);
        return null;
      }
      const target = await store.resource(candidate.resource_uid);
      const selected =
        target && Object.hasOwn(options.forms, target.form_url)
          ? options.forms[target.form_url]
          : undefined;
      if (
        selected &&
        target &&
        selected.backend.id === target.backend_id &&
        selected.backend.targetKey === target.target_key &&
        selected.backend.id === candidate.backend_id &&
        selected.backend.targetKey === candidate.target_key
      ) {
        return { candidate, selected };
      }
      // Missing/changed adapters must not monopolize the oldest-work slot.
      await store.defer(candidate.id, nowMs, nowMs + retryMs);
      unavailable = true;
    }
    fail("temporarily_unavailable", 503);
  }

  return {
    formUrls,
    privateInputsCapability,
    supportsForm(formUrl: string): boolean {
      const selected = options.forms[formUrl];
      return (
        selected !== undefined &&
        (privateInputsCapability || selected.privateInputs?.requiredForEveryInstance !== true)
      );
    },
    supportsPrivateInputs(formUrl: string): boolean {
      return privateInputsCapability && options.forms[formUrl]?.privateInputs !== undefined;
    },
    async supportsPrivateInputsForUpdate(principal: string, uid: string): Promise<boolean> {
      const target = await ownedResource(principal, uid, "write");
      return privateInputsCapability && boundForm(target).privateInputs !== undefined;
    },
    /** Known-key lookup precedes all fresh-request capability and shape checks. */
    async replayExistingCreate(request: {
      principal: string;
      key: string;
      body: Readonly<Record<string, unknown>>;
    }): Promise<V2Operation | null> {
      const input = snapshotRequest(request);
      const body = input.body;
      return replay(
        input.principal,
        input.key,
        canonicalRequest({
          method: "POST",
          path: "/resources",
          query: {},
          body: replayBodyWithoutPrivateValues(body),
        }),
        Object.hasOwn(body, "privateInputs")
          ? (body.privateInputs as V2PrivateInputMap)
          : undefined,
      );
    },
    async replayExistingUpdate(request: {
      principal: string;
      key: string;
      uid: string;
      expectedGeneration: number;
      body: Readonly<Record<string, unknown>>;
    }): Promise<V2Operation | null> {
      const input = snapshotRequest(request);
      const body = input.body;
      return replay(
        input.principal,
        input.key,
        canonicalRequest({
          method: "PUT",
          path: `/resources/${input.uid}`,
          query: {},
          expectedGeneration: input.expectedGeneration,
          body: replayBodyWithoutPrivateValues(body),
        }),
        Object.hasOwn(body, "privateInputs")
          ? (body.privateInputs as V2PrivateInputMap)
          : undefined,
      );
    },
    async acceptCreate(request: {
      principal: string;
      key: string;
      input: V2CreateInput;
    }): Promise<V2Operation> {
      const input = snapshotRequest(request);
      const { principal, key } = input;
      if (!tokenPattern.test(key)) fail("invalid_request", 400);
      const desired = input.input;
      const privateInputs = snapshotPrivateInputs(desired.privateInputs);
      if (!validName(desired.space) || !validName(desired.name) || !isV2FormUrl(desired.form)) {
        fail("invalid_request", 400);
      }
      await permitted(principal, desired.space, "write");
      const fingerprint = canonicalRequest({
        method: "POST",
        path: "/resources",
        query: {},
        body: {
          form: desired.form,
          space: desired.space,
          name: desired.name,
          spec: desired.spec,
          ...(privateInputs === undefined ? {} : { privateInputs: true }),
        },
      });
      const prior = await replay(principal, key, fingerprint, privateInputs);
      if (prior) return prior;
      if (
        Object.keys(desired).some(
          (field) => !["form", "space", "name", "spec", "privateInputs"].includes(field),
        )
      ) {
        fail("capability_required", 422);
      }
      const selected = form(desired.form);
      if (privateInputs !== undefined && (!privateInputsCapability || !selected.privateInputs))
        fail("capability_required", 422);
      selected.validateCreate(desired.spec);
      selected.privateInputs?.validateCreate(desired.spec, privateInputs);
      const referencesJson = prepareV2References(selected, desired.spec);
      if (referencesJson !== null) await permitted(principal, desired.space, "read");
      let record = await seal(
        accepted("create", {
          principal,
          key,
          uid: crypto.randomUUID(),
          generation: 1,
          fingerprint,
          spec: desired.spec,
          formUrl: desired.form,
        }),
        privateInputs,
      );
      if (selected.privateInputs?.prepareCreate) {
        const configured = await selected.privateInputs.prepareCreate({
          principal,
          space: desired.space,
          name: desired.name,
          form: desired.form,
          resourceUid: record.resourceUid,
          operationId: record.id,
          generation: record.generation,
          spec: JSON.parse(record.specJson) as JsonObject,
          privateInputs,
        });
        if (configured !== null) {
          if (
            privateInputs === undefined ||
            !configured.keyId ||
            !configured.nonce ||
            !configured.ciphertext
          ) {
            throw new TypeError("invalid configured private input preparation");
          }
          record = {
            ...record,
            configuredPrivateInputs: Object.freeze({
              keyId: configured.keyId,
              nonce: configured.nonce,
              ciphertext: configured.ciphertext,
            }),
          };
        }
      }
      const output = selected.initialOutput
        ? selected.initialOutput({
            resourceUid: record.resourceUid,
            space: desired.space,
            name: desired.name,
            spec: JSON.parse(record.specJson) as JsonObject,
          })
        : {};
      if (typeof output !== "object" || output === null || Array.isArray(output)) {
        throw new TypeError("Form initial output must be a public JSON object");
      }
      const initialOutputJson = canonicalRequest(output);
      try {
        await store.insertCreate(record, desired, referencesJson, initialOutputJson);
      } catch (error) {
        const winner = await winnerAfterRace(principal, key, fingerprint, privateInputs);
        if (winner) return winner;
        if (await store.activeName(desired.space, desired.name)) {
          fail("name_conflict", 409);
        }
        if (referenceUnavailable(error)) fail("dependency_conflict", 409);
        throw error;
      }
      return operation(await storedOperation(record.id));
    },
    async acceptUpdate(request: {
      principal: string;
      key: string;
      uid: string;
      expectedGeneration: number;
      spec: JsonObject;
      privateInputs?: V2PrivateInputMap;
    }): Promise<V2Operation> {
      const input = snapshotRequest(request);
      if (!tokenPattern.test(input.key) || !validName(input.uid)) fail("invalid_request", 400);
      const privateInputs = snapshotPrivateInputs(input.privateInputs);
      const target = await ownedResource(input.principal, input.uid, "write");
      const fingerprint = canonicalRequest({
        method: "PUT",
        path: `/resources/${input.uid}`,
        query: {},
        expectedGeneration: input.expectedGeneration,
        body: {
          spec: input.spec,
          ...(privateInputs === undefined ? {} : { privateInputs: true }),
        },
      });
      const prior = await replay(input.principal, input.key, fingerprint, privateInputs);
      if (prior) return prior;
      if (target.deleted_at) fail("gone", 410);
      if (target.busy_operation) fail("resource_busy", 409);
      if (target.generation !== input.expectedGeneration) fail("generation_conflict", 409);
      if (target.generation >= Number.MAX_SAFE_INTEGER) fail("invalid_request", 400);
      const selectedForm = boundForm(target);
      if (privateInputs !== undefined && (!privateInputsCapability || !selectedForm.privateInputs))
        fail("capability_required", 422);
      const serializeUpdatesWithPendingReferrers =
        selectedForm.serializeUpdatesWithPendingReferrers === true;
      selectedForm.validateUpdate(JSON.parse(target.spec_json) as JsonObject, input.spec);
      selectedForm.privateInputs?.validateUpdate(
        JSON.parse(target.spec_json) as JsonObject,
        input.spec,
        privateInputs,
      );
      const referencesJson = prepareV2References(selectedForm, input.spec);
      if (referencesJson !== null) await permitted(input.principal, target.space, "read");
      let record = await seal(
        accepted("update", {
          principal: input.principal,
          key: input.key,
          uid: input.uid,
          generation: target.generation + 1,
          fingerprint,
          spec: input.spec,
          formUrl: target.form_url,
        }),
        privateInputs,
      );
      if (selectedForm.privateInputs?.prepareUpdate) {
        const configuredRow = await readV2ConfiguredPrivateInputs(options.sql, {
          principal: input.principal,
          space: target.space,
          name: target.name,
          form: target.form_url,
          resourceUid: target.uid,
        });
        const configured = configuredRow ? Object.freeze({ ...configuredRow }) : null;
        await selectedForm.privateInputs.prepareUpdate({
          principal: input.principal,
          space: target.space,
          name: target.name,
          form: target.form_url,
          resourceUid: target.uid,
          operationId: record.id,
          generation: record.generation,
          previousSpec: JSON.parse(target.spec_json) as JsonObject,
          spec: JSON.parse(record.specJson) as JsonObject,
          privateInputs,
          configured,
        });
        if (configured) record = { ...record, expectedConfiguredPrivateInputs: configured };
      }
      let result: Awaited<ReturnType<typeof store.insertChange>>;
      try {
        result = await store.insertChange(
          record,
          referencesJson,
          serializeUpdatesWithPendingReferrers,
        );
        if (result === "accepted") return operation(await storedOperation(record.id));
      } catch (error) {
        const winner = await winnerAfterRace(
          input.principal,
          input.key,
          fingerprint,
          privateInputs,
        );
        if (winner) return winner;
        if (referenceUnavailable(error)) fail("dependency_conflict", 409);
        throw error;
      }
      const winner = await winnerAfterRace(input.principal, input.key, fingerprint, privateInputs);
      if (winner) return winner;
      if (result === "dependency_conflict") fail("dependency_conflict", 409);
      const latest = await ownedResource(input.principal, input.uid, "write");
      if (latest.busy_operation) fail("resource_busy", 409);
      fail("generation_conflict", 409);
    },
    async acceptDelete(request: {
      principal: string;
      key: string;
      uid: string;
      expectedGeneration: number;
    }): Promise<V2Operation> {
      const input = snapshotRequest(request);
      if (!tokenPattern.test(input.key) || !validName(input.uid)) fail("invalid_request", 400);
      const target = await ownedResource(input.principal, input.uid, "write");
      const fingerprint = canonicalRequest({
        method: "DELETE",
        path: `/resources/${input.uid}`,
        query: {},
        expectedGeneration: input.expectedGeneration,
      });
      const prior = await replay(input.principal, input.key, fingerprint);
      if (prior) return prior;
      if (target.deleted_at) fail("gone", 410);
      if (target.busy_operation) fail("resource_busy", 409);
      if (target.generation !== input.expectedGeneration) fail("generation_conflict", 409);
      if (target.generation >= Number.MAX_SAFE_INTEGER) fail("invalid_request", 400);
      boundForm(target);
      if (await store.hasReferences(target.uid)) {
        fail("dependency_conflict", 409);
      }
      const record = accepted("delete", {
        principal: input.principal,
        key: input.key,
        uid: input.uid,
        generation: target.generation + 1,
        fingerprint,
        spec: JSON.parse(target.spec_json) as JsonObject,
        formUrl: target.form_url,
      });
      try {
        if ((await store.insertChange(record)) === "accepted")
          return operation(await storedOperation(record.id));
      } catch (error) {
        const winner = await winnerAfterRace(input.principal, input.key, fingerprint);
        if (winner) return winner;
        if (referenceUnavailable(error)) fail("dependency_conflict", 409);
        throw error;
      }
      const winner = await winnerAfterRace(input.principal, input.key, fingerprint);
      if (winner) return winner;
      if (await store.hasReferences(target.uid)) {
        fail("dependency_conflict", 409);
      }
      const latest = await ownedResource(input.principal, input.uid, "write");
      if (latest.busy_operation) fail("resource_busy", 409);
      fail("generation_conflict", 409);
    },
    async getResource(input: { principal: string; uid: string }): Promise<V2Resource> {
      const row = await ownedResource(input.principal, input.uid, "read");
      if (row.deleted_at) fail("gone", 410);
      return resource(row);
    },
    async listResources(input: {
      principal: string;
      space?: string;
      name?: string;
      form?: string;
      limit: number;
      afterUid?: string;
    }): Promise<readonly V2Resource[]> {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1) fail("invalid_request", 400);
      if (input.space) await permitted(input.principal, input.space, "read");
      const visible: V2Resource[] = [];
      let afterUid = input.afterUid;
      while (visible.length < input.limit) {
        // SQL bounds each scan even when a principal's Space authorization has
        // since been revoked. Never load an entire owner's history into memory.
        const pageSize = Math.min(100, input.limit - visible.length);
        const rows = await store.list({
          principal: input.principal,
          ...(afterUid !== undefined ? { afterUid } : {}),
          ...(input.space !== undefined ? { space: input.space } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.form !== undefined ? { form: input.form } : {}),
          limit: pageSize,
        });
        if (rows.length === 0) break;
        for (const row of rows) {
          afterUid = row.uid;
          if (!(await options.authorize(input.principal, row.space, "read"))) continue;
          visible.push(resource(row));
        }
        if (rows.length < pageSize) break;
      }
      return visible;
    },
    async getOperation(input: { principal: string; id: string }): Promise<V2Operation> {
      const row = await store.operation(input.id);
      if (!row || row.principal !== input.principal) fail("not_found", 404);
      await ownedResource(input.principal, row.resource_uid, "read");
      return operation(row);
    },
    async replenishPrivateInputs(input: {
      principal: string;
      id: string;
      privateInputs: V2PrivateInputMap;
    }): Promise<V2Operation> {
      const privateInputs = snapshotPrivateInputs(input.privateInputs);
      if (privateInputs === undefined) fail("invalid_request", 400);
      const row = await store.operation(input.id);
      if (!row || row.principal !== input.principal) fail("not_found", 404);
      await ownedResource(input.principal, row.resource_uid, "write");
      if (row.private_inputs_present !== 1) fail("private_inputs_conflict", 409, row.id);
      if (!(await comparePrivate(row, privateInputs))) {
        fail("private_inputs_conflict", 409, row.id);
      }
      if (row.status === "succeeded" || row.status === "failed") {
        fail("operation_terminal", 409, row.id);
      }
      if (row.status !== "waiting_input") return operation(row);
      if (row.dispatch_possible !== 0) return operation(row);
      if (!options.privateInputCustody) fail("private_inputs_unverifiable", 409, row.id);
      const sealed = await sealPrivateInputs(
        options.privateInputCustody,
        privateBinding(row),
        privateInputs,
        now().getTime(),
      );
      await store.replenish(row.id, sealed, now().toISOString());
      return operation(await storedOperation(row.id));
    },
    async runNext(): Promise<V2Operation | null> {
      const runnable = await nextRunnable();
      if (!runnable) return null;
      const { candidate, selected } = runnable;
      const token = crypto.randomUUID();
      const nowMs = now().getTime();
      if (!(await store.claim(candidate.id, token, nowMs, nowMs + leaseMs))) return null;
      const claimed = await storedOperation(candidate.id);
      const target = await store.resource(claimed.resource_uid);
      if (!target) fail("temporarily_unavailable", 503);
      const mustReconcile = claimed.dispatch_possible === 1;
      let transferInputs: V2PrivateInputMap | undefined;
      if (!mustReconcile && claimed.private_inputs_present === 1) {
        const held = await store.privateInputs(claimed.id);
        const custody = options.privateInputCustody;
        if (
          !held ||
          !custody ||
          !(await hasPrivateComparisonMaterial(
            custody,
            held.comparison_key_id,
            held.comparison_tag,
          ))
        ) {
          const at = now();
          await store.failUnverifiable(
            claimed.id,
            token,
            at.toISOString(),
            new Date(at.getTime() + options.replayWindowSeconds * 1000).toISOString(),
          );
          return operation(await storedOperation(claimed.id));
        }
        const expired =
          held.transfer_expires_at_ms === null || held.transfer_expires_at_ms <= now().getTime();
        if (!expired && held.transfer_key_id && held.transfer_nonce && held.transfer_ciphertext) {
          transferInputs =
            (await unsealPrivateInputs(
              custody,
              privateBinding(claimed),
              held.transfer_key_id,
              held.transfer_nonce,
              held.transfer_ciphertext,
            )) ?? undefined;
          if (transferInputs !== undefined) {
            const matched = await matchesPrivateInputs(
              custody,
              privateBinding(claimed),
              held.comparison_key_id,
              held.comparison_tag,
              transferInputs,
            );
            if (matched === null) {
              const at = now();
              await store.failUnverifiable(
                claimed.id,
                token,
                at.toISOString(),
                new Date(at.getTime() + options.replayWindowSeconds * 1000).toISOString(),
              );
              return operation(await storedOperation(claimed.id));
            }
            if (!matched) transferInputs = undefined;
          }
        }
        if (transferInputs === undefined) {
          await store.waitForInputs(
            claimed.id,
            token,
            now().toISOString(),
            held.names_json,
            expired ? "expired" : "unavailable",
          );
          return operation(await storedOperation(claimed.id));
        }
      }
      const execution: V2Execution = {
        operationId: claimed.id,
        leaseToken: token,
        backendKey: claimed.backend_key,
        backendId: claimed.backend_id,
        targetKey: claimed.target_key,
        resourceUid: target.uid,
        principal: claimed.principal,
        action: claimed.action,
        generation: claimed.generation,
        form: target.form_url,
        space: target.space,
        name: target.name,
        spec: JSON.parse(claimed.accepted_spec_json) as JsonObject,
        previousObserved: JSON.parse(target.observed_json) as JsonObject,
        previousOutput: JSON.parse(target.output_json) as JsonObject,
        ...(transferInputs === undefined ? {} : { privateInputs: transferInputs }),
      };
      if (!mustReconcile && !(await store.markDispatch(claimed.id, token, now().toISOString()))) {
        return operation(await storedOperation(claimed.id));
      }
      // A reclaimed claim must not initiate a new send. This local check is
      // intentionally not represented as native provider fencing: the backend
      // must still reject a late send or reconcile it under the stable key.
      if (!(await store.ownsClaim(claimed.id, token))) {
        return operation(await storedOperation(claimed.id));
      }
      let result: V2BackendResult;
      try {
        result = mustReconcile
          ? await selected.backend.reconcile(execution)
          : await selected.backend.execute(execution);
      } catch {
        result = {
          kind: "unknown",
          code: "outcome_unconfirmed",
          message: "Execution outcome is not yet confirmed",
        };
      }
      const at = now();
      const retainUntil = new Date(at.getTime() + options.replayWindowSeconds * 1000).toISOString();
      if (result.kind === "complete") {
        await store.settle({
          id: claimed.id,
          token,
          status: "succeeded",
          effect: "complete",
          at: at.toISOString(),
          retainUntil,
          observedJson: canonicalRequest(result.observed),
          outputJson: canonicalRequest(result.output),
        });
      } else if (result.kind === "partial" || result.kind === "no_effect") {
        await store.settle({
          id: claimed.id,
          token,
          status: "failed",
          effect: result.kind === "partial" ? "partial" : "none",
          at: at.toISOString(),
          retainUntil,
          error: { code: result.code, message: result.message },
          ...(result.kind === "partial" && result.observed
            ? { observedJson: canonicalRequest(result.observed) }
            : {}),
          ...(result.kind === "partial" && result.output
            ? { outputJson: canonicalRequest(result.output) }
            : {}),
        });
      } else if (result.kind === "continue") {
        // Known bounded work yielded after its checkpoint. Retain dispatch
        // history and require reconcile, but do not impose uncertainty backoff
        // or publish an error for an ordinary continuation. A stale writer's
        // settlement still fails the same claim-token CAS.
        await store.settle({
          id: claimed.id,
          token,
          status: "reconciling",
          effect: "unknown",
          at: at.toISOString(),
          retainUntil,
          nextAttemptAtMs: at.getTime() + 1_000,
        });
      } else {
        const error =
          result.code && result.message
            ? { code: result.code, message: result.message }
            : { code: "outcome_unconfirmed", message: "Execution outcome is not yet confirmed" };
        await store.settle({
          id: claimed.id,
          token,
          status: "reconciling",
          effect: "unknown",
          at: at.toISOString(),
          retainUntil,
          nextAttemptAtMs: at.getTime() + retryMs,
          error,
        });
      }
      return operation(await storedOperation(claimed.id));
    },
  };
}

export type TakoformV2Engine = ReturnType<typeof createTakoformV2Engine>;
