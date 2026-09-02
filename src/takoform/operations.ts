import { sanitizedMessage } from "../error-envelope.ts";
import { canonicalJson } from "../json.ts";
import type { Clock, JsonObject } from "../ports.ts";
import type { EngineContext, EngineMutationCommit, TakoformEngine } from "./engine.ts";
import { exactInstalledForm, type FormRegistry, sameFormRef } from "./forms.ts";
import type { TakoformHostAuthority } from "./host-authority.ts";
import { receiptProjectable } from "./receipt-projection.ts";
import type { DeferredOperationRecord, ResourceAddress, TakoformStore } from "./store.ts";
import {
  TakoformHostError,
  type TakoformStoredResource,
  type TakoformV1Alpha3FormRef,
} from "./types.ts";
import {
  applyRequest,
  exactQuery,
  failure,
  idempotencyKey,
  importRequest,
  jsonBody,
  mutationFingerprint,
  portableResourceView,
  type ResourcePath,
  requestBodyDigest,
  requiredQuery,
  resourceResponse,
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
  /**
   * Execute the durable command under its lease before answering the mutation.
   * A terminal result retains the ordinary resource wire response; a provider
   * repair remains durable and is resumed by maintenance after process loss.
   */
  readonly executeOnAccept?: boolean;
}

export interface DeferredOperations {
  accept(
    context: EngineContext,
    path: ResourcePath,
    operation: "apply" | "import" | "delete",
  ): Promise<Response | null>;
  handle(context: EngineContext, id: string, cancel: boolean): Promise<Response | null>;
  drainProviderRepairs(limit?: number): Promise<{
    readonly candidates: number;
    readonly acquired: number;
    readonly settled: number;
    readonly pending: number;
  }>;
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
  readonly authority?: TakoformHostAuthority;
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly omitObservedStatus?: boolean;
  /** Retained alpha/beta wire duplicated path group/kind in exact lifecycle queries. */
  readonly resourceQueryIncludesPathIdentity?: boolean;
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
      // Provision redemption carries non-replayable authority and stays
      // synchronous until it has its own durable resumption contract.
      if (context.beforeCreate || context.commercialAuthority || context.provisionOnly) {
        return null;
      }
      const accepted = await acceptedMutation(
        context,
        path,
        operation,
        input.forms,
        input.store,
        input.authority,
        input.resourceQueryIncludesPathIdentity,
      );
      if (
        !context.workerEndpointOriginReservationId &&
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
          return input.configuration.executeOnAccept
            ? await executeAccepted(replay, accepted.lifecycleOperation)
            : acceptedResponse(replay.id, retryAfterSeconds);
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
        ...(context.workerEndpointOriginReservationId
          ? { workerEndpointOriginReservationId: context.workerEndpointOriginReservationId }
          : {}),
        pollsRemaining: pollsBeforeCommit,
        createdAt: input.clock().toISOString(),
      });
      if (record.fingerprint !== fingerprint) throw new TakoformHostError();
      return input.configuration.executeOnAccept
        ? await executeAccepted(record, accepted.lifecycleOperation)
        : acceptedResponse(record.id, retryAfterSeconds);
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

    async drainProviderRepairs(limit = 64) {
      const boundedLimit = boundedInteger(limit, 1, 1_000, "provider repair limit");
      const candidates = await input.store.recoverableDeferredProviderOperations(boundedLimit);
      let acquired = 0;
      let settled = 0;
      let pending = 0;
      for (const candidate of candidates) {
        const leaseToken = nextIdentifier("lease", input.randomId);
        const advanced = await input.store.advanceDeferredOperation({
          tenantId: candidate.tenantId,
          principalId: candidate.principalId,
          id: candidate.id,
          leaseToken,
          leaseUntil: input.clock().getTime() + leaseMilliseconds,
        });
        if (!advanced.acquired || !advanced.operation) continue;
        acquired += 1;
        await execute(advanced.operation, leaseToken);
        const current = await input.store.readDeferredOperation(
          candidate.tenantId,
          candidate.principalId,
          candidate.id,
        );
        if (current && isTerminal(current)) settled += 1;
        else pending += 1;
      }
      return { candidates: candidates.length, acquired, settled, pending };
    },
  };

  async function executeAccepted(
    record: DeferredOperationRecord,
    lifecycleOperation: "create" | "update" | "import" | "delete",
  ): Promise<Response> {
    const responseOperation =
      record.operation === "apply"
        ? record.acceptedUid === undefined
          ? "create"
          : "update"
        : lifecycleOperation;
    if (isTerminal(record)) {
      return immediateTerminalResponse(record, responseOperation, input.omitObservedStatus);
    }
    const leaseToken = nextIdentifier("lease", input.randomId);
    let advanced = await input.store.advanceDeferredOperation({
      tenantId: record.tenantId,
      principalId: record.principalId,
      id: record.id,
      leaseToken,
      leaseUntil: input.clock().getTime() + leaseMilliseconds,
    });
    // The first transition persists the non-cancellable committing boundary;
    // a distinct fenced write then acquires execution. Inline mode performs
    // both writes, preserving the same crash point used by asynchronous polls.
    if (!advanced.acquired && advanced.operation?.phase === "committing") {
      advanced = await input.store.advanceDeferredOperation({
        tenantId: record.tenantId,
        principalId: record.principalId,
        id: record.id,
        leaseToken,
        leaseUntil: input.clock().getTime() + leaseMilliseconds,
      });
    }
    if (!advanced.operation) throw new TakoformHostError("operation_not_found", 404);
    if (isTerminal(advanced.operation)) {
      return immediateTerminalResponse(
        advanced.operation,
        responseOperation,
        input.omitObservedStatus,
      );
    }
    if (!advanced.acquired) return acceptedResponse(record.id, retryAfterSeconds);
    const outcome = await execute(advanced.operation, leaseToken);
    if (outcome.kind === "repair") {
      return failure(
        outcome.error.code,
        outcome.error.status,
        undefined,
        outcome.error.publicMessage,
      );
    }
    const settled = await input.store.readDeferredOperation(
      record.tenantId,
      record.principalId,
      record.id,
    );
    if (!settled) throw new TakoformHostError("operation_not_found", 404);
    return isTerminal(settled)
      ? immediateTerminalResponse(settled, responseOperation, input.omitObservedStatus)
      : acceptedResponse(settled.id, retryAfterSeconds);
  }

  async function execute(
    operation: DeferredOperationRecord,
    leaseToken: string,
  ): Promise<
    { readonly kind: "settled" } | { readonly kind: "repair"; readonly error: TakoformHostError }
  > {
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
      ...(operation.workerEndpointOriginReservationId
        ? { workerEndpointOriginReservationId: operation.workerEndpointOriginReservationId }
        : {}),
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
      if (providerReceipt && !carriableReceipt(operation, providerReceipt, input.forms)) {
        // A hold that can never settle is not a hold. The receipt is durable
        // and the Form is frozen, so no repair makes this answer publishable;
        // holding it pinned one Host misconfiguration to a resource name for
        // the life of the deployment. It is a refusal about this Host, and
        // ADR 0008 re-attempts those, so the operator who reconfigures the Host
        // and re-runs the identical apply gets a fresh attempt. The saga goes
        // with it: adopting it again would re-project the same answer.
        console.error(
          canonicalJson({
            event: "takoform.deferred_operation.unpublishable_receipt",
            operationId: operation.id,
            operation: operation.operation,
            kind: operation.target.kind,
          }),
        );
        const refusal = new TakoformHostError(
          "unsupported_capability",
          422,
          undefined,
          `the provider's answer for this ${operation.target.kind} is not one ${operation.target.kind}@${operation.target.formRef.definitionVersion} can publish, so this Host cannot record it; repair the Host's configuration and apply again`,
        );
        await input.store.retireUnpublishableProviderMutation({
          operation,
          leaseToken,
          terminalJson: failureTerminal(
            operation.id,
            refusal.code,
            refusal.publicMessage ?? diagnosticMessage(refusal.code),
          ),
        });
        return { kind: "settled" };
      }
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
        return {
          kind: "repair",
          error:
            error instanceof TakoformHostError
              ? error
              : new TakoformHostError("internal_error", 500),
        };
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
          // The Host's own sentence wins over the code's when it has one: a
          // provider refusal names the cause, and "the deferred mutation was
          // refused" names nothing the operator can act on.
          hostError.publicMessage ?? diagnosticMessage(hostError.code),
        ),
      });
    }
    return { kind: "settled" };
  }
}

/**
 * Whether a held provider receipt is one the Form can still carry.
 *
 * The engine holds every receipt to its Form before it materializes a Resource:
 * a driver may only report what its Form declares. When that check refuses, the
 * mutation has already happened, so the command is held for provider repair —
 * and for this one failure the hold is permanent. The receipt is durable, the
 * Form is frozen, and nothing an operator does makes the stored answer
 * publishable, so every later apply of the same plan-derived key resumed the
 * same command and read back the same refusal. A real self-host recorded it: a
 * Worker endpoint created under a Host configured to publish a ported address,
 * refused by `WorkerEndpoint@0.1.0`, and that Space could not create the
 * endpoint again on a Host where every other Space succeeded first time.
 *
 * A Form this Host cannot resolve is not an answer: the hold stands, which is
 * the behaviour that was there before.
 */
function carriableReceipt(
  operation: DeferredOperationRecord,
  receipt: { readonly observed?: JsonObject; readonly outputs?: JsonObject },
  forms: FormRegistry,
): boolean {
  // Only a mutation that materializes a Resource has its receipt held to the
  // Form. A delete's receipt is provider evidence of a removal and is never
  // projected onto anything, so asking this of one would call every delete
  // unpublishable and abandon a real provider repair.
  if (operation.operation === "delete") return true;
  const form = exactInstalledForm(operation.target.formRef, forms);
  return !form || receiptProjectable(form, receipt);
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
  // A delete is not fenced by the revision it was accepted at. The store
  // repeats this rule inside the commit batch; `deleteFencesRevision` there
  // carries why.
  if (
    operation.operation !== "delete" &&
    current.metadata.revision !== operation.acceptedRevision
  ) {
    throw new TakoformHostError("revision_conflict", 412);
  }
}

async function acceptedMutation(
  context: EngineContext,
  path: ResourcePath,
  operation: "apply" | "import" | "delete",
  forms: FormRegistry,
  store: TakoformStore,
  authority?: TakoformHostAuthority,
  resourceQueryIncludesPathIdentity = false,
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
    if (authority) {
      await authority.authorizeMutation({
        operation: operation === "import" ? "import" : current ? "update" : "create",
        context: {
          tenantId: context.tenantId,
          principalId: context.principalId,
          space: parsed.metadata.space,
        },
        formRef: parsed.form.formRef,
      });
    }
    return {
      lifecycleOperation: operation === "import" ? "import" : current ? "update" : "create",
      formRef: structuredClone(parsed.form.formRef),
      space: parsed.metadata.space,
      current,
      body,
    };
  }

  exactQuery(
    context.url,
    resourceQueryIncludesPathIdentity
      ? ["space", "group", "kind", "definitionVersion", "schemaDigest"]
      : ["space", "definitionVersion", "schemaDigest"],
  );
  const space = requiredQuery(context.url, "space");
  const form = exactInstalledForm(
    {
      apiVersion: path.apiVersion,
      kind: path.kind,
      definitionVersion: requiredQuery(context.url, "definitionVersion"),
      schemaDigest: requiredQuery(context.url, "schemaDigest"),
    },
    forms,
  );
  if (
    !form ||
    (resourceQueryIncludesPathIdentity &&
      (requiredQuery(context.url, "group") !== path.apiVersion ||
        requiredQuery(context.url, "kind") !== path.kind))
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
  if (authority) {
    await authority.authorizeRetained({
      operation: "delete",
      context: {
        tenantId: context.tenantId,
        principalId: context.principalId,
        space,
      },
      resource: current,
    });
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
          ...(mutation.preserveClaims ? { preserveClaims: true as const } : {}),
        }
      : {}),
    replayKey: mutation.replayKey,
    replay: mutation.replay,
    ...(mutation.providerReceipt ? { providerReceipt: mutation.providerReceipt } : {}),
    ...(mutation.providerEffect ? { providerEffect: mutation.providerEffect } : {}),
    ...(mutation.kind === "delete" && mutation.deletionTombstone
      ? { deletionTombstone: mutation.deletionTombstone }
      : {}),
    ...(mutation.authorityFence ? { authorityFence: mutation.authorityFence } : {}),
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
  const resource = portableResourceView(mutation.resource, omitObservedStatus);
  return canonicalJson({
    ...operationDocument(id, true),
    result: { resource },
  });
}

function failureTerminal(id: string, code: string, message: string): string {
  return canonicalJson({
    ...operationDocument(id, true),
    error: {
      code,
      message: sanitizedMessage(message) ?? code.replaceAll("_", " "),
      requestId: `req_${id}`,
      retryable: false,
    },
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
  const document = terminalDocument(operation);
  if (isRecord(document.result) && isRecord(document.result.resource)) {
    document.result.resource = portableResourceView(
      document.result.resource as unknown as TakoformStoredResource,
    );
  }
  return jsonResponse(canonicalJson(document));
}

function immediateTerminalResponse(
  operation: DeferredOperationRecord,
  lifecycleOperation: "create" | "update" | "import" | "delete",
  omitObservedStatus = false,
): Response {
  const document = terminalDocument(operation);
  if (isRecord(document.result) && isRecord(document.result.resource)) {
    return resourceResponse(
      document.result.resource as unknown as TakoformStoredResource,
      lifecycleOperation === "create" ? 201 : 200,
      omitObservedStatus,
    );
  }
  if (lifecycleOperation === "delete" && isRecord(document.result) && document.result.deleted) {
    return new Response(null, { status: 204 });
  }
  if (isRecord(document.error) && typeof document.error.code === "string") {
    return failure(
      document.error.code,
      deferredFailureStatus(document.error.code),
      undefined,
      typeof document.error.message === "string" ? document.error.message : undefined,
    );
  }
  throw new TakoformHostError("internal_error", 500);
}

function terminalDocument(operation: DeferredOperationRecord): Record<string, unknown> {
  if (!operation.terminalJson) throw new TakoformHostError("internal_error", 500);
  let document: unknown;
  try {
    document = JSON.parse(operation.terminalJson);
  } catch {
    throw new TakoformHostError("internal_error", 500);
  }
  if (!isRecord(document)) throw new TakoformHostError("internal_error", 500);
  return document;
}

function deferredFailureStatus(code: string): number {
  switch (code) {
    case "insufficient_funds":
      return 402;
    case "policy_denied":
      return 403;
    case "artifact_missing":
    case "form_unknown":
    case "operation_not_found":
    case "resource_not_found":
      return 404;
    case "dependency_in_use":
    case "import_conflict":
    case "migration_required":
    case "offering_mismatch":
    case "operation_cancelled":
    case "resource_busy":
    case "space_mismatch":
    case "uid_mismatch":
      return 409;
    case "generation_conflict":
    case "revision_conflict":
      return 412;
    case "unsupported_capability":
      return 422;
    case "backend_unavailable":
    case "form_unavailable":
    case "unavailable":
      return 503;
    case "internal_error":
      return 500;
    default:
      return 400;
  }
}

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(operation: DeferredOperationRecord): boolean {
  return (
    operation.phase === "succeeded" ||
    operation.phase === "failed" ||
    operation.phase === "cancelled"
  );
}

/**
 * Refusals that describe this Host rather than the request, and are therefore
 * re-attempted when the same request is presented again.
 *
 * The split is what the refusal is *about*. `generation_conflict` says the
 * desired state moved under the caller's fence; `uid_mismatch` says they named
 * an incarnation that is not there; `invalid_argument` says the document is
 * wrong. Those are facts about the request, the fingerprint proves the request
 * has not changed, so the stored answer is still the answer.
 *
 * These are not. A capability this Host does not offer, a Form not installed,
 * a backend that was down, a dependency that still existed, a wallet that was
 * empty — none of them is a statement about the request, and each is cured
 * somewhere other than the configuration. The operator fixes the Host and runs
 * the same `tofu apply`, whose plan-derived idempotency key is identical by
 * design; handing them the old refusal pins a Host defect to a resource name
 * until the record ages out, and the only escapes measured on a real self-host
 * were renaming the resource or editing the Host's database.
 */
const REATTEMPTED_SETTLED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "backend_unavailable",
  "deadline_exceeded",
  "dependency_in_use",
  "deletion_protected",
  "form_identity_conflict",
  "form_not_installed",
  "form_unavailable",
  "form_unknown",
  "insufficient_funds",
  "internal_error",
  "migration_required",
  "quota_exceeded",
  "rate_limited",
  "resource_busy",
  "unavailable",
  "unsupported_capability",
]);

/**
 * Whether a stored acceptance under this replay key has stopped being the
 * answer to the request that just arrived.
 *
 * Two cases retire one. A committed mutation whose Resource no longer exists
 * describes an incarnation that is gone. And a settled failure whose code names
 * something about *this Host* rather than about the request is a statement
 * about facts the operator then changes: the released provider recomputes the
 * same plan-derived idempotency key on every run, so `tofu destroy` gets
 * `dependency_in_use` on a parent, deletes the dependents it named, asks again
 * under the same key — and a Host that replayed the refusal would refuse it
 * until the record expired. The same held for `unsupported_capability` after a
 * Host defect was repaired.
 *
 * The rule and its supersession are recorded in
 * [ADR 0008](../../docs/adr/0008-a-settled-refusal-about-the-host-is-re-attempted.md).
 *
 * Retrying one is a second *attempt*, never a second mutation, and the store is
 * what makes that true rather than the code list: an operation whose provider
 * mutation was receipted, or whose plan is still live, is held for repair and
 * never settled at all. A settled failure is one where either the provider was
 * never invoked, or it answered definitively enough for the engine to
 * terminalize the saga — a precondition failure, whose whole meaning is that
 * nothing was mutated. Cancellation stays terminal: it is not a failure code
 * and never reaches this list.
 */
async function replayRetired(
  operation: DeferredOperationRecord,
  store: TakoformStore,
): Promise<boolean> {
  if (operation.phase === "failed") {
    const code = terminalErrorCode(operation);
    return code !== null && REATTEMPTED_SETTLED_FAILURE_CODES.has(code);
  }
  if (!isTerminal(operation) || !operation.committedUid) return false;
  return (await store.resourceByUid(operation.tenantId, operation.committedUid)) === null;
}

/** The code a settled operation reported, or nothing this Host can act on. */
function terminalErrorCode(operation: DeferredOperationRecord): string | null {
  if (operation.terminalJson === undefined) return null;
  let document: unknown;
  try {
    document = JSON.parse(operation.terminalJson);
  } catch {
    return null;
  }
  if (!isRecord(document)) return null;
  const error = document.error;
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
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
