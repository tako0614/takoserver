import { canonicalJson } from "../json.ts";
import type { Clock, JsonObject } from "../ports.ts";
import type { EngineContext, EngineMutationCommit, TakoformEngine } from "./engine.ts";
import { exactInstalledForm, type FormRegistry, sameFormRef } from "./forms.ts";
import type { DeferredOperationRecord, ResourceAddress, TakoformStore } from "./store.ts";
import { TakoformHostError, type TakoformV1Alpha3FormRef } from "./types.ts";
import {
  applyRequest,
  exactQuery,
  idempotencyKey,
  importRequest,
  jsonBody,
  mutationFingerprint,
  type ResourcePath,
  requestBodyDigest,
  requiredQuery,
  samePathResource,
} from "./wire.ts";

const OPERATION_API_VERSION = "operations.takoform.com/v1alpha1";
const DEFAULT_POLLS_BEFORE_COMMIT = 2;
const DEFAULT_LEASE_MILLISECONDS = 30_000;

export interface DeferredOperationsConfiguration {
  readonly shouldDefer: (input: {
    readonly request: Request;
    readonly operation: "create" | "update" | "import" | "delete";
    readonly formRef: TakoformV1Alpha3FormRef;
  }) => boolean | Promise<boolean>;
  readonly pollsBeforeCommit?: number;
  readonly retryAfterSeconds?: number;
  readonly leaseMilliseconds?: number;
}

export interface DeferredOperations {
  accept(
    context: EngineContext,
    path: ResourcePath,
    operation: "apply" | "import" | "delete",
  ): Promise<Response | null>;
  handle(context: EngineContext, id: string, cancel: boolean): Promise<Response | null>;
}

/**
 * Persistent operation coordinator around the ordinary lifecycle engine.
 *
 * It stores only the portable mutation and closed lifecycle headers, then
 * reconstructs a fresh EngineContext on every lease acquisition. Provider work
 * therefore remains in the existing engine, while the final resource fence,
 * replay, and terminal operation are one store batch.
 */
export function createDeferredOperations(input: {
  readonly configuration: DeferredOperationsConfiguration;
  readonly engine: TakoformEngine;
  readonly store: TakoformStore;
  readonly forms: FormRegistry;
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly omitObservedStatus?: boolean;
}): DeferredOperations {
  const pollsBeforeCommit = boundedInteger(
    input.configuration.pollsBeforeCommit ?? DEFAULT_POLLS_BEFORE_COMMIT,
    1,
    100,
    "pollsBeforeCommit",
  );
  const retryAfterSeconds = boundedInteger(
    input.configuration.retryAfterSeconds ?? 1,
    0,
    3_600,
    "retryAfterSeconds",
  );
  const leaseMilliseconds = boundedInteger(
    input.configuration.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS,
    1,
    3_600_000,
    "leaseMilliseconds",
  );

  return {
    async accept(context, path, operation) {
      // Provision redemption and runtime materialization carry non-replayable
      // authority. They stay synchronous until those authorities have their
      // own durable resumption contract.
      if (
        context.beforeCreate ||
        context.commercialAuthority ||
        context.runtimeMaterialization ||
        context.provisionOnly
      ) {
        return null;
      }
      const accepted = await acceptedMutation(context, path, operation, input.forms, input.store);
      if (
        !(await input.configuration.shouldDefer({
          request: context.request,
          operation: accepted.lifecycleOperation,
          formRef: accepted.formRef,
        }))
      ) {
        return null;
      }

      const key = idempotencyKey(context.request);
      const replayKey = [
        "deferred-v1",
        context.tenantId,
        context.principalId,
        accepted.space,
        operation,
        key,
      ].join("\0");
      const fingerprint = mutationFingerprint(
        context.request,
        await requestBodyDigest(context.request),
      );
      const replay = await input.store.readDeferredOperationByReplay(replayKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new TakoformHostError();
        if (await replayRetired(replay, input.store)) {
          if (replay.committedUid) {
            await input.store.releaseCommittedResourceClaims(replay.tenantId, replay.committedUid);
          }
          await input.store.retireDeferredOperation(replay.id, replay.replayKey);
        } else {
          return acceptedResponse(replay.id, retryAfterSeconds);
        }
      }

      const url = new URL(context.request.url);
      const operationId = nextIdentifier("op", input.randomId);
      const resourceUid = accepted.current?.metadata.uid ?? nextIdentifier("uid", input.randomId);
      const record = await input.store.acceptDeferredOperation({
        id: operationId,
        tenantId: context.tenantId,
        principalId: context.principalId,
        operation,
        phase: "pending",
        requestPath: url.pathname,
        requestQuery: url.search,
        requestHeaders: retainedLifecycleHeaders(context.request),
        ...(accepted.body === undefined ? {} : { requestBody: accepted.body }),
        fingerprint,
        replayKey,
        target: {
          space: accepted.space,
          apiVersion: path.apiVersion,
          kind: path.kind,
          name: path.name,
          formRef: structuredClone(accepted.formRef),
        },
        ...(accepted.current
          ? {
              acceptedUid: accepted.current.metadata.uid,
              acceptedGeneration: accepted.current.metadata.generation,
              acceptedRevision: accepted.current.metadata.revision,
            }
          : {}),
        resourceUid,
        pollsRemaining: pollsBeforeCommit,
        createdAt: input.clock().toISOString(),
      });
      if (record.fingerprint !== fingerprint) throw new TakoformHostError();
      return acceptedResponse(record.id, retryAfterSeconds);
    },

    async handle(context, id, cancel) {
      const existing = await input.store.readDeferredOperation(
        context.tenantId,
        context.principalId,
        id,
      );
      if (!existing) {
        if (await input.store.deferredOperationExists(id)) {
          throw new TakoformHostError("operation_not_found", 404);
        }
        return null;
      }
      if (cancel) {
        if (context.request.method !== "POST") throw new TakoformHostError();
        idempotencyKey(context.request);
        if (isTerminal(existing)) return terminalResponse(existing);
        const terminalJson = failureTerminal(
          existing.id,
          "operation_cancelled",
          "operation was cancelled before completion",
        );
        const outcome = await input.store.cancelDeferredOperation({
          tenantId: context.tenantId,
          principalId: context.principalId,
          id,
          terminalJson,
        });
        if (outcome === "cancelled") {
          await input.store.releaseResourceClaims(existing.id);
          return jsonResponse(terminalJson);
        }
        if (outcome === "settled") {
          const settled = await input.store.readDeferredOperation(
            context.tenantId,
            context.principalId,
            id,
          );
          return settled ? terminalResponse(settled) : null;
        }
        if (outcome === "not_found") return null;
        throw new TakoformHostError("operation_cancelled", 409);
      }
      if (context.request.method !== "GET") throw new TakoformHostError();
      if (isTerminal(existing)) return terminalResponse(existing);

      const leaseToken = nextIdentifier("lease", input.randomId);
      const advanced = await input.store.advanceDeferredOperation({
        tenantId: context.tenantId,
        principalId: context.principalId,
        id,
        leaseToken,
        leaseUntil: input.clock().getTime() + leaseMilliseconds,
      });
      const operation = advanced.operation;
      if (!operation) return null;
      if (isTerminal(operation)) return terminalResponse(operation);
      if (!advanced.acquired) return pendingResponse(operation.id, retryAfterSeconds);

      await execute(operation, leaseToken);
      const settled = await input.store.readDeferredOperation(
        operation.tenantId,
        operation.principalId,
        operation.id,
      );
      if (!settled) throw new TakoformHostError("operation_not_found", 404);
      return isTerminal(settled)
        ? terminalResponse(settled)
        : pendingResponse(settled.id, retryAfterSeconds);
    },
  };

  async function execute(operation: DeferredOperationRecord, leaseToken: string): Promise<void> {
    const url = new URL(
      `https://durable-operation.invalid${operation.requestPath}${operation.requestQuery}`,
    );
    const request = new Request(url, {
      method:
        operation.operation === "delete"
          ? "DELETE"
          : operation.operation === "import"
            ? "POST"
            : "PUT",
      headers: operation.requestHeaders,
      ...(operation.requestBody === undefined ? {} : { body: operation.requestBody }),
    });
    const context: EngineContext = {
      request,
      url,
      tenantId: operation.tenantId,
      principalId: operation.principalId,
      durableOperation: {
        id: operation.id,
        resourceUid: operation.resourceUid,
        claimOwnerId: leaseToken,
        commit: async (mutation) => {
          await input.store.commitDeferredMutation({
            operation,
            leaseToken,
            mutation: storedCommit(
              mutation,
              successTerminal(operation.id, mutation, input.omitObservedStatus),
            ),
          });
        },
      },
    };
    const path: ResourcePath = {
      apiVersion: operation.target.apiVersion,
      kind: operation.target.kind,
      name: operation.target.name,
      ...(operation.operation === "import" ? { action: "import" } : {}),
    };
    try {
      await assertAcceptedTarget(operation, input.store);
      if (operation.operation === "apply") await input.engine.apply(context, path);
      else if (operation.operation === "import") await input.engine.importResource(context, path);
      else await input.engine.remove(context, path);
    } catch (error) {
      const providerReceipt = await input.store.readProviderMutationReceipt(
        operation.tenantId,
        operation.id,
        operation.resourceUid,
      );
      const providerPlan = providerReceipt
        ? false
        : await input.store.providerMutationPlanExists(
            operation.tenantId,
            operation.id,
            operation.resourceUid,
          );
      if (providerReceipt || providerPlan) {
        console.error(
          canonicalJson({
            event: "takoform.deferred_operation.repair_required",
            operationId: operation.id,
            operation: operation.operation,
            boundary: providerReceipt ? "receipt" : "plan",
            errorCode: error instanceof TakoformHostError ? error.code : "internal_error",
          }),
        );
        await input.store.holdDeferredProviderRepair({ operation, leaseToken });
        return;
      }
      const hostError =
        error instanceof TakoformHostError ? error : new TakoformHostError("internal_error", 500);
      if (!(error instanceof TakoformHostError)) {
        console.error(
          canonicalJson({
            event: "takoform.deferred_operation.failed",
            operationId: operation.id,
            operation: operation.operation,
            errorClass: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
      await input.store.settleDeferredFailure({
        operation,
        leaseToken,
        terminalJson: failureTerminal(
          operation.id,
          hostError.code,
          diagnosticMessage(hostError.code),
        ),
      });
    }
  }
}

/** First fence is before provider work; the store repeats it in the commit batch. */
async function assertAcceptedTarget(
  operation: DeferredOperationRecord,
  store: TakoformStore,
): Promise<void> {
  const current = await store.readResource({
    tenantId: operation.tenantId,
    space: operation.target.space,
    apiVersion: operation.target.apiVersion,
    kind: operation.target.kind,
    name: operation.target.name,
  });
  if (operation.acceptedUid === undefined) {
    if (current) throw new TakoformHostError("uid_mismatch", 409);
    return;
  }
  if (!current) throw new TakoformHostError("resource_not_found", 404);
  if (
    current.metadata.uid !== operation.acceptedUid ||
    !sameFormRef(current.form.formRef, operation.target.formRef)
  ) {
    throw new TakoformHostError("uid_mismatch", 409);
  }
  if (current.metadata.generation !== operation.acceptedGeneration) {
    throw new TakoformHostError("generation_conflict", 412);
  }
  if (current.metadata.revision !== operation.acceptedRevision) {
    throw new TakoformHostError("revision_conflict", 412);
  }
}

async function acceptedMutation(
  context: EngineContext,
  path: ResourcePath,
  operation: "apply" | "import" | "delete",
  forms: FormRegistry,
  store: TakoformStore,
): Promise<{
  readonly lifecycleOperation: "create" | "update" | "import" | "delete";
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly space: string;
  readonly current: Awaited<ReturnType<TakoformStore["readResource"]>>;
  readonly body?: string;
}> {
  if (operation === "apply" || operation === "import") {
    const body = await context.request.clone().text();
    const parsed =
      operation === "apply"
        ? applyRequest(await jsonBody(context.request.clone()))
        : importRequest(await jsonBody(context.request.clone()));
    const form = exactInstalledForm(parsed.form.formRef, forms);
    if (!form || !samePathResource(parsed, path)) {
      throw new TakoformHostError("form_unknown", 404);
    }
    const address: ResourceAddress = {
      tenantId: context.tenantId,
      space: parsed.metadata.space,
      apiVersion: parsed.apiVersion,
      kind: parsed.kind,
      name: parsed.metadata.name,
    };
    const current = await store.readResource(address);
    if (current && !sameFormRef(current.form.formRef, parsed.form.formRef)) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    return {
      lifecycleOperation: operation === "import" ? "import" : current ? "update" : "create",
      formRef: structuredClone(parsed.form.formRef),
      space: parsed.metadata.space,
      current,
      body,
    };
  }

  exactQuery(context.url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
  const space = requiredQuery(context.url, "space");
  const form = exactInstalledForm(
    {
      apiVersion: requiredQuery(context.url, "group"),
      kind: requiredQuery(context.url, "kind"),
      definitionVersion: requiredQuery(context.url, "definitionVersion"),
      schemaDigest: requiredQuery(context.url, "schemaDigest"),
    },
    forms,
  );
  if (
    !form ||
    form.identity.formRef.apiVersion !== path.apiVersion ||
    form.identity.formRef.kind !== path.kind
  ) {
    throw new TakoformHostError("form_unknown", 404);
  }
  const current = await store.readResource({
    tenantId: context.tenantId,
    space,
    apiVersion: path.apiVersion,
    kind: path.kind,
    name: path.name,
  });
  if (!current || !sameFormRef(current.form.formRef, form.identity.formRef)) {
    throw new TakoformHostError("resource_not_found", 404);
  }
  return {
    lifecycleOperation: "delete",
    formRef: structuredClone(form.identity.formRef),
    space,
    current,
  };
}

function retainedLifecycleHeaders(request: Request): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of [
    "content-type",
    "idempotency-key",
    "if-match",
    "if-none-match",
    "takoform-expected-generation",
  ]) {
    const value = request.headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

function storedCommit(
  mutation: EngineMutationCommit,
  terminalJson: string,
): Parameters<TakoformStore["commitDeferredMutation"]>[0]["mutation"] {
  return {
    kind: mutation.kind,
    resourceUid: mutation.resourceUid,
    address: mutation.address,
    expectedRevision: mutation.expectedRevision,
    ...(mutation.kind === "write"
      ? {
          resource: mutation.resource,
          relations: mutation.relations,
          ...(mutation.claimKeys ? { claimKeys: mutation.claimKeys } : {}),
        }
      : {}),
    replayKey: mutation.replayKey,
    replay: mutation.replay,
    ...(mutation.providerReceipt ? { providerReceipt: mutation.providerReceipt } : {}),
    terminalJson,
  };
}

function successTerminal(
  id: string,
  mutation: EngineMutationCommit,
  omitObservedStatus = false,
): string {
  if (mutation.kind === "delete") {
    return canonicalJson({
      ...operationDocument(id, true),
      result: { deleted: true },
    });
  }
  const resource = structuredClone(mutation.resource);
  if (omitObservedStatus) delete (resource.status as { observed?: JsonObject }).observed;
  return canonicalJson({
    ...operationDocument(id, true),
    result: { resource },
  });
}

function failureTerminal(id: string, code: string, message: string): string {
  return canonicalJson({
    ...operationDocument(id, true),
    error: { code, message, requestId: `req_${id}`, retryable: false },
  });
}

function operationDocument(id: string, done: boolean): JsonObject {
  return { apiVersion: OPERATION_API_VERSION, kind: "Operation", id, done };
}

function acceptedResponse(id: string, retryAfterSeconds: number): Response {
  return new Response(canonicalJson({ operation: operationDocument(id, false) }), {
    status: 202,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
    },
  });
}

function pendingResponse(id: string, retryAfterSeconds: number): Response {
  return new Response(canonicalJson(operationDocument(id, false)), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
    },
  });
}

function terminalResponse(operation: DeferredOperationRecord): Response {
  if (!operation.terminalJson) throw new TakoformHostError("internal_error", 500);
  return jsonResponse(operation.terminalJson);
}

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isTerminal(operation: DeferredOperationRecord): boolean {
  return (
    operation.phase === "succeeded" ||
    operation.phase === "failed" ||
    operation.phase === "cancelled"
  );
}

async function replayRetired(
  operation: DeferredOperationRecord,
  store: TakoformStore,
): Promise<boolean> {
  if (!isTerminal(operation) || !operation.committedUid) return false;
  return (await store.resourceByUid(operation.tenantId, operation.committedUid)) === null;
}

function nextIdentifier(prefix: "op" | "uid" | "lease", randomId: () => string): string {
  const suffix = randomId().replace(/[^A-Za-z0-9._-]/gu, "");
  if (suffix.length === 0) throw new TypeError("randomId did not yield an identifier");
  return `${prefix}_${suffix}`.slice(0, 128);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`invalid ${name}`);
  }
  return value;
}

function diagnosticMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    resource_not_found: "the accepted resource is absent",
    uid_mismatch: "the accepted resource incarnation changed",
    generation_conflict: "the accepted desired generation changed",
    revision_conflict: "the accepted resource revision changed",
    unsupported_capability: "the required Host capability is unavailable",
    dependency_in_use: "the resource gained a blocking dependency",
    operation_cancelled: "the operation was cancelled",
    backend_unavailable: "the backend is unavailable",
    resource_busy: "the accepted resource changed concurrently",
  };
  return messages[code] ?? "the deferred mutation was refused";
}
