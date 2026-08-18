import type { Catalog } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { Ledger } from "./ledger.ts";
import type {
  Provider,
  ProviderOffering,
  ProviderResult,
  ProviderTicket,
} from "./provider-port.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverReceipt,
  TakoformResourceDriver,
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

  const select = (
    form: InstalledTakoformForm,
  ): {
    provider: Provider;
    offering: ProviderOffering;
    sold: ReturnType<Catalog["offeringsFor"]>[number];
    priceMinor: number;
  } => {
    const matches = catalog.offeringsFor(form.identity.formRef);
    const sold = matches.length === 1 ? matches[0] : undefined;
    if (!sold) throw new TakoformHostError("unsupported_capability", 422);
    const provider = byId.get(sold.providerPackRef);
    const offering = provider?.offerings.find((candidate) => candidate.id === sold.id);
    if (!provider || !offering) throw new TakoformHostError("backend_unavailable", 503);
    return { provider, offering, sold, priceMinor: sold.pricePlan.recurring.amountMinor };
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
      await ledger.release({ organizationId, reference: operationId, amountMinor: priceMinor });
      throw error;
    }
    if (ticket.phase === "succeeded") {
      await ledger.capture({ organizationId, reference: operationId, amountMinor: priceMinor });
    } else {
      await ledger.release({ organizationId, reference: operationId, amountMinor: priceMinor });
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
    const sold = catalog.findOffering(deployment.offeringId);
    if (
      !sold ||
      sold.providerPackRef !== deployment.providerPackRef ||
      sold.providerInstallationRef !== deployment.providerInstallationRef ||
      sold.form.apiVersion !== form.apiVersion ||
      sold.form.kind !== form.kind ||
      sold.form.definitionVersion !== form.definitionVersion ||
      sold.form.schemaDigest !== form.schemaDigest
    ) {
      throw new TakoformHostError("backend_unavailable", 503);
    }
    const provider = byId.get(deployment.providerPackRef);
    const offering = provider?.offerings.find(
      (candidate) => candidate.id === deployment.offeringId,
    );
    if (!provider || !offering) throw new TakoformHostError("backend_unavailable", 503);
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

  return {
    async apply(input): Promise<TakoformDriverReceipt> {
      const { provider, offering, sold, priceMinor } = select(input.form);
      const current = await deployments.active(input.tenantId, input.resourceUid);
      if (
        input.commercialAuthority &&
        (input.commercialAuthority.offeringId !== sold.id ||
          (!current && input.commercialAuthority.offeringDigest !== (await catalog.digest(sold))))
      ) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      if (
        current &&
        (current.offeringId !== sold.id ||
          current.providerPackRef !== sold.providerPackRef ||
          current.providerInstallationRef !== sold.providerInstallationRef)
      ) {
        // Moving supply is a Migration, never an ordinary Resource update.
        throw new TakoformHostError("unsupported_capability", 422);
      }
      const previous = current
        ? { nativeId: current.nativeId, spec: input.previous?.spec ?? input.spec }
        : undefined;
      const work = async () =>
        await settle(
          provider,
          input.operationId,
          await provider.apply({
            operationId: input.operationId,
            offering,
            identity: { tenantRef: input.tenantId, space: input.space, name: input.name },
            spec: input.spec,
            ...(previous ? { previous } : {}),
          }),
        );
      // A reseller reservation already holds this exact Offering's price.
      // Charging the organization wallet again here would double-settle the
      // same Resource. Direct organization credentials have no such authority
      // and retain the ordinary hold/capture path.
      const result = input.commercialAuthority
        ? resultOf(await work())
        : await charged(input.tenantId, input.operationId, priceMinor, work);
      if (current) {
        await refresh(current, result);
      } else {
        try {
          await deployments.create({
            tenantId: input.tenantId,
            id: `dep_${input.operationId}`,
            resourceUid: input.resourceUid,
            offeringId: sold.id,
            providerPackRef: sold.providerPackRef,
            providerInstallationRef: sold.providerInstallationRef,
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
        }),
      );
      await refresh(deployment, result);
      return receiptOf(result);
    },

    async delete(input): Promise<void> {
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
        }),
      );
      const result = resultOf(ticket);
      if (
        result.nativeId !== deployment.nativeId ||
        !(await deployments.markDeleted(input.tenantId, deployment.id, deployment.nativeId))
      ) {
        throw new TakoformHostError("resource_busy", 409);
      }
    },

    async import(input): Promise<TakoformDriverReceipt> {
      const { provider, offering, sold } = select(input.form);
      if (!provider.adopt) throw new TakoformHostError("unsupported_capability", 422);
      const claim = await deployments.findByNative(
        input.tenantId,
        sold.providerInstallationRef,
        input.nativeId,
      );
      const current = await deployments.active(input.tenantId, input.resourceUid);
      if (
        (claim && claim.resourceUid !== input.resourceUid) ||
        (current &&
          (current.nativeId !== input.nativeId ||
            current.offeringId !== sold.id ||
            current.providerInstallationRef !== sold.providerInstallationRef))
      ) {
        throw new TakoformHostError("import_conflict", 409);
      }
      // Adoption bills nothing: the resource already exists and was paid for
      // wherever it came from.
      const result = resultOf(
        await provider.adopt({
          offering,
          nativeId: input.nativeId,
          identity: { tenantRef: input.tenantId, space: input.space, name: input.name },
          spec: input.spec,
        }),
      );
      if (result.nativeId !== input.nativeId) {
        throw new TakoformHostError("import_conflict", 409);
      }
      if (current) {
        await refresh(current, result);
      } else {
        try {
          await deployments.create({
            tenantId: input.tenantId,
            id: `dep_${input.operationId}`,
            resourceUid: input.resourceUid,
            offeringId: sold.id,
            providerPackRef: sold.providerPackRef,
            providerInstallationRef: sold.providerInstallationRef,
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
  };
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
