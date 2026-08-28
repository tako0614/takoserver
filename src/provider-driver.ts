import type { Catalog } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { isEdgeFormsApiVersion } from "./form-ref.ts";
import type { Ledger } from "./ledger.ts";
import type {
  Provider,
  ProviderOffering,
  ProviderRelation,
  ProviderResult,
  ProviderTicket,
  ProviderValue,
} from "./provider-port.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverReceipt,
  TakoformDriverRelation,
  TakoformFormAvailabilityResolver,
  TakoformResourceDriver,
  TakoformStoredResource,
} from "./takoform/types.ts";
import { TakoformHostError } from "./takoform/types.ts";

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
  readonly catalog: Catalog;
  readonly ledger: Ledger;
  readonly deployments: ResourceDeploymentStore;
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
  const { providers, catalog, ledger, deployments } = options;
  const pollBudget = options.inlinePollBudget ?? 5;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  const selectSold = (
    form: InstalledTakoformForm,
    offeringId?: string,
  ): {
    provider: Provider;
    offering: ProviderOffering;
    sold: ReturnType<Catalog["offeringsFor"]>[number];
    priceMinor: number;
  } => {
    const matches = catalog.offeringsFor(form.identity.formRef);
    const sold = offeringId
      ? matches.find((candidate) => candidate.id === offeringId)
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (!sold) throw new TakoformHostError("unsupported_capability", 422);
    const provider = byId.get(sold.providerPackRef);
    const offering = provider?.offerings.find((candidate) => candidate.id === sold.id);
    if (!provider || !offering) throw new TakoformHostError("backend_unavailable", 503);
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
    const parents = resolved.flatMap((relation) =>
      relation.deployment ? [relation.deployment] : [],
    );
    if (parents.length === 0) throw new TakoformHostError("unsupported_capability", 422);
    const providerPackRef = parents[0]?.providerPackRef;
    const providerInstallationRef = parents[0]?.providerInstallationRef;
    if (
      !providerPackRef ||
      !providerInstallationRef ||
      parents.some(
        (deployment) =>
          deployment.providerPackRef !== providerPackRef ||
          deployment.providerInstallationRef !== providerInstallationRef,
      )
    ) {
      // A native attachment cannot silently bridge two provider accounts.
      throw new TakoformHostError("unsupported_capability", 422);
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

  /** Drives a ticket to a terminal state within the inline budget. */
  const settle = async (
    provider: Provider,
    operationId: string,
    first: ProviderTicket,
  ): Promise<ProviderTicket> => {
    let ticket = first;
    for (let attempt = 0; ticket.phase === "running" && attempt < pollBudget; attempt += 1) {
      if (!provider.poll) break;
      await sleep(ticket.pollAfterMs);
      ticket = await provider.poll({ operationId, handle: ticket.handle });
    }
    return ticket;
  };

  const resultOf = (ticket: ProviderTicket): ProviderResult => {
    if (ticket.phase === "succeeded") {
      return ticket.result;
    }
    if (ticket.phase === "running") {
      // Still working when the budget ran out. Saying so is honest; claiming
      // success would record a resource the backend has not made yet.
      throw new TakoformHostError("backend_unavailable", 503);
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
    let ticket: ProviderTicket;
    try {
      ticket = await work();
    } catch (error) {
      await ledger.release({
        organizationId,
        reference: operationId,
        amountMinor: priceMinor,
      });
      throw error;
    }
    if (ticket.phase === "succeeded") {
      await ledger.capture({
        organizationId,
        reference: operationId,
        amountMinor: priceMinor,
      });
    } else {
      await ledger.release({
        organizationId,
        reference: operationId,
        amountMinor: priceMinor,
      });
    }
    return resultOf(ticket);
  };

  const receiptOf = (result: ProviderResult): TakoformDriverReceipt => ({
    observed: result.observed,
    outputs: result.outputs,
  });

  const installed = (
    deployment: ResourceDeployment,
    form: TakoformV1Alpha3FormRef,
  ): { provider: Provider; offering: ProviderOffering } => {
    const provider = byId.get(deployment.providerPackRef);
    const offering = provider?.offerings.find(
      (candidate) => candidate.id === deployment.offeringId,
    );
    const sold = catalog.findOffering(deployment.offeringId);
    if (
      !provider ||
      !offering ||
      !sameForm(offering.form, form) ||
      (sold !== undefined &&
        (sold.providerPackRef !== deployment.providerPackRef ||
          sold.providerInstallationRef !== deployment.providerInstallationRef ||
          !sameForm(sold.form, form)))
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
      const soldSelection =
        input.form.role === "identity" ||
        catalog.offeringsFor(input.form.identity.formRef).length > 0
          ? selectSold(input.form, input.commercialAuthority?.offeringId)
          : undefined;
      const inheritedSelection = soldSelection
        ? undefined
        : await inherited(input.tenantId, input.form, input.relations);
      const provider = soldSelection?.provider ?? inheritedSelection?.provider;
      const offering = soldSelection?.offering ?? inheritedSelection?.offering;
      if (!provider || !offering) throw new TakoformHostError("unsupported_capability", 422);
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
      const work = async () =>
        await settle(
          provider,
          input.operationId,
          await provider.apply({
            operationId: input.operationId,
            ...(input.operationMode ? { operationMode: input.operationMode } : {}),
            offering,
            identity: {
              tenantRef: input.tenantId,
              space: input.space,
              name: input.name,
            },
            spec: input.spec,
            relations: relationTargets,
            ...(input.runtimeMaterialization
              ? { runtimeMaterialization: input.runtimeMaterialization }
              : {}),
            ...(input.standardServices
              ? { standardServices: structuredClone(input.standardServices) }
              : {}),
            ...(previous ? { previous } : {}),
          }),
        );
      // A reseller reservation already holds this exact Offering's price.
      // Charging the organization wallet again here would double-settle the
      // same Resource. Direct organization credentials have no such authority
      // and retain the ordinary hold/capture path.
      const result =
        input.commercialAuthority || priceMinor === 0
          ? resultOf(await work())
          : await charged(input.tenantId, input.operationId, priceMinor, work);
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
                outputs: result.outputs,
              }
            : {
                kind: "create",
                deployment: {
                  tenantId: input.tenantId,
                  id: `dep_${input.operationId}`,
                  resourceUid: input.resourceUid,
                  offeringId: offering.id,
                  providerPackRef: provider.id,
                  providerInstallationRef:
                    sold?.providerInstallationRef ??
                    inheritedSelection?.providerInstallationRef ??
                    (() => {
                      throw new TakoformHostError("backend_unavailable", 503);
                    })(),
                  nativeId: result.nativeId,
                  state: "active",
                  observed: result.observed,
                  outputs: result.outputs,
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
            providerInstallationRef:
              sold?.providerInstallationRef ??
              inheritedSelection?.providerInstallationRef ??
              (() => {
                throw new TakoformHostError("backend_unavailable", 503);
              })(),
            nativeId: result.nativeId,
            state: "active",
            observed: result.observed,
            outputs: result.outputs,
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
      const ticket = await settle(
        provider,
        input.operationId,
        await provider.delete({
          operationId: input.operationId,
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
      const result = resultOf(ticket);
      if (result.nativeId !== deployment.nativeId) {
        throw new TakoformHostError("resource_busy", 409);
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
                }
              : {
                  kind: "delete",
                  tenantId: input.tenantId,
                  deploymentId: deployment.id,
                  expectedNativeId: deployment.nativeId,
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
            )
          : await deployments.markDeleted(input.tenantId, deployment.id, deployment.nativeId);
      if (!recorded) {
        throw new TakoformHostError("resource_busy", 409);
      }
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
        await provider.adopt({
          offering,
          nativeId: input.nativeId,
          identity: {
            tenantRef: input.tenantId,
            space: input.space,
            name: input.name,
          },
          spec: input.spec,
          relations: await providerRelations(input.tenantId, input.relations),
        }),
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
                  outputs: result.outputs,
                }
              : {
                  kind: "claim",
                  tenantId: input.tenantId,
                  deploymentId: current.id,
                  expectedNativeId: current.nativeId,
                  nativeId: result.nativeId,
                  observed: result.observed,
                  outputs: result.outputs,
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
                  outputs: result.outputs,
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
            outputs: result.outputs,
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
            outputs: result.outputs,
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

const INTRINSIC_FORMS = new Set([
  "WorkerBundle",
  "StaticAssetBundle",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
]);

function intrinsicForm(form: InstalledTakoformForm): boolean {
  return intrinsicFormRef(form.identity.formRef);
}

function intrinsicFormRef(form: TakoformV1Alpha3FormRef): boolean {
  return isEdgeFormsApiVersion(form.apiVersion) && INTRINSIC_FORMS.has(form.kind);
}

function sameForm(left: TakoformV1Alpha3FormRef, right: TakoformV1Alpha3FormRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
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
