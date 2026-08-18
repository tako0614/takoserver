import type { Catalog } from "./catalog.ts";
import type { Ledger } from "./ledger.ts";
import type { JsonObject } from "./ports.ts";
import type { Provider, ProviderOffering, ProviderTicket } from "./provider-port.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverReceipt,
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
 * Provider selection is by exact Form. A Form maps to at most one offering; two
 * would be a configuration error rather than a choice the Host may make on a
 * customer's behalf.
 */

export interface CreateProviderDriverOptions {
  readonly providers: readonly Provider[];
  readonly catalog: Catalog;
  readonly ledger: Ledger;
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
  const { providers, catalog, ledger } = options;
  const pollBudget = options.inlinePollBudget ?? 5;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  const select = (
    form: InstalledTakoformForm,
  ): { provider: Provider; offering: ProviderOffering; priceMinor: number } => {
    const sold = catalog.forForm(form.identity.formRef);
    if (!sold) throw new TakoformHostError("unsupported_capability", 422);
    const provider = byId.get(sold.providerId);
    const offering = provider?.offerings.find((candidate) => candidate.id === sold.id);
    if (!provider || !offering) throw new TakoformHostError("backend_unavailable", 503);
    return { provider, offering, priceMinor: sold.price.unitPriceMinor };
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

  const receiptOf = (ticket: ProviderTicket): TakoformDriverReceipt => {
    if (ticket.phase === "succeeded") {
      return {
        observed: ticket.result.observed,
        outputs: ticket.result.outputs,
        nativeId: ticket.result.nativeId,
      };
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
  ): Promise<TakoformDriverReceipt> => {
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
    return receiptOf(ticket);
  };

  return {
    async apply(input): Promise<TakoformDriverReceipt> {
      const { provider, offering, priceMinor } = select(input.form);
      const previous = previousOf(input.previous, input.nativeId);
      return await charged(input.tenantId, input.operationId, priceMinor, async () =>
        settle(
          provider,
          input.operationId,
          await provider.apply({
            operationId: input.operationId,
            offering,
            identity: { tenantRef: input.tenantId, space: input.space, name: input.name },
            spec: input.spec,
            ...(previous ? { previous } : {}),
          }),
        ),
      );
    },

    async observe(input): Promise<TakoformDriverReceipt> {
      // Reading state is not a billable act.
      const form = formOf(input.resource);
      const sold = catalog.forForm(form);
      const provider = sold ? byId.get(sold.providerId) : undefined;
      const offering = provider?.offerings.find((candidate) => candidate.id === sold?.id);
      if (!provider || !offering) throw new TakoformHostError("backend_unavailable", 503);
      return receiptOf(
        await provider.observe({
          offering,
          nativeId: requiredNativeId(input.nativeId),
          identity: {
            tenantRef: input.tenantId,
            space: input.resource.metadata.space,
            name: input.resource.metadata.name,
          },
          spec: input.resource.spec,
        }),
      );
    },

    async delete(input): Promise<void> {
      const sold = catalog.forForm(formOf(input.resource));
      const provider = sold ? byId.get(sold.providerId) : undefined;
      const offering = provider?.offerings.find((candidate) => candidate.id === sold?.id);
      if (!provider || !offering) throw new TakoformHostError("backend_unavailable", 503);
      const ticket = await settle(
        provider,
        input.operationId,
        await provider.delete({
          operationId: input.operationId,
          offering,
          nativeId: requiredNativeId(input.nativeId),
          identity: {
            tenantRef: input.tenantId,
            space: input.resource.metadata.space,
            name: input.resource.metadata.name,
          },
        }),
      );
      if (ticket.phase !== "succeeded") receiptOf(ticket);
    },

    async import(input): Promise<TakoformDriverReceipt> {
      const { provider, offering } = select(input.form);
      if (!provider.adopt) throw new TakoformHostError("unsupported_capability", 422);
      // Adoption bills nothing: the resource already exists and was paid for
      // wherever it came from.
      return receiptOf(
        await provider.adopt({
          offering,
          nativeId: input.nativeId,
          identity: { tenantRef: input.tenantId, space: input.space, name: input.name },
          spec: input.spec,
        }),
      );
    },
  };
}

function previousOf(
  resource: TakoformStoredResource | undefined,
  nativeId: string | undefined,
): { readonly nativeId: string; readonly spec: JsonObject } | undefined {
  return resource && nativeId ? { nativeId, spec: resource.spec } : undefined;
}

function formOf(resource: TakoformStoredResource) {
  return resource.form.formRef;
}

/** A resource the Host holds no native identity for was never provisioned. */
function requiredNativeId(nativeId: string | undefined): string {
  if (!nativeId) throw new TakoformHostError("resource_not_found", 404);
  return nativeId;
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
