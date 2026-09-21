import type {
  ArtifactConsumerProviderDeployment,
  ArtifactConsumerProviderReader,
} from "./artifact-consumer-repair.ts";
import type { Catalog } from "./catalog.ts";
import { sanitizedMessage } from "./error-envelope.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { isEdgeFormsApiVersion } from "./form-ref.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import type { Ledger, LedgerHeldCharge } from "./ledger.ts";
import type { JsonObject } from "./ports.ts";
import type { ProviderPack } from "./provider-pack.ts";
import { createSoldProviderPlacementSelector } from "./provider-placement.ts";
import {
  type Provider,
  type ProviderExecutionAuthority,
  type ProviderNativeAbsence,
  type ProviderNativeReadbackDescriptor,
  type ProviderOffering,
  type ProviderRelation,
  type ProviderResult,
  type ProviderRuntimeBinding,
  type ProviderTicket,
  type ProviderValue,
  providerFailureProvesNoMutation,
  providerFailureProvesWholeOperationNoMutation,
} from "./provider-port.ts";
import {
  canMaterializeAcrossProviderPacks,
  materializeProviderRuntimeBindings,
} from "./provider-runtime-bindings.ts";
import type {
  ResourceDeployment,
  ResourceDeploymentMutation,
  ResourceDeploymentStore,
} from "./resource-deployments.ts";
import {
  sameTakoformApplySelection,
  TAKOFORM_APPLY_SELECTION_VERSION,
  type TakoformApplySelection,
  type TakoformApplySelectionDeployment,
  type TakoformApplySelectionRelation,
} from "./takoform/apply-selection.ts";
import { validateMaximumRuntimeInputBindings } from "./takoform/forms.ts";
import {
  sameTakoformImportSelection,
  TAKOFORM_IMPORT_SELECTION_VERSION,
  type TakoformImportSelection,
} from "./takoform/import-selection.ts";
import { receiptProjectable } from "./takoform/receipt-projection.ts";
import { validateStandardServiceSlots } from "./takoform/standard-services.ts";
import type { TakoformStore } from "./takoform/store.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverReceipt,
  TakoformDriverRelation,
  TakoformFormAvailabilityResolver,
  TakoformNativeAbsenceEvidence,
  TakoformResourceDriver,
  TakoformRuntimeInputPolicy,
  TakoformStoredResource,
} from "./takoform/types.ts";
import { TakoformHostError } from "./takoform/types.ts";
import { increment } from "./takoform/wire.ts";
import {
  type WorkerEndpointOriginAssignment,
  WorkerEndpointOriginReservationError,
  type WorkerEndpointOriginReservations,
} from "./worker-endpoint-origin-reservations.ts";

type TakoformImportSelectionWithRelations = Extract<
  TakoformImportSelection,
  { readonly kind: "provider" | "sqlite-migration" }
>;
type TakoformImportSelectionRelation = TakoformImportSelectionWithRelations["relations"][number];
type TakoformImportSelectionDeployment = NonNullable<TakoformImportSelectionRelation["deployment"]>;
type TakoformImportProviderSelection = Extract<
  TakoformImportSelection,
  { readonly kind: "provider" }
>;

function selectStandardServiceProjections(
  provider: Provider,
  input: Parameters<TakoformResourceDriver["apply"]>[0],
) {
  const projections = input.standardServices ?? [];
  if (projections.length === 0) return [];
  const slots = validateStandardServiceSlots(input);
  const seen = new Set<string>();
  for (const projection of projections) {
    const slot = slots.find((candidate) => candidate.name === projection.name);
    if (
      !slot ||
      seen.has(projection.name) ||
      slot.required !== projection.required ||
      slot.service.apiVersion !== projection.service.apiVersion ||
      slot.service.protocol !== projection.service.protocol
    ) {
      throw new TakoformHostError("invalid_argument", 400);
    }
    seen.add(projection.name);
  }
  const supported = (service: (typeof projections)[number]["service"]) =>
    provider.standardServiceProtocols?.some(
      (candidate) =>
        candidate.apiVersion === service.apiVersion && candidate.protocol === service.protocol,
    ) === true;
  for (const slot of slots) {
    if (slot.required && (!seen.has(slot.name) || !supported(slot.service))) {
      throw new TakoformHostError("unsupported_capability", 422);
    }
  }
  // Optional slots which the selected runtime cannot deliver remain absent.
  // This field never joins Deployment.spec, provider outputs or receipt material.
  return structuredClone(projections.filter((projection) => supported(projection.service)));
}

/**
 * The provider accepted a mutation but the driver could not observe a
 * terminal result. The handle is intentionally opaque and is persisted by the
 * Host saga; retries must poll/adopt it rather than dispatching a second write.
 */
export class ProviderMutationRecoveryError extends TakoformHostError {
  constructor(
    readonly providerOutcome: "running" | "indeterminate",
    readonly providerHandle?: string,
    code = "backend_unavailable",
    status = 503,
    message?: string,
  ) {
    super(code, status, undefined, sanitizedMessage(message));
    this.name = "ProviderMutationRecoveryError";
  }
}

/**
 * The current initial mutation was refused with driver-owned proof that no
 * provider mutation was accepted. The engine may settle its already-written
 * dispatch marker; the same evidence observed during recovery is deliberately
 * degraded to indeterminate because it says nothing about an older invocation.
 */
export class ProviderMutationDefinitiveRefusalError extends TakoformHostError {
  constructor(
    code: string,
    status: number,
    message?: string,
    options?: {
      readonly heldCharge?: LedgerHeldCharge;
      readonly hostCode?: string;
      readonly details?: unknown;
    },
  ) {
    super(code, status, options?.details, sanitizedMessage(message), options?.hostCode);
    this.name = "ProviderMutationDefinitiveRefusalError";
    if (options?.heldCharge) this.heldCharge = options.heldCharge;
  }

  readonly heldCharge?: LedgerHeldCharge;
}

/**
 * A direct recovery result proved the entire durable operation idle. The
 * action keeps import settlement separate from create convergence settlement.
 */
export class ProviderMutationWholeOperationRefusalError extends TakoformHostError {
  constructor(
    code: string,
    status: number,
    message?: string,
    options?: {
      readonly action?: "recoverAdopt" | "convergeApply";
      readonly heldCharge?: LedgerHeldCharge;
    },
  ) {
    super(code, status, undefined, sanitizedMessage(message));
    this.name = "ProviderMutationWholeOperationRefusalError";
    this.action = options?.action ?? "recoverAdopt";
    if (options?.heldCharge) this.heldCharge = options.heldCharge;
  }
  readonly action: "recoverAdopt" | "convergeApply";
  readonly heldCharge?: LedgerHeldCharge;
}

/**
 * Promotes only a driver-owned preflight rejection into no-provider-mutation
 * evidence. Callers deliberately bound each use to validation and read-only
 * ports; reservation writes and Provider methods never run inside this helper.
 */
async function definitiveProviderPreflight<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof ProviderMutationRecoveryError ||
      error instanceof ProviderMutationDefinitiveRefusalError
    ) {
      throw error;
    }
    if (error instanceof TakoformHostError) {
      throw new ProviderMutationDefinitiveRefusalError(
        error.code,
        error.status,
        error.publicMessage,
        {
          ...(error.details !== undefined ? { details: error.details } : {}),
          ...(error.hostCode ? { hostCode: error.hostCode } : {}),
        },
      );
    }
    throw error;
  }
}

/** An extension callback cannot manufacture whole-attempt no-effect proof. */
function withoutDefinitiveProviderProof(error: unknown): unknown {
  return error instanceof ProviderMutationDefinitiveRefusalError
    ? new TakoformHostError(
        error.code,
        error.status,
        error.details,
        error.publicMessage,
        error.hostCode,
      )
    : error;
}

/**
 * Connects a Takoform apply to a real backend, and to the wallet.
 *
 * This is where declaring a resource finally costs money. The old design had
 * these two halves disconnected: a Takoform apply provisioned infrastructure
 * and charged nothing, while the reseller lane charged for reservations nobody
 * had to redeem. Here, funds are held before the provider is called and either
 * captured on success or released on failure, keyed by the operation id so a
 * retry settles once.
 *
 * Until the durable Deployment controller calls this port directly, the bare
 * Takoform lane is usable only when one exact sellable Offering exists. More
 * than one fails closed: a Form is never authority to choose supply.
 */

export interface CreateProviderDriverOptions {
  readonly providers: readonly Provider[];
  /** Provider-private capabilities paired to the provisioners above. */
  readonly providerPacks?: readonly ProviderPack[];
  readonly catalog: Catalog;
  readonly ledger: Ledger;
  readonly deployments: ResourceDeploymentStore;
  /** Host-private reservation lifecycle. Opaque refs never cross the Provider port. */
  readonly originReservations?: Pick<
    WorkerEndpointOriginReservations,
    | "mintForWorker"
    | "bind"
    | "assignEndpoint"
    | "cancelEndpointAssignment"
    | "releaseEndpointAssignment"
    | "activateEndpointAssignment"
    | "endpointAssignment"
    | "deactivateEndpointAssignment"
  >;
  /** Host-owned deletion tombstones and effect-closure evidence. */
  readonly deletions?: Pick<
    TakoformStore,
    "readResourceDeletion" | "cacheResourceDeletionEvidence" | "readResourceEffectLedger"
  >;
  /**
   * How long an apply may wait for a backend that answers `running`. Cloudflare
   * settles within one call; anything slower currently surfaces as retryable
   * rather than being abandoned, and moves to the background reconciler when
   * that lands.
   */
  readonly inlinePollBudget?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface TakoserverProviderDriver extends TakoformResourceDriver {
  /** Host-lifecycle-only fresh provider evidence; never mounted as a Takoform Host route. */
  readonly artifactConsumerRepair: ArtifactConsumerProviderReader;
}

export function createProviderDriver(
  options: CreateProviderDriverOptions,
): TakoserverProviderDriver {
  const { providers, catalog, ledger, deployments, deletions, originReservations } = options;
  const pollBudget = options.inlinePollBudget ?? 5;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const packsById = new Map((options.providerPacks ?? []).map((pack) => [pack.id, pack]));
  const soldPlacements = createSoldProviderPlacementSelector({ providers, catalog });
  for (const provider of providers) {
    validateMaximumRuntimeInputBindings(provider.runtimeInputCapabilities?.maximumBindings ?? 0);
  }
  // A Provider instance is selected by pack id and has no installation
  // selector. Build the closed commercial authority up front: if one pack is
  // advertised for multiple installations, catalog-backed readback cannot
  // safely choose one. Inherited relation readback instead requires its own
  // exact, non-authoring ProviderNativeReadbackAuthority tuple below.
  const installationsByPack = new Map<string, Set<string>>();
  for (const offering of catalog.list()) {
    const refs = installationsByPack.get(offering.providerPackRef) ?? new Set<string>();
    refs.add(offering.providerInstallationRef);
    installationsByPack.set(offering.providerPackRef, refs);
  }

  const selectSold = (
    form: InstalledTakoformForm,
    offeringId?: string,
  ): {
    provider: Provider;
    offering: ProviderOffering;
    sold: ReturnType<Catalog["offeringsFor"]>[number];
    priceMinor: number;
  } => {
    const { provider, offering, sold } = soldPlacements.select(form.identity.formRef, offeringId);
    return {
      provider,
      offering,
      sold,
      priceMinor: sold.pricePlan.provisioning.amountMinor,
    };
  };

  const providerRelations = async (
    tenantId: string,
    relations: readonly TakoformDriverRelation[],
  ): Promise<readonly ProviderRelation[]> =>
    await Promise.all(
      relations.map(async (relation) => {
        const deployment = await deployments.active(tenantId, relation.targetUid);
        // Stored resources and deployments include Host-owned state. Project
        // the closed Provider port explicitly; a structural type annotation
        // alone would still transmit status, provenance and native claims.
        return {
          pointer: relation.pointer,
          relation: relation.relation,
          targetUid: relation.targetUid,
          resource: {
            apiVersion: relation.resource.apiVersion,
            kind: relation.resource.kind,
            form: { formRef: structuredClone(relation.resource.form.formRef) },
            metadata: {
              name: relation.resource.metadata.name,
              space: relation.resource.metadata.space,
              uid: relation.resource.metadata.uid,
              generation: relation.resource.metadata.generation,
              revision: relation.resource.metadata.revision,
            },
            spec: structuredClone(relation.resource.spec),
          },
          ...(relation.bindingRef ? { bindingRef: structuredClone(relation.bindingRef) } : {}),
          ...(deployment
            ? {
                deployment: {
                  tenantId: deployment.tenantId,
                  id: deployment.id,
                  resourceUid: deployment.resourceUid,
                  offeringId: deployment.offeringId,
                  providerPackRef: deployment.providerPackRef,
                  providerInstallationRef: deployment.providerInstallationRef,
                  nativeId: deployment.nativeId,
                  state: deployment.state,
                  observed: structuredClone(deployment.observed),
                  outputs: structuredClone(deployment.outputs),
                  createdAt: deployment.createdAt,
                  updatedAt: deployment.updatedAt,
                },
              }
            : {}),
        } satisfies ProviderRelation;
      }),
    );

  const inherited = async (
    tenantId: string,
    form: InstalledTakoformForm,
    relations: readonly TakoformDriverRelation[],
  ): Promise<{
    provider: Provider;
    offering: ProviderOffering;
    providerInstallationRef: string;
    relations: readonly ProviderRelation[];
  }> => {
    const resolved = await providerRelations(tenantId, relations);
    const parents = resolved.flatMap((relation) => (relation.deployment ? [relation] : []));
    if (parents.length === 0) throw new TakoformHostError("unsupported_capability", 422);
    // Non-Binding relations remain the native placement anchor. A Binding is
    // allowed to name a different pack only when both target export and
    // consumer import capabilities claim its exact identity. This preserves
    // the mixed-native-parent guard instead of turning it into provider
    // guessing.
    const nativeParents = parents.filter((relation) => !relation.bindingRef);
    const anchors = nativeParents.length > 0 ? nativeParents : parents;
    const providerPackRef = anchors[0]?.deployment?.providerPackRef;
    const providerInstallationRef = anchors[0]?.deployment?.providerInstallationRef;
    if (
      !providerPackRef ||
      !providerInstallationRef ||
      anchors.some(
        (relation) =>
          relation.deployment?.providerPackRef !== providerPackRef ||
          relation.deployment?.providerInstallationRef !== providerInstallationRef,
      )
    ) {
      // A native attachment cannot silently bridge two provider accounts.
      throw new TakoformHostError("unsupported_capability", 422);
    }
    const consumerPack = packsById.get(providerPackRef);
    for (const relation of parents) {
      const deployment = relation.deployment;
      if (!deployment || deployment.providerPackRef === providerPackRef) continue;
      if (
        !canMaterializeAcrossProviderPacks({
          bindingRef: relation.bindingRef,
          consumerPack,
          targetPack: packsById.get(deployment.providerPackRef),
        })
      ) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
    }
    const provider = byId.get(providerPackRef);
    const offerings = provider?.offerings.filter((candidate) =>
      sameForm(candidate.form, form.identity.formRef),
    );
    if (!provider || offerings?.length !== 1 || offerings[0] === undefined) {
      throw new TakoformHostError("unsupported_capability", 422);
    }
    return {
      provider,
      offering: offerings[0],
      providerInstallationRef,
      relations: resolved,
    };
  };

  const selectForMutation = async (input: {
    readonly tenantId: string;
    readonly form: InstalledTakoformForm;
    readonly relations: readonly TakoformDriverRelation[];
    readonly offeringId?: string;
  }) => {
    const soldSelection =
      input.form.role === "identity" || catalog.offeringsFor(input.form.identity.formRef).length > 0
        ? selectSold(input.form, input.offeringId)
        : undefined;
    const inheritedSelection = soldSelection
      ? undefined
      : await inherited(input.tenantId, input.form, input.relations);
    const provider = soldSelection?.provider ?? inheritedSelection?.provider;
    const offering = soldSelection?.offering ?? inheritedSelection?.offering;
    if (!provider || !offering) throw new TakoformHostError("unsupported_capability", 422);
    return { provider, offering, soldSelection, inheritedSelection };
  };

  const selectedDeployment = async (
    deployment: Pick<
      ResourceDeployment,
      | "id"
      | "resourceUid"
      | "offeringId"
      | "providerPackRef"
      | "providerInstallationRef"
      | "nativeId"
      | "state"
      | "observed"
      | "outputs"
    >,
  ): Promise<TakoformApplySelectionDeployment> => ({
    id: deployment.id,
    resourceUid: deployment.resourceUid,
    offeringId: deployment.offeringId,
    providerPackRef: deployment.providerPackRef,
    providerInstallationRef: deployment.providerInstallationRef,
    nativeId: deployment.nativeId,
    state: deployment.state,
    projectionDigest: await canonicalDigest({
      observed: deployment.observed,
      outputs: deployment.outputs,
    }),
  });

  const selectedImportDeployment = async (
    deployment: ResourceDeployment,
  ): Promise<TakoformImportSelectionDeployment> => ({
    ...(await selectedDeployment(deployment)),
    nativeClaimed: deployment.nativeClaimed,
  });

  const selectedRelations = async (
    relations: readonly ProviderRelation[],
  ): Promise<readonly TakoformApplySelectionRelation[]> =>
    await Promise.all(
      relations.map(async (relation) => ({
        pointer: relation.pointer,
        relation: relation.relation,
        targetUid: relation.targetUid,
        resource: {
          apiVersion: relation.resource.apiVersion,
          kind: relation.resource.kind,
          formRef: structuredClone(relation.resource.form.formRef),
          name: relation.resource.metadata.name,
          space: relation.resource.metadata.space,
          uid: relation.resource.metadata.uid,
          generation: relation.resource.metadata.generation,
          revision: relation.resource.metadata.revision,
        },
        ...(relation.bindingRef ? { bindingRef: structuredClone(relation.bindingRef) } : {}),
        ...(relation.deployment
          ? { deployment: await selectedDeployment(relation.deployment) }
          : {}),
      })),
    );

  const selectedImportRelations = async (
    relations: readonly ProviderRelation[],
  ): Promise<readonly TakoformImportSelectionRelation[]> =>
    await Promise.all(
      relations.map(async (relation) => {
        let deployment: TakoformImportSelectionDeployment | undefined;
        if (relation.deployment) {
          const stored = await deployments.find(
            relation.deployment.tenantId,
            relation.deployment.id,
          );
          if (
            !stored ||
            canonicalJson({
              tenantId: stored.tenantId,
              id: stored.id,
              resourceUid: stored.resourceUid,
              offeringId: stored.offeringId,
              providerPackRef: stored.providerPackRef,
              providerInstallationRef: stored.providerInstallationRef,
              nativeId: stored.nativeId,
              state: stored.state,
              observed: stored.observed,
              outputs: stored.outputs,
              createdAt: stored.createdAt,
              updatedAt: stored.updatedAt,
            }) !== canonicalJson(relation.deployment)
          ) {
            throw new TakoformHostError("resource_busy", 409);
          }
          deployment = await selectedImportDeployment(stored);
        }
        return {
          pointer: relation.pointer,
          relation: relation.relation,
          targetUid: relation.targetUid,
          resource: {
            apiVersion: relation.resource.apiVersion,
            kind: relation.resource.kind,
            formRef: structuredClone(relation.resource.form.formRef),
            name: relation.resource.metadata.name,
            space: relation.resource.metadata.space,
            uid: relation.resource.metadata.uid,
            generation: relation.resource.metadata.generation,
            revision: relation.resource.metadata.revision,
          },
          ...(relation.bindingRef ? { bindingRef: structuredClone(relation.bindingRef) } : {}),
          ...(deployment ? { deployment } : {}),
        };
      }),
    );

  const resolveApplySelection = async (input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly form: InstalledTakoformForm;
    readonly spec: JsonObject;
    readonly relations: readonly TakoformDriverRelation[];
    readonly commercialAuthority?: Parameters<
      TakoformResourceDriver["selectApply"]
    >[0]["commercialAuthority"];
  }) => {
    const current = await deployments.active(input.tenantId, input.resourceUid);
    if (intrinsicForm(input.form)) {
      if (input.form.identity.formRef.kind !== "SQLiteMigrationApplication") {
        return {
          current,
          selection: {
            version: TAKOFORM_APPLY_SELECTION_VERSION,
            kind: "intrinsic",
          } satisfies TakoformApplySelection,
        } as const;
      }
      const database = input.relations.find(
        (relation) => relation.relation === "/database",
      )?.resource;
      if (!database) throw new TakoformHostError("resource_not_found", 404);
      await sqliteProvider(input.tenantId, database);
      const relationTargets = await providerRelations(input.tenantId, input.relations);
      const relations = await selectedRelations(relationTargets);
      if (
        relations.filter(
          (relation) => relation.relation === "/database" && relation.deployment !== undefined,
        ).length !== 1
      ) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      return {
        current,
        relationTargets,
        selection: {
          version: TAKOFORM_APPLY_SELECTION_VERSION,
          kind: "sqlite-migration",
          relations,
        } satisfies TakoformApplySelection,
      } as const;
    }
    const { provider, offering, soldSelection, inheritedSelection } = await selectForMutation({
      tenantId: input.tenantId,
      form: input.form,
      relations: input.relations,
      ...(input.commercialAuthority ? { offeringId: input.commercialAuthority.offeringId } : {}),
    });
    assertProviderRuntimeInputs(provider, input.spec);
    const sold = soldSelection?.sold;
    const offeringDigest = sold ? await catalog.digest(sold) : undefined;
    if (
      sold &&
      input.commercialAuthority &&
      (input.commercialAuthority.offeringId !== sold.id ||
        (!current && input.commercialAuthority.offeringDigest !== offeringDigest))
    ) {
      throw new TakoformHostError("unsupported_capability", 422);
    }
    const providerInstallationRef =
      sold?.providerInstallationRef ??
      inheritedSelection?.providerInstallationRef ??
      (() => {
        throw new TakoformHostError("backend_unavailable", 503);
      })();
    if (
      current &&
      (current.offeringId !== offering.id ||
        current.providerPackRef !== provider.id ||
        current.providerInstallationRef !== providerInstallationRef)
    ) {
      throw new TakoformHostError("unsupported_capability", 422);
    }
    const relationTargets =
      inheritedSelection?.relations ?? (await providerRelations(input.tenantId, input.relations));
    const selection = {
      version: TAKOFORM_APPLY_SELECTION_VERSION,
      kind: "provider",
      providerPackRef: provider.id,
      providerInstallationRef,
      technicalOffering: structuredClone(offering),
      ...(sold && offeringDigest
        ? {
            sold: {
              offeringId: sold.id,
              offeringDigest,
              pricePlanRef: sold.pricePlanRef,
              pricePlan: structuredClone(sold.pricePlan),
            },
          }
        : {}),
      ...(current ? { incumbent: await selectedDeployment(current) } : {}),
      relations: await selectedRelations(relationTargets),
    } satisfies TakoformApplySelection;
    return {
      current,
      provider,
      relationTargets,
      selection,
    } as const;
  };

  const resolveImportSelection = async (input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly nativeId: string;
    readonly relations: readonly TakoformDriverRelation[];
    readonly previous?: TakoformStoredResource;
  }) => {
    const current = await deployments.active(input.tenantId, input.resourceUid);
    if (intrinsicForm(input.form)) {
      if (input.form.identity.formRef.kind !== "SQLiteMigrationApplication") {
        return {
          current,
          selection: {
            version: TAKOFORM_IMPORT_SELECTION_VERSION,
            kind: "intrinsic",
            nativeId: input.nativeId,
          } satisfies TakoformImportSelection,
        } as const;
      }
      const database = input.relations.find(
        (relation) => relation.relation === "/database",
      )?.resource;
      if (!database) throw new TakoformHostError("resource_not_found", 404);
      await sqliteProvider(input.tenantId, database);
      const relationTargets = await providerRelations(input.tenantId, input.relations);
      const relations = await selectedImportRelations(relationTargets);
      const databaseRelations = relations.filter((relation) => relation.relation === "/database");
      if (databaseRelations.length !== 1 || databaseRelations[0]?.deployment === undefined) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      return {
        current,
        relationTargets,
        selection: {
          version: TAKOFORM_IMPORT_SELECTION_VERSION,
          kind: "sqlite-migration",
          nativeId: input.nativeId,
          relations,
        } satisfies TakoformImportSelection,
      } as const;
    }

    const catalogPlacement =
      input.form.role === "identity" ||
      catalog.offeringsFor(input.form.identity.formRef).length > 0;
    const soldSelection = catalogPlacement ? selectSold(input.form) : undefined;
    const inheritedSelection = soldSelection
      ? undefined
      : await inherited(input.tenantId, input.form, input.relations);
    const provider = soldSelection?.provider ?? inheritedSelection?.provider;
    const offering = soldSelection?.offering ?? inheritedSelection?.offering;
    const providerInstallationRef =
      soldSelection?.sold.providerInstallationRef ?? inheritedSelection?.providerInstallationRef;
    if (!provider || !offering || !providerInstallationRef || !provider.adopt) {
      throw new TakoformHostError("unsupported_capability", 422);
    }

    const claim = await deployments.findNativeClaim(providerInstallationRef, input.nativeId);
    if (
      (claim && (!current || claim.tenantId !== current.tenantId || claim.id !== current.id)) ||
      (current &&
        ((current.nativeClaimed && current.nativeId !== input.nativeId) ||
          current.offeringId !== offering.id ||
          current.providerPackRef !== provider.id ||
          current.providerInstallationRef !== providerInstallationRef))
    ) {
      throw new TakoformHostError("import_conflict", 409);
    }

    const relationTargets =
      inheritedSelection?.relations ?? (await providerRelations(input.tenantId, input.relations));
    const selection = {
      version: TAKOFORM_IMPORT_SELECTION_VERSION,
      kind: "provider",
      nativeId: input.nativeId,
      providerPackRef: provider.id,
      providerInstallationRef,
      technicalOffering: structuredClone(offering),
      placement: soldSelection
        ? { kind: "catalog", offeringId: soldSelection.sold.id }
        : { kind: "inherited" },
      ...(current ? { incumbent: await selectedImportDeployment(current) } : {}),
      relations: await selectedImportRelations(relationTargets),
    } satisfies TakoformImportProviderSelection;
    return {
      current,
      provider,
      offering,
      providerInstallationRef,
      relationTargets,
      selection,
    } as const;
  };

  const assertProviderRuntimeInputs = (provider: Provider, spec: JsonObject): void => {
    const required = spec.requiredSensitiveVars;
    const count = Array.isArray(required) ? required.length : 0;
    const maximum = provider.runtimeInputCapabilities?.maximumBindings ?? 0;
    validateMaximumRuntimeInputBindings(maximum);
    if (count > maximum) throw new TakoformHostError("unsupported_capability", 422);
  };

  const runtimeInputPolicy: TakoformRuntimeInputPolicy = {
    guaranteedMaximum(form) {
      const candidates = providers.filter((provider) =>
        provider.offerings.some((offering) => sameForm(offering.form, form.identity.formRef)),
      );
      if (candidates.length === 0) return 0;
      return Math.min(
        ...candidates.map((provider) => provider.runtimeInputCapabilities?.maximumBindings ?? 0),
      );
    },
    async admit(input) {
      const { provider } = await selectForMutation({
        tenantId: input.tenantId,
        form: input.form,
        relations: input.relations,
        ...(input.commercialAuthority ? { offeringId: input.commercialAuthority.offeringId } : {}),
      });
      assertProviderRuntimeInputs(provider, input.spec);
    },
  };

  /** A current-call proof cannot cross into a later poll invocation. */
  const detachPolledFailureProof = (ticket: ProviderTicket): ProviderTicket =>
    ticket.phase === "failed" ? { ...ticket, failure: { ...ticket.failure } } : ticket;

  const retainPolledRecoveryAuthority = (
    ticket: ProviderTicket,
    handle: string,
  ): ProviderTicket => {
    const detached = detachPolledFailureProof(ticket);
    // A terminal answer from `poll` describes that poll invocation, not the
    // mutation which first returned this handle. Retain the provider's durable
    // recovery identity even for a non-retryable ambiguous failure; otherwise
    // recording the outcome would erase the only authority a later executor
    // has to inspect the accepted mutation.
    return detached.phase === "failed" && !detached.handle ? { ...detached, handle } : detached;
  };

  /** Drives a ticket to a terminal state within the inline budget. */
  const settle = async (
    provider: Provider,
    operationId: string,
    first: ProviderTicket,
    executionAuthority: ProviderExecutionAuthority,
    handleDurable = false,
  ): Promise<ProviderTicket> => {
    let ticket = first;
    let handle = ticket.phase === "running" ? ticket.handle : undefined;
    // A running ticket is the provider's only recovery identity. The Host
    // saga can persist it only after this call returns, so do not cross a
    // fallible poll/sleep boundary while the handle still lives only in this
    // stack frame. Recovery callers already have the persisted handle and may
    // continue polling within the inline budget.
    if (ticket.phase === "running" && !handleDurable) {
      throw new ProviderMutationRecoveryError("running", ticket.handle);
    }
    for (let attempt = 0; ticket.phase === "running" && attempt < pollBudget; attempt += 1) {
      if (!provider.poll) break;
      try {
        const polledHandle = ticket.handle;
        await sleep(ticket.pollAfterMs);
        ticket = retainPolledRecoveryAuthority(
          await provider.poll({ operationId, handle: polledHandle, executionAuthority }),
          polledHandle,
        );
      } catch {
        // The opaque handle was durable before entering this loop. Preserve it
        // when a transport or scheduler failure leaves the outcome unknown.
        throw new ProviderMutationRecoveryError("indeterminate", handle);
      }
      if (ticket.phase === "running") {
        handle = ticket.handle;
      }
    }
    return ticket;
  };

  const pollHandle = async (
    provider: Provider,
    operationId: string,
    handle: string,
    executionAuthority: ProviderExecutionAuthority,
  ): Promise<ProviderTicket> => {
    if (!provider.poll) {
      return {
        phase: "failed",
        failure: {
          code: "unavailable",
          message: "the provider recovery handle cannot be polled",
          retryable: true,
        },
        handle,
      };
    }
    try {
      return retainPolledRecoveryAuthority(
        await provider.poll({ operationId, handle, executionAuthority }),
        handle,
      );
    } catch {
      throw new ProviderMutationRecoveryError("indeterminate", handle);
    }
  };

  const resultOf = (
    ticket: ProviderTicket,
    mutation?: {
      readonly operationId: string;
      readonly mode: "initial" | "recovery";
      readonly wholeOperationProof?: "recoverAdopt" | "convergeApply";
    },
  ): ProviderResult => {
    if (ticket.phase === "succeeded") {
      return ticket.result;
    }
    if (ticket.phase === "running") {
      // Still working when the budget ran out. Saying so is honest; claiming
      // success would record a resource the backend has not made yet.
      throw new ProviderMutationRecoveryError("running", ticket.handle);
    }
    if (ticket.failure.retryable) {
      // A retryable provider failure after a mutating call may be a lost
      // response rather than a pre-dispatch rejection. Keep the saga in an
      // explicit indeterminate state and require deterministic recovery.
      const [code, status] = failureToWire(ticket.failure.code);
      throw new ProviderMutationRecoveryError(
        "indeterminate",
        ticket.handle,
        code,
        status,
        ticket.failure.message,
      );
    }
    // The provider's own sentence, not the code's. `ProviderFailure.message`
    // is declared safe for a customer to read, and dropping it left the caller
    // with `invalid_argument` and a repair line telling them to "correct the
    // desired state the message names" against a message that named nothing.
    const [code, status] = failureToWire(ticket.failure.code);
    if (
      mutation?.wholeOperationProof !== undefined &&
      mutation.mode === "recovery" &&
      providerFailureProvesWholeOperationNoMutation(ticket, mutation.operationId)
    ) {
      throw new ProviderMutationWholeOperationRefusalError(code, status, ticket.failure.message, {
        action: mutation.wholeOperationProof,
      });
    }
    if (mutation && providerFailureProvesNoMutation(ticket, mutation.operationId)) {
      if (mutation.mode === "initial") {
        throw new ProviderMutationDefinitiveRefusalError(code, status, ticket.failure.message);
      }
      // This ticket proves only that the recovery invocation did not write.
      // An older invocation already owns the durable dispatch marker and may
      // have mutated before losing its acknowledgement, so retain its plan.
      throw new ProviderMutationRecoveryError(
        "indeterminate",
        ticket.handle,
        code,
        status,
        ticket.failure.message,
      );
    }
    const refusal = new TakoformHostError(
      code,
      status,
      undefined,
      sanitizedMessage(ticket.failure.message),
    );
    if (mutation) {
      // A provider failure code controls its public diagnosis and automatic
      // retry policy, not mutation certainty. Even a 4xx-looking ticket may be
      // a post-write refusal; without identity-bound no-effect proof, retain the
      // exact operation for reconciliation.
      throw new ProviderMutationRecoveryError(
        "indeterminate",
        ticket.handle,
        code,
        status,
        ticket.failure.message,
      );
    }
    throw refusal;
  };

  const indeterminateProviderMutationFailure = (error: unknown): ProviderMutationRecoveryError => {
    if (error instanceof ProviderMutationRecoveryError) return error;
    return error instanceof TakoformHostError
      ? new ProviderMutationRecoveryError(
          "indeterminate",
          undefined,
          error.code,
          error.status,
          error.publicMessage,
        )
      : new ProviderMutationRecoveryError("indeterminate");
  };

  /** Direct Provider throws never carry the operation-bound ticket proof. */
  const enteredProviderMutation = async (
    work: () => Promise<ProviderTicket>,
  ): Promise<ProviderTicket> => {
    try {
      return await work();
    } catch (error) {
      throw indeterminateProviderMutationFailure(error);
    }
  };

  /** Holds the price, runs the work, then captures or durably retains it. */
  const charged = async (
    organizationId: string,
    priceMinor: number,
    mutation: {
      readonly operationId: string;
      readonly mode: "initial" | "recovery";
      readonly wholeOperationProof?: "recoverAdopt" | "convergeApply";
    },
    work: () => Promise<ProviderTicket>,
  ): Promise<ProviderResult> => {
    if (priceMinor === 0) return resultOf(await work(), mutation);
    const held = await ledger.hold({
      organizationId,
      reference: mutation.operationId,
      amountMinor: priceMinor,
    });
    if (!held) {
      if (mutation.mode === "initial") {
        throw new ProviderMutationDefinitiveRefusalError("insufficient_funds", 402);
      }
      // Failing to obtain funds for this recovery call does not prove that the
      // earlier dispatched provider call was idle.
      throw new ProviderMutationRecoveryError(
        "indeterminate",
        undefined,
        "insufficient_funds",
        402,
      );
    }
    // A provider recovery error means dispatch was accepted but the driver did
    // not observe a terminal result. The durable hold is the only authority
    // keeping this operation's price earmarked while a restarted executor
    // polls/adopts the same operation. A thrown adapter error is likewise not
    // definitive proof of a pre-dispatch failure, so the hold remains.
    const ticket = await work();
    if (ticket.phase === "succeeded") {
      await ledger.capture({
        organizationId,
        reference: mutation.operationId,
        amountMinor: priceMinor,
      });
      return ticket.result;
    }
    try {
      // `running` and retryable `failed` tickets are recovery outcomes. Call
      // resultOf before releasing so both retain the hold for the next poll or
      // same-operation retry.
      return resultOf(ticket, mutation);
    } catch (error) {
      if (error instanceof ProviderMutationRecoveryError) throw error;
      if (error instanceof ProviderMutationWholeOperationRefusalError) {
        throw new ProviderMutationWholeOperationRefusalError(
          error.code,
          error.status,
          error.publicMessage,
          {
            action: error.action,
            heldCharge: { reference: mutation.operationId, amountMinor: priceMinor },
          },
        );
      }
      if (error instanceof ProviderMutationDefinitiveRefusalError) {
        // Releasing here would put money back before the engine's provider-plan
        // lease fence commits. Carry the exact hold to the lifecycle owner so
        // refusal, cleanup, and release become one atomic SQL decision.
        throw new ProviderMutationDefinitiveRefusalError(
          error.code,
          error.status,
          error.publicMessage,
          {
            heldCharge: { reference: mutation.operationId, amountMinor: priceMinor },
            ...(error.details !== undefined ? { details: error.details } : {}),
            ...(error.hostCode ? { hostCode: error.hostCode } : {}),
          },
        );
      }
      await ledger.release({
        organizationId,
        reference: mutation.operationId,
        amountMinor: priceMinor,
      });
      throw error;
    }
  };

  const receiptOf = (result: ProviderResult): TakoformDriverReceipt => ({
    observed: result.observed,
    outputs: result.outputs,
  });

  /** Deployment rows are Host-internal; this marker is never projected onto a Resource. */
  const deploymentOutputs = (
    outputs: ProviderResult["outputs"],
    input: {
      readonly resourceUid: string;
      readonly space: string;
      readonly name: string;
      readonly spec: JsonObject;
      readonly previous?: TakoformStoredResource;
      readonly deleteOperationId?: string;
    },
  ): ProviderResult["outputs"] => ({
    ...structuredClone(outputs),
    __takoserver: {
      resourceUid: input.resourceUid,
      space: input.space,
      name: input.name,
      generation: input.previous
        ? canonicalJson(input.previous.spec) === canonicalJson(input.spec)
          ? input.previous.metadata.generation
          : increment(input.previous.metadata.generation)
        : "1",
      ...(input.deleteOperationId ? { deleteOperationId: input.deleteOperationId } : {}),
    },
  });

  const deploymentMarker = (
    outputs: JsonObject,
  ): {
    readonly resourceUid: string;
    readonly space: string;
    readonly name: string;
    readonly generation: string;
    readonly deleteOperationId?: string;
  } | null => {
    const value = outputs.__takoserver;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const marker = value as Record<string, unknown>;
    if (
      typeof marker.resourceUid !== "string" ||
      typeof marker.space !== "string" ||
      typeof marker.name !== "string" ||
      typeof marker.generation !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(marker.generation) ||
      BigInt(marker.generation) > 9_223_372_036_854_775_807n
    ) {
      return null;
    }
    return {
      resourceUid: marker.resourceUid,
      space: marker.space,
      name: marker.name,
      generation: marker.generation,
      ...(typeof marker.deleteOperationId === "string"
        ? { deleteOperationId: marker.deleteOperationId }
        : {}),
    };
  };

  const installed = (
    deployment: ResourceDeployment,
    form: TakoformV1Alpha3FormRef,
  ): { provider: Provider; offering: ProviderOffering } => {
    const provider = byId.get(deployment.providerPackRef);
    const sold = catalog.findOffering(deployment.offeringId);
    const currentOffering = provider?.offerings.find(
      (candidate) => candidate.id === deployment.offeringId && sameForm(candidate.form, form),
    );
    const recoveryOffering = provider?.recoveryOfferings?.find(
      (candidate) => candidate.id === deployment.offeringId && sameForm(candidate.form, form),
    );
    // A current catalog row may reuse an offering id after its Form family
    // advances. Recorded Deployments may cross that boundary only through an
    // exact recovery-only capability; the ordinary offering remains the sole
    // authoring path.
    const offering =
      sold && !sameForm(sold.form, form) ? recoveryOffering : (currentOffering ?? recoveryOffering);
    if (
      !provider ||
      !offering ||
      !sameForm(offering.form, form) ||
      (sold !== undefined &&
        (sold.providerPackRef !== deployment.providerPackRef ||
          sold.providerInstallationRef !== deployment.providerInstallationRef))
    ) {
      throw new TakoformHostError("backend_unavailable", 503);
    }
    return { provider, offering };
  };

  const repairDeployment = (
    deployment: ArtifactConsumerProviderDeployment,
  ): ResourceDeployment => ({
    tenantId: deployment.tenantId,
    id: deployment.deploymentId,
    resourceUid: deployment.resourceUid,
    offeringId: deployment.offeringId,
    providerPackRef: deployment.providerPackRef,
    providerInstallationRef: deployment.providerInstallationRef,
    nativeId: deployment.nativeId,
    nativeClaimed: false,
    state: deployment.state,
    observed: deployment.observed,
    outputs: deployment.outputs,
    createdAt: new Date(deployment.createdAt).toISOString(),
    updatedAt: new Date(deployment.updatedAt).toISOString(),
  });

  const parsedRepairFormRef = (value: JsonObject): TakoformV1Alpha3FormRef | null => {
    if (
      Object.keys(value).sort().join("\u0000") !==
        ["apiVersion", "definitionVersion", "kind", "schemaDigest"].sort().join("\u0000") ||
      typeof value.apiVersion !== "string" ||
      typeof value.kind !== "string" ||
      typeof value.definitionVersion !== "string" ||
      typeof value.schemaDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.schemaDigest)
    ) {
      return null;
    }
    return {
      apiVersion: value.apiVersion,
      kind: value.kind,
      definitionVersion: value.definitionVersion,
      schemaDigest: value.schemaDigest as `sha256:${string}`,
    };
  };

  const repairInstalled = (
    deployment: ArtifactConsumerProviderDeployment,
    formRef?: JsonObject,
  ): { provider: Provider; offering: ProviderOffering } | null => {
    const recorded = repairDeployment(deployment);
    let form = formRef === undefined ? null : parsedRepairFormRef(formRef);
    // A surviving Resource or deletion attestation is the Form authority for
    // this readback. If it is malformed, never replace it with a current
    // Catalog row that merely shares the recorded offering id.
    if (formRef !== undefined && !form) return null;
    if (formRef === undefined) {
      const provider = byId.get(deployment.providerPackRef);
      const sold = catalog.findOffering(deployment.offeringId);
      if (
        sold &&
        (sold.providerPackRef !== deployment.providerPackRef ||
          sold.providerInstallationRef !== deployment.providerInstallationRef)
      ) {
        return null;
      }
      const matching = [
        ...(provider?.offerings ?? []),
        ...(provider?.recoveryOfferings ?? []),
      ].filter((candidate) => candidate.id === deployment.offeringId);
      const exact = matching[0];
      // With no surviving FormRef, an offering id reused across Form families
      // carries no authority to choose either family. The provider must expose
      // one unambiguous family, and any current catalog projection must agree.
      if (
        !exact ||
        matching.some((candidate) => !sameForm(candidate.form, exact.form)) ||
        (sold !== undefined && !sameForm(sold.form, exact.form))
      ) {
        return null;
      }
      form = exact.form;
    }
    const installations = installationsByPack.get(deployment.providerPackRef);
    if (
      !form ||
      installations?.size !== 1 ||
      !installations.has(deployment.providerInstallationRef)
    ) {
      return null;
    }
    try {
      return installed(recorded, form);
    } catch {
      return null;
    }
  };

  const active = async (tenantId: string, resourceUid: string): Promise<ResourceDeployment> => {
    const deployment = await deployments.active(tenantId, resourceUid);
    if (!deployment) throw new TakoformHostError("resource_not_found", 404);
    return deployment;
  };

  const refresh = async (
    deployment: ResourceDeployment,
    result: ProviderResult,
    outputs: JsonObject = result.outputs,
  ): Promise<void> => {
    if (
      result.nativeId !== deployment.nativeId ||
      !(await deployments.refresh(
        deployment.tenantId,
        deployment.id,
        deployment.nativeId,
        result.observed,
        outputs,
      ))
    ) {
      throw new TakoformHostError("resource_busy", 409);
    }
  };

  const sqliteProvider = async (
    tenantId: string,
    database: TakoformStoredResource,
  ): Promise<{
    provider: Provider;
    deployment: ResourceDeployment;
    port: NonNullable<Provider["sqliteMigrations"]>;
  }> => {
    const deployment = await active(tenantId, database.metadata.uid);
    const { provider } = installed(deployment, database.form.formRef);
    if (!provider.sqliteMigrations) {
      throw new TakoformHostError("unsupported_capability", 422);
    }
    return { provider, deployment, port: provider.sqliteMigrations };
  };

  const sqliteProviderFromSelection = async (
    tenantId: string,
    database: TakoformStoredResource,
    selection:
      | Extract<TakoformApplySelection, { readonly kind: "sqlite-migration" }>
      | Extract<TakoformImportSelection, { readonly kind: "sqlite-migration" }>,
  ): Promise<{
    deployment: TakoformApplySelectionDeployment;
    port: NonNullable<Provider["sqliteMigrations"]>;
  }> => {
    if (selection.kind !== "sqlite-migration") {
      throw new TakoformHostError("backend_unavailable", 503);
    }
    const databaseRelation = selection.relations.find(
      (relation) => relation.relation === "/database",
    );
    const deployment = databaseRelation?.deployment;
    if (
      !databaseRelation ||
      !deployment ||
      databaseRelation.targetUid !== database.metadata.uid ||
      databaseRelation.resource.uid !== database.metadata.uid ||
      databaseRelation.resource.generation !== database.metadata.generation ||
      databaseRelation.resource.revision !== database.metadata.revision ||
      !sameForm(databaseRelation.resource.formRef, database.form.formRef)
    ) {
      throw new TakoformHostError("backend_unavailable", 503);
    }
    const current = await deployments.active(tenantId, database.metadata.uid);
    const currentSelection = current
      ? selection.version === TAKOFORM_IMPORT_SELECTION_VERSION
        ? await selectedImportDeployment(current)
        : await selectedDeployment(current)
      : undefined;
    if (!current || canonicalJson(currentSelection) !== canonicalJson(deployment)) {
      throw new TakoformHostError("backend_unavailable", 503);
    }
    const provider =
      selection.version === TAKOFORM_IMPORT_SELECTION_VERSION
        ? (() => {
            const selectedProvider = byId.get(deployment.providerPackRef);
            const selectedOffering = selectedProvider?.offerings.find(
              (candidate) =>
                candidate.id === deployment.offeringId &&
                sameForm(candidate.form, database.form.formRef),
            );
            if (
              !selectedProvider ||
              !selectedOffering ||
              selectedProvider.id !== deployment.providerPackRef ||
              current.providerInstallationRef !== deployment.providerInstallationRef
            ) {
              throw new TakoformHostError("backend_unavailable", 503);
            }
            return selectedProvider;
          })()
        : installed(current, database.form.formRef).provider;
    if (!provider.sqliteMigrations) throw new TakoformHostError("backend_unavailable", 503);
    return { deployment, port: provider.sqliteMigrations };
  };

  const providerValue = <T>(result: ProviderValue<T>): T => {
    if (result.ok) return result.value as T;
    throw new TakoformHostError(...failureToWire(result.failure.code));
  };

  return {
    runtimeInputPolicy,
    async selectApply(input) {
      return structuredClone((await resolveApplySelection(input)).selection);
    },
    async selectImport(input) {
      return structuredClone((await resolveImportSelection(input)).selection);
    },
    artifactConsumerRepair: {
      async verifyNativeAbsence(input) {
        const selected = repairInstalled(input.deployment, input.formRef);
        if (
          !selected?.provider.createNativeReadbackDescriptor ||
          !selected.provider.verifyNativeAbsence
        ) {
          return { outcome: "indeterminate", reason: "authority_unavailable", retryable: false };
        }
        const marker = deploymentMarker(input.deployment.outputs);
        if (
          !marker ||
          marker.resourceUid !== input.deployment.resourceUid ||
          marker.space !== input.address.space ||
          marker.name !== input.address.name
        ) {
          return { outcome: "indeterminate", reason: "malformed", retryable: false };
        }
        let descriptor: ProviderNativeReadbackDescriptor;
        try {
          descriptor = selected.provider.createNativeReadbackDescriptor({
            offering: selected.offering,
            nativeId: input.deployment.nativeId,
            identity: {
              tenantRef: input.deployment.tenantId,
              space: input.address.space,
              name: input.address.name,
              uid: input.deployment.resourceUid,
              incarnationId: input.deployment.deploymentId,
              generation: marker.generation,
            },
            spec: input.deployment.observed,
          });
        } catch {
          return { outcome: "indeterminate", reason: "malformed", retryable: false };
        }
        try {
          const result = await selected.provider.verifyNativeAbsence({
            offering: selected.offering,
            descriptor,
            target: {
              tenantId: input.deployment.tenantId,
              resourceUid: input.deployment.resourceUid,
              incarnationId: input.deployment.deploymentId,
              generation: marker.generation,
            },
          });
          return result.outcome === "unknown"
            ? {
                outcome: "indeterminate",
                reason: result.reason,
                retryable: result.retryable,
              }
            : result;
        } catch {
          return { outcome: "indeterminate", reason: "transport", retryable: true };
        }
      },
      async verifyArtifactConsumption(input) {
        const selected = repairInstalled(input.deployment, input.resource?.formRef);
        if (!selected?.provider.verifyArtifactConsumption) {
          return { outcome: "indeterminate", reason: "unsupported", retryable: false };
        }
        const marker = deploymentMarker(input.deployment.outputs);
        if (
          input.resource &&
          (!marker ||
            marker.resourceUid !== input.resource.uid ||
            marker.space !== input.resource.space ||
            marker.name !== input.resource.name)
        ) {
          return { outcome: "indeterminate", reason: "malformed", retryable: false };
        }
        try {
          const result = await selected.provider.verifyArtifactConsumption({
            offering: selected.offering,
            nativeId: input.deployment.nativeId,
            target: {
              tenantId: input.deployment.tenantId,
              resourceUid: input.deployment.resourceUid,
              incarnationId: input.deployment.deploymentId,
              state: input.deployment.state,
              updatedAt: input.deployment.updatedAt,
            },
            identity: {
              tenantRef: input.deployment.tenantId,
              resourceUid: input.deployment.resourceUid,
              ...(input.resource
                ? { address: { space: input.resource.space, name: input.resource.name } }
                : marker
                  ? { address: { space: marker.space, name: marker.name } }
                  : {}),
            },
            candidateManifestDigests: input.candidateManifestDigests,
            ...(input.resource
              ? {
                  currentResource: {
                    revision: input.resource.revision,
                    relationsDigest: input.resource.relationsDigest,
                    providerOperationIds: input.resource.providerOperationIds,
                  },
                }
              : {}),
          });
          return result.outcome === "unknown"
            ? {
                outcome: "indeterminate",
                reason: result.reason,
                retryable: result.retryable,
              }
            : result;
        } catch {
          return { outcome: "indeterminate", reason: "transport", retryable: true };
        }
      },
    },
    sqliteMigrations: {
      async readLedger(input) {
        const { deployment, port } = input.selection
          ? input.selection.kind === "sqlite-migration"
            ? await sqliteProviderFromSelection(input.tenantId, input.database, input.selection)
            : (() => {
                throw new TakoformHostError("backend_unavailable", 503);
              })()
          : await sqliteProvider(input.tenantId, input.database);
        return providerValue(
          await port.readLedger({
            nativeId: deployment.nativeId,
            target: {
              tenantId: input.tenantId,
              resourceUid: input.database.metadata.uid,
              incarnationId: deployment.id,
              generation: input.database.metadata.generation,
            },
          }),
        );
      },
      async applySuffix(input) {
        if (input.selection?.kind !== "sqlite-migration") {
          throw new TakoformHostError("backend_unavailable", 503);
        }
        const { deployment, port } = await sqliteProviderFromSelection(
          input.tenantId,
          input.database,
          input.selection,
        );
        providerValue(
          await port.applySuffix({
            operationId: input.operationId,
            operationMode: input.operationMode,
            executionAuthority: input.executionAuthority,
            nativeId: deployment.nativeId,
            target: {
              resourceUid: input.database.metadata.uid,
              incarnationId: deployment.id,
              generation: input.database.metadata.generation,
            },
            desired: input.desired,
            expectedPrefix: input.expectedPrefix,
            migrations: input.migrations,
          }),
        );
      },
    },
    async apply(input): Promise<TakoformDriverReceipt> {
      if (intrinsicForm(input.form)) {
        const current = await definitiveProviderPreflight(() =>
          deployments.active(input.tenantId, input.resourceUid),
        );
        if (current) {
          throw new ProviderMutationDefinitiveRefusalError("backend_unavailable", 503);
        }
        if (
          (input.form.identity.formRef.kind === "SQLiteMigrationApplication") !==
          (input.selection.kind === "sqlite-migration")
        ) {
          throw new ProviderMutationDefinitiveRefusalError("resource_busy", 409);
        }
        return { observed: structuredClone(input.spec) };
      }
      const resolved = await definitiveProviderPreflight(() => resolveApplySelection(input));
      if (!sameTakoformApplySelection(resolved.selection, input.selection)) {
        throw new ProviderMutationDefinitiveRefusalError("resource_busy", 409);
      }
      const current = resolved.current;
      const preflight = await definitiveProviderPreflight(async () => {
        if (resolved.selection.kind !== "provider" || !resolved.provider) {
          throw new TakoformHostError("backend_unavailable", 503);
        }
        const provider = resolved.provider;
        const offering = structuredClone(resolved.selection.technicalOffering);
        // Recovery adopts the retained runtime binding, not today's integration
        // registry. Initial delivery is fenced before placement or native work.
        if (input.standardServices?.length && input.operationMode === undefined) {
          throw new TakoformHostError("unsupported_capability", 422);
        }
        const standardServices =
          input.operationMode === "initial"
            ? selectStandardServiceProjections(provider, input)
            : [];
        const priceMinor = resolved.selection.sold?.pricePlan.provisioning.amountMinor ?? 0;
        const relationTargets = resolved.relationTargets;
        const previous = current
          ? {
              nativeId: current.nativeId,
              spec: input.previous?.spec ?? input.spec,
            }
          : undefined;
        const providerInstallationRef = resolved.selection.providerInstallationRef;
        const providerIdentity = {
          tenantRef: input.tenantId,
          space: input.space,
          name: input.name,
          uid: input.resourceUid,
          ...(current && input.previous
            ? {
                incarnationId: current.id,
                generation: input.previous.metadata.generation,
              }
            : {}),
        } as const;
        return {
          provider,
          offering,
          priceMinor,
          relationTargets,
          previous,
          providerInstallationRef,
          providerIdentity,
          standardServices,
        };
      });
      const {
        provider,
        offering,
        priceMinor,
        relationTargets,
        previous,
        providerInstallationRef,
        providerIdentity,
        standardServices,
      } = preflight;
      let endpointAssignment: WorkerEndpointOriginAssignment | undefined;
      let endpointPreflight:
        | {
            readonly reservations: NonNullable<typeof originReservations>;
            readonly worker: TakoformStoredResource;
          }
        | undefined;
      if (input.form.identity.formRef.kind === "WorkerEndpoint") {
        endpointPreflight = await definitiveProviderPreflight(() => {
          if (!originReservations) {
            throw new TakoformHostError("unsupported_capability", 422);
          }
          const workerRelations = input.relations.filter(
            (relation) =>
              relation.pointer === "/worker" &&
              relation.relation === "/worker" &&
              relation.resource.kind === "ModuleWorker",
          );
          const worker = workerRelations.length === 1 ? workerRelations[0]?.resource : undefined;
          if (!worker || worker.metadata.space !== input.space) {
            throw new TakoformHostError("invalid_argument", 400);
          }
          return { reservations: originReservations, worker };
        });
        const { reservations, worker } = endpointPreflight;
        if (current) {
          endpointAssignment = await definitiveProviderPreflight(async () => {
            let assignment: WorkerEndpointOriginAssignment | null;
            try {
              assignment = await reservations.endpointAssignment(input.tenantId, input.resourceUid);
            } catch (error) {
              throw endpointReservationHostError(error);
            }
            if (
              !assignment ||
              (input.workerEndpointOriginReservationId !== undefined &&
                input.workerEndpointOriginReservationId !== assignment.reservationId) ||
              assignment.endpoint.space !== input.space ||
              assignment.endpoint.name !== input.name ||
              assignment.endpoint.uid !== input.resourceUid ||
              assignment.worker.name !== worker.metadata.name ||
              assignment.worker.uid !== worker.metadata.uid ||
              assignment.worker.revision !== worker.metadata.revision ||
              assignment.placement.providerPackRef !== provider.id ||
              assignment.placement.providerInstallationRef !== providerInstallationRef
            ) {
              throw new TakoformHostError("resource_busy", 409);
            }
            return assignment;
          });
        }
      }
      // Runtime Binding import/export calls are extension callbacks, not a
      // provider-mutation certainty boundary. Even though this projection is
      // intended to be read-only, an adapter throw cannot prove it had no
      // effects, and no later validation may upgrade it into an idle attempt.
      const consumerPack = packsById.get(provider.id);
      // When materialization returns, every exact route counted here necessarily
      // crossed both extension callback sites. No route means the helper either
      // performed local validation only or skipped a same-pack relation.
      const runtimeBindingCallbacksEntered = relationTargets.some((relation) =>
        canMaterializeAcrossProviderPacks({
          bindingRef: relation.bindingRef,
          consumerPack,
          targetPack: relation.deployment
            ? packsById.get(relation.deployment.providerPackRef)
            : undefined,
        }),
      );
      let runtimeBindings: readonly ProviderRuntimeBinding[];
      try {
        runtimeBindings = await materializeProviderRuntimeBindings({
          tenantId: input.tenantId,
          source: providerIdentity,
          sourceSpec: input.spec,
          consumerPack,
          packs: packsById,
          relations: relationTargets,
        });
      } catch (error) {
        throw withoutDefinitiveProviderProof(error);
      }
      for (const relation of relationTargets) {
        if (
          relation.deployment &&
          relation.deployment.providerPackRef !== provider.id &&
          !runtimeBindings.some(
            (binding) =>
              binding.targetUid === relation.targetUid &&
              binding.bindingRef.apiVersion === relation.bindingRef?.apiVersion &&
              binding.bindingRef.name === relation.bindingRef?.name &&
              binding.bindingRef.version === relation.bindingRef?.version &&
              binding.bindingRef.schemaDigest === relation.bindingRef?.schemaDigest,
          )
        ) {
          throw new TakoformHostError("unsupported_capability", 422);
        }
      }
      if (endpointPreflight && !current) {
        const { reservations, worker } = endpointPreflight;
        // A reservation supplied by the caller is the reseller lane's
        // authority: it sold a name and held it before the Resource graph
        // existed. An ordinary organization API key has no such input — the
        // released provider's `takoform_worker_endpoint` accepts only `name`
        // and `worker` — so on an installation whose endpoint address is
        // derived from the Worker anyway, the Host reserves on the caller's
        // behalf. Without that, no ordinary key could ever create a
        // WorkerEndpoint at all, and the 14th resource of a Worker graph was
        // unreachable.
        let reservationId = input.workerEndpointOriginReservationId;
        if (reservationId === undefined) {
          let minted: Awaited<ReturnType<typeof reservations.mintForWorker>>;
          try {
            // No Offering is named here on purpose. `offering` in this branch
            // is always the WorkerEndpoint's, and a reservation is placed on
            // the ModuleWorker's — the authority reads that off the Worker's
            // own active Deployment, which is the placement everything
            // downstream compares against.
            minted = await reservations.mintForWorker({
              organizationId: input.tenantId,
              space: input.space,
              workerName: worker.metadata.name,
              workerResourceUid: worker.metadata.uid,
            });
          } catch (error) {
            throw endpointReservationHostError(error);
          }
          // No derived address on this installation: the reservation really
          // is the caller's to supply, and there is nothing to mint. Runtime
          // Binding callbacks already ran, so this is intentionally unbranded.
          if (!minted) throw new TakoformHostError("unsupported_capability", 422);
          reservationId = minted.reservationId;
        } else {
          try {
            // A supplied reservation is only prepared until this exact
            // WorkerEndpoint create. Bind it to the resolved Ready Worker
            // before assigning the endpoint witness or crossing into the
            // Provider. Host-minted reservations are already bound by
            // `mintForWorker`, so they intentionally skip this transition.
            await reservations.bind({
              organizationId: input.tenantId,
              reservationId,
              space: input.space,
              workerName: worker.metadata.name,
              workerResourceUid: worker.metadata.uid,
            });
          } catch (error) {
            throw endpointReservationHostError(error);
          }
        }
        try {
          endpointAssignment = await reservations.assignEndpoint({
            organizationId: input.tenantId,
            reservationId,
            space: input.space,
            endpointName: input.name,
            endpointResourceUid: input.resourceUid,
            endpointResourceRevision: "1",
            workerName: worker.metadata.name,
            workerResourceUid: worker.metadata.uid,
            providerPackRef: provider.id,
            providerInstallationRef,
          });
        } catch (error) {
          throw endpointReservationHostError(error);
        }
      }
      const providerInput = {
        operationId: input.operationId,
        operationKey: input.operationKey,
        ...(input.desiredGeneration !== undefined
          ? { desiredGeneration: input.desiredGeneration }
          : {}),
        ...(input.publicApply ? { publicApply: input.publicApply } : {}),
        ...(input.operationMode ? { operationMode: input.operationMode } : {}),
        executionAuthority: input.executionAuthority,
        offering,
        identity: providerIdentity,
        spec: input.spec,
        relations: relationTargets,
        ...(runtimeBindings.length > 0 ? { runtimeBindings } : {}),
        ...(standardServices.length > 0 ? { standardServices } : {}),
        ...(endpointAssignment
          ? {
              workerEndpointOriginAssignment: {
                canonicalPublicOrigin: endpointAssignment.canonicalPublicOrigin,
                assignmentDigest: endpointAssignment.assignmentDigest,
              },
            }
          : {}),
        ...(previous ? { previous } : {}),
      } satisfies import("./provider-port.ts").ApplyInput;
      let providerBoundaryEntered = false;
      let activatedAssignment: WorkerEndpointOriginAssignment | null = null;
      const mutation: {
        readonly operationId: string;
        readonly mode: "initial" | "recovery";
        wholeOperationProof?: "convergeApply";
      } = {
        operationId: input.operationId,
        mode: input.operationMode === "recovery" ? "recovery" : "initial",
      };
      const work = async () => {
        providerBoundaryEntered = true;
        try {
          const firstTicket = input.providerHandle
            ? await pollHandle(
                provider,
                input.operationId,
                input.providerHandle,
                input.executionAuthority,
              )
            : input.operationMode === "recovery"
              ? provider.convergeApply
                ? await provider.convergeApply(providerInput)
                : (() => {
                    // A Host recovery lease may resume a mutation only through
                    // an explicitly operation-keyed convergence seam. The
                    // read-only `recoverApply` capability is never promoted
                    // into mutation authority here.
                    throw new ProviderMutationRecoveryError("indeterminate");
                  })()
              : await provider.apply(providerInput);
          if (
            input.operationMode === "recovery" &&
            !input.providerHandle &&
            !previous &&
            firstTicket.phase === "failed"
          ) {
            mutation.wholeOperationProof = "convergeApply";
          }
          const ticket = await settle(
            provider,
            input.operationId,
            firstTicket,
            input.executionAuthority,
            Boolean(input.providerHandle),
          );
          if (endpointAssignment && ticket.phase === "succeeded") {
            // Asked here, before anything is activated, because this is the last
            // moment at which the answer is free. The engine holds every receipt
            // to its Form before it materializes a Resource; when that check ran
            // there and failed, the reservation had already been activated and
            // the endpoint's deletion attestation opened, the wire still said
            // "the host mutated nothing", and the space could never create that
            // endpoint again. One rule, asked at the point where refusing it
            // costs nothing.
            if (!receiptProjectable(input.form, receiptOf(ticket.result))) {
              throw new TakoformHostError();
            }
            try {
              activatedAssignment =
                (await originReservations?.activateEndpointAssignment({
                  assignment: endpointAssignment,
                  providerOutputs: ticket.result.outputs,
                })) ?? null;
            } catch (error) {
              throw endpointReservationHostError(error);
            }
          }
          return ticket;
        } catch (error) {
          // A thrown value has no producer-owned no-effect proof. This remains
          // ambiguous even when it happens to use a normally precondition-like
          // Host status: the provider boundary was already entered. Preserve a
          // known public diagnosis without promoting it into mutation certainty.
          throw indeterminateProviderMutationFailure(error);
        }
      };
      // A reseller reservation already holds this exact Offering's price.
      // Charging the organization wallet again here would double-settle the
      // same Resource. Direct organization credentials have no such authority
      // and retain the ordinary hold/capture path.
      let result: ProviderResult;
      try {
        result =
          input.commercialAuthority || priceMinor === 0
            ? resultOf(await work(), mutation)
            : await charged(input.tenantId, priceMinor, mutation, work);
      } catch (error) {
        // An assignment that was never activated is let go of, whether or not
        // the provider was entered. Keeping it after a failed create is what
        // made a lost readiness race permanent: the reservation stayed bound to
        // an endpoint UID whose Resource was never committed, its deletion
        // attestation could therefore never close, and every later apply — with
        // a fresh UID, as a re-created resource always has — was refused
        // `resource_busy` 409 until the reservation aged out a day later.
        //
        // Letting go of it reallocates nothing. The reservation stays `bound`
        // and still owns its canonical origin under the live uniqueness
        // constraint; only the endpoint witness is dropped, and a recovery that
        // resumes this operation re-assigns the same endpoint before the
        // provider is called again.
        // An activated assignment is let go of too, and through its own seam:
        // `cancelEndpointAssignment` pins the revision it was handed, which
        // activation has already moved, so it could never reach one. That is
        // how a refusal raised after activation left a reservation pinned to an
        // endpoint UID no Resource would ever name — permanently, because the
        // reservation id is derived from the Worker and an activated address is
        // immutable.
        const activated: WorkerEndpointOriginAssignment | null = activatedAssignment;
        const letGo = activated
          ? () => originReservations?.releaseEndpointAssignment(activated)
          : endpointAssignment
            ? () => originReservations?.cancelEndpointAssignment(endpointAssignment)
            : null;
        if (letGo) {
          try {
            await letGo();
          } catch (cancelError) {
            // Before dispatch the cancel failure is the only thing that went
            // wrong, so it is the answer. After dispatch the provider's own
            // refusal is what the operator has to read, and a witness this
            // could not drop is repaired by the next mint.
            if (!providerBoundaryEntered) throw endpointReservationHostError(cancelError);
          }
        }
        // A later wallet/provider refusal speaks only for that boundary. Once
        // Binding extension callbacks ran, it cannot prove the whole Host
        // attempt idle even when it carries producer-owned provider evidence.
        throw runtimeBindingCallbacksEntered ? withoutDefinitiveProviderProof(error) : error;
      }
      if (input.atomicDeploymentCommit) {
        const outputs = deploymentOutputs(result.outputs, input);
        let deploymentMutation: ResourceDeploymentMutation;
        if (!current) {
          deploymentMutation = {
            kind: "create",
            deployment: {
              tenantId: input.tenantId,
              id: `dep_${input.operationId}`,
              resourceUid: input.resourceUid,
              offeringId: offering.id,
              providerPackRef: provider.id,
              providerInstallationRef,
              nativeId: result.nativeId,
              state: "active",
              observed: result.observed,
              outputs,
            },
          };
        } else if (result.nativeId === current.nativeId) {
          deploymentMutation = {
            kind: "refresh",
            tenantId: input.tenantId,
            deploymentId: current.id,
            expectedNativeId: current.nativeId,
            observed: result.observed,
            outputs,
          };
        } else {
          // An import makes the old object a customer claim. A provider apply
          // may replace only the Host-minted realization it already owned; the
          // store repeats this unclaimed fence in the atomic commit batch.
          if (current.nativeClaimed) throw new TakoformHostError("resource_busy", 409);
          deploymentMutation = {
            kind: "replace",
            tenantId: input.tenantId,
            deploymentId: current.id,
            expectedNativeId: current.nativeId,
            nativeId: result.nativeId,
            observed: result.observed,
            outputs,
          };
        }
        return {
          ...receiptOf(result),
          deploymentMutation,
        };
      }
      if (current) {
        await refresh(current, result, deploymentOutputs(result.outputs, input));
      } else {
        try {
          await deployments.create({
            tenantId: input.tenantId,
            id: `dep_${input.operationId}`,
            resourceUid: input.resourceUid,
            offeringId: offering.id,
            providerPackRef: provider.id,
            providerInstallationRef,
            nativeId: result.nativeId,
            state: "active",
            observed: result.observed,
            outputs: deploymentOutputs(result.outputs, input),
          });
        } catch {
          throw new TakoformHostError("resource_busy", 409);
        }
      }
      return receiptOf(result);
    },

    async observe(input): Promise<TakoformDriverReceipt> {
      if (intrinsicFormRef(input.resource.form.formRef)) {
        return {
          observed: structuredClone(input.resource.status.observed ?? input.resource.spec),
          ...(input.resource.status.outputs
            ? { outputs: structuredClone(input.resource.status.outputs) }
            : {}),
        };
      }
      // Reading state is not a billable act.
      const deployment = await active(input.tenantId, input.resourceUid);
      const { provider, offering } = installed(deployment, input.resource.form.formRef);
      const result = resultOf(
        await provider.observe({
          offering,
          nativeId: deployment.nativeId,
          identity: {
            tenantRef: input.tenantId,
            space: input.resource.metadata.space,
            name: input.resource.metadata.name,
            uid: input.resourceUid,
            incarnationId: deployment.id,
            generation: input.resource.metadata.generation,
          },
          spec: input.resource.spec,
          relations: await providerRelations(input.tenantId, input.relations),
        }),
      );
      await refresh(
        deployment,
        result,
        deploymentOutputs(result.outputs, {
          resourceUid: input.resourceUid,
          space: input.resource.metadata.space,
          name: input.resource.metadata.name,
          spec: input.resource.spec,
          previous: input.resource,
        }),
      );
      return receiptOf(result);
    },

    // biome-ignore lint/suspicious/noConfusingVoidType: the driver contract intentionally allows no receipt for intrinsic resources
    async delete(input): Promise<TakoformDriverReceipt | void> {
      if (intrinsicFormRef(input.resource.form.formRef)) return;
      const { deployment, provider, offering, endpointAssignment } =
        await definitiveProviderPreflight(async () => {
          const deployment = await active(input.tenantId, input.resourceUid);
          const { provider, offering } = installed(deployment, input.resource.form.formRef);
          let endpointAssignment: WorkerEndpointOriginAssignment | null = null;
          if (input.resource.form.formRef.kind === "WorkerEndpoint") {
            if (!originReservations) {
              throw new TakoformHostError("unsupported_capability", 422);
            }
            try {
              endpointAssignment = await originReservations.endpointAssignment(
                input.tenantId,
                input.resourceUid,
              );
            } catch (error) {
              throw endpointReservationHostError(error);
            }
            if (
              !endpointAssignment ||
              endpointAssignment.endpoint.space !== input.resource.metadata.space ||
              endpointAssignment.endpoint.name !== input.resource.metadata.name ||
              endpointAssignment.endpoint.uid !== input.resourceUid ||
              endpointAssignment.placement.providerPackRef !== deployment.providerPackRef ||
              endpointAssignment.placement.providerInstallationRef !==
                deployment.providerInstallationRef
            ) {
              throw new TakoformHostError("resource_busy", 409);
            }
          }
          return { deployment, provider, offering, endpointAssignment };
        });
      const resolvedProviderRelations = () =>
        definitiveProviderPreflight(() => providerRelations(input.tenantId, input.relations));
      let firstTicket: ProviderTicket;
      if (input.providerHandle) {
        firstTicket = await pollHandle(
          provider,
          input.operationId,
          input.providerHandle,
          input.executionAuthority,
        );
      } else {
        if (input.operationMode === "recovery") {
          const recoverDelete = provider.recoverDelete?.bind(provider);
          if (!recoverDelete) {
            // A lost DELETE acknowledgement has no safe replay. Only a
            // provider-owned deterministic readback may settle it.
            throw new ProviderMutationRecoveryError("indeterminate");
          }
          // Relation projection is a read-only driver preflight. Keep it outside
          // the entered Provider call so its explicit refusal remains terminal.
          const relations = await resolvedProviderRelations();
          firstTicket = await enteredProviderMutation(() =>
            recoverDelete({
              operationId: input.operationId,
              operationMode: "recovery",
              executionAuthority: input.executionAuthority,
              offering,
              nativeId: deployment.nativeId,
              identity: {
                tenantRef: input.tenantId,
                space: input.resource.metadata.space,
                name: input.resource.metadata.name,
                uid: input.resourceUid,
                incarnationId: deployment.id,
                generation: input.resource.metadata.generation,
              },
              spec: input.resource.spec,
              relations,
            }),
          );
        } else {
          const relations = await resolvedProviderRelations();
          firstTicket = await enteredProviderMutation(() =>
            provider.delete({
              operationId: input.operationId,
              ...(input.operationMode ? { operationMode: input.operationMode } : {}),
              executionAuthority: input.executionAuthority,
              offering,
              nativeId: deployment.nativeId,
              identity: {
                tenantRef: input.tenantId,
                space: input.resource.metadata.space,
                name: input.resource.metadata.name,
                uid: input.resourceUid,
                incarnationId: deployment.id,
                generation: input.resource.metadata.generation,
              },
              spec: input.resource.spec,
              relations,
            }),
          );
        }
      }
      const ticket = await settle(
        provider,
        input.operationId,
        firstTicket,
        input.executionAuthority,
        Boolean(input.providerHandle),
      );
      const result = resultOf(ticket, {
        operationId: input.operationId,
        mode: input.operationMode === "recovery" ? "recovery" : "initial",
      });
      if (result.nativeId !== deployment.nativeId) {
        throw new TakoformHostError("resource_busy", 409);
      }
      if (endpointAssignment) {
        try {
          await originReservations?.deactivateEndpointAssignment(endpointAssignment);
        } catch (error) {
          throw endpointReservationHostError(error);
        }
      }
      if (input.atomicDeploymentCommit) {
        return {
          deploymentMutation:
            result.disposition === "retained"
              ? {
                  kind: "retain",
                  tenantId: input.tenantId,
                  deploymentId: deployment.id,
                  expectedNativeId: deployment.nativeId,
                  observed: result.observed,
                  outputs: deploymentOutputs(result.outputs, {
                    resourceUid: input.resourceUid,
                    space: input.resource.metadata.space,
                    name: input.resource.metadata.name,
                    spec: input.resource.spec,
                    previous: input.resource,
                    deleteOperationId: input.operationId,
                  }),
                  operationId: input.operationId,
                  resourceUid: input.resourceUid,
                  space: input.resource.metadata.space,
                  name: input.resource.metadata.name,
                  providerPackRef: deployment.providerPackRef,
                  providerInstallationRef: deployment.providerInstallationRef,
                }
              : {
                  kind: "delete",
                  tenantId: input.tenantId,
                  deploymentId: deployment.id,
                  expectedNativeId: deployment.nativeId,
                  operationId: input.operationId,
                  resourceUid: input.resourceUid,
                  space: input.resource.metadata.space,
                  name: input.resource.metadata.name,
                  providerPackRef: deployment.providerPackRef,
                  providerInstallationRef: deployment.providerInstallationRef,
                },
        };
      }
      const recorded =
        result.disposition === "retained"
          ? await deployments.markRetained(
              input.tenantId,
              deployment.id,
              deployment.nativeId,
              result.observed,
              deploymentOutputs(result.outputs, {
                resourceUid: input.resourceUid,
                space: input.resource.metadata.space,
                name: input.resource.metadata.name,
                spec: input.resource.spec,
                previous: input.resource,
                deleteOperationId: input.operationId,
              }),
            )
          : await deployments.markDeleted(input.tenantId, deployment.id, deployment.nativeId, {
              operationId: input.operationId,
              resourceUid: input.resourceUid,
              space: input.resource.metadata.space,
              name: input.resource.metadata.name,
            });
      if (!recorded) {
        throw new TakoformHostError("resource_busy", 409);
      }
    },

    async verifyNativeAbsence(input): Promise<TakoformNativeAbsenceEvidence> {
      const checkedAt = new Date().toISOString();
      const indeterminate = (
        source: "intrinsic" | "provider",
        reason: TakoformNativeAbsenceEvidence["reason"],
        effectCount: number,
        deploymentCount: number,
      ): TakoformNativeAbsenceEvidence => ({
        status: "indeterminate",
        source,
        ...(reason ? { reason } : {}),
        effectCount,
        deploymentCount,
        checkedAt,
      });
      if (!deletions) return indeterminate("provider", "legacy_unattested", 0, 0);

      const tombstone = await deletions.readResourceDeletion(input.tenantId, input.resourceUid);
      const rows = await deployments.forResource(input.tenantId, input.resourceUid);
      if (!tombstone) {
        if (rows.length > 0) {
          return indeterminate("provider", "legacy_unattested", 0, rows.length);
        }
        throw new TakoformHostError("resource_not_found", 404);
      }
      if (tombstone.address.space !== input.space || tombstone.address.name !== input.name) {
        return indeterminate(
          "provider",
          "legacy_unattested",
          tombstone.effects.length,
          rows.length,
        );
      }

      const source = intrinsicFormRef(tombstone.formRef) ? "intrinsic" : "provider";
      const effects = deletions.readResourceEffectLedger
        ? await deletions.readResourceEffectLedger(input.tenantId, input.resourceUid)
        : tombstone.effects;
      const effectSetDigest = await canonicalDigest({
        // The evidence cache is scoped to the exact incarnation address and
        // Form identity as well as its effect history. A same-UID or same-name
        // request for another Form must never hit a prior absence proof.
        address: tombstone.address,
        formRef: tombstone.formRef,
        effects: effects.map((effect) => ({
          eventId: effect.eventId,
          operationId: effect.operationId,
          kind: effect.kind,
          phase: effect.phase,
          operationMode: effect.operationMode,
          providerPackRef: effect.providerPackRef,
          providerInstallationRef: effect.providerInstallationRef,
          nativeId: effect.nativeId,
        })),
      });
      const effectCount = effects.length;
      if (effectCount > 512 || rows.length > 128) {
        return indeterminate(source, "effect_unresolved", effectCount, rows.length);
      }
      const latest = new Map<string, (typeof effects)[number]>();
      for (const effect of effects) {
        const prior = latest.get(effect.operationId);
        if (!prior || phaseRank(effect.phase) >= phaseRank(prior.phase))
          latest.set(effect.operationId, effect);
      }
      const unresolved = [...latest.values()].some(
        (effect) => effect.phase !== "succeeded" && effect.phase !== "cancelled",
      );

      // A closed cache is usable only when the closure fence and complete
      // effect set still match, and only for a short TTL. Readback is otherwise
      // performed again so stale absence can never become a false zero.
      const checkedAtMs = tombstone.evidenceCheckedAt
        ? Date.parse(tombstone.evidenceCheckedAt)
        : Number.NaN;
      const cacheFresh =
        tombstone.state === "closed" &&
        tombstone.evidenceJson !== undefined &&
        tombstone.evidenceRef !== undefined &&
        tombstone.evidenceEffectDigest === effectSetDigest &&
        Number.isFinite(checkedAtMs) &&
        Date.now() - checkedAtMs >= 0 &&
        Date.now() - checkedAtMs <= 30_000 &&
        tombstone.evidenceStatus !== undefined;
      if (cacheFresh) {
        const cachedStatus = tombstone.evidenceStatus;
        if (
          cachedStatus === "absent" ||
          cachedStatus === "present" ||
          cachedStatus === "indeterminate"
        ) {
          return {
            status: cachedStatus,
            source,
            evidenceRef: tombstone.evidenceRef,
            effectCount,
            deploymentCount: rows.length,
            checkedAt: tombstone.evidenceCheckedAt ?? checkedAt,
          };
        }
      }

      const attest = async (
        status: TakoformNativeAbsenceEvidence["status"],
        reason?: TakoformNativeAbsenceEvidence["reason"],
        cache = false,
      ): Promise<TakoformNativeAbsenceEvidence> => {
        const evidenceBase: TakoformNativeAbsenceEvidence = {
          status,
          source,
          ...(reason ? { reason } : {}),
          effectCount,
          deploymentCount: rows.length,
          checkedAt,
        };
        if (!cache || tombstone.state !== "closed") return evidenceBase;
        const evidenceRef = await canonicalDigest({
          tenantId: input.tenantId,
          resourceUid: input.resourceUid,
          space: input.space,
          name: input.name,
          closureFence: tombstone.closureFence,
          effectSetDigest,
          ...evidenceBase,
        });
        await deletions.cacheResourceDeletionEvidence({
          tenantId: input.tenantId,
          resourceUid: input.resourceUid,
          closureFence: tombstone.closureFence,
          evidence: evidenceBase as unknown as JsonObject,
          evidenceRef,
          effectSetDigest,
          checkedAt: Date.parse(checkedAt),
          status,
        });
        return { ...evidenceBase, evidenceRef };
      };

      if (tombstone.state !== "closed") return await attest("indeterminate", "closure_pending");
      if (unresolved) return await attest("indeterminate", "effect_unresolved");

      if (rows.length === 0) {
        const physical = [...latest.values()].some(
          (effect) =>
            effect.phase === "succeeded" &&
            (effect.nativeId !== undefined || effect.providerPackRef !== undefined),
        );
        if (!intrinsicFormRef(tombstone.formRef) || physical) {
          return await attest("indeterminate", "provider_identity_missing");
        }
        return await attest("absent", undefined, true);
      }

      const marked = rows.map((deployment) => ({
        deployment,
        marker: deploymentMarker(deployment.outputs),
      }));
      if (
        marked.some(
          ({ marker }) =>
            marker === null ||
            marker.resourceUid !== input.resourceUid ||
            marker.space !== input.space ||
            marker.name !== input.name,
        )
      ) {
        return await attest("indeterminate", "deployment_unmarked");
      }
      if (
        marked.some(({ deployment }) =>
          ["provisioning", "candidate", "active", "draining"].includes(deployment.state),
        )
      ) {
        return await attest("present", "deployment_active");
      }
      if (
        marked.some(
          ({ deployment }) =>
            deployment.state === "failed" ||
            (deployment.state !== "deleted" && deployment.state !== "retained"),
        )
      ) {
        return await attest("indeterminate", "effect_unresolved");
      }

      const unique = new Map<string, ResourceDeployment>();
      for (const { deployment } of marked) {
        const key = [
          deployment.providerPackRef,
          deployment.providerInstallationRef,
          deployment.nativeId,
        ].join("\u0000");
        if (!unique.has(key)) unique.set(key, deployment);
      }
      for (const deployment of [...unique.values()].sort((a, b) =>
        [a.providerPackRef, a.providerInstallationRef, a.nativeId]
          .join("\u0000")
          .localeCompare([b.providerPackRef, b.providerInstallationRef, b.nativeId].join("\u0000")),
      )) {
        // A retained Deployment is an historical provider identity, not a
        // license to ask whichever installation currently happens to expose
        // the same offering id. Resolve either its exact commercial catalog
        // tuple or an exact non-authoring technical relation tuple. A Form-
        // family advance may cross either only through an exact recovery
        // capability. Missing, retired, drifted, or ambiguous authority fails
        // closed without a native provider readback call.
        const provider = byId.get(deployment.providerPackRef);
        const catalogOffering = catalog.findOffering(deployment.offeringId);
        if (
          catalogOffering &&
          (catalogOffering.providerPackRef !== deployment.providerPackRef ||
            catalogOffering.providerInstallationRef !== deployment.providerInstallationRef)
        ) {
          return await attest("indeterminate", "provider_unavailable");
        }
        const currentOffering = provider?.offerings.find(
          (candidate) =>
            candidate.id === deployment.offeringId && sameForm(candidate.form, tombstone.formRef),
        );
        const recoveryOffering = provider?.recoveryOfferings?.find(
          (candidate) =>
            candidate.id === deployment.offeringId && sameForm(candidate.form, tombstone.formRef),
        );
        let offering: ProviderOffering | undefined;
        if (catalogOffering) {
          const installationRefs = installationsByPack.get(deployment.providerPackRef);
          if (
            installationRefs?.size !== 1 ||
            !installationRefs.has(deployment.providerInstallationRef)
          ) {
            return await attest("indeterminate", "provider_unavailable");
          }
          offering = sameForm(catalogOffering.form, tombstone.formRef)
            ? (currentOffering ?? recoveryOffering)
            : recoveryOffering;
        } else {
          const authorities =
            provider?.nativeReadbackAuthorities?.filter(
              (authority) =>
                authority.offeringId === deployment.offeringId &&
                authority.providerInstallationRef === deployment.providerInstallationRef &&
                sameForm(authority.form, tombstone.formRef),
            ) ?? [];
          const capabilities = [
            ...(currentOffering ? [currentOffering] : []),
            ...(recoveryOffering ? [recoveryOffering] : []),
          ];
          if (authorities.length !== 1 || capabilities.length !== 1) {
            return await attest("indeterminate", "provider_unavailable");
          }
          offering = capabilities[0];
        }
        if (
          !provider ||
          !offering ||
          !sameForm(offering.form, tombstone.formRef) ||
          !provider.createNativeReadbackDescriptor ||
          !provider.verifyNativeAbsence
        ) {
          return await attest("indeterminate", "provider_unavailable");
        }
        const marker = deploymentMarker(deployment.outputs);
        if (!marker) return await attest("indeterminate", "deployment_unmarked");
        let descriptor: ProviderNativeReadbackDescriptor;
        try {
          descriptor = provider.createNativeReadbackDescriptor({
            offering,
            nativeId: deployment.nativeId,
            identity: {
              tenantRef: input.tenantId,
              space: input.space,
              name: input.name,
              uid: input.resourceUid,
              incarnationId: deployment.id,
              generation: marker.generation,
            },
            spec: deployment.observed,
          });
        } catch {
          return await attest("indeterminate", "provider_readback_failed");
        }
        let proof: ProviderNativeAbsence;
        try {
          proof = await provider.verifyNativeAbsence({
            offering,
            descriptor,
            target: {
              tenantId: input.tenantId,
              resourceUid: input.resourceUid,
              incarnationId: deployment.id,
              generation: marker.generation,
            },
          });
        } catch {
          return await attest("indeterminate", "provider_readback_failed");
        }
        if (proof.outcome === "present") return await attest("present");
        if (proof.outcome !== "absent")
          return await attest("indeterminate", "provider_readback_failed");
      }
      return await attest("absent", undefined, true);
    },

    async import(input): Promise<TakoformDriverReceipt> {
      const resolved = await definitiveProviderPreflight(() =>
        resolveImportSelection({
          tenantId: input.tenantId,
          resourceUid: input.resourceUid,
          form: input.form,
          name: input.name,
          space: input.space,
          spec: input.spec,
          nativeId: input.nativeId,
          relations: input.relations,
          ...(input.previous ? { previous: input.previous } : {}),
        }),
      );
      let selectionMatches = false;
      try {
        selectionMatches = sameTakoformImportSelection(resolved.selection, input.selection);
      } catch {
        throw new ProviderMutationDefinitiveRefusalError("resource_busy", 409);
      }
      if (!selectionMatches) {
        throw new ProviderMutationDefinitiveRefusalError("resource_busy", 409);
      }
      if (input.selection.kind === "intrinsic") {
        return { observed: structuredClone(input.spec) };
      }
      if (input.selection.kind === "sqlite-migration") {
        return { observed: structuredClone(input.spec) };
      }
      if (input.selection.kind !== "provider" || !resolved.provider) {
        throw new ProviderMutationDefinitiveRefusalError("backend_unavailable", 503);
      }
      const provider = resolved.provider;
      // The provider object is selected only after the persisted snapshot has
      // been revalidated. The offering and installation sent to it are the
      // retained values, never a fresh catalog projection.
      const offering = structuredClone(input.selection.technicalOffering);
      const providerInstallationRef = input.selection.providerInstallationRef;
      const current = resolved.current;
      const relationTargets = resolved.relationTargets;
      if (!relationTargets) {
        throw new ProviderMutationDefinitiveRefusalError("backend_unavailable", 503);
      }
      const adopt = provider.adopt?.bind(provider);
      if (!adopt) throw new ProviderMutationDefinitiveRefusalError("unsupported_capability", 422);
      const resolvedProviderRelations = () => Promise.resolve(relationTargets);
      let firstTicket: ProviderTicket;
      let wholeOperationProof: "recoverAdopt" | undefined;
      if (input.providerHandle) {
        firstTicket = await pollHandle(
          provider,
          input.operationId,
          input.providerHandle,
          input.executionAuthority,
        );
      } else {
        if (input.operationMode === "recovery") {
          const recoverAdopt = provider.recoverAdopt?.bind(provider);
          if (!recoverAdopt) {
            // Adoption recovery must observe/adopt an existing object;
            // calling `adopt` again could claim it twice.
            throw new ProviderMutationRecoveryError("indeterminate");
          }
          // Relation projection is a read-only driver preflight. Keep it outside
          // the entered Provider call so its explicit refusal remains terminal.
          const relations = await resolvedProviderRelations();
          firstTicket = await enteredProviderMutation(() =>
            recoverAdopt({
              operationId: input.operationId,
              operationMode: "recovery",
              executionAuthority: input.executionAuthority,
              offering,
              nativeId: input.nativeId,
              identity: {
                tenantRef: input.tenantId,
                space: input.space,
                name: input.name,
                uid: input.resourceUid,
                ...(current && input.previous
                  ? {
                      incarnationId: current.id,
                      generation: input.previous.metadata.generation,
                    }
                  : {}),
              },
              spec: input.spec,
              relations,
            }),
          );
          // Only a terminal ticket returned directly by recoverAdopt may carry
          // whole-operation proof. A running result must first cross a poll,
          // whose answer describes that poll invocation and is never trusted
          // for this settlement even if a future caller makes its handle
          // durable before entering settle().
          if (firstTicket.phase === "failed") wholeOperationProof = "recoverAdopt";
        } else {
          const relations = await resolvedProviderRelations();
          firstTicket = await enteredProviderMutation(() =>
            adopt({
              operationId: input.operationId,
              ...(input.operationMode ? { operationMode: input.operationMode } : {}),
              executionAuthority: input.executionAuthority,
              offering,
              nativeId: input.nativeId,
              // The adopting provider needs the Resource UID: a bucket's
              // native name is derived from the incarnation, and adoption is
              // fenced to that exact derivation.
              identity: {
                tenantRef: input.tenantId,
                space: input.space,
                name: input.name,
                uid: input.resourceUid,
                ...(current && input.previous
                  ? {
                      incarnationId: current.id,
                      generation: input.previous.metadata.generation,
                    }
                  : {}),
              },
              spec: input.spec,
              relations,
            }),
          );
        }
      }
      // Adoption bills nothing: the resource already exists and was paid for
      // wherever it came from.
      const result = resultOf(
        await settle(
          provider,
          input.operationId,
          firstTicket,
          input.executionAuthority,
          Boolean(input.providerHandle),
        ),
        {
          operationId: input.operationId,
          mode: input.operationMode === "recovery" ? "recovery" : "initial",
          ...(wholeOperationProof ? { wholeOperationProof } : {}),
        },
      );
      if (result.nativeId !== input.nativeId) {
        throw new TakoformHostError("import_conflict", 409);
      }
      if (input.atomicDeploymentCommit) {
        return {
          ...receiptOf(result),
          deploymentMutation: current
            ? current.nativeClaimed
              ? {
                  kind: "refresh",
                  tenantId: input.tenantId,
                  deploymentId: current.id,
                  expectedNativeId: current.nativeId,
                  observed: result.observed,
                  outputs: deploymentOutputs(result.outputs, input),
                }
              : {
                  kind: "claim",
                  tenantId: input.tenantId,
                  deploymentId: current.id,
                  expectedNativeId: current.nativeId,
                  nativeId: result.nativeId,
                  observed: result.observed,
                  outputs: deploymentOutputs(result.outputs, input),
                }
            : {
                kind: "create",
                deployment: {
                  tenantId: input.tenantId,
                  id: `dep_${input.operationId}`,
                  resourceUid: input.resourceUid,
                  offeringId: offering.id,
                  providerPackRef: provider.id,
                  providerInstallationRef,
                  nativeId: result.nativeId,
                  nativeClaimed: true,
                  state: "active",
                  observed: result.observed,
                  outputs: deploymentOutputs(result.outputs, input),
                },
              },
        };
      }
      if (current) {
        // Recording the claim is the whole point of an import, and it is
        // recorded even when the named object is the one already deployed:
        // otherwise the first import would leave nothing behind and the next
        // workspace would adopt the same object unopposed. The fence is in the
        // ledger, so a concurrent import cannot record two first claims.
        if (current.nativeClaimed) {
          await refresh(current, result, deploymentOutputs(result.outputs, input));
        } else if (
          !(await deployments.claimNative({
            tenantId: input.tenantId,
            deploymentId: current.id,
            expectedNativeId: current.nativeId,
            nativeId: result.nativeId,
            observed: result.observed,
            outputs: deploymentOutputs(result.outputs, input),
          }))
        ) {
          throw new TakoformHostError("resource_busy", 409);
        }
      } else {
        try {
          await deployments.create({
            tenantId: input.tenantId,
            id: `dep_${input.operationId}`,
            resourceUid: input.resourceUid,
            offeringId: offering.id,
            providerPackRef: provider.id,
            providerInstallationRef,
            nativeId: result.nativeId,
            nativeClaimed: true,
            state: "active",
            observed: result.observed,
            outputs: deploymentOutputs(result.outputs, input),
          });
        } catch {
          throw new TakoformHostError("resource_busy", 409);
        }
      }
      return receiptOf(result);
    },
  };
}

/**
 * Answers only for exact capabilities the concrete provider composition can
 * execute. Definition installation remains independent, so unsupported
 * families stay discoverable without being advertised as active runtime.
 */
export function createProviderFormAvailability(
  providers: readonly Provider[],
): TakoformFormAvailabilityResolver {
  const backed = providers.flatMap((provider) =>
    provider.offerings.map((offering) => offering.form),
  );
  return {
    async resolve({ form }) {
      const executable =
        (form.identity.formRef.apiVersion === "edge.forms.takoform.com" &&
          INTRINSIC_FORMS.has(form.identity.formRef.kind)) ||
        backed.some((candidate) => sameForm(candidate, form.identity.formRef));
      return {
        executable,
        activated: executable,
        availableToPrincipal: executable,
      };
    },
  };
}

export const TAKOSERVER_INTRINSIC_HANDLER_KINDS = [
  "WorkerBundle",
  "StaticAssetBundle",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
] as const;

const INTRINSIC_FORMS = new Set<string>(TAKOSERVER_INTRINSIC_HANDLER_KINDS);

function intrinsicForm(form: InstalledTakoformForm): boolean {
  return intrinsicFormRef(form.identity.formRef);
}

function intrinsicFormRef(form: TakoformV1Alpha3FormRef): boolean {
  return isEdgeFormsApiVersion(form.apiVersion) && INTRINSIC_FORMS.has(form.kind);
}

function phaseRank(phase: "planned" | "dispatched" | "succeeded" | "cancelled"): number {
  switch (phase) {
    case "planned":
      return 0;
    case "dispatched":
      return 1;
    case "succeeded":
    case "cancelled":
      return 2;
  }
}

function sameForm(left: TakoformV1Alpha3FormRef, right: TakoformV1Alpha3FormRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function endpointReservationHostError(error: unknown): TakoformHostError {
  if (!(error instanceof WorkerEndpointOriginReservationError)) {
    return new TakoformHostError("backend_unavailable", 503);
  }
  // A reservation refusal that names this deployment's own configuration
  // carries its sentence across: the code alone tells an operator that
  // something about the Host is wrong and nothing about which knob to turn.
  const detail = error.publicMessage;
  switch (error.code) {
    case "invalid_argument":
      return new TakoformHostError("invalid_argument", 400, undefined, detail);
    case "not_found":
      return new TakoformHostError("resource_not_found", 404, undefined, detail);
    case "conflict":
      return new TakoformHostError("resource_busy", 409, undefined, detail);
    case "unsupported_capability":
      return new TakoformHostError("unsupported_capability", 422, undefined, detail);
    case "backend_unavailable":
      return new TakoformHostError("backend_unavailable", 503, undefined, detail);
  }
}

export function failureToWire(code: string): [string, number] {
  switch (code) {
    case "invalid_spec":
      return ["invalid_argument", 400];
    case "conflict":
      return ["resource_busy", 409];
    case "occupied":
      // Not `resource_busy`: that is in the released provider's automatic
      // retry table and its repair line says to wait and re-run, which never
      // empties a bucket. `dependency_in_use` is outside that table and its
      // repair line is the true one — remove what the message names first.
      return ["dependency_in_use", 409];
    case "not_found":
      return ["resource_not_found", 404];
    case "denied":
      // The credential a provider refused is *ours*, not the caller's. Told
      // "permission denied", a customer checks their own key, their own
      // scopes, and their own account, and finds nothing wrong — because
      // nothing is. This is our misconfiguration or our outage, and it is
      // retryable in the only sense that matters: it will work once we fix it.
      return ["backend_unavailable", 503];
    case "quota":
      return ["quota_exceeded", 409];
    case "timeout":
      return ["deadline_exceeded", 504];
    default:
      return ["backend_unavailable", 503];
  }
}
