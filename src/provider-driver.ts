import type { Catalog } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { isEdgeFormsApiVersion } from "./form-ref.ts";
import { canonicalDigest } from "./json.ts";
import type { Ledger } from "./ledger.ts";
import type { JsonObject } from "./ports.ts";
import type { ProviderPack } from "./provider-pack.ts";
import { createSoldProviderPlacementSelector } from "./provider-placement.ts";
import type {
  Provider,
  ProviderNativeAbsence,
  ProviderNativeReadbackDescriptor,
  ProviderOffering,
  ProviderRelation,
  ProviderResult,
  ProviderTicket,
  ProviderValue,
} from "./provider-port.ts";
import {
  canMaterializeAcrossProviderPacks,
  materializeProviderRuntimeBindings,
} from "./provider-runtime-bindings.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";
import { validateMaximumRuntimeInputBindings } from "./takoform/forms.ts";
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
import {
  type WorkerEndpointOriginAssignment,
  WorkerEndpointOriginReservationError,
  type WorkerEndpointOriginReservations,
} from "./worker-endpoint-origin-reservations.ts";

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
  ) {
    super(code, status);
    this.name = "ProviderMutationRecoveryError";
  }
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
    | "assignEndpoint"
    | "cancelEndpointAssignment"
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

export function createProviderDriver(options: CreateProviderDriverOptions): TakoformResourceDriver {
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
  // selector. Build the closed catalog authority up front: if one pack is
  // advertised for multiple installations, readback cannot safely choose one
  // and every historical deployment under that pack must fail closed.
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
        return {
          ...structuredClone(relation),
          ...(deployment ? { deployment } : {}),
        };
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

  /** Drives a ticket to a terminal state within the inline budget. */
  const settle = async (
    provider: Provider,
    operationId: string,
    first: ProviderTicket,
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
        await sleep(ticket.pollAfterMs);
        ticket = await provider.poll({ operationId, handle: ticket.handle });
      } catch {
        // The opaque handle was durable before entering this loop. Preserve it
        // when a transport or scheduler failure leaves the outcome unknown.
        throw new ProviderMutationRecoveryError("indeterminate", handle);
      }
      if (ticket.phase === "running") {
        handle = ticket.handle;
      } else if (ticket.phase === "failed" && ticket.failure.retryable && handle) {
        // Keep the handle beside a retryable poll fault. The next executor
        // must retry the same operation, never dispatch a fresh mutation.
        ticket = { ...ticket, handle };
      }
    }
    return ticket;
  };

  const pollHandle = async (
    provider: Provider,
    operationId: string,
    handle: string,
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
      const ticket = await provider.poll({ operationId, handle });
      return ticket.phase === "failed" && ticket.failure.retryable && !ticket.handle
        ? { ...ticket, handle }
        : ticket;
    } catch {
      throw new ProviderMutationRecoveryError("indeterminate", handle);
    }
  };

  const resultOf = (ticket: ProviderTicket): ProviderResult => {
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
      throw new ProviderMutationRecoveryError("indeterminate", ticket.handle, code, status);
    }
    throw new TakoformHostError(...failureToWire(ticket.failure.code));
  };

  /**
   * Holds the price, runs the work, then captures or releases. A crash between
   * hold and settlement leaves an earmark the reservation sweep returns.
   */
  const charged = async (
    organizationId: string,
    operationId: string,
    priceMinor: number,
    work: () => Promise<ProviderTicket>,
  ): Promise<ProviderResult> => {
    if (priceMinor === 0) return resultOf(await work());
    const held = await ledger.hold({
      organizationId,
      reference: operationId,
      amountMinor: priceMinor,
    });
    if (!held) throw new TakoformHostError("insufficient_funds", 402);
    // A provider recovery error means dispatch was accepted but the driver did
    // not observe a terminal result. The durable hold is the only authority
    // keeping this operation's price earmarked while a restarted executor
    // polls/adopts the same operation. A thrown adapter error is likewise not
    // definitive proof of a pre-dispatch failure, so the hold remains.
    const ticket = await work();
    if (ticket.phase === "succeeded") {
      await ledger.capture({
        organizationId,
        reference: operationId,
        amountMinor: priceMinor,
      });
      return ticket.result;
    }
    try {
      // `running` and retryable `failed` tickets are recovery outcomes. Call
      // resultOf before releasing so both retain the hold for the next poll or
      // same-operation retry.
      return resultOf(ticket);
    } catch (error) {
      if (error instanceof ProviderMutationRecoveryError) throw error;
      await ledger.release({
        organizationId,
        reference: operationId,
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
    input: { readonly resourceUid: string; readonly space: string; readonly name: string },
  ): ProviderResult["outputs"] => ({
    ...structuredClone(outputs),
    __takoserver: {
      resourceUid: input.resourceUid,
      space: input.space,
      name: input.name,
    },
  });

  const deploymentMarker = (
    outputs: JsonObject,
  ): {
    readonly resourceUid: string;
    readonly space: string;
    readonly name: string;
    readonly deleteOperationId?: string;
  } | null => {
    const value = outputs.__takoserver;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const marker = value as Record<string, unknown>;
    if (
      typeof marker.resourceUid !== "string" ||
      typeof marker.space !== "string" ||
      typeof marker.name !== "string"
    ) {
      return null;
    }
    return {
      resourceUid: marker.resourceUid,
      space: marker.space,
      name: marker.name,
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

  const active = async (tenantId: string, resourceUid: string): Promise<ResourceDeployment> => {
    const deployment = await deployments.active(tenantId, resourceUid);
    if (!deployment) throw new TakoformHostError("resource_not_found", 404);
    return deployment;
  };

  const refresh = async (deployment: ResourceDeployment, result: ProviderResult): Promise<void> => {
    if (
      result.nativeId !== deployment.nativeId ||
      !(await deployments.refresh(
        deployment.tenantId,
        deployment.id,
        deployment.nativeId,
        result.observed,
        result.outputs,
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

  const providerValue = <T>(result: ProviderValue<T>): T => {
    if (result.ok) return result.value as T;
    throw new TakoformHostError(...failureToWire(result.failure.code));
  };

  return {
    runtimeInputPolicy,
    sqliteMigrations: {
      async readLedger(input) {
        const { deployment, port } = await sqliteProvider(input.tenantId, input.database);
        return providerValue(await port.readLedger({ nativeId: deployment.nativeId }));
      },
      async applySuffix(input) {
        const { deployment, port } = await sqliteProvider(input.tenantId, input.database);
        providerValue(
          await port.applySuffix({
            nativeId: deployment.nativeId,
            expectedPrefix: input.expectedPrefix,
            migrations: input.migrations,
          }),
        );
      },
    },
    async apply(input): Promise<TakoformDriverReceipt> {
      const current = await deployments.active(input.tenantId, input.resourceUid);
      if (intrinsicForm(input.form)) {
        if (current) throw new TakoformHostError("backend_unavailable", 503);
        return { observed: structuredClone(input.spec) };
      }
      const { provider, offering, soldSelection, inheritedSelection } = await selectForMutation({
        tenantId: input.tenantId,
        form: input.form,
        relations: input.relations,
        ...(input.commercialAuthority ? { offeringId: input.commercialAuthority.offeringId } : {}),
      });
      assertProviderRuntimeInputs(provider, input.spec);
      const sold = soldSelection?.sold;
      const priceMinor = soldSelection?.priceMinor ?? 0;
      const relationTargets =
        inheritedSelection?.relations ?? (await providerRelations(input.tenantId, input.relations));
      if (
        sold &&
        input.commercialAuthority &&
        (input.commercialAuthority.offeringId !== sold.id ||
          (!current && input.commercialAuthority.offeringDigest !== (await catalog.digest(sold))))
      ) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      if (
        current &&
        (current.offeringId !== offering.id ||
          current.providerPackRef !== provider.id ||
          current.providerInstallationRef !==
            (sold?.providerInstallationRef ?? inheritedSelection?.providerInstallationRef))
      ) {
        // Moving supply is a Migration, never an ordinary Resource update.
        throw new TakoformHostError("unsupported_capability", 422);
      }
      const previous = current
        ? {
            nativeId: current.nativeId,
            spec: input.previous?.spec ?? input.spec,
          }
        : undefined;
      const providerInstallationRef =
        sold?.providerInstallationRef ??
        inheritedSelection?.providerInstallationRef ??
        (() => {
          throw new TakoformHostError("backend_unavailable", 503);
        })();
      const providerIdentity = {
        tenantRef: input.tenantId,
        space: input.space,
        name: input.name,
        uid: input.resourceUid,
      } as const;
      const runtimeBindings = await materializeProviderRuntimeBindings({
        tenantId: input.tenantId,
        source: providerIdentity,
        sourceSpec: input.spec,
        consumerPack: packsById.get(provider.id),
        packs: packsById,
        relations: relationTargets,
      });
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
      let endpointAssignment: WorkerEndpointOriginAssignment | undefined;
      if (input.form.identity.formRef.kind === "WorkerEndpoint") {
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
        if (current) {
          try {
            endpointAssignment =
              (await originReservations.endpointAssignment(input.tenantId, input.resourceUid)) ??
              undefined;
          } catch (error) {
            throw endpointReservationHostError(error);
          }
          if (
            !endpointAssignment ||
            (input.workerEndpointOriginReservationId !== undefined &&
              input.workerEndpointOriginReservationId !== endpointAssignment.reservationId) ||
            endpointAssignment.endpoint.space !== input.space ||
            endpointAssignment.endpoint.name !== input.name ||
            endpointAssignment.endpoint.uid !== input.resourceUid ||
            endpointAssignment.worker.name !== worker.metadata.name ||
            endpointAssignment.worker.uid !== worker.metadata.uid ||
            endpointAssignment.worker.revision !== worker.metadata.revision ||
            endpointAssignment.placement.providerPackRef !== provider.id ||
            endpointAssignment.placement.providerInstallationRef !== providerInstallationRef
          ) {
            throw new TakoformHostError("resource_busy", 409);
          }
        } else {
          if (input.workerEndpointOriginReservationId === undefined) {
            throw new TakoformHostError("unsupported_capability", 422);
          }
          try {
            endpointAssignment = await originReservations.assignEndpoint({
              organizationId: input.tenantId,
              reservationId: input.workerEndpointOriginReservationId,
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
      }
      const providerInput = {
        operationId: input.operationId,
        operationKey: input.operationKey,
        ...(input.publicApply ? { publicApply: input.publicApply } : {}),
        ...(input.operationMode ? { operationMode: input.operationMode } : {}),
        offering,
        identity: providerIdentity,
        spec: input.spec,
        relations: relationTargets,
        ...(runtimeBindings.length > 0 ? { runtimeBindings } : {}),
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
      const work = async () => {
        providerBoundaryEntered = true;
        const ticket = await settle(
          provider,
          input.operationId,
          input.providerHandle
            ? await pollHandle(provider, input.operationId, input.providerHandle)
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
              : await provider.apply(providerInput),
          Boolean(input.providerHandle),
        );
        if (endpointAssignment && ticket.phase === "succeeded") {
          try {
            await originReservations?.activateEndpointAssignment({
              assignment: endpointAssignment,
              providerOutputs: ticket.result.outputs,
            });
          } catch (error) {
            throw endpointReservationHostError(error);
          }
        }
        return ticket;
      };
      // A reseller reservation already holds this exact Offering's price.
      // Charging the organization wallet again here would double-settle the
      // same Resource. Direct organization credentials have no such authority
      // and retain the ordinary hold/capture path.
      let result: ProviderResult;
      try {
        result =
          input.commercialAuthority || priceMinor === 0
            ? resultOf(await work())
            : await charged(input.tenantId, input.operationId, priceMinor, work);
      } catch (error) {
        if (endpointAssignment && !providerBoundaryEntered) {
          try {
            await originReservations?.cancelEndpointAssignment(endpointAssignment);
          } catch (cancelError) {
            throw endpointReservationHostError(cancelError);
          }
        }
        throw error;
      }
      if (input.atomicDeploymentCommit) {
        return {
          ...receiptOf(result),
          deploymentMutation: current
            ? {
                kind: "refresh",
                tenantId: input.tenantId,
                deploymentId: current.id,
                expectedNativeId: current.nativeId,
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
                  state: "active",
                  observed: result.observed,
                  outputs: deploymentOutputs(result.outputs, input),
                },
              },
        };
      }
      if (current) {
        await refresh(current, result);
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
          },
          spec: input.resource.spec,
          relations: await providerRelations(input.tenantId, input.relations),
        }),
      );
      await refresh(deployment, result);
      return receiptOf(result);
    },

    // biome-ignore lint/suspicious/noConfusingVoidType: the driver contract intentionally allows no receipt for intrinsic resources
    async delete(input): Promise<TakoformDriverReceipt | void> {
      if (intrinsicFormRef(input.resource.form.formRef)) return;
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
      const ticket = await settle(
        provider,
        input.operationId,
        input.providerHandle
          ? await pollHandle(provider, input.operationId, input.providerHandle)
          : input.operationMode === "recovery"
            ? provider.recoverDelete
              ? await provider.recoverDelete({
                  operationId: input.operationId,
                  operationMode: "recovery",
                  offering,
                  nativeId: deployment.nativeId,
                  identity: {
                    tenantRef: input.tenantId,
                    space: input.resource.metadata.space,
                    name: input.resource.metadata.name,
                  },
                  spec: input.resource.spec,
                  relations: await providerRelations(input.tenantId, input.relations),
                })
              : (() => {
                  // A lost DELETE acknowledgement has no safe replay. Only a
                  // provider-owned deterministic readback may settle it.
                  throw new ProviderMutationRecoveryError("indeterminate");
                })()
            : await provider.delete({
                operationId: input.operationId,
                ...(input.operationMode ? { operationMode: input.operationMode } : {}),
                offering,
                nativeId: deployment.nativeId,
                identity: {
                  tenantRef: input.tenantId,
                  space: input.resource.metadata.space,
                  name: input.resource.metadata.name,
                },
                spec: input.resource.spec,
                relations: await providerRelations(input.tenantId, input.relations),
              }),
        Boolean(input.providerHandle),
      );
      const result = resultOf(ticket);
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
                  outputs: result.outputs,
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
              result.outputs,
              {
                operationId: input.operationId,
                resourceUid: input.resourceUid,
                space: input.resource.metadata.space,
                name: input.resource.metadata.name,
              },
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
        // the same offering id. Resolve the exact current catalog tuple first;
        // a Form-family advance may cross that tuple only through an exact
        // recovery-only capability. A missing/retired/drifted installation
        // fails closed without a native provider readback call.
        const catalogOffering = catalog.findOffering(deployment.offeringId);
        if (
          !catalogOffering ||
          catalogOffering.providerPackRef !== deployment.providerPackRef ||
          catalogOffering.providerInstallationRef !== deployment.providerInstallationRef
        ) {
          return await attest("indeterminate", "provider_unavailable");
        }
        const installationRefs = installationsByPack.get(deployment.providerPackRef);
        if (
          installationRefs?.size !== 1 ||
          !installationRefs?.has(deployment.providerInstallationRef)
        ) {
          return await attest("indeterminate", "provider_unavailable");
        }
        const provider = byId.get(deployment.providerPackRef);
        const currentOffering = provider?.offerings.find(
          (candidate) =>
            candidate.id === deployment.offeringId && sameForm(candidate.form, tombstone.formRef),
        );
        const recoveryOffering = provider?.recoveryOfferings?.find(
          (candidate) =>
            candidate.id === deployment.offeringId && sameForm(candidate.form, tombstone.formRef),
        );
        const offering = sameForm(catalogOffering.form, tombstone.formRef)
          ? (currentOffering ?? recoveryOffering)
          : recoveryOffering;
        if (
          !provider ||
          !offering ||
          !sameForm(offering.form, tombstone.formRef) ||
          !provider.createNativeReadbackDescriptor ||
          !provider.verifyNativeAbsence
        ) {
          return await attest("indeterminate", "provider_unavailable");
        }
        let descriptor: ProviderNativeReadbackDescriptor;
        try {
          descriptor = provider.createNativeReadbackDescriptor({
            offering,
            nativeId: deployment.nativeId,
            identity: { tenantRef: input.tenantId, space: input.space, name: input.name },
            spec: deployment.observed,
          });
        } catch {
          return await attest("indeterminate", "provider_readback_failed");
        }
        let proof: ProviderNativeAbsence;
        try {
          proof = await provider.verifyNativeAbsence({ offering, descriptor });
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
      if (intrinsicForm(input.form)) return { observed: structuredClone(input.spec) };
      const soldSelection =
        input.form.role === "identity" ||
        catalog.offeringsFor(input.form.identity.formRef).length > 0
          ? selectSold(input.form)
          : undefined;
      const inheritedSelection = soldSelection
        ? undefined
        : await inherited(input.tenantId, input.form, input.relations);
      const provider = soldSelection?.provider ?? inheritedSelection?.provider;
      const offering = soldSelection?.offering ?? inheritedSelection?.offering;
      const sold = soldSelection?.sold;
      const providerInstallationRef =
        sold?.providerInstallationRef ?? inheritedSelection?.providerInstallationRef;
      if (!provider || !offering || !providerInstallationRef) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      if (!provider.adopt) throw new TakoformHostError("unsupported_capability", 422);
      const claim = await deployments.findByNative(
        input.tenantId,
        providerInstallationRef,
        input.nativeId,
      );
      const current = await deployments.active(input.tenantId, input.resourceUid);
      // A claim is immutable from the moment it is made, but a native id this
      // host MINTED is not a claim: the ordinary import onto an address a
      // configuration already manages names the object for the first time, and
      // a host that refused it could never be imported into at all. So the
      // refusal is a claim that already exists and names another object, never
      // the mere presence of a minted one.
      if (
        (claim && claim.resourceUid !== input.resourceUid) ||
        (current &&
          ((current.nativeClaimed && current.nativeId !== input.nativeId) ||
            current.offeringId !== offering.id ||
            current.providerInstallationRef !== providerInstallationRef))
      ) {
        throw new TakoformHostError("import_conflict", 409);
      }
      // Adoption bills nothing: the resource already exists and was paid for
      // wherever it came from.
      const result = resultOf(
        await settle(
          provider,
          input.operationId,
          input.providerHandle
            ? await pollHandle(provider, input.operationId, input.providerHandle)
            : input.operationMode === "recovery"
              ? provider.recoverAdopt
                ? await provider.recoverAdopt({
                    operationId: input.operationId,
                    operationMode: "recovery",
                    offering,
                    nativeId: input.nativeId,
                    identity: {
                      tenantRef: input.tenantId,
                      space: input.space,
                      name: input.name,
                      uid: input.resourceUid,
                    },
                    spec: input.spec,
                    relations: await providerRelations(input.tenantId, input.relations),
                  })
                : (() => {
                    // Adoption recovery must observe/adopt an existing object;
                    // calling `adopt` again could claim it twice.
                    throw new ProviderMutationRecoveryError("indeterminate");
                  })()
              : await provider.adopt({
                  operationId: input.operationId,
                  ...(input.operationMode ? { operationMode: input.operationMode } : {}),
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
                  },
                  spec: input.spec,
                  relations: await providerRelations(input.tenantId, input.relations),
                }),
          Boolean(input.providerHandle),
        ),
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
          await refresh(current, result);
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
  switch (error.code) {
    case "invalid_argument":
      return new TakoformHostError("invalid_argument", 400);
    case "not_found":
      return new TakoformHostError("resource_not_found", 404);
    case "conflict":
      return new TakoformHostError("resource_busy", 409);
    case "unsupported_capability":
      return new TakoformHostError("unsupported_capability", 422);
    case "backend_unavailable":
      return new TakoformHostError("backend_unavailable", 503);
  }
}

export function failureToWire(code: string): [string, number] {
  switch (code) {
    case "invalid_spec":
      return ["invalid_argument", 400];
    case "conflict":
      return ["resource_busy", 409];
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
