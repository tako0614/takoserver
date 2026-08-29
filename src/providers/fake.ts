import type { JsonObject } from "../ports.ts";
import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderNativeReadbackDescriptor,
  type ProviderOffering,
  type ProviderResult,
  type ProviderTicket,
  running,
  succeeded,
} from "../provider-port.ts";

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
  /** Optional durable state shared by provider instances across host restarts. */
  readonly state?: FakeProviderState;
}

export interface FakeProviderOperation {
  readonly operationId: string;
  readonly settleAfter: number;
  polls: number;
  readonly ticket: ProviderTicket;
}

export interface FakeProviderState {
  readonly pending: Map<string, FakeProviderOperation>;
  readonly completed: Map<string, ProviderTicket>;
  readonly resources: Map<string, { spec: JsonObject; identity: string }>;
  sideEffectCount: number;
  adoptCount: number;
}

export function createFakeProviderState(): FakeProviderState {
  return {
    pending: new Map(),
    completed: new Map(),
    resources: new Map(),
    sideEffectCount: 0,
    adoptCount: 0,
  };
}

export class FakeProvider implements Provider {
  readonly id: string;
  readonly offerings: readonly ProviderOffering[];
  readonly #mode: "sync" | "async";
  readonly #pollsToSettle: number;
  readonly #failOn: ReadonlySet<string>;
  readonly #pending: Map<string, FakeProviderOperation>;
  readonly #completed: Map<string, ProviderTicket>;
  readonly #resources: Map<string, { spec: JsonObject; identity: string }>;
  readonly #state: FakeProviderState;

  constructor(options: FakeProviderOptions) {
    this.id = options.id ?? "fake";
    this.offerings = structuredClone(options.offerings);
    this.#mode = options.mode ?? "sync";
    this.#pollsToSettle = options.pollsToSettle ?? 1;
    this.#failOn = new Set(options.failOn ?? []);
    this.#state = options.state ?? createFakeProviderState();
    this.#pending = this.#state.pending;
    this.#completed = this.#state.completed;
    this.#resources = this.#state.resources;
  }

  async apply(input: ApplyInput): Promise<ProviderTicket> {
    const address = addressOf(input.identity);
    const existingOperation = this.#reuseOperation(input.operationId);
    if (existingOperation) return existingOperation;
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
    this.#state.sideEffectCount += 1;
    return this.#settle(
      input.operationId,
      succeeded({
        nativeId,
        observed: structuredClone(input.spec),
        outputs: { resourceUri: `fake://${this.id}/${address}` },
      }),
    );
  }

  /** Read-only recovery for a lost apply acknowledgement. */
  async recoverApply(input: ApplyInput): Promise<ProviderTicket> {
    const address = addressOf(input.identity);
    const completed = this.#completed.get(input.operationId);
    if (completed) return completed;
    const held = this.#resources.get(address);
    if (!held) {
      return failed("unavailable", "the fake provider cannot prove an indeterminate apply", true);
    }
    return succeeded({
      nativeId: input.previous?.nativeId ?? `${this.id}:${address}`,
      observed: structuredClone(held.spec),
      outputs: { resourceUri: `fake://${this.id}/${held.identity}` },
    });
  }

  async poll(input: { operationId: string; handle: string }): Promise<ProviderTicket> {
    const pending = this.#pending.get(input.handle);
    if (!pending) return failed("not_found", "unknown operation handle");
    if (pending.operationId !== input.operationId) {
      return failed("conflict", "the operation handle belongs to another operation");
    }
    pending.polls += 1;
    if (pending.polls < pending.settleAfter) return running(input.handle, 1_000);
    this.#pending.delete(input.handle);
    this.#completed.set(pending.operationId, pending.ticket);
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

  createNativeReadbackDescriptor(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: { tenantRef: string; space: string; name: string };
  }): ProviderNativeReadbackDescriptor {
    if (
      input.offering.id.length === 0 ||
      !this.offerings.some((offering) => offering.id === input.offering.id) ||
      !input.nativeId
    ) {
      throw new Error("invalid fake readback descriptor");
    }
    return {
      apiVersion: "providers.takoserver.com/readback/v1",
      provider: this.id,
      kind: input.offering.kind,
      nativeId: input.nativeId,
      data: {
        tenantRef: input.identity.tenantRef,
        space: input.identity.space,
        name: input.identity.name,
      },
    };
  }

  async verifyNativeAbsence(input: {
    readonly offering: ProviderOffering;
    readonly descriptor: ProviderNativeReadbackDescriptor;
  }) {
    const data = input.descriptor.data;
    if (
      input.descriptor.apiVersion !== "providers.takoserver.com/readback/v1" ||
      input.descriptor.provider !== this.id ||
      input.descriptor.kind !== input.offering.kind ||
      typeof data.tenantRef !== "string" ||
      typeof data.space !== "string" ||
      typeof data.name !== "string"
    ) {
      return { outcome: "unknown" as const, reason: "malformed" as const, retryable: false };
    }
    const address = `${data.tenantRef}/${data.space}/${data.name}`;
    return this.#resources.has(address)
      ? { outcome: "present" as const, evidence: { state: "present" } }
      : { outcome: "absent" as const, evidence: { state: "absent" } };
  }

  async delete(input: {
    operationId: string;
    operationMode?: "initial" | "recovery";
    providerHandle?: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
  }): Promise<ProviderTicket> {
    if (input.operationMode === "recovery" && !input.providerHandle) {
      return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
    }
    if (input.providerHandle) {
      return await this.poll({ operationId: input.operationId, handle: input.providerHandle });
    }
    const existingOperation = this.#reuseOperation(input.operationId);
    if (existingOperation) return existingOperation;
    this.#resources.delete(addressOf(input.identity));
    this.#state.sideEffectCount += 1;
    return this.#settle(
      input.operationId,
      succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} }),
    );
  }

  /** Read-only recovery for a lost delete acknowledgement. */
  async recoverDelete(input: {
    operationId: string;
    operationMode?: "initial" | "recovery";
    providerHandle?: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
  }): Promise<ProviderTicket> {
    if (input.providerHandle)
      return await this.poll({ operationId: input.operationId, handle: input.providerHandle });
    if (this.#resources.has(addressOf(input.identity))) {
      return failed("unavailable", "the fake provider cannot prove delete completion", true);
    }
    return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
  }

  /** Read-only adoption recovery: confirm the deterministic native identity. */
  async recoverAdopt(input: {
    operationId: string;
    operationMode?: "initial" | "recovery";
    providerHandle?: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
    spec: JsonObject;
  }): Promise<ProviderTicket> {
    if (input.providerHandle)
      return await this.poll({ operationId: input.operationId, handle: input.providerHandle });
    const held = this.#resources.get(addressOf(input.identity));
    if (!held) return failed("not_found", "the native resource does not exist");
    return succeeded({
      nativeId: input.nativeId,
      observed: structuredClone(held.spec),
      outputs: { resourceUri: `fake://${this.id}/${held.identity}` },
    });
  }

  async adopt(input: {
    operationId: string;
    operationMode?: "initial" | "recovery";
    providerHandle?: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
    spec: JsonObject;
  }): Promise<ProviderTicket> {
    if (input.operationMode === "recovery" && !input.providerHandle) {
      return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
    }
    if (input.providerHandle) {
      return await this.poll({ operationId: input.operationId, handle: input.providerHandle });
    }
    const existingOperation = this.#reuseOperation(input.operationId);
    if (existingOperation) return existingOperation;
    const address = addressOf(input.identity);
    this.#resources.set(address, { spec: structuredClone(input.spec), identity: address });
    this.#state.adoptCount += 1;
    return this.#settle(
      input.operationId,
      succeeded({
        nativeId: input.nativeId,
        observed: structuredClone(input.spec),
        outputs: { resourceUri: `fake://${this.id}/${address}` },
      }),
    );
  }

  /** In async mode the caller gets a handle; in sync mode the answer directly. */
  #settle(operationId: string, ticket: ProviderTicket): ProviderTicket {
    if (this.#mode === "sync") return ticket;
    const handle = `handle_${operationId}`;
    if (this.#completed.has(operationId)) return this.#completed.get(operationId) as ProviderTicket;
    const pending = this.#pending.get(handle);
    if (pending) return running(handle, 1_000);
    this.#pending.set(handle, {
      operationId,
      settleAfter: this.#pollsToSettle,
      polls: 0,
      ticket,
    });
    return running(handle, 1_000);
  }

  #reuseOperation(operationId: string): ProviderTicket | undefined {
    const completed = this.#completed.get(operationId);
    if (completed) return completed;
    const pending = this.#pending.get(`handle_${operationId}`);
    return pending ? running(`handle_${operationId}`, 1_000) : undefined;
  }

  /** Test affordance: what the provider believes exists. */
  listResources(): readonly string[] {
    return [...this.#resources.keys()].sort();
  }

  /** Test affordance: how many provider-side writes/deletes were dispatched. */
  get sideEffectCount(): number {
    return this.#state.sideEffectCount;
  }

  /** Test affordance: how many adoption mutations were dispatched. */
  get adoptCount(): number {
    return this.#state.adoptCount;
  }
}

function addressOf(identity: { tenantRef: string; space: string; name: string }): string {
  return `${identity.tenantRef}/${identity.space}/${identity.name}`;
}

export function pickResult(ticket: ProviderTicket): ProviderResult | null {
  return ticket.phase === "succeeded" ? ticket.result : null;
}
