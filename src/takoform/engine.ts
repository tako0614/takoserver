import { canonicalDigest, canonicalJson } from "../json.ts";
import type { Clock, JsonObject } from "../ports.ts";
import { SqlError } from "../ports.ts";
import type { TakoformArtifactManifest } from "./artifacts.ts";
import { type BindingRegistry, installedBindings } from "./bindings.ts";
import { canonicalizeEdgeSpec } from "./edge-semantics.ts";
import { exactInstalledForm, type FormRegistry, installedForms, sameFormRef } from "./forms.ts";
import type { TakoformAuthorityFence, TakoformHostAuthority } from "./host-authority.ts";
import {
  PREPARE_TTL_MILLISECONDS,
  PROVIDER_MUTATION_EXECUTION_LEASE_MILLISECONDS,
  RESOURCE_CLAIM_RESERVATION_TTL_MILLISECONDS,
} from "./limits.ts";
import {
  declaredResourceClaims,
  relationDrift,
  resolveRelations,
  type TakoformStoredRelation,
  validateDeclaredConstraintRequest,
  validateDeclaredConstraints,
} from "./relations.ts";
import { materializeDefaults, validateDesired, validateSchemaValue } from "./schema.ts";
import { applySqliteMigrationApplication, sqliteMigrationCondition } from "./sqlite-migrations.ts";
import { resolveStandardServiceSlots } from "./standard-services.ts";
import type { ResourceAddress, StoredReplay, TakoformStore } from "./store.ts";
import {
  type InstalledTakoformForm,
  type TakoformCommercialAuthority,
  type TakoformDiagnostic,
  type TakoformDriverReceipt,
  type TakoformDriverRelation,
  type TakoformFormAvailabilityResolver,
  TakoformHostError,
  type TakoformResourceDriver,
  type TakoformStandardServiceResolver,
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
  validateClassHolderRuntime,
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
  }): Promise<{
    readonly loadable: boolean;
    readonly handlers: readonly string[];
    readonly classes?: readonly string[];
  }>;
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
  readonly runtimeMaterialization?: JsonObject;
  /** Stable identity and atomic commit owned by a durable Host Operation. */
  readonly durableOperation?: {
    readonly id: string;
    readonly resourceUid: string;
    /** Lease-scoped claim owner; stale workers must not release a successor's reservation. */
    readonly claimOwnerId: string;
    readonly commit: (mutation: EngineMutationCommit) => Promise<void>;
  };
}

export type EngineMutationCommit =
  | {
      readonly kind: "write";
      readonly resourceUid: string;
      readonly operation: "create" | "update" | "import";
      readonly address: ResourceAddress;
      readonly expectedRevision: string | null;
      readonly resource: TakoformStoredResource;
      readonly relations: readonly TakoformStoredRelation[];
      readonly replayKey: string;
      readonly replay: StoredReplay;
      readonly providerReceipt?: TakoformDriverReceipt;
      readonly claimKeys?: readonly string[];
      readonly authorityFence?: TakoformAuthorityFence;
    }
  | {
      readonly kind: "delete";
      readonly resourceUid: string;
      readonly operation: "delete";
      readonly address: ResourceAddress;
      readonly expectedRevision: string;
      readonly replayKey: string;
      readonly replay: StoredReplay;
      readonly providerReceipt?: TakoformDriverReceipt;
      readonly authorityFence?: TakoformAuthorityFence;
    };

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
      readonly review: {
        readonly prepareDigest: string;
        readonly specDigest?: string;
      };
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
  /** Test/host override; normally aligned with the durable operation lease. */
  readonly providerMutationLeaseMilliseconds?: number;
  readonly workerModuleInspector?: WorkerModuleInspector;
  readonly allowBodyGenerationFence?: boolean;
  readonly allowReviewSpecDigest?: boolean;
  readonly standardServiceResolver?: TakoformStandardServiceResolver;
  /** Stable v1 defers mutation-only declared constraints until apply/import. */
  readonly stableReviewConstraintPhases?: boolean;
  readonly availability?: TakoformFormAvailabilityResolver;
  /** Durable public authority. Omitted only by the historical in-process test harness. */
  readonly authority?: TakoformHostAuthority;
  /** Every live relation that must be removed before the Resource can be deleted. */
  readonly blockingRelations?: (
    tenantId: string,
    resourceUid: string,
  ) => Promise<readonly string[]>;
}

export function createTakoformEngine(options: CreateTakoformEngineOptions): TakoformEngine {
  const { store, forms, bindings, driver, artifacts, clock, randomId } = options;
  const providerMutationLeaseMilliseconds =
    options.providerMutationLeaseMilliseconds ?? PROVIDER_MUTATION_EXECUTION_LEASE_MILLISECONDS;
  if (
    !Number.isSafeInteger(providerMutationLeaseMilliseconds) ||
    providerMutationLeaseMilliseconds < 1 ||
    providerMutationLeaseMilliseconds > 3_600_000
  ) {
    throw new TypeError("providerMutationLeaseMilliseconds must be an integer from 1 to 3600000");
  }

  type RuntimeRegistry = {
    readonly forms: FormRegistry;
    readonly bindings: BindingRegistry;
  };

  const authorityContext = (context: EngineContext, space: string) => ({
    tenantId: context.tenantId,
    principalId: context.principalId,
    space: spaceId(space),
  });

  const runtimeRegistry = async (
    context: EngineContext,
    space: string,
  ): Promise<RuntimeRegistry> => {
    if (!options.authority) return { forms, bindings };
    const catalog = await options.authority.catalog(authorityContext(context, space));
    return {
      forms: installedForms(
        catalog.forms.map((entry) => entry.form),
        "forms.takoform.com/v1",
      ),
      bindings: installedBindings(catalog.bindings),
    };
  };

  const authorizeMutation = async (
    context: EngineContext,
    operation: "create" | "update" | "import",
    space: string,
    formRef: InstalledTakoformForm["identity"]["formRef"],
  ): Promise<{ readonly form: InstalledTakoformForm; readonly fence?: TakoformAuthorityFence }> => {
    if (options.authority) {
      return options.authority.authorizeMutation({
        operation,
        context: authorityContext(context, space),
        formRef,
      });
    }
    const form = exactInstalledForm(formRef, forms);
    if (!form) throw new TakoformHostError("form_unknown", 404);
    await requireExecutable(context, form, operation === "create");
    return { form: historicalForm(form) };
  };

  const operationId = (): string => `op_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`;
  let providerMutationLeaseSequence = 0;

  const executeProviderMutation = async (input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly authorityHeadDigest?: `sha256:${string}`;
    readonly claimOwnerId?: string;
    readonly onContention?: () => void;
    readonly onDispatch?: () => void;
    readonly onReceiptReady?: () => void;
    readonly prepare?: () => Promise<void>;
    readonly execute: (mode: "initial" | "recovery") => Promise<TakoformDriverReceipt>;
  }): Promise<TakoformDriverReceipt> => {
    providerMutationLeaseSequence += 1;
    const leaseToken =
      `pmlease_${providerMutationLeaseSequence.toString(36)}_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`.slice(
        0,
        128,
      );
    const execution = await store.acquireProviderMutationExecution({
      tenantId: input.tenantId,
      operationId: input.operationId,
      resourceUid: input.resourceUid,
      leaseToken,
      leaseUntil: clock().getTime() + providerMutationLeaseMilliseconds,
    });
    if (execution.kind === "executed") return execution.receipt;
    if (execution.kind === "busy") {
      input.onContention?.();
      throw new TakoformHostError("backend_unavailable", 503);
    }
    try {
      if (execution.mode === "recovery") input.onDispatch?.();
      await input.prepare?.();
      if (execution.mode === "initial") {
        if (
          !(await store.markProviderMutationDispatch({
            tenantId: input.tenantId,
            operationId: input.operationId,
            resourceUid: input.resourceUid,
            leaseToken,
          }))
        ) {
          input.onContention?.();
          throw new TakoformHostError("resource_busy", 409);
        }
        input.onDispatch?.();
      }
      const receipt = await input.execute(execution.mode);
      input.onReceiptReady?.();
      await store.recordProviderMutationReceipt({
        tenantId: input.tenantId,
        operationId: input.operationId,
        resourceUid: input.resourceUid,
        leaseToken,
        receipt,
        ...(input.claimOwnerId ? { claimOwnerId: input.claimOwnerId } : {}),
        ...(input.authorityHeadDigest ? { authorityHeadDigest: input.authorityHeadDigest } : {}),
      });
      return receipt;
    } catch (error) {
      const released = await store.releaseProviderMutationExecution({
        tenantId: input.tenantId,
        operationId: input.operationId,
        resourceUid: input.resourceUid,
        leaseToken,
      });
      if (!released) input.onContention?.();
      throw error;
    }
  };

  const requireExecutable = async (
    context: EngineContext,
    form: InstalledTakoformForm,
    requireActivation = false,
  ): Promise<void> => {
    const availability = options.availability
      ? await options.availability.resolve({
          tenantId: context.tenantId,
          principalId: context.principalId,
          form,
        })
      : { executable: true, activated: true, availableToPrincipal: true };
    if (!availability.executable) throw new TakoformHostError("form_unavailable", 503);
    if (!availability.availableToPrincipal) throw new TakoformHostError("policy_denied", 403);
    if (requireActivation && !availability.activated) {
      throw new TakoformHostError("policy_denied", 403);
    }
  };

  const authorizeRetained = async (
    context: EngineContext,
    operation: "observe" | "delete" | "evacuate",
    resource: TakoformStoredResource,
  ): Promise<{
    readonly form: InstalledTakoformForm;
    readonly fence?: TakoformAuthorityFence;
  }> => {
    if (options.authority) {
      return options.authority.authorizeRetained({
        operation,
        context: authorityContext(context, resource.metadata.space),
        resource,
      });
    }
    const form = exactInstalledForm(resource.form.formRef, forms);
    if (!form) throw new TakoformHostError("form_unknown", 404);
    await requireExecutable(context, form);
    return { form: historicalForm(form) };
  };

  const refreshMutation = async (
    context: EngineContext,
    operation: "create" | "update" | "import",
    space: string,
    formRef: InstalledTakoformForm["identity"]["formRef"],
    accepted: { readonly fence?: TakoformAuthorityFence },
  ): Promise<{ readonly form: InstalledTakoformForm; readonly fence?: TakoformAuthorityFence }> => {
    const fresh = await authorizeMutation(context, operation, space, formRef);
    requireSameAuthority(accepted.fence, fresh.fence);
    return fresh;
  };

  const refreshRetained = async (
    context: EngineContext,
    operation: "observe" | "delete" | "evacuate",
    resource: TakoformStoredResource,
    accepted: { readonly fence?: TakoformAuthorityFence },
  ): Promise<{ readonly form: InstalledTakoformForm; readonly fence?: TakoformAuthorityFence }> => {
    const fresh = await authorizeRetained(context, operation, resource);
    requireSameAuthority(accepted.fence, fresh.fence);
    return fresh;
  };

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

  const formRefFromResourceQuery = (
    url: URL,
    path: ResourcePath,
  ): InstalledTakoformForm["identity"]["formRef"] | undefined => {
    if (
      requiredQuery(url, "group") !== path.apiVersion ||
      requiredQuery(url, "kind") !== path.kind
    ) {
      return undefined;
    }
    return {
      apiVersion: path.apiVersion,
      kind: path.kind,
      definitionVersion: requiredQuery(url, "definitionVersion"),
      schemaDigest: requiredQuery(url, "schemaDigest") as `sha256:${string}`,
    };
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

  const reserveClaims = async (input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly space: string;
    readonly name: string;
    readonly uid: string;
    readonly form: InstalledTakoformForm;
    readonly spec: JsonObject;
    readonly relations: readonly TakoformStoredRelation[];
  }): Promise<readonly string[]> => {
    const declarations = await declaredResourceClaims({
      tenantId: input.tenantId,
      space: input.space,
      form: input.form,
      spec: input.spec,
      relations: input.relations,
    });
    const keys = [...new Set(declarations.map((claim) => claim.key))].sort();
    try {
      await store.reserveResourceClaims(
        keys.map((key) => ({
          key,
          tenantId: input.tenantId,
          holderSpace: input.space,
          holderApiVersion: input.form.identity.formRef.apiVersion,
          holderKind: input.form.identity.formRef.kind,
          holderName: input.name,
          holderUid: input.uid,
          operationId: input.operationId,
        })),
        clock().getTime() + RESOURCE_CLAIM_RESERVATION_TTL_MILLISECONDS,
      );
    } catch (error) {
      if (error instanceof SqlError && error.code === "constraint") {
        throw new TakoformHostError("invalid_argument", 400);
      }
      throw error;
    }
    return keys;
  };

  /** Persists a settled mutation, refusing to overwrite a concurrent winner. */
  const commit = async (
    address: ResourceAddress,
    resource: TakoformStoredResource,
    previous: TakoformStoredResource | undefined,
    relations: readonly TakoformStoredRelation[],
    claimCommit?: {
      readonly operationId: string;
      readonly claimKeys: readonly string[];
    },
    authorityFence?: TakoformAuthorityFence,
  ): Promise<void> => {
    const written = await store.writeResource({
      address,
      resource,
      relations,
      expectedRevision: previous?.metadata.revision ?? null,
      ...(claimCommit ? { claimCommit } : {}),
      ...(authorityFence ? { authorityFence } : {}),
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
      const runtime = await runtimeRegistry(context, parsed.metadata.space);
      let form = exactInstalledForm(parsed.form.formRef, runtime.forms);
      if (!form) throw new TakoformHostError("form_unknown", 404);
      await requireExecutable(context, form);
      const requestResource: ParsedResource = {
        ...parsed,
        spec: canonicalizeEdgeSpec(form, materializeDefaults(form.desiredSchema, parsed.spec)),
      };
      const diagnostics = [...validateDesired(form, requestResource.spec)];
      if (!diagnostics.some((entry) => entry.severity === "error")) {
        try {
          validateDeclaredConstraintRequest({
            resourceName: requestResource.metadata.name,
            form,
            spec: requestResource.spec,
          });
          const reviewConstraints = form.constraints ?? [];
          const needsResolvedReview = options.stableReviewConstraintPhases
            ? reviewConstraints.some((constraint) =>
                ["acyclic", "distinctPair", "uniquePair", "sameResolvedTarget"].includes(
                  constraint.kind,
                ),
              )
            : reviewConstraints.some((constraint) =>
                [
                  "sum",
                  "orderedPair",
                  "uniqueBy",
                  "acyclic",
                  "distinctPair",
                  "uniquePair",
                  "sameResolvedTarget",
                ].includes(constraint.kind),
              );
          if (needsResolvedReview) {
            const relations = await resolveRelations({
              tenantId: context.tenantId,
              space: requestResource.metadata.space,
              form,
              spec: requestResource.spec,
              forms: runtime.forms,
              bindings: runtime.bindings,
              store,
            });
            await validateDeclaredConstraints({
              tenantId: context.tenantId,
              space: requestResource.metadata.space,
              resourceName: requestResource.metadata.name,
              form,
              spec: requestResource.spec,
              relations,
              forms: runtime.forms,
              store,
              ...(options.stableReviewConstraintPhases ? { resolvedUidOnly: true } : {}),
            });
          }
        } catch (error) {
          if (!(error instanceof TakoformHostError)) throw error;
          diagnostics.push({
            severity: "error",
            message: error.code,
          });
        }
      }
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
      await resolveStandardServiceSlots({
        tenantId: context.tenantId,
        space: requestResource.metadata.space,
        form,
        spec: requestResource.spec,
        ...(options.standardServiceResolver ? { resolver: options.standardServiceResolver } : {}),
        project: false,
      });
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
      const authority = await authorizeMutation(
        context,
        current ? "update" : "create",
        requestResource.metadata.space,
        form.identity.formRef,
      );
      form = authority.form;

      const specDigest = await canonicalDigest(requestResource.spec);
      const prepareDigest = await canonicalDigest({
        tenantId: context.tenantId,
        resource: requestResource,
        expectedGeneration: expectedGeneration ?? null,
        currentUid: current?.metadata.uid ?? null,
        authorityHeadDigest: authority.fence?.headDigest ?? null,
      });
      await store.putPrepare(
        context.tenantId,
        prepareDigest,
        {
          fingerprint: canonicalJson(requestResource),
          ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
          ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
          ...(current ? { currentUid: current.metadata.uid } : {}),
        },
        clock().getTime() + PREPARE_TTL_MILLISECONDS,
      );
      return {
        kind: "prepared",
        resource: structuredClone(requestResource),
        review: {
          prepareDigest,
          ...(options.allowReviewSpecDigest ? { specDigest } : {}),
        },
      };
    },

    async read(context, path): Promise<EngineResult> {
      exactQuery(context.url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
      const space = requiredQuery(context.url, "space");
      const address = addressFromParts(context.tenantId, space, path);
      let resource = await store.readResource(address);
      const queriedFormRef = formRefFromResourceQuery(context.url, path);
      if (!queriedFormRef) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (!resource || !sameFormRef(resource.form.formRef, queriedFormRef)) {
        const runtime = await runtimeRegistry(context, space);
        if (!exactInstalledForm(queriedFormRef, runtime.forms)) {
          throw new TakoformHostError("form_unknown", 404);
        }
        throw new TakoformHostError("resource_not_found", 404);
      }
      const authority = await authorizeRetained(context, "observe", resource);
      const form = authority.form;
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
          : await workerServiceCondition({
              tenantId: context.tenantId,
              resource,
              store,
            });
      const rendered = withDerivedRendering(
        resource,
        drift ?? migrationCondition ?? workerCondition,
        clock,
      );
      if (rendered.metadata.revision !== resource.metadata.revision) {
        const fresh = await refreshRetained(context, "observe", resource, authority);
        await commit(address, rendered, resource, relations, undefined, fresh.fence);
        resource = rendered;
      }
      return { kind: "resource", resource, status: 200 };
    },

    async apply(context, path): Promise<EngineResult> {
      const rawBodyDigest = await requestBodyDigest(context.request);
      const parsedBody = applyRequest(await jsonBody(context.request));
      const runtime = await runtimeRegistry(context, parsedBody.metadata.space);
      let form = exactInstalledForm(parsedBody.form.formRef, runtime.forms);
      if (!form || !samePathResource(parsedBody, path)) {
        throw new TakoformHostError("form_unknown", 404);
      }
      await requireExecutable(context, form);
      const body = {
        ...parsedBody,
        spec: canonicalizeEdgeSpec(form, materializeDefaults(form.desiredSchema, parsedBody.spec)),
      };
      if (
        body.review.specDigest !== undefined &&
        (!options.allowReviewSpecDigest ||
          body.review.specDigest !== (await canonicalDigest(body.spec)))
      ) {
        throw new TakoformHostError();
      }
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
      await resolveStandardServiceSlots({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        ...(options.standardServiceResolver ? { resolver: options.standardServiceResolver } : {}),
        project: false,
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
      const authority = await authorizeMutation(
        context,
        create ? "create" : "update",
        body.metadata.space,
        form.identity.formRef,
      );
      form = authority.form;
      const createIntent = context.request.headers.get("if-none-match") === "*";
      const generationHeader = context.request.headers.get("takoform-expected-generation");
      if (
        options.allowBodyGenerationFence &&
        generationHeader !== null &&
        body.expectedGeneration !== undefined &&
        generationHeader !== body.expectedGeneration
      ) {
        throw new TakoformHostError();
      }
      if (
        createIntent &&
        options.allowBodyGenerationFence &&
        (generationHeader !== null || body.expectedGeneration !== undefined)
      ) {
        throw new TakoformHostError();
      }
      if (!create && createIntent) {
        throw new TakoformHostError("generation_conflict", 412);
      }
      if (create && !createIntent) {
        if (generationHeader !== null || body.expectedGeneration !== undefined) {
          throw new TakoformHostError("resource_not_found", 404);
        }
        throw new TakoformHostError();
      }
      if (current) {
        const expected = requiredExpectedGeneration(
          context.request,
          body.expectedGeneration,
          options.allowBodyGenerationFence,
        );
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
        review.currentUid !== (current?.metadata.uid ?? undefined) ||
        review.authorityHeadDigest !== authority.fence?.headDigest
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
          ? await workerServiceCondition({
              tenantId: context.tenantId,
              resource: current,
              store,
            })
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
        const noOpId = context.durableOperation?.id ?? operationId();
        const replayRecord: StoredReplay = {
          fingerprint,
          status: 200,
          resource: current,
          boundUid: current.metadata.uid,
        };
        if (context.durableOperation) {
          await context.durableOperation.commit({
            kind: "write",
            resourceUid: current.metadata.uid,
            operation: "update",
            address,
            expectedRevision: current.metadata.revision,
            resource: current,
            relations: currentRelations,
            replayKey,
            replay: replayRecord,
            ...(authority.fence ? { authorityFence: authority.fence } : {}),
          });
        } else {
          await store.commitImmediateMutation({
            tenantId: context.tenantId,
            operationId: noOpId,
            operation: "update",
            createdAt: clock().toISOString(),
            mutation: {
              kind: "write",
              resourceUid: current.metadata.uid,
              address,
              expectedRevision: current.metadata.revision,
              resource: current,
              relations: currentRelations,
              replayKey,
              replay: replayRecord,
              ...(authority.fence ? { authorityFence: authority.fence } : {}),
            },
          });
        }
        return { kind: "resource", resource: current, status: 200 };
      }
      if (current && form.role === "revision") {
        throw new TakoformHostError("invalid_argument", 400);
      }
      if (!form.operations.includes(create ? "create" : "update") && !identicalDesired) {
        throw new TakoformHostError("unsupported_capability", 422);
      }

      validateDeclaredConstraintRequest({
        resourceName: body.metadata.name,
        form,
        spec: body.spec,
      });
      const relations = await resolveRelations({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        forms: runtime.forms,
        bindings: runtime.bindings,
        store,
      });
      await validateDeclaredConstraints({
        tenantId: context.tenantId,
        space: body.metadata.space,
        resourceName: body.metadata.name,
        form,
        spec: body.spec,
        relations,
        forms: runtime.forms,
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
      await validateClassHolderRuntime({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        relations,
        store,
        artifacts,
        ...(options.workerModuleInspector ? { inspector: options.workerModuleInspector } : {}),
      });
      const proposedOperationId = context.durableOperation?.id ?? operationId();
      const proposedResourceUid =
        current?.metadata.uid ?? context.durableOperation?.resourceUid ?? nextResourceUid(randomId);
      const saga = await store.acceptProviderMutationSaga({
        operationId: proposedOperationId,
        replayKey,
        tenantId: context.tenantId,
        fingerprint,
        resourceUid: proposedResourceUid,
        ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
        target: address,
        ...(current
          ? {
              acceptedUid: current.metadata.uid,
              acceptedGeneration: current.metadata.generation,
              acceptedRevision: current.metadata.revision,
            }
          : {}),
      });
      const opId = saga.operationId;
      const uid = saga.resourceUid;
      const claimOwnerId = context.durableOperation?.claimOwnerId ?? opId;
      let claimKeys: readonly string[];
      try {
        claimKeys = await reserveClaims({
          operationId: claimOwnerId,
          tenantId: context.tenantId,
          space: body.metadata.space,
          name: body.metadata.name,
          uid,
          form,
          spec: body.spec,
          relations,
        });
      } catch (error) {
        await store.abandonProviderMutationPlan({
          tenantId: context.tenantId,
          operationId: opId,
          replayKey,
          resourceUid: uid,
        });
        throw error;
      }
      let standardServices: Awaited<ReturnType<typeof resolveStandardServiceSlots>>;
      try {
        await applySqliteMigrationApplication({
          tenantId: context.tenantId,
          space: body.metadata.space,
          form,
          relations,
          store,
          artifacts,
          driver,
          ...(authority.fence
            ? {
                beforeSideEffect: async () => {
                  await refreshMutation(
                    context,
                    create ? "create" : "update",
                    body.metadata.space,
                    form.identity.formRef,
                    authority,
                  );
                },
              }
            : {}),
        });
        if (create) await context.beforeCreate?.();
        standardServices = await resolveStandardServiceSlots({
          tenantId: context.tenantId,
          space: body.metadata.space,
          form,
          spec: body.spec,
          ...(options.standardServiceResolver ? { resolver: options.standardServiceResolver } : {}),
          project: true,
        });
      } catch (error) {
        await store.releaseResourceClaims(claimOwnerId);
        await store.abandonProviderMutationPlan({
          tenantId: context.tenantId,
          operationId: opId,
          replayKey,
          resourceUid: uid,
        });
        throw error;
      }
      let persisted = false;
      let providerSettled = false;
      let providerDispatched = false;
      let releaseClaimsOnFailure = true;
      try {
        let preparedDriverRelations: readonly TakoformDriverRelation[] = [];
        const receipt = await executeProviderMutation({
          tenantId: context.tenantId,
          operationId: opId,
          resourceUid: uid,
          claimOwnerId,
          onContention: () => {
            releaseClaimsOnFailure = false;
          },
          onReceiptReady: () => {
            releaseClaimsOnFailure = false;
          },
          onDispatch: () => {
            providerDispatched = true;
          },
          ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
          prepare: async () => {
            preparedDriverRelations = await driverRelations(
              context.tenantId,
              body.metadata.space,
              relations,
            );
            await refreshMutation(
              context,
              create ? "create" : "update",
              body.metadata.space,
              form.identity.formRef,
              authority,
            );
          },
          execute: async (operationMode) => {
            return await driver.apply({
              operationId: opId,
              operationMode,
              tenantId: context.tenantId,
              resourceUid: uid,
              form,
              name: body.metadata.name,
              space: body.metadata.space,
              spec: structuredClone(body.spec),
              relations: preparedDriverRelations,
              atomicDeploymentCommit: true,
              ...(context.commercialAuthority
                ? { commercialAuthority: context.commercialAuthority }
                : {}),
              ...(context.runtimeMaterialization
                ? { runtimeMaterialization: context.runtimeMaterialization }
                : {}),
              ...(standardServices.length > 0 ? { standardServices } : {}),
              ...(current ? { previous: structuredClone(current) } : {}),
            });
          },
        });
        providerSettled = true;
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
        const status = create ? 201 : 200;
        const replayRecord: StoredReplay = {
          fingerprint,
          status,
          resource: next,
          boundUid: next.metadata.uid,
        };
        if (context.durableOperation) {
          await context.durableOperation.commit({
            kind: "write",
            resourceUid: uid,
            operation: create ? "create" : "update",
            address,
            expectedRevision: current?.metadata.revision ?? null,
            resource: next,
            relations,
            replayKey,
            replay: replayRecord,
            providerReceipt: receipt,
            claimKeys,
            ...(authority.fence ? { authorityFence: authority.fence } : {}),
          });
          persisted = true;
        } else {
          await store.commitImmediateMutation({
            tenantId: context.tenantId,
            operationId: opId,
            operation: create ? "create" : "update",
            createdAt: clock().toISOString(),
            mutation: {
              kind: "write",
              resourceUid: uid,
              address,
              expectedRevision: current?.metadata.revision ?? null,
              resource: next,
              relations,
              replayKey,
              replay: replayRecord,
              providerReceipt: receipt,
              ...(claimKeys.length > 0 ? { claimKeys } : {}),
              ...(authority.fence ? { authorityFence: authority.fence } : {}),
            },
          });
          persisted = true;
        }
        return { kind: "resource", resource: next, status };
      } catch (error) {
        if (!persisted && !providerSettled && releaseClaimsOnFailure) {
          await store.releaseResourceClaims(claimOwnerId);
          if (!providerDispatched) {
            await store.abandonProviderMutationPlan({
              tenantId: context.tenantId,
              operationId: opId,
              replayKey,
              resourceUid: uid,
            });
          }
        }
        throw error;
      }
    },

    async observe(context, path): Promise<EngineResult> {
      exactQuery(context.url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
      const address = addressFromParts(context.tenantId, requiredQuery(context.url, "space"), path);
      const current = await store.readResource(address);
      const queriedFormRef = formRefFromResourceQuery(context.url, path);
      if (!current || !queriedFormRef || !sameFormRef(current.form.formRef, queriedFormRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      const authority = await authorizeRetained(context, "observe", current);
      const form = authority.form;
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
      const providerRelations = await driverRelations(
        context.tenantId,
        current.metadata.space,
        relations,
      );
      const fresh = await refreshRetained(context, "observe", current, authority);
      const receipt = await driver.observe({
        tenantId: context.tenantId,
        resourceUid: current.metadata.uid,
        resource: structuredClone(current),
        relations: providerRelations,
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
          : await workerServiceCondition({
              tenantId: context.tenantId,
              resource: observed,
              store,
            });
      const next = withDerivedRendering(
        observed,
        drift ?? migrationCondition ?? workerCondition,
        clock,
      );
      await commit(address, next, current, relations, undefined, fresh.fence);
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
      const runtime = await runtimeRegistry(context, parsedBody.metadata.space);
      let form = exactInstalledForm(parsedBody.form.formRef, runtime.forms);
      if (!form || !samePathResource(parsedBody, path)) {
        throw new TakoformHostError("form_unknown", 404);
      }
      await requireExecutable(context, form);
      const body = {
        ...parsedBody,
        spec: canonicalizeEdgeSpec(form, materializeDefaults(form.desiredSchema, parsedBody.spec)),
      };
      const importProviderResource = driver.import?.bind(driver);
      if (!form.operations.includes("import") || !importProviderResource) {
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
      const authority = await authorizeMutation(
        context,
        "import",
        body.metadata.space,
        form.identity.formRef,
      );
      form = authority.form;
      await requireArtifact(form, body.spec, context.tenantId);
      await validateWorkerBundleRuntime({
        tenantId: context.tenantId,
        form,
        spec: body.spec,
        artifacts,
        ...(options.workerModuleInspector ? { inspector: options.workerModuleInspector } : {}),
      });
      await resolveStandardServiceSlots({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        ...(options.standardServiceResolver ? { resolver: options.standardServiceResolver } : {}),
        project: false,
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

      validateDeclaredConstraintRequest({
        resourceName: body.metadata.name,
        form,
        spec: body.spec,
      });
      const relations = await resolveRelations({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        forms: runtime.forms,
        bindings: runtime.bindings,
        store,
      });
      await validateDeclaredConstraints({
        tenantId: context.tenantId,
        space: body.metadata.space,
        resourceName: body.metadata.name,
        form,
        spec: body.spec,
        relations,
        forms: runtime.forms,
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
      await validateClassHolderRuntime({
        tenantId: context.tenantId,
        space: body.metadata.space,
        form,
        spec: body.spec,
        relations,
        store,
        artifacts,
        ...(options.workerModuleInspector ? { inspector: options.workerModuleInspector } : {}),
      });
      const proposedImportId = context.durableOperation?.id ?? operationId();
      const proposedResourceUid =
        current?.metadata.uid ?? context.durableOperation?.resourceUid ?? nextResourceUid(randomId);
      const saga = await store.acceptProviderMutationSaga({
        operationId: proposedImportId,
        replayKey,
        tenantId: context.tenantId,
        fingerprint,
        resourceUid: proposedResourceUid,
        ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
        target: address,
        ...(current
          ? {
              acceptedUid: current.metadata.uid,
              acceptedGeneration: current.metadata.generation,
              acceptedRevision: current.metadata.revision,
            }
          : {}),
      });
      const importId = saga.operationId;
      const uid = saga.resourceUid;
      const claimOwnerId = context.durableOperation?.claimOwnerId ?? importId;
      let claimKeys: readonly string[];
      try {
        claimKeys = await reserveClaims({
          operationId: claimOwnerId,
          tenantId: context.tenantId,
          space: body.metadata.space,
          name: body.metadata.name,
          uid,
          form,
          spec: body.spec,
          relations,
        });
      } catch (error) {
        await store.abandonProviderMutationPlan({
          tenantId: context.tenantId,
          operationId: importId,
          replayKey,
          resourceUid: uid,
        });
        throw error;
      }
      let standardServices: Awaited<ReturnType<typeof resolveStandardServiceSlots>>;
      try {
        await applySqliteMigrationApplication({
          tenantId: context.tenantId,
          space: body.metadata.space,
          form,
          relations,
          store,
          artifacts,
          driver,
          ...(authority.fence
            ? {
                beforeSideEffect: async () => {
                  await refreshMutation(
                    context,
                    "import",
                    body.metadata.space,
                    form.identity.formRef,
                    authority,
                  );
                },
              }
            : {}),
        });
        standardServices = await resolveStandardServiceSlots({
          tenantId: context.tenantId,
          space: body.metadata.space,
          form,
          spec: body.spec,
          ...(options.standardServiceResolver ? { resolver: options.standardServiceResolver } : {}),
          project: true,
        });
      } catch (error) {
        await store.releaseResourceClaims(claimOwnerId);
        await store.abandonProviderMutationPlan({
          tenantId: context.tenantId,
          operationId: importId,
          replayKey,
          resourceUid: uid,
        });
        throw error;
      }
      let persisted = false;
      let providerSettled = false;
      let providerDispatched = false;
      let releaseClaimsOnFailure = true;
      try {
        let preparedDriverRelations: readonly TakoformDriverRelation[] = [];
        const receipt = await executeProviderMutation({
          tenantId: context.tenantId,
          operationId: importId,
          resourceUid: uid,
          claimOwnerId,
          onContention: () => {
            releaseClaimsOnFailure = false;
          },
          onReceiptReady: () => {
            releaseClaimsOnFailure = false;
          },
          onDispatch: () => {
            providerDispatched = true;
          },
          ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
          prepare: async () => {
            preparedDriverRelations = await driverRelations(
              context.tenantId,
              body.metadata.space,
              relations,
            );
            await refreshMutation(
              context,
              "import",
              body.metadata.space,
              form.identity.formRef,
              authority,
            );
          },
          execute: async () => {
            return await importProviderResource({
              operationId: importId,
              tenantId: context.tenantId,
              resourceUid: uid,
              form,
              name: body.metadata.name,
              space: body.metadata.space,
              spec: structuredClone(body.spec),
              nativeId: body.nativeId,
              relations: preparedDriverRelations,
              atomicDeploymentCommit: true,
              ...(standardServices.length > 0 ? { standardServices } : {}),
              ...(current ? { previous: structuredClone(current) } : {}),
            });
          },
        });
        providerSettled = true;
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
        const status = create ? 201 : 200;
        const replayRecord: StoredReplay = {
          fingerprint,
          status,
          resource: next,
          boundUid: next.metadata.uid,
        };
        if (context.durableOperation) {
          await context.durableOperation.commit({
            kind: "write",
            resourceUid: uid,
            operation: "import",
            address,
            expectedRevision: current?.metadata.revision ?? null,
            resource: next,
            relations,
            replayKey,
            replay: replayRecord,
            providerReceipt: receipt,
            claimKeys,
            ...(authority.fence ? { authorityFence: authority.fence } : {}),
          });
          persisted = true;
        } else {
          await store.commitImmediateMutation({
            tenantId: context.tenantId,
            operationId: importId,
            operation: "import",
            createdAt: clock().toISOString(),
            mutation: {
              kind: "write",
              resourceUid: uid,
              address,
              expectedRevision: current?.metadata.revision ?? null,
              resource: next,
              relations,
              replayKey,
              replay: replayRecord,
              providerReceipt: receipt,
              ...(claimKeys.length > 0 ? { claimKeys } : {}),
              ...(authority.fence ? { authorityFence: authority.fence } : {}),
            },
          });
          persisted = true;
        }
        return { kind: "resource", resource: next, status };
      } catch (error) {
        if (!persisted && !providerSettled && releaseClaimsOnFailure) {
          await store.releaseResourceClaims(claimOwnerId);
          if (
            !providerDispatched ||
            (error instanceof TakoformHostError && error.code === "import_conflict")
          ) {
            await store.abandonProviderMutationPlan({
              tenantId: context.tenantId,
              operationId: importId,
              replayKey,
              resourceUid: uid,
            });
          }
        }
        throw error;
      }
    },

    async remove(context, path): Promise<EngineResult> {
      exactQuery(context.url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
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
      const queriedFormRef = formRefFromResourceQuery(context.url, path);
      if (!current || !queriedFormRef || !sameFormRef(current.form.formRef, queriedFormRef)) {
        throw new TakoformHostError("resource_not_found", 404);
      }
      let authority = await authorizeRetained(context, "delete", current);
      const form = authority.form;
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
        : await workerServiceCondition({
            tenantId: context.tenantId,
            resource: current,
            store,
          });
      const rendered = withDerivedRendering(current, drift ?? workerCondition, clock);
      if (rendered.metadata.revision !== current.metadata.revision) {
        const fresh = await refreshRetained(context, "delete", current, authority);
        await commit(address, rendered, current, currentRelations, undefined, fresh.fence);
        current = rendered;
        authority = await authorizeRetained(context, "delete", current);
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

      const saga = await store.acceptProviderMutationSaga({
        operationId: context.durableOperation?.id ?? operationId(),
        replayKey,
        tenantId: context.tenantId,
        fingerprint,
        resourceUid: current.metadata.uid,
        target: address,
        acceptedUid: current.metadata.uid,
        acceptedGeneration: current.metadata.generation,
        acceptedRevision: current.metadata.revision,
        ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
      });
      const deleteId = saga.operationId;
      let preparedDriverRelations: readonly TakoformDriverRelation[] = [];
      let providerDispatched = false;
      let providerContended = false;
      let receipt: TakoformDriverReceipt;
      try {
        receipt = await executeProviderMutation({
          tenantId: context.tenantId,
          operationId: deleteId,
          resourceUid: current.metadata.uid,
          claimOwnerId: context.durableOperation?.claimOwnerId ?? deleteId,
          onContention: () => {
            providerContended = true;
          },
          onDispatch: () => {
            providerDispatched = true;
          },
          ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
          prepare: async () => {
            preparedDriverRelations = await driverRelations(
              context.tenantId,
              current.metadata.space,
              currentRelations,
            );
            await refreshRetained(context, "delete", current, authority);
          },
          execute: async () => {
            return (
              (await driver.delete({
                operationId: deleteId,
                tenantId: context.tenantId,
                resourceUid: current.metadata.uid,
                resource: structuredClone(current),
                relations: preparedDriverRelations,
                atomicDeploymentCommit: true,
              })) ?? {}
            );
          },
        });
      } catch (error) {
        if (!providerDispatched && !providerContended) {
          await store.abandonProviderMutationPlan({
            tenantId: context.tenantId,
            operationId: deleteId,
            replayKey,
            resourceUid: current.metadata.uid,
          });
        }
        throw error;
      }
      const replayRecord: StoredReplay = { fingerprint, status: 204 };
      if (context.durableOperation) {
        await context.durableOperation.commit({
          kind: "delete",
          resourceUid: current.metadata.uid,
          operation: "delete",
          address,
          expectedRevision: current.metadata.revision,
          replayKey,
          replay: replayRecord,
          providerReceipt: receipt,
          ...(authority.fence ? { authorityFence: authority.fence } : {}),
        });
      } else {
        await store.commitImmediateMutation({
          tenantId: context.tenantId,
          operationId: deleteId,
          operation: "delete",
          createdAt: clock().toISOString(),
          mutation: {
            kind: "delete",
            resourceUid: current.metadata.uid,
            address,
            expectedRevision: current.metadata.revision,
            replayKey,
            replay: replayRecord,
            providerReceipt: receipt,
            ...(authority.fence ? { authorityFence: authority.fence } : {}),
          },
        });
      }
      return { kind: "deleted" };
    },
  };
}

function requireSameAuthority(
  accepted: TakoformAuthorityFence | undefined,
  fresh: TakoformAuthorityFence | undefined,
): void {
  if (accepted === undefined && fresh === undefined) return;
  if (
    accepted === undefined ||
    fresh === undefined ||
    accepted.headDigest !== fresh.headDigest ||
    canonicalJson(accepted) !== canonicalJson(fresh)
  ) {
    throw new TakoformHostError("form_unavailable", 503);
  }
}

/** Keeps the historical test harness from partially persisting an authority identity. */
function historicalForm(form: InstalledTakoformForm): InstalledTakoformForm {
  const packageDigest = form.identity.packageDigest;
  const implementationDigest = form.identity.implementationDigest;
  if (
    typeof packageDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(packageDigest) &&
    typeof implementationDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(implementationDigest)
  ) {
    return form;
  }
  return {
    ...structuredClone(form),
    identity: { formRef: structuredClone(form.identity.formRef) },
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
    metadata: {
      ...candidate.metadata,
      revision: increment(current.metadata.revision),
    },
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
