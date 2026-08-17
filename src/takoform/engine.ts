import { canonicalDigest, canonicalJson } from "../json.ts";
import type { Clock, JsonObject } from "../ports.ts";
import { exactInstalledForm, type FormRegistry, sameFormRef } from "./forms.ts";
import { PREPARE_TTL_MILLISECONDS } from "./limits.ts";
import { materializeDefaults, validateDesired, validateSchemaValue } from "./schema.ts";
import type { ResourceAddress, StoredReplay, TakoformStore } from "./store.ts";
import {
  type InstalledTakoformForm,
  type TakoformDiagnostic,
  type TakoformDriverReceipt,
  TakoformHostError,
  type TakoformResourceDriver,
  type TakoformStoredResource,
} from "./types.ts";
import {
  applyRequest,
  exactQuery,
  idempotencyKey,
  importRequest,
  increment,
  jsonBody,
  mutationFingerprint,
  optionalGeneration,
  type ParsedResource,
  type ResourcePath,
  requestBodyDigest,
  requiredExpectedGeneration,
  requiredQuery,
  resourceRequest,
  samePathResource,
  spaceId,
  stripApplyReview,
} from "./wire.ts";

/**
 * The Takoform resource lifecycle.
 *
 * The engine owns identity, fences, review, replay, and receipt projection; the
 * driver owns only the side effect. It speaks in typed results rather than
 * `Response` objects — HTTP shaping belongs to `routes.ts` — but it does read
 * the request, because several fences (`if-match`, `if-none-match`,
 * `takoform-expected-generation`, `idempotency-key`) and the replay fingerprint
 * are defined in terms of the raw HTTP request itself.
 */

export interface ArtifactResolver {
  resolveManifest(tenantId: string, digest: string): Promise<{ readonly kind: string } | null>;
}

export interface EngineContext {
  readonly request: Request;
  readonly url: URL;
  readonly tenantId: string;
  readonly principalId: string;
}

export type EngineResult =
  | {
      readonly kind: "resource";
      readonly resource: TakoformStoredResource;
      readonly status: number;
    }
  | { readonly kind: "deleted" }
  | {
      readonly kind: "validated";
      readonly valid: boolean;
      readonly diagnostics: readonly TakoformDiagnostic[];
    }
  | {
      readonly kind: "prepared";
      readonly resource: ParsedResource;
      readonly review: { readonly prepareDigest: string; readonly specDigest: string };
    };

export interface TakoformEngine {
  validateOrPrepare(context: EngineContext, mode: "validate" | "prepare"): Promise<EngineResult>;
  read(context: EngineContext, path: ResourcePath): Promise<EngineResult>;
  apply(context: EngineContext, path: ResourcePath): Promise<EngineResult>;
  observe(context: EngineContext, path: ResourcePath): Promise<EngineResult>;
  importResource(context: EngineContext, path: ResourcePath): Promise<EngineResult>;
  remove(context: EngineContext, path: ResourcePath): Promise<EngineResult>;
}

export interface CreateTakoformEngineOptions {
  readonly store: TakoformStore;
  readonly forms: FormRegistry;
  readonly driver: TakoformResourceDriver;
  readonly artifacts: ArtifactResolver;
  readonly clock: Clock;
  readonly randomId: () => string;
}

export function createTakoformEngine(options: CreateTakoformEngineOptions): TakoformEngine {
  const { store, forms, driver, artifacts, clock, randomId } = options;

  const operationId = (): string => `op_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`;

  const replayKeyFor = (context: EngineContext, space: string, operation: string): string =>
    [context.tenantId, context.principalId, space, operation, idempotencyKey(context.request)].join(
      "\u0000",
    );

  const requireArtifact = async (
    form: InstalledTakoformForm,
    spec: JsonObject,
    tenantId: string,
  ): Promise<void> => {
    const requirement = form.artifactRequirement;
    if (requirement === undefined) return;
    const manifestDigest = spec[requirement.specField];
    if (typeof manifestDigest !== "string") throw new TakoformHostError("artifact_missing", 404);
    const manifest = await artifacts.resolveManifest(tenantId, manifestDigest);
    if (manifest?.kind !== requirement.kind) throw new TakoformHostError("artifact_missing", 404);
  };

  const formFromResourceQuery = (
    url: URL,
    path: ResourcePath,
  ): InstalledTakoformForm | undefined => {
    if (
      requiredQuery(url, "group") !== path.apiVersion ||
      requiredQuery(url, "kind") !== path.kind
    ) {
      return undefined;
    }
    return exactInstalledForm(
      {
        apiVersion: path.apiVersion,
        kind: path.kind,
        definitionVersion: requiredQuery(url, "definitionVersion"),
        schemaDigest: requiredQuery(url, "schemaDigest"),
      },
      forms,
    );
  };

  const addressOf = (tenantId: string, resource: ParsedResource): ResourceAddress => ({
    tenantId,
    space: resource.metadata.space,
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
  });

  const addressFromParts = (
    tenantId: string,
    space: string,
    path: ResourcePath,
  ): ResourceAddress => ({
    tenantId,
    space: spaceId(space),
    apiVersion: path.apiVersion,
    kind: path.kind,
    name: path.name,
  });

  /** Records a settled operation so `/operations/{id}` can answer truthfully. */
  const recordOperationFor =
    (tenantId: string) =>
    (id: string, operation: string, resource?: TakoformStoredResource): Promise<void> =>
      store.putOperation(tenantId, {
        id,
        operation,
        state: "succeeded",
        createdAt: clock().toISOString(),
        ...(resource ? { resource } : {}),
      });

  /** Persists a settled mutation, refusing to overwrite a concurrent winner. */
  const commit = async (
    address: ResourceAddress,
    resource: TakoformStoredResource,
    previous: TakoformStoredResource | undefined,
    nativeId?: string,
  ): Promise<void> => {
    const written = await store.writeResource({
      address,
      resource,
      expectedRevision: previous?.metadata.revision ?? null,
      ...(nativeId === undefined ? {} : { nativeId }),
    });
    if (!written) throw new TakoformHostError("resource_busy", 409);
  };

  return {
    async validateOrPrepare(context, mode): Promise<EngineResult> {
      const parsed = resourceRequest(await jsonBody(context.request));
      const form = exactInstalledForm(parsed.form.formRef, forms);
      if (!form) throw new TakoformHostError("form_unknown", 404);
      const requestResource: ParsedResource = {
        ...parsed,
        spec: materializeDefaults(form.desiredSchema, parsed.spec),
      };
      const diagnostics = validateDesired(form, requestResource.spec);
      if (mode === "validate") {
        return {
          kind: "validated",
          valid: !diagnostics.some((entry) => entry.severity === "error"),
          diagnostics,
        };
      }
      if (diagnostics.some((entry) => entry.severity === "error")) {
        throw new TakoformHostError("invalid_argument", 400, { diagnostics });
      }
      await requireArtifact(form, requestResource.spec, context.tenantId);

      const expectedGeneration = optionalGeneration(
        context.request.headers.get("takoform-expected-generation"),
      );
      const address = addressOf(context.tenantId, requestResource);
      const current = await store.readResource(address);
      if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (current && expectedGeneration !== current.metadata.generation) {
        throw new TakoformHostError("generation_conflict", 412);
      }
      if (!current && expectedGeneration !== undefined) {
        throw new TakoformHostError("resource_not_found", 404);
      }

      const specDigest = await canonicalDigest(requestResource.spec);
      const prepareDigest = await canonicalDigest({
        tenantId: context.tenantId,
        resource: requestResource,
        expectedGeneration: expectedGeneration ?? null,
        currentUid: current?.metadata.uid ?? null,
      });
      await store.putPrepare(
        context.tenantId,
        prepareDigest,
        {
          fingerprint: canonicalJson(requestResource),
          ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
          ...(current ? { currentUid: current.metadata.uid } : {}),
        },
        clock().getTime() + PREPARE_TTL_MILLISECONDS,
      );
      return {
        kind: "prepared",
        resource: structuredClone(requestResource),
        review: { prepareDigest, specDigest },
      };
    },

    async read(context, path): Promise<EngineResult> {
      exactQuery(context.url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
      const form = formFromResourceQuery(context.url, path);
      if (!form) throw new TakoformHostError("form_unknown", 404);
      const resource = await store.readResource(
        addressFromParts(context.tenantId, requiredQuery(context.url, "space"), path),
      );
      if (!resource || !sameFormRef(resource.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (!form.operations.includes("read")) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      return { kind: "resource", resource, status: 200 };
    },

    async apply(context, path): Promise<EngineResult> {
      const rawBodyDigest = await requestBodyDigest(context.request);
      const parsedBody = applyRequest(await jsonBody(context.request));
      const form = exactInstalledForm(parsedBody.form.formRef, forms);
      if (!form || !samePathResource(parsedBody, path)) {
        throw new TakoformHostError("form_unknown", 404);
      }
      const body = {
        ...parsedBody,
        spec: materializeDefaults(form.desiredSchema, parsedBody.spec),
      };
      const address = addressOf(context.tenantId, body);
      const current = await store.readResource(address);
      if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      await requireArtifact(form, body.spec, context.tenantId);

      const replayKey = replayKeyFor(context, body.metadata.space, "apply");
      const fingerprint = mutationFingerprint(context.request, rawBodyDigest);
      const replay = await store.readReplay(replayKey);
      if (replay) {
        const replayed = replayedMutation(replay, fingerprint, current?.metadata.uid);
        if (replayed) return replayed;
        // The recorded resource no longer exists, so the key is released and
        // the request is served as a fresh mutation.
        await store.deleteReplay(replayKey);
      }

      const create = current === null;
      if (!form.operations.includes(create ? "create" : "update")) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      if (create && context.request.headers.get("if-none-match") !== "*") {
        throw new TakoformHostError();
      }
      if (current) {
        const expected = requiredExpectedGeneration(context.request, body.expectedGeneration);
        if (expected !== current.metadata.generation) {
          throw new TakoformHostError("generation_conflict", 412);
        }
        if (body.expectedUid && body.expectedUid !== current.metadata.uid) {
          throw new TakoformHostError("uid_mismatch", 409);
        }
        const ifMatch = context.request.headers.get("if-match");
        if (ifMatch && ifMatch !== `"${current.metadata.revision}"`) {
          throw new TakoformHostError("revision_conflict", 412);
        }
      }

      const review = await store.readPrepare(context.tenantId, body.review.prepareDigest);
      if (
        !review ||
        review.fingerprint !== canonicalJson(stripApplyReview(body)) ||
        review.expectedGeneration !== (current?.metadata.generation ?? undefined) ||
        review.currentUid !== (current?.metadata.uid ?? undefined)
      ) {
        throw new TakoformHostError();
      }

      const opId = operationId();
      const receipt = await driver.apply({
        operationId: opId,
        tenantId: context.tenantId,
        form,
        name: body.metadata.name,
        space: body.metadata.space,
        spec: structuredClone(body.spec),
        ...(current ? { previous: structuredClone(current) } : {}),
      });
      const next = materializeResource(body, form, receipt, current, clock, randomId);
      const nativeId = current ? await store.nativeIdOf(address) : null;
      await commit(address, next, current ?? undefined, nativeId ?? undefined);
      const status = create ? 201 : 200;
      await recordOperationFor(context.tenantId)(opId, create ? "create" : "update", next);
      await store.putReplay(replayKey, {
        fingerprint,
        status,
        resource: next,
        boundUid: next.metadata.uid,
      });
      return { kind: "resource", resource: next, status };
    },

    async observe(context, path): Promise<EngineResult> {
      exactQuery(context.url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
      const form = formFromResourceQuery(context.url, path);
      if (!form) throw new TakoformHostError("form_unknown", 404);
      const address = addressFromParts(context.tenantId, requiredQuery(context.url, "space"), path);
      const current = await store.readResource(address);
      if (!current || !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (!form.operations.includes("observe")) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      const expected = requiredExpectedGeneration(context.request);
      if (expected !== current.metadata.generation) {
        throw new TakoformHostError("generation_conflict", 412);
      }
      const replayKey = replayKeyFor(context, current.metadata.space, "observe");
      const fingerprint = mutationFingerprint(
        context.request,
        await requestBodyDigest(context.request),
      );
      const replay = await store.readReplay(replayKey);
      if (replay) return replayedObservation(replay, fingerprint, current.metadata.uid);

      const observeId = operationId();
      const receipt = await driver.observe({
        tenantId: context.tenantId,
        resource: structuredClone(current),
      });
      const next = withObservation(current, form, receipt, clock);
      await commit(address, next, current, (await store.nativeIdOf(address)) ?? undefined);
      await recordOperationFor(context.tenantId)(observeId, "observe", next);
      await store.putReplay(replayKey, {
        fingerprint,
        status: 200,
        resource: next,
        boundUid: next.metadata.uid,
      });
      return { kind: "resource", resource: next, status: 200 };
    },

    async importResource(context, path): Promise<EngineResult> {
      const rawBodyDigest = await requestBodyDigest(context.request);
      const parsedBody = importRequest(await jsonBody(context.request));
      const form = exactInstalledForm(parsedBody.form.formRef, forms);
      if (!form || !samePathResource(parsedBody, path)) {
        throw new TakoformHostError("form_unknown", 404);
      }
      const body = {
        ...parsedBody,
        spec: materializeDefaults(form.desiredSchema, parsedBody.spec),
      };
      if (!form.operations.includes("import") || !driver.import) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      const diagnostics = validateDesired(form, body.spec);
      if (diagnostics.some((entry) => entry.severity === "error")) {
        throw new TakoformHostError("invalid_argument", 400, { diagnostics });
      }
      const address = addressOf(context.tenantId, body);
      const current = await store.readResource(address);
      if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      await requireArtifact(form, body.spec, context.tenantId);

      const replayKey = replayKeyFor(context, body.metadata.space, "import");
      const fingerprint = mutationFingerprint(context.request, rawBodyDigest);
      const replay = await store.readReplay(replayKey);
      if (replay) {
        const replayed = replayedMutation(replay, fingerprint, current?.metadata.uid);
        if (replayed) return replayed;
        await store.deleteReplay(replayKey);
      }

      const create = current === null;
      if (create && context.request.headers.get("if-none-match") !== "*") {
        throw new TakoformHostError();
      }
      if (current) {
        const expected = requiredExpectedGeneration(context.request);
        if (expected !== current.metadata.generation) {
          throw new TakoformHostError("generation_conflict", 412);
        }
      }

      // A native resource belongs to exactly one address, and an existing
      // address keeps the native id it was adopted with.
      const claim = await store.nativeClaim(context.tenantId, body.nativeId);
      const claimedElsewhere = claim !== null && !sameAddress(claim, address);
      const rebinding = current !== null && (await store.nativeIdOf(address)) !== body.nativeId;
      if (claimedElsewhere || rebinding) {
        throw new TakoformHostError("import_conflict", 409);
      }

      const importId = operationId();
      const receipt = await driver.import({
        operationId: importId,
        tenantId: context.tenantId,
        form,
        name: body.metadata.name,
        space: body.metadata.space,
        spec: structuredClone(body.spec),
        nativeId: body.nativeId,
        ...(current ? { previous: structuredClone(current) } : {}),
      });
      const next = materializeResource(body, form, receipt, current, clock, randomId);
      await commit(address, next, current ?? undefined, body.nativeId);
      const status = create ? 201 : 200;
      await recordOperationFor(context.tenantId)(importId, "import", next);
      await store.putReplay(replayKey, {
        fingerprint,
        status,
        resource: next,
        boundUid: next.metadata.uid,
      });
      return { kind: "resource", resource: next, status };
    },

    async remove(context, path): Promise<EngineResult> {
      exactQuery(context.url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
      const form = formFromResourceQuery(context.url, path);
      if (!form) throw new TakoformHostError("form_unknown", 404);
      const space = requiredQuery(context.url, "space");
      const address = addressFromParts(context.tenantId, space, path);
      const expected = requiredExpectedGeneration(context.request);
      const replayKey = replayKeyFor(context, space, "delete");
      const fingerprint = mutationFingerprint(
        context.request,
        await requestBodyDigest(context.request),
      );
      const replay = await store.readReplay(replayKey);
      const current = await store.readResource(address);
      if (replay) {
        // A delete replay is answered on the fingerprint alone: the resource it
        // removed is, by definition, no longer there to compare against.
        if (replay.fingerprint !== fingerprint) throw new TakoformHostError();
        return { kind: "deleted" };
      }
      if (!current || !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (!form.operations.includes("delete")) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      if (expected !== current.metadata.generation) {
        throw new TakoformHostError("generation_conflict", 412);
      }
      const ifMatch = context.request.headers.get("if-match");
      if (ifMatch && ifMatch !== `"${current.metadata.revision}"`) {
        throw new TakoformHostError("revision_conflict", 412);
      }

      const deleteId = operationId();
      await driver.delete({
        operationId: deleteId,
        tenantId: context.tenantId,
        resource: structuredClone(current),
      });
      const removed = await store.deleteResource(address, current.metadata.revision);
      if (!removed) throw new TakoformHostError("resource_busy", 409);
      await recordOperationFor(context.tenantId)(deleteId, "delete");
      await store.putReplay(replayKey, { fingerprint, status: 204 });
      return { kind: "deleted" };
    },
  };
}

function sameAddress(left: ResourceAddress, right: ResourceAddress): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.space === right.space &&
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.name === right.name
  );
}

/**
 * Replays a recorded create or update. Returns null when the recorded resource
 * has since been deleted, which releases the key rather than resurrecting it.
 */
function replayedMutation(
  replay: StoredReplay,
  fingerprint: string,
  currentUid: string | undefined,
): EngineResult | null {
  if (!replay.resource || !replay.boundUid) {
    throw new TakoformHostError("resource_not_found", 404);
  }
  if (currentUid === undefined) return null;
  if (replay.fingerprint !== fingerprint) throw new TakoformHostError();
  if (replay.boundUid !== currentUid) throw new TakoformHostError("resource_not_found", 404);
  return { kind: "resource", resource: replay.resource, status: replay.status };
}

function replayedObservation(
  replay: StoredReplay,
  fingerprint: string,
  currentUid: string,
): EngineResult {
  if (replay.fingerprint !== fingerprint) throw new TakoformHostError();
  if (!replay.resource || replay.boundUid !== currentUid) {
    throw new TakoformHostError("resource_not_found", 404);
  }
  return { kind: "resource", resource: replay.resource, status: replay.status };
}

function materializeResource(
  input: ParsedResource,
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
  current: TakoformStoredResource | null,
  clock: Clock,
  randomId: () => string,
): TakoformStoredResource {
  // Generation tracks desired state, so it only moves when the spec does.
  const generation = current
    ? canonicalJson(current.spec) === canonicalJson(input.spec)
      ? current.metadata.generation
      : increment(current.metadata.generation)
    : "1";
  const revision = current ? increment(current.metadata.revision) : "1";
  return {
    apiVersion: input.apiVersion,
    kind: input.kind,
    form: structuredClone(form.identity),
    metadata: {
      name: input.metadata.name,
      space: input.metadata.space,
      uid: current?.metadata.uid ?? `uid_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`,
      generation,
      revision,
    },
    spec: structuredClone(input.spec),
    status: {
      observedGeneration: generation,
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: clock().toISOString(),
        },
      ],
      ...projectReceipt(form, receipt),
    },
  };
}

/** An observation that changed nothing must not mint a new revision. */
function withObservation(
  current: TakoformStoredResource,
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
  clock: Clock,
): TakoformStoredResource {
  const candidate: TakoformStoredResource = {
    ...structuredClone(current),
    status: {
      ...structuredClone(current.status),
      ...projectReceipt(form, receipt),
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: clock().toISOString(),
        },
      ],
    },
  };
  const comparable = (value: TakoformStoredResource) =>
    canonicalJson({
      ...value,
      metadata: { ...value.metadata, revision: "" },
      status: { ...value.status, conditions: [] },
    });
  if (comparable(current) === comparable(candidate)) return structuredClone(current);
  return {
    ...candidate,
    metadata: { ...candidate.metadata, revision: increment(current.metadata.revision) },
  };
}

/**
 * A driver may only report what its Form declares, and it must report all of
 * it. Anything else is the Host's failure to trust, not the caller's.
 */
function projectReceipt(
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
): { readonly observed?: JsonObject; readonly outputs?: JsonObject } {
  if (form.observedSchema && !receipt.observed) throw new TakoformHostError();
  if (form.outputSchema && !receipt.outputs) throw new TakoformHostError();
  if (
    form.observedSchema &&
    receipt.observed &&
    validateSchemaValue(form.observedSchema, receipt.observed, "").length > 0
  ) {
    throw new TakoformHostError();
  }
  if (
    form.outputSchema &&
    receipt.outputs &&
    validateSchemaValue(form.outputSchema, receipt.outputs, "").length > 0
  ) {
    throw new TakoformHostError();
  }
  return {
    ...(form.observedSchema && receipt.observed
      ? { observed: structuredClone(receipt.observed) }
      : {}),
    ...(form.outputSchema && receipt.outputs ? { outputs: structuredClone(receipt.outputs) } : {}),
  };
}
