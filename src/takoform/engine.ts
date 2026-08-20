import { canonicalDigest, canonicalJson } from "../json.ts";
import type { Clock, JsonObject } from "../ports.ts";
import type { TakoformArtifactManifest } from "./artifacts.ts";
import type { BindingRegistry } from "./bindings.ts";
import { canonicalizeEdgeSpec } from "./edge-semantics.ts";
import { exactInstalledForm, type FormRegistry, sameFormRef } from "./forms.ts";
import { PREPARE_TTL_MILLISECONDS } from "./limits.ts";
import { relationDrift, resolveRelations, type TakoformStoredRelation } from "./relations.ts";
import { materializeDefaults, validateDesired, validateSchemaValue } from "./schema.ts";
import { applySqliteMigrationApplication, sqliteMigrationCondition } from "./sqlite-migrations.ts";
import type { ResourceAddress, StoredReplay, TakoformStore } from "./store.ts";
import {
  type InstalledTakoformForm,
  type TakoformCommercialAuthority,
  type TakoformDiagnostic,
  type TakoformDriverReceipt,
  type TakoformDriverRelation,
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
import {
  validateWorkerAggregate,
  validateWorkerDeploymentRemoval,
  workerServiceCondition,
} from "./worker-aggregate.ts";
import {
  validateWorkerBundleRuntime,
  validateWorkerVersionRuntime,
} from "./worker-runtime-contract.ts";

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
  resolveManifest(tenantId: string, digest: string): Promise<TakoformArtifactManifest | null>;
  resolveBlob(tenantId: string, digest: string): Promise<Uint8Array | null>;
}

export interface WorkerModuleInspector {
  inspect(input: {
    readonly digest: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly loadable: boolean; readonly handlers: readonly string[] }>;
}

export interface EngineContext {
  readonly request: Request;
  readonly url: URL;
  readonly tenantId: string;
  readonly principalId: string;
  /** Runs after every portable fence/review check and immediately before create side effects. */
  readonly beforeCreate?: () => Promise<void>;
  /** A paid create credential must never inherit authority over an existing incarnation. */
  readonly provisionOnly?: boolean;
  readonly expectedResourceUid?: string;
  readonly commercialAuthority?: TakoformCommercialAuthority;
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
  readonly bindings: BindingRegistry;
  readonly driver: TakoformResourceDriver;
  readonly artifacts: ArtifactResolver;
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly workerModuleInspector?: WorkerModuleInspector;
  /** Every live relation that must be removed before the Resource can be deleted. */
  readonly blockingRelations?: (
    tenantId: string,
    resourceUid: string,
  ) => Promise<readonly string[]>;
}

export function createTakoformEngine(options: CreateTakoformEngineOptions): TakoformEngine {
  const { store, forms, bindings, driver, artifacts, clock, randomId } = options;

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
    if (!manifest) throw new TakoformHostError("artifact_missing", 404);
    if (manifest.kind !== requirement.kind) throw new TakoformHostError("artifact_invalid", 400);
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
    relations: readonly TakoformStoredRelation[],
  ): Promise<void> => {
    const written = await store.writeResource({
      address,
      resource,
      relations,
      expectedRevision: previous?.metadata.revision ?? null,
    });
    if (!written) throw new TakoformHostError("resource_busy", 409);
  };

  /** Re-reads every pinned target immediately before provider execution. */
  const driverRelations = async (
    tenantId: string,
    space: string,
    relations: readonly TakoformStoredRelation[],
  ): Promise<readonly TakoformDriverRelation[]> => {
    const resolved: TakoformDriverRelation[] = [];
    for (const relation of relations) {
      const resource = await store.readResource({
        tenantId,
        space,
        apiVersion: relation.targetApiVersion,
        kind: relation.targetKind,
        name: relation.targetName,
      });
      if (
        !resource ||
        resource.metadata.uid !== relation.targetUid ||
        !sameFormRef(resource.form.formRef, relation.targetFormRef)
      ) {
        throw new TakoformHostError("resource_not_found", 404, {
          pointer: relation.pointer,
        });
      }
      resolved.push({
        pointer: relation.pointer,
        relation: relation.relation,
        targetUid: relation.targetUid,
        resource: structuredClone(resource),
        ...(relation.bindingRef ? { bindingRef: structuredClone(relation.bindingRef) } : {}),
      });
    }
    return resolved;
  };

  return {
    async validateOrPrepare(context, mode): Promise<EngineResult> {
      const parsed = resourceRequest(await jsonBody(context.request));
      const form = exactInstalledForm(parsed.form.formRef, forms);
      if (!form) throw new TakoformHostError("form_unknown", 404);
      const requestResource: ParsedResource = {
        ...parsed,
        spec: canonicalizeEdgeSpec(form, materializeDefaults(form.desiredSchema, parsed.spec)),
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
      const expectedGeneration = optionalGeneration(
        context.request.headers.get("takoform-expected-generation"),
      );
      const address = addressOf(context.tenantId, requestResource);
      const current = await store.readResource(address);
      if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (current && expectedGeneration === undefined) {
        throw new TakoformHostError();
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
      const address = addressFromParts(context.tenantId, requiredQuery(context.url, "space"), path);
      let resource = await store.readResource(address);
      if (!resource || !sameFormRef(resource.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (
        context.expectedResourceUid !== undefined &&
        resource.metadata.uid !== context.expectedResourceUid
      ) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (!form.operations.includes("read")) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      const relations = await store.readRelations(address);
      const drift = await relationDrift({
        tenantId: context.tenantId,
        space: resource.metadata.space,
        relations,
        store,
      });
      const migrationCondition = drift
        ? null
        : await sqliteMigrationCondition({
            tenantId: context.tenantId,
            space: resource.metadata.space,
            form,
            relations,
            store,
            artifacts,
            driver,
          });
      const workerCondition =
        drift || migrationCondition
          ? null
          : await workerServiceCondition({ tenantId: context.tenantId, resource, store });
      const rendered = withDerivedRendering(
        resource,
        drift ?? migrationCondition ?? workerCondition,
        clock,
      );
      if (rendered.metadata.revision !== resource.metadata.revision) {
        await commit(address, rendered, resource, relations);
        resource = rendered;
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
        spec: canonicalizeEdgeSpec(form, materializeDefaults(form.desiredSchema, parsedBody.spec)),
      };
      const address = addressOf(context.tenantId, body);
      const current = await store.readResource(address);
      if (context.provisionOnly && current !== null) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (
        context.expectedResourceUid !== undefined &&
        current?.metadata.uid !== context.expectedResourceUid
      ) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      await requireArtifact(form, body.spec, context.tenantId);
      await validateWorkerBundleRuntime({
        tenantId: context.tenantId,
        form,
        spec: body.spec,
        artifacts,
        ...(options.workerModuleInspector ? { inspector: options.workerModuleInspector } : {}),
      });

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
      const createIntent = context.request.headers.get("if-none-match") === "*";
      if (!create && createIntent) {
        throw new TakoformHostError("generation_conflict", 412);
      }
      if (create && !createIntent) {
        if (
          context.request.headers.has("takoform-expected-generation") ||
          body.expectedGeneration !== undefined
        ) {
          throw new TakoformHostError("resource_not_found", 404);
        }
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

      // Reasserting an identical desired state is a no-op, not an update.
      // This matters for immutable attachment/revision Forms and for values
      // canonicalized before hashing (for example DNS spelling variants).
      const identicalDesired =
        current !== null && canonicalJson(current.spec) === canonicalJson(body.spec);
      const currentRelations = current ? await store.readRelations(address) : [];
      const currentDrift = current
        ? await relationDrift({
            tenantId: context.tenantId,
            space: current.metadata.space,
            relations: currentRelations,
            store,
          })
        : null;
      const currentWorkerCondition =
        current && !currentDrift
          ? await sqliteMigrationCondition({
              tenantId: context.tenantId,
              space: current.metadata.space,
              form,
              relations: currentRelations,
              store,
              artifacts,
              driver,
            })
          : null;
      const currentMigrationCondition = currentWorkerCondition;
      const currentActualWorkerCondition =
        current && !currentDrift && !currentMigrationCondition
          ? await workerServiceCondition({ tenantId: context.tenantId, resource: current, store })
          : null;
      const currentDerivedReady =
        (currentMigrationCondition === null || currentMigrationCondition.status === "True") &&
        (currentActualWorkerCondition === null || currentActualWorkerCondition.status === "True");
      if (
        current &&
        form.role !== "revision" &&
        identicalDesired &&
        !currentDrift &&
        currentDerivedReady &&
        current.status.conditions.some(
          (condition) =>
            condition.type === "Ready" &&
            condition.status === "True" &&
            condition.reason === "Available",
        )
      ) {
        const noOpId = operationId();
        await recordOperationFor(context.tenantId)(noOpId, "update", current);
        await store.putReplay(replayKey, {
          fingerprint,
          status: 200,
          resource: current,
          boundUid: current.metadata.uid,
        });
        return { kind: "resource", resource: current, status: 200 };
      }
      if (current && form.role === "revision") {
        throw new TakoformHostError("invalid_argument", 400);
      }
      if (!form.operations.includes(create ? "create" : "update") && !identicalDesired) {
        throw new TakoformHostError("unsupported_capability", 422);
      }

      const relations = await resolveRelations({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        forms,
        bindings,
        store,
      });
      await validateWorkerAggregate({
        tenantId: context.tenantId,
        space: body.metadata.space,
        resourceName: body.metadata.name,
        form,
        spec: body.spec,
        relations,
        store,
      });
      await validateWorkerVersionRuntime({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        relations,
        store,
        artifacts,
        ...(options.workerModuleInspector ? { inspector: options.workerModuleInspector } : {}),
      });
      await applySqliteMigrationApplication({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        relations,
        store,
        artifacts,
        driver,
      });

      if (create) await context.beforeCreate?.();

      const opId = operationId();
      const uid = current?.metadata.uid ?? nextResourceUid(randomId);
      const receipt = await driver.apply({
        operationId: opId,
        tenantId: context.tenantId,
        resourceUid: uid,
        form,
        name: body.metadata.name,
        space: body.metadata.space,
        spec: structuredClone(body.spec),
        relations: await driverRelations(context.tenantId, body.metadata.space, relations),
        ...(context.commercialAuthority
          ? { commercialAuthority: context.commercialAuthority }
          : {}),
        ...(current ? { previous: structuredClone(current) } : {}),
      });
      const materialized = materializeResource(body, form, receipt, current, clock, uid);
      const initialMigrationCondition = await sqliteMigrationCondition({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        relations,
        store,
        artifacts,
        driver,
      });
      const initialWorkerCondition = initialMigrationCondition
        ? null
        : await workerServiceCondition({
            tenantId: context.tenantId,
            resource: materialized,
            store,
          });
      const next = withDerivedRendering(
        materialized,
        initialMigrationCondition ?? initialWorkerCondition,
        clock,
        !create,
      );
      await commit(address, next, current ?? undefined, relations);
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
      if (
        context.expectedResourceUid !== undefined &&
        current.metadata.uid !== context.expectedResourceUid
      ) {
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

      const relations = await store.readRelations(address);
      const observeId = operationId();
      const receipt = await driver.observe({
        tenantId: context.tenantId,
        resourceUid: current.metadata.uid,
        resource: structuredClone(current),
        relations: await driverRelations(context.tenantId, current.metadata.space, relations),
      });
      const observed = withObservation(current, form, receipt);
      const drift = await relationDrift({
        tenantId: context.tenantId,
        space: current.metadata.space,
        relations,
        store,
      });
      const migrationCondition = drift
        ? null
        : await sqliteMigrationCondition({
            tenantId: context.tenantId,
            space: current.metadata.space,
            form,
            relations,
            store,
            artifacts,
            driver,
          });
      const workerCondition =
        drift || migrationCondition
          ? null
          : await workerServiceCondition({ tenantId: context.tenantId, resource: observed, store });
      const next = withDerivedRendering(
        observed,
        drift ?? migrationCondition ?? workerCondition,
        clock,
      );
      await commit(address, next, current, relations);
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
        spec: canonicalizeEdgeSpec(form, materializeDefaults(form.desiredSchema, parsedBody.spec)),
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
      if (
        context.expectedResourceUid !== undefined &&
        current?.metadata.uid !== context.expectedResourceUid
      ) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      await requireArtifact(form, body.spec, context.tenantId);
      await validateWorkerBundleRuntime({
        tenantId: context.tenantId,
        form,
        spec: body.spec,
        artifacts,
        ...(options.workerModuleInspector ? { inspector: options.workerModuleInspector } : {}),
      });

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
        if (context.request.headers.has("takoform-expected-generation")) {
          throw new TakoformHostError("resource_not_found", 404);
        }
        throw new TakoformHostError();
      }
      if (current) {
        const expected = requiredExpectedGeneration(context.request);
        if (expected !== current.metadata.generation) {
          throw new TakoformHostError("generation_conflict", 412);
        }
      }

      const relations = await resolveRelations({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        forms,
        bindings,
        store,
      });
      await validateWorkerAggregate({
        tenantId: context.tenantId,
        space: body.metadata.space,
        resourceName: body.metadata.name,
        form,
        spec: body.spec,
        relations,
        store,
      });
      await validateWorkerVersionRuntime({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        relations,
        store,
        artifacts,
        ...(options.workerModuleInspector ? { inspector: options.workerModuleInspector } : {}),
      });
      await applySqliteMigrationApplication({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        relations,
        store,
        artifacts,
        driver,
      });

      const importId = operationId();
      const uid = current?.metadata.uid ?? nextResourceUid(randomId);
      const receipt = await driver.import({
        operationId: importId,
        tenantId: context.tenantId,
        resourceUid: uid,
        form,
        name: body.metadata.name,
        space: body.metadata.space,
        spec: structuredClone(body.spec),
        nativeId: body.nativeId,
        relations: await driverRelations(context.tenantId, body.metadata.space, relations),
        ...(current ? { previous: structuredClone(current) } : {}),
      });
      const materialized = materializeResource(body, form, receipt, current, clock, uid);
      const initialMigrationCondition = await sqliteMigrationCondition({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        relations,
        store,
        artifacts,
        driver,
      });
      const initialWorkerCondition = initialMigrationCondition
        ? null
        : await workerServiceCondition({
            tenantId: context.tenantId,
            resource: materialized,
            store,
          });
      const next = withDerivedRendering(
        materialized,
        initialMigrationCondition ?? initialWorkerCondition,
        clock,
        !create,
      );
      await commit(address, next, current ?? undefined, relations);
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
      let current = await store.readResource(address);
      if (replay) {
        // A delete replay is answered on the fingerprint alone: the resource it
        // removed is, by definition, no longer there to compare against.
        if (replay.fingerprint !== fingerprint) throw new TakoformHostError();
        return { kind: "deleted" };
      }
      if (!current || !sameFormRef(current.form.formRef, form.identity.formRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (
        context.expectedResourceUid !== undefined &&
        current.metadata.uid !== context.expectedResourceUid
      ) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (!form.operations.includes("delete")) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      const currentRelations = await store.readRelations(address);
      const drift = await relationDrift({
        tenantId: context.tenantId,
        space: current.metadata.space,
        relations: currentRelations,
        store,
      });
      const workerCondition = drift
        ? null
        : await workerServiceCondition({ tenantId: context.tenantId, resource: current, store });
      const rendered = withDerivedRendering(current, drift ?? workerCondition, clock);
      if (rendered.metadata.revision !== current.metadata.revision) {
        await commit(address, rendered, current, currentRelations);
        current = rendered;
      }
      if (expected !== current.metadata.generation) {
        throw new TakoformHostError("generation_conflict", 412);
      }
      const ifMatch = context.request.headers.get("if-match");
      if (ifMatch && ifMatch !== `"${current.metadata.revision}"`) {
        throw new TakoformHostError("revision_conflict", 412);
      }
      const storedHolders = await store.relationHolders(context.tenantId, current.metadata.uid);
      const externalHolders = options.blockingRelations
        ? await options.blockingRelations(context.tenantId, current.metadata.uid)
        : [];
      if (storedHolders.length > 0 || externalHolders.length > 0) {
        throw new TakoformHostError("dependency_in_use", 409);
      }
      await validateWorkerDeploymentRemoval({
        tenantId: context.tenantId,
        space,
        form,
        relations: currentRelations,
        store,
      });

      const deleteId = operationId();
      await driver.delete({
        operationId: deleteId,
        tenantId: context.tenantId,
        resourceUid: current.metadata.uid,
        resource: structuredClone(current),
        relations: await driverRelations(
          context.tenantId,
          current.metadata.space,
          currentRelations,
        ),
      });
      const removed = await store.deleteResource(address, current.metadata.revision);
      if (!removed) throw new TakoformHostError("resource_busy", 409);
      await recordOperationFor(context.tenantId)(deleteId, "delete");
      await store.putReplay(replayKey, { fingerprint, status: 204 });
      return { kind: "deleted" };
    },
  };
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
  resourceUid: string,
): TakoformStoredResource {
  // Generation tracks desired state, so it only moves when the spec does.
  const generation = current
    ? canonicalJson(current.spec) === canonicalJson(input.spec)
      ? current.metadata.generation
      : increment(current.metadata.generation)
    : "1";
  const revision = current ? increment(current.metadata.revision) : "1";
  const projection = projectReceipt(form, receipt);
  return {
    apiVersion: input.apiVersion,
    kind: input.kind,
    form: structuredClone(form.identity),
    metadata: {
      name: input.metadata.name,
      space: input.metadata.space,
      uid: resourceUid,
      generation,
      revision,
    },
    spec: structuredClone(input.spec),
    status: {
      observedGeneration: generation,
      conditions: projection.conditions ?? [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: clock().toISOString(),
        },
      ],
      ...projection,
    },
  };
}

function nextResourceUid(randomId: () => string): string {
  const raw = randomId();
  const uuidHex = raw.replaceAll("-", "");
  if (/^[0-9a-fA-F]{32}$/u.test(uuidHex)) {
    const bytes = Uint8Array.from(
      uuidHex.match(/.{2}/gu)?.map((octet) => Number.parseInt(octet, 16)) ?? [],
    );
    const encoded = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    return `uid_${encoded}`;
  }
  return `uid_${raw.replace(/[^A-Za-z0-9._-]/gu, "")}`;
}

/** An observation that changed nothing must not mint a new revision. */
function withObservation(
  current: TakoformStoredResource,
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
): TakoformStoredResource {
  const projection = projectReceipt(form, receipt);
  const candidate: TakoformStoredResource = {
    ...structuredClone(current),
    status: {
      ...structuredClone(current.status),
      ...projection,
      conditions: projection.conditions ?? structuredClone(current.status.conditions),
    },
  };
  const comparable = (value: TakoformStoredResource) =>
    canonicalJson({
      ...value,
      metadata: { ...value.metadata, revision: "" },
    });
  if (comparable(current) === comparable(candidate)) return structuredClone(current);
  return {
    ...candidate,
    metadata: { ...candidate.metadata, revision: increment(current.metadata.revision) },
  };
}

function withDerivedRendering(
  current: TakoformStoredResource,
  drift: TakoformStoredResource["status"]["conditions"][number] | null,
  clock: Clock,
  incrementRevision = true,
): TakoformStoredResource {
  if (!drift) return current;
  const previous = current.status.conditions[0];
  if (
    previous?.type === drift.type &&
    previous.status === drift.status &&
    previous.reason === drift.reason &&
    previous.hostReason === drift.hostReason
  ) {
    return current;
  }
  return {
    ...current,
    metadata: {
      ...current.metadata,
      revision: incrementRevision
        ? increment(current.metadata.revision)
        : current.metadata.revision,
    },
    status: {
      ...current.status,
      conditions: [{ ...drift, lastTransitionTime: clock().toISOString() }],
    },
  };
}

/**
 * A driver may only report what its Form declares, and it must report all of
 * it. Anything else is the Host's failure to trust, not the caller's.
 */
function projectReceipt(
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
): {
  readonly observed?: JsonObject;
  readonly outputs?: JsonObject;
  readonly conditions?: TakoformStoredResource["status"]["conditions"];
} {
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
  if (receipt.conditions && !validConditions(receipt.conditions)) {
    throw new TakoformHostError();
  }
  return {
    ...(form.observedSchema && receipt.observed
      ? { observed: structuredClone(receipt.observed) }
      : {}),
    ...(form.outputSchema && receipt.outputs ? { outputs: structuredClone(receipt.outputs) } : {}),
    ...(receipt.conditions ? { conditions: structuredClone(receipt.conditions) } : {}),
  };
}

function validConditions(conditions: TakoformStoredResource["status"]["conditions"]): boolean {
  if (conditions.length !== 1) return false;
  const condition = conditions[0];
  if (condition?.type !== "Ready") return false;
  if (!(["True", "False", "Unknown"] as const).includes(condition.status)) return false;
  if (
    !(
      [
        "Available",
        "Provisioning",
        "Reconciling",
        "Failed",
        "BackendUnavailable",
        "SpecDrift",
        "ExternalChange",
        "DependencyMissing",
        "DependencyInUse",
        "PolicyDenied",
        "UnsupportedCapability",
        "Deleting",
      ] as const
    ).includes(condition.reason)
  ) {
    return false;
  }
  if (
    condition.hostReason !== undefined &&
    (condition.hostReason.length < 1 || condition.hostReason.length > 256)
  ) {
    return false;
  }
  const transitionTime = Date.parse(condition.lastTransitionTime);
  if (
    !Number.isFinite(transitionTime) ||
    new Date(transitionTime).toISOString() !== condition.lastTransitionTime
  ) {
    return false;
  }
  return condition.message === undefined || condition.message.length > 0;
}
