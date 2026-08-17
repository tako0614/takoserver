import type { JsonObject } from "../ports.ts";
import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderOffering,
  type ProviderResult,
  type ProviderTicket,
  running,
  succeeded,
} from "./port.ts";

/**
 * A provider that provisions nothing, in both completion styles.
 *
 * With `mode: "async"` every mutation answers `running` and settles only when
 * polled, which is what proves the reconciler actually drives operations
 * instead of relying on providers that happen to finish inline. The two modes
 * share all their bookkeeping, so a behaviour that holds for one is expected to
 * hold for the other.
 */
export interface FakeProviderOptions {
  readonly id?: string;
  readonly offerings: readonly ProviderOffering[];
  readonly mode?: "sync" | "async";
  /** Polls required before an operation settles, when asynchronous. */
  readonly pollsToSettle?: number;
  /** Names that always fail, to exercise the failure path. */
  readonly failOn?: readonly string[];
}

interface Pending {
  readonly settleAfter: number;
  polls: number;
  readonly ticket: ProviderTicket;
}

export class FakeProvider implements Provider {
  readonly id: string;
  readonly offerings: readonly ProviderOffering[];
  readonly #mode: "sync" | "async";
  readonly #pollsToSettle: number;
  readonly #failOn: ReadonlySet<string>;
  readonly #pending = new Map<string, Pending>();
  readonly #resources = new Map<string, { spec: JsonObject; identity: string }>();

  constructor(options: FakeProviderOptions) {
    this.id = options.id ?? "fake";
    this.offerings = structuredClone(options.offerings);
    this.#mode = options.mode ?? "sync";
    this.#pollsToSettle = options.pollsToSettle ?? 1;
    this.#failOn = new Set(options.failOn ?? []);
  }

  async apply(input: ApplyInput): Promise<ProviderTicket> {
    const address = addressOf(input.identity);
    if (this.#failOn.has(input.identity.name)) {
      return this.#settle(
        input.operationId,
        failed("provider_error", "the fake provider was told to fail", false),
      );
    }
    const nativeId = input.previous?.nativeId ?? `${this.id}:${address}`;
    if (!input.previous && this.#resources.has(address)) {
      return this.#settle(input.operationId, failed("conflict", "resource already exists"));
    }
    this.#resources.set(address, { spec: structuredClone(input.spec), identity: address });
    return this.#settle(
      input.operationId,
      succeeded({
        nativeId,
        observed: structuredClone(input.spec),
        outputs: { resourceUri: `fake://${this.id}/${address}` },
      }),
    );
  }

  async poll(input: { operationId: string; handle: string }): Promise<ProviderTicket> {
    const pending = this.#pending.get(input.handle);
    if (!pending) return failed("not_found", "unknown operation handle");
    pending.polls += 1;
    if (pending.polls < pending.settleAfter) return running(input.handle, 1_000);
    this.#pending.delete(input.handle);
    return pending.ticket;
  }

  async observe(input: {
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
    spec: JsonObject;
  }): Promise<ProviderTicket> {
    const held = this.#resources.get(addressOf(input.identity));
    if (!held) return failed("not_found", "resource does not exist");
    return succeeded({
      nativeId: input.nativeId,
      observed: structuredClone(held.spec),
      outputs: { resourceUri: `fake://${this.id}/${held.identity}` },
    });
  }

  async delete(input: {
    operationId: string;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
  }): Promise<ProviderTicket> {
    this.#resources.delete(addressOf(input.identity));
    return this.#settle(
      input.operationId,
      succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} }),
    );
  }

  async adopt(input: {
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
    spec: JsonObject;
  }): Promise<ProviderTicket> {
    const address = addressOf(input.identity);
    this.#resources.set(address, { spec: structuredClone(input.spec), identity: address });
    return succeeded({
      nativeId: input.nativeId,
      observed: structuredClone(input.spec),
      outputs: { resourceUri: `fake://${this.id}/${address}` },
    });
  }

  /** In async mode the caller gets a handle; in sync mode the answer directly. */
  #settle(operationId: string, ticket: ProviderTicket): ProviderTicket {
    if (this.#mode === "sync") return ticket;
    const handle = `handle_${operationId}`;
    this.#pending.set(handle, { settleAfter: this.#pollsToSettle, polls: 0, ticket });
    return running(handle, 1_000);
  }

  /** Test affordance: what the provider believes exists. */
  listResources(): readonly string[] {
    return [...this.#resources.keys()].sort();
  }
}

function addressOf(identity: { tenantRef: string; space: string; name: string }): string {
  return `${identity.tenantRef}/${identity.space}/${identity.name}`;
}

export function pickResult(ticket: ProviderTicket): ProviderResult | null {
  return ticket.phase === "succeeded" ? ticket.result : null;
}
