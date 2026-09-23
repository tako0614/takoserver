import { canonicalDigest, canonicalJson } from "../json.ts";
import type { LedgerHeldCharge } from "../ledger.ts";
import type { Clock, JsonObject } from "../ports.ts";
import { SqlError } from "../ports.ts";
import {
  ProviderApplyCompensationUnsupportedError,
  ProviderApplyNoEffectUnsupportedError,
  ProviderMutationCompensatedFailureError,
  ProviderMutationDefinitiveRefusalError,
  ProviderMutationRecoveryError,
  ProviderMutationWholeOperationRefusalError,
} from "../provider-driver.ts";
import {
  type AcceptedAuthoritySummary,
  assertAcceptedAuthorityGrant,
} from "./accepted-authority.ts";
import type { TakoformApplySelection } from "./apply-selection.ts";
import type { TakoformArtifactManifest } from "./artifacts.ts";
import { type BindingRegistry, installedBindings } from "./bindings.ts";
import { createResourceDependencySet, type ResourceDependencySet } from "./dependency-fence.ts";
import { canonicalizeEdgeSpec } from "./edge-semantics.ts";
import { exactInstalledForm, type FormRegistry, installedForms, sameFormRef } from "./forms.ts";
import type { TakoformAuthorityFence, TakoformHostAuthority } from "./host-authority.ts";
import { sameTakoformImportSelection, type TakoformImportSelection } from "./import-selection.ts";
import {
  PREPARE_TTL_MILLISECONDS,
  PROVIDER_MUTATION_EXECUTION_LEASE_MILLISECONDS,
  RESOURCE_CLAIM_RESERVATION_TTL_MILLISECONDS,
} from "./limits.ts";
import { receiptProjectable } from "./receipt-projection.ts";
import {
  declaredResourceClaims,
  relationDrift,
  resolveRelations,
  type TakoformStoredRelation,
  validateDeclaredConstraintRequest,
  validateDeclaredConstraints,
} from "./relations.ts";
import { materializeDefaults, validateDesired } from "./schema.ts";
import {
  applySqliteMigrationApplication,
  isSqliteMigrationApplication,
  type PreparedSqliteMigrationApplication,
  prepareSqliteMigrationApplication,
  sqliteMigrationCondition,
} from "./sqlite-migrations.ts";
import { resolveStandardServiceSlots, validateStandardServiceSlots } from "./standard-services.ts";
import type {
  ProviderMutationExecution,
  ProviderMutationSaga,
  ResourceAddress,
  ResourceEffectKind,
  StoredReplay,
  TakoformStore,
} from "./store.ts";
import {
  crossResourcePrecondition,
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
  requestBodyText,
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
import { validateClassHolderRuntime } from "./worker-runtime-contract.ts";

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

export interface EngineContext {
  readonly request: Request;
  readonly url: URL;
  readonly tenantId: string;
  readonly principalId: string;
  /**
   * Runs after every portable fence/review check and immediately before create
   * side effects. The callback is invoked before the durable dispatch marker,
   * so its owner must make the same exact request/token retry-safe: a lost
   * acknowledgement may invoke it again before the provider boundary is
   * crossed.
   */
  readonly beforeCreate?: () => Promise<void>;
  /** A paid create credential must never inherit authority over an existing incarnation. */
  readonly provisionOnly?: boolean;
  readonly expectedResourceUid?: string;
  readonly commercialAuthority?: TakoformCommercialAuthority;
  /** Private tenant-run context. It is never included in a public Resource. */
  readonly workerEndpointOriginReservationId?: string;
  /** Stable identity and atomic commit owned by a durable Host Operation. */
  readonly durableOperation?: {
    readonly id: string;
    readonly resourceUid: string;
    /** Immutable admission identity, not the latest status-rendering revision. */
    readonly acceptedRevision?: string;
    /** Authority accepted before this deferred apply crossed the Host boundary. */
    readonly acceptedAuthority?: AcceptedAuthoritySummary;
    /** Lease-scoped claim owner; stale workers must not release a successor's reservation. */
    readonly claimOwnerId: string;
    readonly commit: (mutation: EngineMutationCommit) => Promise<void>;
    readonly commitDefinitiveProviderFailure: (
      failure: EngineDefinitiveProviderFailureCommit,
    ) => Promise<boolean>;
  };
}

export interface EngineDefinitiveProviderFailureCommit {
  readonly recoveryAction?: "convergeApply" | "concludeApplyNoEffect" | "compensateApply";
  readonly saga: ProviderMutationSaga;
  readonly providerLeaseToken: string;
  readonly operation: "create" | "update";
  readonly charge?: LedgerHeldCharge;
  readonly compensation?: {
    readonly selection: TakoformApplySelection;
    readonly dependencies: ResourceDependencySet;
  };
  readonly error: {
    readonly code: string;
    readonly publicMessage?: string;
    readonly hostCode?: string;
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
      readonly providerEffect?: {
        readonly effectId: string;
        readonly kind: ResourceEffectKind;
        readonly operationMode?: "initial" | "recovery";
      };
      readonly claimKeys?: readonly string[];
      readonly dependencySet?: ResourceDependencySet;
      readonly preserveClaims?: true;
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
      readonly providerEffect?: {
        readonly effectId: string;
        readonly kind: ResourceEffectKind;
        readonly operationMode?: "initial" | "recovery";
      };
      readonly deletionTombstone?: {
        readonly operationId: string;
      };
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
  readonly allowBodyGenerationFence?: boolean;
  readonly allowReviewSpecDigest?: boolean;
  readonly standardServiceResolver?: TakoformStandardServiceResolver;
  /** Stable v1 resolves only relation-dependent declared constraints during review. */
  readonly stableReviewConstraintPhases?: boolean;
  /** Retained alpha/beta wire duplicated path group/kind in exact lifecycle queries. */
  readonly resourceQueryIncludesPathIdentity?: boolean;
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
  const resourceQueryKeys = options.resourceQueryIncludesPathIdentity
    ? (["space", "group", "kind", "definitionVersion", "schemaDigest"] as const)
    : (["space", "definitionVersion", "schemaDigest"] as const);
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
    readonly fingerprint: string;
    readonly authorityHeadDigest?: `sha256:${string}`;
    readonly claimOwnerId?: string;
    readonly dependencies?: ResourceDependencySet;
    /** Restores the exact accepted set before any recovered result is committed. */
    readonly onDependenciesAccepted?: (dependencies: ResourceDependencySet) => void;
    /** Signals that an earlier attempt already crossed the provider boundary. */
    readonly onPreviouslyDispatched?: () => void;
    readonly onContention?: () => void;
    readonly onDispatch?: (mode: "initial" | "recovery") => void | Promise<void>;
    readonly onReceiptReady?: () => void;
    /** The wallet hold and Host lifecycle settle through one store-owned batch. */
    readonly commitDefinitiveFailure?: (
      leaseToken: string,
      error:
        | ProviderMutationCompensatedFailureError
        | ProviderMutationDefinitiveRefusalError
        | ProviderMutationWholeOperationRefusalError,
    ) => Promise<boolean>;
    /** Provider-only refusal proof cannot erase an earlier mutation step. */
    readonly providerRefusalProvesWholeAttemptIdle?: () => boolean;
    readonly onDefinitiveFailureSettled?: () => void;
    /**
     * The attempt ended having provably mutated nothing.
     *
     * Raised only where the saga itself is terminalized as a precondition
     * failure: the plan is deleted, so no recovery will ever resume it, and the
     * refusal's whole meaning is that the provider did not act. That is the one
     * fact the caller's effect ledger needs in order to close its own record of
     * the attempt rather than leaving it open for a repair that will not come.
     */
    readonly onProvablyIdle?: () => void;
    readonly prepare?: (
      dependencies: ResourceDependencySet | undefined,
      mode: "initial" | "recovery",
      leaseToken: string,
      acceptedSelection?: TakoformApplySelection,
      acceptedImportSelection?: TakoformImportSelection,
    ) => Promise<void>;
    readonly settleDefinitiveImportFailure?: (
      leaseToken: string,
      outcome: "import_conflict" | "adoption_aborted",
    ) => Promise<boolean>;
    readonly execute: (
      mode: "initial" | "recovery",
      execution: Extract<ProviderMutationExecution, { readonly kind: "acquired" }>,
      leaseToken: string,
    ) => Promise<TakoformDriverReceipt>;
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
    if (execution.kind === "executed") {
      // The provider result is already durable even if restoring its accepted
      // dependency projection fails. Never treat this as an idle attempt.
      input.onPreviouslyDispatched?.();
      if (input.dependencies) {
        const acceptedDependencies = await store.readProviderMutationDependencies({
          tenantId: input.tenantId,
          resourceUid: input.resourceUid,
          operationId: input.operationId,
        });
        if (!acceptedDependencies) {
          // A receipt proves provider entry, but not which target incarnation
          // an older Host selected. Never rebuild that authority by name.
          throw new TakoformHostError("backend_unavailable", 503);
        }
        input.onDependenciesAccepted?.(acceptedDependencies);
      }
      return execution.receipt;
    }
    if (execution.kind === "busy") {
      input.onContention?.();
      throw new TakoformHostError("backend_unavailable", 503);
    }
    // This saga crossed the provider boundary on an earlier attempt. Mark that
    // fact before exact dependency restoration can fail.
    if (execution.mode === "recovery") input.onPreviouslyDispatched?.();
    let executeEntered = false;
    // The saga is marked as dispatched before the caller's effect ledger
    // callback runs.  Keep this bit separate from executeEntered so a
    // durable-marker failure can still be terminalized as a precondition
    // failure (without ever invoking the provider).
    let providerDispatchMarked = false;
    let dependencySet: ResourceDependencySet | undefined;
    let dependencyReservationOwnerId: string | undefined;
    try {
      if (input.dependencies) {
        if (execution.mode === "recovery") {
          dependencySet =
            (await store.readProviderMutationDependencies({
              tenantId: input.tenantId,
              resourceUid: input.resourceUid,
              operationId: input.operationId,
            })) ?? undefined;
          if (!dependencySet) {
            // A dispatched command accepted by an older Host has no exact
            // lifecycle snapshot to recover. Re-resolving a name here could
            // silently bind a recreated UID, so retain the saga for repair.
            throw new TakoformHostError("backend_unavailable", 503);
          }
          dependencyReservationOwnerId = input.operationId;
        } else {
          dependencySet = input.dependencies;
          dependencyReservationOwnerId = leaseToken;
          try {
            await store.reserveResourceDependencies({
              tenantId: input.tenantId,
              holderUid: input.resourceUid,
              reservationOwnerId: leaseToken,
              dependencies: dependencySet,
              expiresAt: clock().getTime() + RESOURCE_CLAIM_RESERVATION_TTL_MILLISECONDS,
            });
          } catch (error) {
            if (error instanceof SqlError && error.code === "constraint") {
              throw crossResourcePrecondition();
            }
            throw error;
          }
        }
        input.onDependenciesAccepted?.(dependencySet);
      }
      await input.prepare?.(
        dependencySet,
        execution.mode,
        leaseToken,
        execution.applySelection,
        execution.importSelection,
      );
      const marked = await store.markProviderMutationDispatch({
        tenantId: input.tenantId,
        operationId: input.operationId,
        resourceUid: input.resourceUid,
        leaseToken,
        mode: execution.mode,
        ...(dependencySet && dependencyReservationOwnerId
          ? { dependencySet, dependencyReservationOwnerId }
          : {}),
      });
      if (marked !== true) {
        if (marked === "dependency_changed") {
          throw crossResourcePrecondition();
        }
        if (execution.mode === "initial") {
          input.onContention?.();
        }
        throw new TakoformHostError("resource_busy", 409);
      }
      providerDispatchMarked = true;
      await input.onDispatch?.(execution.mode);
      executeEntered = true;
      const receipt = {
        ...(await input.execute(execution.mode, execution, leaseToken)),
        providerExecutionMode: execution.mode,
      };
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
      if (error instanceof ProviderApplyNoEffectUnsupportedError) {
        // The dedicated provider seam explicitly declined before attempting
        // its abort fence. Release this lease unchanged so the caller may
        // resume the pre-existing recovery path for that offering.
        const released = await store.releaseProviderMutationExecution({
          tenantId: input.tenantId,
          operationId: input.operationId,
          resourceUid: input.resourceUid,
          leaseToken,
        });
        if (!released) input.onContention?.();
        throw error;
      }
      const providerRefusalProvesWholeAttemptIdle =
        input.providerRefusalProvesWholeAttemptIdle?.() ?? true;
      const initialImportConflict =
        execution.mode === "initial" &&
        error instanceof TakoformHostError &&
        error.code === "import_conflict";
      const recoveryAdoptionAborted =
        execution.mode === "recovery" &&
        error instanceof ProviderMutationWholeOperationRefusalError &&
        error.action === "recoverAdopt";
      let definitiveImportFailureOutcome: "import_conflict" | "adoption_aborted" | undefined;
      if (
        executeEntered &&
        providerRefusalProvesWholeAttemptIdle &&
        input.settleDefinitiveImportFailure
      ) {
        if (initialImportConflict) definitiveImportFailureOutcome = "import_conflict";
        else if (recoveryAdoptionAborted) definitiveImportFailureOutcome = "adoption_aborted";
      }
      if (definitiveImportFailureOutcome && input.settleDefinitiveImportFailure) {
        let settled: boolean;
        try {
          settled = await input.settleDefinitiveImportFailure(
            leaseToken,
            definitiveImportFailureOutcome,
          );
        } catch (settlementError) {
          input.onContention?.();
          throw settlementError;
        }
        if (settled) {
          await store.releaseResourceDependencies({
            tenantId: input.tenantId,
            resourceUid: input.resourceUid,
            ownerId: input.operationId,
          });
          input.onProvablyIdle?.();
          throw error;
        }
        input.onContention?.();
      }
      let settledPrecondition = false;
      let settledDefinitiveFailureAtomically = false;
      const definitiveInitialRefusal =
        execution.mode === "initial" &&
        providerRefusalProvesWholeAttemptIdle &&
        error instanceof ProviderMutationDefinitiveRefusalError;
      const definitiveApplyAbort =
        execution.mode === "recovery" &&
        // Only apply installs this lifecycle settlement owner; imports and
        // deletes must never consume an apply-convergence disposition.
        input.commitDefinitiveFailure !== undefined &&
        providerRefusalProvesWholeAttemptIdle &&
        error instanceof ProviderMutationWholeOperationRefusalError &&
        (error.action === "convergeApply" || error.action === "concludeApplyNoEffect");
      const definitiveCompensation =
        execution.mode === "recovery" &&
        input.commitDefinitiveFailure !== undefined &&
        error instanceof ProviderMutationCompensatedFailureError &&
        error.action === "compensateApply";
      const definitiveRefusal =
        definitiveInitialRefusal || definitiveApplyAbort || definitiveCompensation;
      const recoveryError =
        error instanceof ProviderMutationRecoveryError
          ? error
          : executeEntered && !definitiveRefusal
            ? new ProviderMutationRecoveryError("indeterminate")
            : undefined;
      if (recoveryError) {
        const recorded = await store.recordProviderMutationOutcome({
          tenantId: input.tenantId,
          operationId: input.operationId,
          resourceUid: input.resourceUid,
          leaseToken,
          outcome: recoveryError.providerOutcome,
          ...(recoveryError.providerHandle ? { providerHandle: recoveryError.providerHandle } : {}),
        });
        if (!recorded) input.onContention?.();
      } else if (definitiveRefusal && input.commitDefinitiveFailure) {
        try {
          settledPrecondition = await input.commitDefinitiveFailure(leaseToken, error);
        } catch (settlementError) {
          input.onContention?.();
          throw settlementError;
        }
        if (settledPrecondition) {
          settledDefinitiveFailureAtomically = true;
          input.onDefinitiveFailureSettled?.();
        } else {
          input.onContention?.();
        }
      } else if (
        (execution.mode === "initial" && providerDispatchMarked && !executeEntered) ||
        (executeEntered && definitiveRefusal)
      ) {
        settledPrecondition = await store.settleProviderMutationPreconditionFailure({
          tenantId: input.tenantId,
          operationId: input.operationId,
          resourceUid: input.resourceUid,
          leaseToken,
          ...(definitiveApplyAbort && error instanceof ProviderMutationWholeOperationRefusalError
            ? { recoveryAction: error.action as "convergeApply" | "concludeApplyNoEffect" }
            : {}),
        });
        if (settledPrecondition) input.onProvablyIdle?.();
        else input.onContention?.();
      }
      if (!settledPrecondition) {
        const released = await store.releaseProviderMutationExecution({
          tenantId: input.tenantId,
          operationId: input.operationId,
          resourceUid: input.resourceUid,
          leaseToken,
        });
        if (!released) input.onContention?.();
      }
      if (!providerDispatchMarked && dependencyReservationOwnerId === leaseToken) {
        await store.releaseResourceDependencies({
          tenantId: input.tenantId,
          resourceUid: input.resourceUid,
          ownerId: leaseToken,
        });
      } else if (settledPrecondition && !settledDefinitiveFailureAtomically) {
        await store.releaseResourceDependencies({
          tenantId: input.tenantId,
          resourceUid: input.resourceUid,
          ownerId: input.operationId,
        });
      }
      throw error;
    }
  };

  /**
   * Closes the Host's own record of an attempt that provably mutated nothing.
   *
   * A create reserves an incarnation — a deletion attestation opened `live`,
   * then a `planned` and, once the saga is marked, a `dispatched` effect — all
   * before the provider is asked. A refusal that follows commits no Resource,
   * so the record described an incarnation that never existed: the attestation
   * could never be closed by a deletion that never happened, and the `apply`
   * effect stayed open for a repair that was never coming. Every later question
   * of the form "is this endpoint provably gone" reads exactly those two rows,
   * so one refusal's residue made the next repair impossible — which is how a
   * space came to be unable to create its endpoint again on a Host that had
   * been repaired.
   *
   * The effect is terminalized first, because that is a statement this Host can
   * always make truthfully once the saga is settled: the mutation did not
   * happen. Dropping the record then needs the stronger proof that the
   * incarnation produced nothing at all, and if that does not hold the settled
   * effect is still there for the repair to read.
   */
  const settleIdleAttempt = async (
    tenantId: string,
    resourceUid: string,
    effectId: string,
    kind: "apply" | "import",
  ): Promise<void> => {
    await store.recordResourceEffect({
      tenantId,
      resourceUid,
      effectId,
      kind,
      phase: "cancelled",
      operationMode: "initial",
    });
    await store.releaseUncommittedResourceIncarnation({ tenantId, resourceUid, effectId });
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
      options.resourceQueryIncludesPathIdentity &&
      (requiredQuery(url, "group") !== path.apiVersion || requiredQuery(url, "kind") !== path.kind)
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
        // Somebody else holds the declared claim. That is a fact about the
        // holder, not about this document, and it stops being true the moment
        // the holder goes.
        throw crossResourcePrecondition();
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

  /** Builds the provider projection; the dispatch batch separately fences its accepted revision. */
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
        throw crossResourcePrecondition({
          code: "resource_not_found",
          status: 404,
          details: { pointer: relation.pointer },
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

  const admitRuntimeInputs = async (input: {
    readonly context: EngineContext;
    readonly form: InstalledTakoformForm;
    readonly space: string;
    readonly spec: JsonObject;
    readonly relations: readonly TakoformStoredRelation[];
  }): Promise<void> => {
    const required = input.spec.requiredSensitiveVars;
    if (!Array.isArray(required) || required.length === 0) return;
    const policy = driver.runtimeInputPolicy;
    if (!policy) throw new TakoformHostError("unsupported_capability", 422);
    await policy.admit({
      tenantId: input.context.tenantId,
      form: input.form,
      spec: input.spec,
      relations: await driverRelations(input.context.tenantId, input.space, input.relations),
      ...(input.context.commercialAuthority
        ? { commercialAuthority: input.context.commercialAuthority }
        : {}),
    });
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
      let declaredConstraintError: TakoformHostError | undefined;
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
                ["claim", "acyclic", "distinctPair", "uniquePair", "sameResolvedTarget"].includes(
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
              ...(options.stableReviewConstraintPhases ? { reviewPhaseOnly: true } : {}),
            });
          }
        } catch (error) {
          if (!(error instanceof TakoformHostError)) throw error;
          declaredConstraintError = error;
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
        if (declaredConstraintError) throw declaredConstraintError;
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
      exactQuery(context.url, resourceQueryKeys);
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
      // Read before the original stream is consumed. This is the value-free
      // identity a sensitive runtime-input claim is fenced against: the
      // preparation committed to one exact apply, and only the request actually
      // executing can prove it is that one.
      const rawBodyText = await requestBodyText(context.request);
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
      const hasApplyServiceSlots =
        validateStandardServiceSlots({ form, spec: body.spec }).length > 0;

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
      let authority = await authorizeMutation(
        context,
        create ? "create" : "update",
        body.metadata.space,
        form.identity.formRef,
      );
      if (context.durableOperation?.acceptedAuthority) {
        try {
          assertAcceptedAuthorityGrant({
            summary: context.durableOperation.acceptedAuthority,
            lifecycleOperation: create ? "create" : "update",
            formRef: form.identity.formRef,
            grant: authority,
          });
        } catch {
          throw new TakoformHostError("form_unavailable", 503);
        }
      }
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

      const proposedOperationId = context.durableOperation?.id ?? operationId();
      const proposedResourceUid =
        current?.metadata.uid ?? context.durableOperation?.resourceUid ?? nextResourceUid(randomId);
      const acceptedSagaAuthorityHeadDigest = sagaAuthorityHeadDigest(
        context.durableOperation?.acceptedAuthority,
        authority.fence,
      );
      const proposedSaga = {
        operationId: proposedOperationId,
        operationKind: "apply" as const,
        replayKey,
        tenantId: context.tenantId,
        fingerprint,
        resourceUid: proposedResourceUid,
        ...(acceptedSagaAuthorityHeadDigest
          ? {
              authorityHeadDigest: acceptedSagaAuthorityHeadDigest,
            }
          : {}),
        target: address,
        ...(current
          ? {
              acceptedUid: current.metadata.uid,
              acceptedGeneration: current.metadata.generation,
              acceptedRevision: current.metadata.revision,
            }
          : {}),
      };
      // The saga row is created only after the initial prepare review below
      // succeeds. On a dispatched recovery it is therefore the durable exact
      // command authority; an expired short-lived prepare must not strand the
      // external mutation. Mismatched saga identity fails closed in the store.
      const establishedSaga =
        context.durableOperation !== undefined &&
        (await store.establishedProviderMutationSaga(proposedSaga));

      // An accepted create whose original provider acknowledgement was lost
      // may no longer satisfy today's mutable relation/readiness projection.
      // Route only the exact persisted no-handle/indeterminate state around
      // those checks. The authoritative selection is restored below under the
      // current saga lease; this read-only predicate conveys no placement or
      // provider authority of its own.
      const applyNoEffectCandidate =
        establishedSaga &&
        create &&
        context.durableOperation !== undefined &&
        (driver.concludeApplyNoEffect !== undefined || driver.compensateApply !== undefined) &&
        !hasApplyServiceSlots &&
        !isSqliteMigrationApplication(form) &&
        (await store.isProviderMutationApplyNoEffectCandidate({
          tenantId: context.tenantId,
          operationId: proposedOperationId,
          resourceUid: proposedResourceUid,
        }));
      if (applyNoEffectCandidate) {
        const durableOperation = context.durableOperation;
        const concludeApplyNoEffect = driver.concludeApplyNoEffect;
        if (!durableOperation) {
          throw new ProviderMutationRecoveryError("indeterminate");
        }

        const compensateApply = driver.compensateApply;
        let applySelection: TakoformApplySelection | undefined;
        let compensationDependencies: ResourceDependencySet | undefined;
        let providerProvablyIdle = false;
        try {
          // A concurrently recorded receipt is returned here and then consumed
          // by the ordinary path below. Only a current leased, receipt-less
          // recovery can enter the conclusion capability.
          await executeProviderMutation({
            tenantId: context.tenantId,
            operationId: proposedOperationId,
            resourceUid: proposedResourceUid,
            fingerprint,
            claimOwnerId: durableOperation.claimOwnerId,
            providerRefusalProvesWholeAttemptIdle: () => true,
            onProvablyIdle: () => {
              providerProvablyIdle = true;
            },
            ...(acceptedSagaAuthorityHeadDigest
              ? { authorityHeadDigest: acceptedSagaAuthorityHeadDigest }
              : {}),
            prepare: async (_dependencies, mode, leaseToken, acceptedSelection) => {
              if (mode !== "recovery" || !acceptedSelection) {
                throw new ProviderMutationRecoveryError("indeterminate");
              }
              const boundSelection = await store.bindProviderMutationApplySelection({
                tenantId: context.tenantId,
                operationId: proposedOperationId,
                resourceUid: proposedResourceUid,
                fingerprint,
                leaseToken,
                mode,
                selection: acceptedSelection,
              });
              if (!boundSelection) throw new ProviderMutationRecoveryError("indeterminate");
              applySelection = boundSelection;
            },
            commitDefinitiveFailure: async (providerLeaseToken, error) => {
              if (error instanceof ProviderMutationCompensatedFailureError) {
                if (!applySelection || !compensationDependencies) {
                  throw new ProviderMutationRecoveryError("indeterminate");
                }
                return await durableOperation.commitDefinitiveProviderFailure({
                  saga: proposedSaga,
                  providerLeaseToken,
                  operation: "create",
                  recoveryAction: "compensateApply",
                  compensation: {
                    selection: applySelection,
                    dependencies: compensationDependencies,
                  },
                  ...(error.heldCharge ? { charge: error.heldCharge } : {}),
                  error: {
                    code: error.code,
                    ...(error.publicMessage ? { publicMessage: error.publicMessage } : {}),
                    ...(error.hostCode ? { hostCode: error.hostCode } : {}),
                  },
                });
              }
              return await durableOperation.commitDefinitiveProviderFailure({
                saga: proposedSaga,
                providerLeaseToken,
                operation: "create",
                recoveryAction: "concludeApplyNoEffect",
                ...(error.heldCharge ? { charge: error.heldCharge } : {}),
                error: {
                  code: error.code,
                  ...(error.publicMessage ? { publicMessage: error.publicMessage } : {}),
                  ...(error.hostCode ? { hostCode: error.hostCode } : {}),
                },
              });
            },
            execute: async (mode, execution, leaseToken) => {
              if (mode !== "recovery" || !applySelection) {
                throw new ProviderMutationRecoveryError(
                  execution.providerOutcome === "running" ? "running" : "indeterminate",
                  execution.providerHandle,
                );
              }
              // The cheap candidate read may race a newly recorded handle.
              // Nothing on the conclusion seam has run yet, so hand this
              // exact leased state back to the existing poll/convergence path.
              if (
                execution.providerHandle !== undefined ||
                execution.providerOutcome === "running"
              ) {
                throw new ProviderApplyNoEffectUnsupportedError();
              }
              if (execution.providerOutcome !== "indeterminate") {
                throw new ProviderMutationRecoveryError("indeterminate");
              }
              // Provider-only proof cannot cover Host or extension work that
              // may have happened before the original provider invocation.
              // Treat these accepted selections as pre-attempt unsupported so
              // the shipped apply/convergence path performs its own callback
              // and reservation handling. This check is under the current
              // saga lease and precedes any conclusion/provider/ledger call.
              if (
                context.workerEndpointOriginReservationId !== undefined ||
                form.identity.formRef.kind === "WorkerEndpoint" ||
                (applySelection.kind === "provider" &&
                  applySelection.relations.some((relation) => relation.bindingRef !== undefined))
              ) {
                throw new ProviderApplyNoEffectUnsupportedError();
              }
              const recoveryInput = {
                operationId: proposedOperationId,
                executionAuthority: {
                  tenantId: context.tenantId,
                  resourceUid: proposedResourceUid,
                  leaseToken,
                  fingerprint,
                },
                tenantId: context.tenantId,
                resourceUid: proposedResourceUid,
                form,
                name: body.metadata.name,
                space: body.metadata.space,
                selection: applySelection,
                ...(context.commercialAuthority
                  ? { commercialAuthority: context.commercialAuthority }
                  : {}),
              } as const;
              if (concludeApplyNoEffect) {
                try {
                  await concludeApplyNoEffect(recoveryInput);
                } catch (error) {
                  if (!(error instanceof ProviderApplyNoEffectUnsupportedError)) throw error;
                }
              }
              if (!compensateApply) throw new ProviderApplyNoEffectUnsupportedError();
              const dependencyStatus = await store.providerMutationDependencyStatus({
                tenantId: context.tenantId,
                operationId: proposedOperationId,
                resourceUid: proposedResourceUid,
                leaseToken,
              });
              if (dependencyStatus === "current") {
                throw new ProviderApplyNoEffectUnsupportedError();
              }
              if (dependencyStatus === null) {
                throw new ProviderMutationRecoveryError("indeterminate");
              }
              compensationDependencies =
                (await store.readProviderMutationDependencies({
                  tenantId: context.tenantId,
                  resourceUid: proposedResourceUid,
                  operationId: proposedOperationId,
                })) ?? undefined;
              if (!compensationDependencies) {
                throw new ProviderMutationRecoveryError("indeterminate");
              }
              try {
                await compensateApply(recoveryInput);
              } catch (error) {
                if (error instanceof ProviderApplyCompensationUnsupportedError) {
                  throw new ProviderApplyNoEffectUnsupportedError();
                }
                throw error;
              }
              // The capability never returns success. A return is
              // inconclusive and therefore keeps the accepted operation held.
              throw new ProviderMutationRecoveryError("indeterminate");
            },
          });
        } catch (error) {
          if (!(error instanceof ProviderApplyNoEffectUnsupportedError)) {
            if (providerProvablyIdle) {
              await store.releaseResourceClaims(durableOperation.claimOwnerId);
              await settleIdleAttempt(
                context.tenantId,
                proposedResourceUid,
                proposedOperationId,
                "apply",
              );
            }
            throw error;
          }
        }
        // An explicit pre-attempt unsupported result continues into the
        // original validation and convergence path below.
      }
      if (!establishedSaga) {
        const review = await store.readPrepare(context.tenantId, body.review.prepareDigest);
        const reviewAuthorityHeadDigest =
          context.durableOperation?.acceptedAuthority?.mode === "mutation"
            ? context.durableOperation.acceptedAuthority.headDigest
            : authority.fence?.headDigest;
        if (
          !review ||
          review.fingerprint !== canonicalJson(stripApplyReview(body)) ||
          review.expectedGeneration !== (current?.metadata.generation ?? undefined) ||
          review.currentUid !== (current?.metadata.uid ?? undefined) ||
          review.authorityHeadDigest !== reviewAuthorityHeadDigest
        ) {
          throw new TakoformHostError();
        }
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
            preserveClaims: true,
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
              preserveClaims: true,
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
      await admitRuntimeInputs({
        context,
        form,
        space: body.metadata.space,
        spec: body.spec,
        relations,
      });
      validateClassHolderRuntime(form);
      const saga = await store.acceptProviderMutationSaga(proposedSaga);
      const opId = saga.operationId;
      const uid = saga.resourceUid;
      const claimOwnerId = context.durableOperation?.claimOwnerId ?? opId;
      let claimKeys: readonly string[];
      let dependencySet: ResourceDependencySet;
      try {
        dependencySet = await createResourceDependencySet({
          tenantId: context.tenantId,
          space: body.metadata.space,
          holderUid: uid,
          operationId: opId,
          relations,
        });
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
      let standardServices: Awaited<ReturnType<typeof resolveStandardServiceSlots>> | undefined;
      if (
        !(await store.reserveResourceIncarnation({
          tenantId: context.tenantId,
          resourceUid: uid,
          address,
          formRef: form.identity.formRef,
        }))
      ) {
        await store.releaseResourceClaims(claimOwnerId);
        await store.abandonProviderMutationPlan({
          tenantId: context.tenantId,
          operationId: opId,
          replayKey,
          resourceUid: uid,
        });
        throw new TakoformHostError("resource_busy", 409);
      }
      let persisted = false;
      let providerSettled = false;
      let providerDispatched = false;
      let providerProvablyIdle = false;
      let providerPlanRecorded = false;
      let releaseClaimsOnFailure = true;
      try {
        let preparedDriverRelations: readonly TakoformDriverRelation[] = [];
        let acceptedRelations = relations;
        let preparedMigration: PreparedSqliteMigrationApplication | null = null;
        let applySelection: TakoformApplySelection | undefined;
        const receipt = await executeProviderMutation({
          tenantId: context.tenantId,
          operationId: opId,
          resourceUid: uid,
          fingerprint,
          claimOwnerId,
          dependencies: dependencySet,
          onDependenciesAccepted: (acceptedDependencies) => {
            dependencySet = acceptedDependencies;
            acceptedRelations = acceptedDependencies.relations;
          },
          onPreviouslyDispatched: () => {
            providerDispatched = true;
            releaseClaimsOnFailure = false;
          },
          onContention: () => {
            releaseClaimsOnFailure = false;
          },
          onReceiptReady: () => {
            releaseClaimsOnFailure = false;
          },
          onDefinitiveFailureSettled: () => {
            providerSettled = true;
          },
          onProvablyIdle: () => {
            providerProvablyIdle = true;
            releaseClaimsOnFailure = true;
          },
          providerRefusalProvesWholeAttemptIdle: () =>
            preparedMigration === null && !hasApplyServiceSlots,
          onDispatch: async (operationMode) => {
            if (
              !(await store.recordResourceEffect({
                tenantId: context.tenantId,
                resourceUid: uid,
                effectId: opId,
                kind: "apply",
                phase: "dispatched",
                operationMode,
              }))
            ) {
              throw new TakoformHostError("resource_busy", 409);
            }
            providerDispatched = true;
          },
          ...(acceptedSagaAuthorityHeadDigest
            ? {
                authorityHeadDigest: acceptedSagaAuthorityHeadDigest,
              }
            : {}),
          prepare: async (acceptedDependencies, executionMode, leaseToken, acceptedSelection) => {
            if (!acceptedDependencies) throw new TakoformHostError("backend_unavailable", 503);
            preparedDriverRelations = await driverRelations(
              context.tenantId,
              body.metadata.space,
              acceptedRelations,
            );
            const resolvedSelection = await driver.selectApply({
              tenantId: context.tenantId,
              resourceUid: uid,
              form,
              name: body.metadata.name,
              space: body.metadata.space,
              spec: structuredClone(body.spec),
              relations: preparedDriverRelations,
              ...(context.commercialAuthority
                ? { commercialAuthority: context.commercialAuthority }
                : {}),
              ...(current ? { previous: structuredClone(current) } : {}),
            });
            const currentSelection =
              executionMode === "recovery"
                ? acceptedSelection &&
                  canonicalJson(resolvedSelection) === canonicalJson(acceptedSelection)
                  ? acceptedSelection
                  : undefined
                : resolvedSelection;
            if (!currentSelection) throw new TakoformHostError("resource_busy", 409);
            const boundSelection = await store.bindProviderMutationApplySelection({
              tenantId: context.tenantId,
              operationId: opId,
              resourceUid: uid,
              fingerprint,
              leaseToken,
              mode: executionMode,
              selection: currentSelection,
            });
            if (!boundSelection) throw new TakoformHostError("resource_busy", 409);
            applySelection = boundSelection;
            if (
              !(await store.recordResourceEffect({
                tenantId: context.tenantId,
                resourceUid: uid,
                effectId: opId,
                kind: "apply",
                phase: "planned",
                operationMode: executionMode,
              }))
            ) {
              throw new TakoformHostError("resource_busy", 409);
            }
            providerPlanRecorded = true;
            preparedMigration = await prepareSqliteMigrationApplication({
              tenantId: context.tenantId,
              space: body.metadata.space,
              form,
              relations: acceptedRelations,
              store,
              artifacts,
              driver,
            });
            // Satisfiability is pure pre-dispatch preparation. Completed
            // receipts and recovered commands must not depend on a resolver or
            // project fresh runtime material.
            if (executionMode === "initial") {
              await resolveStandardServiceSlots({
                tenantId: context.tenantId,
                space: body.metadata.space,
                form,
                spec: body.spec,
                ...(options.standardServiceResolver
                  ? { resolver: options.standardServiceResolver }
                  : {}),
                project: false,
              });
              if (create && context.beforeCreate) {
                await context.beforeCreate();
              }
            }
            authority = await refreshMutation(
              context,
              create ? "create" : "update",
              body.metadata.space,
              form.identity.formRef,
              authority,
            );
          },
          commitDefinitiveFailure: async (providerLeaseToken, error) => {
            const failure = {
              saga,
              providerLeaseToken,
              operation: create ? ("create" as const) : ("update" as const),
              ...(error.heldCharge ? { charge: error.heldCharge } : {}),
              ...(error instanceof ProviderMutationWholeOperationRefusalError &&
              (error.action === "convergeApply" || error.action === "concludeApplyNoEffect")
                ? { recoveryAction: error.action }
                : {}),
            };
            if (context.durableOperation) {
              return await context.durableOperation.commitDefinitiveProviderFailure({
                ...failure,
                error: {
                  code: error.code,
                  ...(error.publicMessage ? { publicMessage: error.publicMessage } : {}),
                  ...(error.hostCode ? { hostCode: error.hostCode } : {}),
                },
              });
            }
            return await store.commitDefinitiveProviderMutationFailure({
              ...failure,
              claimOwnerId,
              hostOperation: { kind: "immediate", createdAt: clock().toISOString() },
            });
          },
          execute: async (operationMode, execution, leaseToken) => {
            if (!applySelection) throw new TakoformHostError("backend_unavailable", 503);
            // Material projection is deliberately after the durable dispatch
            // marker. If acknowledgement is lost, the saga remains a repair
            // unit and recovery never issues a second projection.
            if (operationMode === "initial") {
              standardServices = await resolveStandardServiceSlots({
                tenantId: context.tenantId,
                space: body.metadata.space,
                form,
                spec: body.spec,
                ...(options.standardServiceResolver
                  ? { resolver: options.standardServiceResolver }
                  : {}),
                project: true,
              });
            }
            const executionAuthority = {
              tenantId: context.tenantId,
              resourceUid: uid,
              leaseToken,
              fingerprint,
            } as const;
            await applySqliteMigrationApplication({
              tenantId: context.tenantId,
              operationId: opId,
              operationMode,
              executionAuthority,
              prepared: preparedMigration,
              driver,
              selection: applySelection,
            });
            return await driver.apply({
              operationId: opId,
              operationKey: idempotencyKey(context.request),
              ...(createIntent
                ? {
                    publicApply: {
                      method: context.request.method,
                      path: `${context.url.pathname}${context.url.search}`,
                      ifNoneMatch: "*",
                      body: rawBodyText,
                    },
                  }
                : {}),
              operationMode,
              ...(execution.providerHandle ? { providerHandle: execution.providerHandle } : {}),
              executionAuthority,
              tenantId: context.tenantId,
              resourceUid: uid,
              form,
              name: body.metadata.name,
              space: body.metadata.space,
              spec: structuredClone(body.spec),
              desiredGeneration: incomingDesiredGeneration(body, current),
              relations: preparedDriverRelations,
              selection: applySelection,
              atomicDeploymentCommit: true,
              ...(context.commercialAuthority
                ? { commercialAuthority: context.commercialAuthority }
                : {}),
              ...(create && context.workerEndpointOriginReservationId
                ? {
                    workerEndpointOriginReservationId: context.workerEndpointOriginReservationId,
                  }
                : {}),
              ...(standardServices && standardServices.length > 0 ? { standardServices } : {}),
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
          relations: acceptedRelations,
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
            relations: acceptedRelations,
            replayKey,
            replay: replayRecord,
            providerReceipt: receipt,
            providerEffect: {
              effectId: opId,
              kind: "apply",
              operationMode: receipt.providerExecutionMode ?? "initial",
            },
            claimKeys,
            dependencySet,
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
              relations: acceptedRelations,
              replayKey,
              replay: replayRecord,
              providerReceipt: receipt,
              providerEffect: {
                effectId: opId,
                kind: "apply",
                operationMode: receipt.providerExecutionMode ?? "initial",
              },
              ...(claimKeys.length > 0 ? { claimKeys } : {}),
              dependencySet,
              ...(authority.fence ? { authorityFence: authority.fence } : {}),
            },
          });
          persisted = true;
        }
        return { kind: "resource", resource: next, status };
      } catch (error) {
        if (!persisted && !providerSettled && releaseClaimsOnFailure) {
          let idle = providerProvablyIdle;
          if (!providerDispatched && !idle) {
            idle = await store.abandonProviderMutationPlan({
              tenantId: context.tenantId,
              operationId: opId,
              replayKey,
              resourceUid: uid,
            });
          }
          if (idle) {
            await store.releaseResourceClaims(claimOwnerId);
            if (providerPlanRecorded) {
              await settleIdleAttempt(context.tenantId, uid, opId, "apply");
            } else {
              await store.releaseUncommittedResourceIncarnation({
                tenantId: context.tenantId,
                resourceUid: uid,
                effectId: opId,
              });
            }
          }
        }
        throw error;
      }
    },

    async observe(context, path): Promise<EngineResult> {
      exactQuery(context.url, resourceQueryKeys);
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
      const selectImport = driver.selectImport?.bind(driver);
      if (!form.operations.includes("import") || !importProviderResource || !selectImport) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      const hasImportServiceSlots =
        validateStandardServiceSlots({ form, spec: body.spec }).length > 0;
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
      validateStandardServiceSlots({ form, spec: body.spec });

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
      await admitRuntimeInputs({
        context,
        form,
        space: body.metadata.space,
        spec: body.spec,
        relations,
      });
      validateClassHolderRuntime(form);
      const proposedImportId = context.durableOperation?.id ?? operationId();
      const proposedResourceUid =
        current?.metadata.uid ?? context.durableOperation?.resourceUid ?? nextResourceUid(randomId);
      const saga = await store.acceptProviderMutationSaga({
        operationId: proposedImportId,
        operationKind: "import",
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
      let dependencySet: ResourceDependencySet;
      try {
        dependencySet = await createResourceDependencySet({
          tenantId: context.tenantId,
          space: body.metadata.space,
          holderUid: uid,
          operationId: importId,
          relations,
        });
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
      let standardServices: Awaited<ReturnType<typeof resolveStandardServiceSlots>> | undefined;
      if (
        !(await store.reserveResourceIncarnation({
          tenantId: context.tenantId,
          resourceUid: uid,
          address,
          formRef: form.identity.formRef,
        }))
      ) {
        const abandoned = await store.abandonProviderMutationPlan({
          tenantId: context.tenantId,
          operationId: importId,
          replayKey,
          resourceUid: uid,
        });
        if (abandoned) await store.releaseResourceClaims(claimOwnerId);
        throw new TakoformHostError("resource_busy", 409);
      }
      if (
        !(await store.recordResourceEffect({
          tenantId: context.tenantId,
          resourceUid: uid,
          effectId: importId,
          kind: "import",
          phase: "planned",
          operationMode: "initial",
        }))
      ) {
        throw new TakoformHostError("resource_busy", 409);
      }
      let persisted = false;
      let providerSettled = false;
      let providerDispatched = false;
      let providerProvablyIdle = false;
      let releaseClaimsOnFailure = true;
      try {
        let preparedDriverRelations: readonly TakoformDriverRelation[] = [];
        let acceptedRelations = relations;
        let preparedMigration: PreparedSqliteMigrationApplication | null = null;
        let importSelection: TakoformImportSelection | undefined;
        const receipt = await executeProviderMutation({
          tenantId: context.tenantId,
          operationId: importId,
          resourceUid: uid,
          fingerprint,
          claimOwnerId,
          dependencies: dependencySet,
          onDependenciesAccepted: (acceptedDependencies) => {
            dependencySet = acceptedDependencies;
            acceptedRelations = acceptedDependencies.relations;
          },
          onPreviouslyDispatched: () => {
            providerDispatched = true;
            releaseClaimsOnFailure = false;
          },
          onContention: () => {
            releaseClaimsOnFailure = false;
          },
          onReceiptReady: () => {
            releaseClaimsOnFailure = false;
          },
          onProvablyIdle: () => {
            providerProvablyIdle = true;
            releaseClaimsOnFailure = true;
          },
          providerRefusalProvesWholeAttemptIdle: () =>
            preparedMigration === null && !hasImportServiceSlots,
          onDispatch: async (operationMode) => {
            if (
              !(await store.recordResourceEffect({
                tenantId: context.tenantId,
                resourceUid: uid,
                effectId: importId,
                kind: "import",
                phase: "dispatched",
                operationMode,
              }))
            ) {
              throw new TakoformHostError("resource_busy", 409);
            }
            providerDispatched = true;
          },
          ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
          prepare: async (
            acceptedDependencies,
            executionMode,
            leaseToken,
            _acceptedApplySelection,
            acceptedImportSelection,
          ) => {
            if (!acceptedDependencies) throw new TakoformHostError("backend_unavailable", 503);
            preparedDriverRelations = await driverRelations(
              context.tenantId,
              body.metadata.space,
              acceptedRelations,
            );
            const resolvedSelection = await selectImport({
              tenantId: context.tenantId,
              resourceUid: uid,
              form,
              name: body.metadata.name,
              space: body.metadata.space,
              spec: structuredClone(body.spec),
              nativeId: body.nativeId,
              relations: preparedDriverRelations,
              ...(current ? { previous: structuredClone(current) } : {}),
            });
            // Even an undispatched retry can already have accepted placement.
            // Never overwrite it; historical dispatched NULL cannot be filled.
            if (
              resolvedSelection.nativeId !== body.nativeId ||
              (executionMode === "recovery" && !acceptedImportSelection) ||
              (acceptedImportSelection &&
                !sameTakoformImportSelection(resolvedSelection, acceptedImportSelection))
            ) {
              throw new TakoformHostError("resource_busy", 409);
            }
            preparedMigration = await prepareSqliteMigrationApplication({
              tenantId: context.tenantId,
              space: body.metadata.space,
              form,
              relations: acceptedRelations,
              store,
              artifacts,
              driver,
            });
            await refreshMutation(
              context,
              "import",
              body.metadata.space,
              form.identity.formRef,
              authority,
            );
            const boundSelection = await store.bindProviderMutationImportSelection({
              tenantId: context.tenantId,
              operationId: importId,
              resourceUid: uid,
              fingerprint,
              leaseToken,
              mode: executionMode,
              selection: acceptedImportSelection ?? resolvedSelection,
            });
            if (!boundSelection) throw new TakoformHostError("resource_busy", 409);
            importSelection = boundSelection;
          },
          settleDefinitiveImportFailure: async (leaseToken, outcome) => {
            return await store.settleDefinitiveProviderImportFailure({
              tenantId: context.tenantId,
              operationId: importId,
              replayKey,
              resourceUid: uid,
              leaseToken,
              outcome,
            });
          },
          execute: async (operationMode, execution, leaseToken) => {
            if (!importSelection) throw new TakoformHostError("resource_busy", 409);
            // A resolver can issue material. Cross the durable dispatch fence
            // first so an uncertain projection is never erased as idle prep.
            // Recovery does not issue fresh material or infer prior absence.
            if (operationMode === "initial") {
              standardServices = await resolveStandardServiceSlots({
                tenantId: context.tenantId,
                space: body.metadata.space,
                form,
                spec: body.spec,
                ...(options.standardServiceResolver
                  ? { resolver: options.standardServiceResolver }
                  : {}),
                project: true,
              });
            }
            const executionAuthority = {
              tenantId: context.tenantId,
              resourceUid: uid,
              leaseToken,
              fingerprint,
            } as const;
            await applySqliteMigrationApplication({
              tenantId: context.tenantId,
              operationId: importId,
              operationMode,
              executionAuthority,
              prepared: preparedMigration,
              driver,
              selection: importSelection,
            });
            return await importProviderResource({
              selection: importSelection,
              operationId: importId,
              operationMode,
              ...(execution.providerHandle ? { providerHandle: execution.providerHandle } : {}),
              executionAuthority,
              tenantId: context.tenantId,
              resourceUid: uid,
              form,
              name: body.metadata.name,
              space: body.metadata.space,
              spec: structuredClone(body.spec),
              nativeId: body.nativeId,
              relations: preparedDriverRelations,
              atomicDeploymentCommit: true,
              ...(standardServices && standardServices.length > 0 ? { standardServices } : {}),
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
          relations: acceptedRelations,
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
            relations: acceptedRelations,
            replayKey,
            replay: replayRecord,
            providerReceipt: receipt,
            providerEffect: {
              effectId: importId,
              kind: "import",
              operationMode: receipt.providerExecutionMode ?? "initial",
            },
            claimKeys,
            dependencySet,
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
              relations: acceptedRelations,
              replayKey,
              replay: replayRecord,
              providerReceipt: receipt,
              providerEffect: {
                effectId: importId,
                kind: "import",
                operationMode: receipt.providerExecutionMode ?? "initial",
              },
              ...(claimKeys.length > 0 ? { claimKeys } : {}),
              dependencySet,
              ...(authority.fence ? { authorityFence: authority.fence } : {}),
            },
          });
          persisted = true;
        }
        return { kind: "resource", resource: next, status };
      } catch (error) {
        if (!persisted && !providerSettled && releaseClaimsOnFailure) {
          let idle = providerProvablyIdle;
          if (!providerDispatched && !idle) {
            idle = await store.abandonProviderMutationPlan({
              tenantId: context.tenantId,
              operationId: importId,
              replayKey,
              resourceUid: uid,
            });
          }
          // The guarded delete is also the ACK-loss readback: a bound import
          // remains a repair unit, even when this invocation saw no bind result.
          if (idle) {
            await store.releaseResourceClaims(claimOwnerId);
            await settleIdleAttempt(context.tenantId, uid, importId, "import");
          }
        }
        throw error;
      }
    },

    async remove(context, path): Promise<EngineResult> {
      exactQuery(context.url, resourceQueryKeys);
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
        operationKind: "delete",
        replayKey,
        tenantId: context.tenantId,
        fingerprint,
        resourceUid: current.metadata.uid,
        target: address,
        acceptedUid: current.metadata.uid,
        acceptedGeneration: current.metadata.generation,
        acceptedRevision: context.durableOperation?.acceptedRevision ?? current.metadata.revision,
        ...(authority.fence ? { authorityHeadDigest: authority.fence.headDigest } : {}),
      });
      const deleteId = saga.operationId;
      try {
        await store.prepareResourceDeletion({
          tenantId: context.tenantId,
          resourceUid: current.metadata.uid,
          address,
          formRef: form.identity.formRef,
          operationId: deleteId,
        });
      } catch (error) {
        await store.abandonProviderMutationPlan({
          tenantId: context.tenantId,
          operationId: deleteId,
          replayKey,
          resourceUid: current.metadata.uid,
        });
        throw error;
      }
      let preparedDriverRelations: readonly TakoformDriverRelation[] = [];
      let providerDispatched = false;
      let providerContended = false;
      let receipt: TakoformDriverReceipt;
      try {
        receipt = await executeProviderMutation({
          tenantId: context.tenantId,
          operationId: deleteId,
          resourceUid: current.metadata.uid,
          fingerprint,
          claimOwnerId: context.durableOperation?.claimOwnerId ?? deleteId,
          onPreviouslyDispatched: () => {
            providerDispatched = true;
          },
          onContention: () => {
            providerContended = true;
          },
          onDispatch: async () => {
            if (
              !(await store.markResourceDeletionDispatch({
                tenantId: context.tenantId,
                resourceUid: current.metadata.uid,
                operationId: deleteId,
              }))
            ) {
              throw new TakoformHostError("resource_busy", 409);
            }
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
          execute: async (operationMode, execution, leaseToken) => {
            return (
              (await driver.delete({
                operationId: deleteId,
                operationMode,
                ...(execution.providerHandle ? { providerHandle: execution.providerHandle } : {}),
                executionAuthority: {
                  tenantId: context.tenantId,
                  resourceUid: current.metadata.uid,
                  leaseToken,
                  fingerprint,
                },
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
          await store.recordResourceEffect({
            tenantId: context.tenantId,
            resourceUid: current.metadata.uid,
            effectId: deleteId,
            kind: "delete",
            phase: "cancelled",
            operationMode: "initial",
          });
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
          providerEffect: {
            effectId: deleteId,
            kind: "delete",
            operationMode: receipt.providerExecutionMode ?? "initial",
          },
          deletionTombstone: { operationId: deleteId },
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
            providerEffect: {
              effectId: deleteId,
              kind: "delete",
              operationMode: receipt.providerExecutionMode ?? "initial",
            },
            deletionTombstone: { operationId: deleteId },
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

function incomingDesiredGeneration(
  input: ParsedResource,
  current: TakoformStoredResource | null,
): string {
  // Generation tracks desired state, so it only moves when the spec does.
  return current
    ? canonicalJson(current.spec) === canonicalJson(input.spec)
      ? current.metadata.generation
      : increment(current.metadata.generation)
    : "1";
}

function materializeResource(
  input: ParsedResource,
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
  current: TakoformStoredResource | null,
  clock: Clock,
  resourceUid: string,
): TakoformStoredResource {
  const generation = incomingDesiredGeneration(input, current);
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

function sagaAuthorityHeadDigest(
  accepted: AcceptedAuthoritySummary | undefined,
  current: TakoformAuthorityFence | undefined,
): `sha256:${string}` | undefined {
  if (accepted !== undefined) {
    return accepted.mode === "mutation" ? accepted.headDigest : undefined;
  }
  return current?.headDigest;
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
  if (!receiptProjectable(form, receipt)) throw new TakoformHostError();
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
