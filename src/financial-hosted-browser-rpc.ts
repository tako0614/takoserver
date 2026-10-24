import {
  type HostedBrowserBillingChoice,
  type HostedBrowserBillingCurrentSelection,
  type HostedBrowserBillingOriginal,
  type HostedBrowserBillingScope,
  HostedBrowserContinuationError,
  parseHostedBrowserBillingOriginal,
  parseHostedBrowserBillingScope,
  sameHostedBrowserBillingOriginal,
  sameHostedBrowserBillingScope,
  toFinancialHostedBrowserRequestOriginal,
} from "./financial-hosted-browser-continuation.ts";
import {
  assertFinancialHostedBrowserRequestAuthorizationOriginal,
  type FinancialHostedBrowserRequestAuthorization,
} from "./financial-hosted-browser-request.ts";
import {
  assertFinancialHostedBrowserSelection,
  type FinancialHostedBrowserSelection,
} from "./financial-hosted-browser-selection.ts";
import {
  assertFinancialHostedOwnerReadSource,
  type FinancialHostedOwnerRead,
} from "./financial-hosted-owner-read.ts";

/** The fixed, named Hosted native entrypoint. Its binding is service capability only. */
export interface HostedBrowserBillingRpcSupplier {
  prepareBrowserBillingContinuation?(
    input: HostedBrowserBillingLookup,
    selection: HostedBrowserLiveSelectionTarget,
  ): Promise<unknown>;
  readBrowserBillingContinuation(
    input: HostedBrowserBillingLookup,
    liveRead?: HostedBrowserLiveReadTarget,
  ): Promise<unknown>;
  claimBrowserBillingContinuation(
    input: HostedBrowserBillingLookup,
    authorization: HostedBrowserLiveAuthorizationTarget,
  ): Promise<unknown>;
  recordBrowserBillingContinuationOutcome(input: {
    readonly continuationRef: string;
    readonly original: HostedBrowserBillingOriginal;
    readonly outcome: HostedBrowserBillingOutcome;
  }): Promise<unknown>;
}

export interface HostedBrowserBillingLookup {
  readonly continuationRef: string;
  readonly canonicalAccountId: string;
}

export interface HostedBrowserLiveReadTarget {
  assertReadCurrent(scope: HostedBrowserBillingScope): Promise<void>;
}

export type HostedBrowserBillingRefusal = {
  readonly kind: "invalid" | "denied" | "conflict" | "unavailable";
};
export type HostedBrowserBillingOutcome =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "topup" | "subscription";
      readonly receipt: Readonly<Record<string, unknown>>;
    };
export type HostedBrowserBillingAccepted = {
  readonly family: "topup" | "subscription";
  readonly command: Readonly<Record<string, unknown>>;
};

/** Both operands must be closed, parsed accepted DATA; flat field order is irrelevant. */
export function sameHostedBrowserBillingAccepted(
  left: HostedBrowserBillingAccepted,
  right: HostedBrowserBillingAccepted,
): boolean {
  if (left.family !== right.family) return false;
  const leftKeys = Object.keys(left.command);
  const rightKeys = Object.keys(right.command);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right.command, key) && left.command[key] === right.command[key],
    )
  );
}
export type HostedBrowserBillingCustody =
  | { readonly phase: "prepared" }
  | { readonly phase: "dispatch-started"; readonly accepted: HostedBrowserBillingAccepted }
  | {
      readonly phase: "outcome-recorded";
      readonly accepted: HostedBrowserBillingAccepted;
      readonly outcome: HostedBrowserBillingOutcome;
    };
export type HostedBrowserBillingRead =
  | { readonly kind: "view"; readonly scope: HostedBrowserBillingScope }
  | {
      readonly kind: "payment";
      readonly original: HostedBrowserBillingOriginal;
      readonly custody: HostedBrowserBillingCustody;
    }
  | HostedBrowserBillingRefusal;
export type HostedBrowserBillingClaim =
  | {
      readonly kind: "fresh-dispatch";
      readonly original: HostedBrowserBillingOriginal;
      readonly accepted: HostedBrowserBillingAccepted;
    }
  | {
      readonly kind: "accepted-history";
      readonly original: HostedBrowserBillingOriginal;
      readonly custody: Exclude<HostedBrowserBillingCustody, { readonly phase: "prepared" }>;
    }
  | HostedBrowserBillingRefusal;
export type HostedBrowserBillingOutcomeResult =
  | { readonly kind: "recorded" | "already-recorded" }
  | HostedBrowserBillingRefusal;
export type HostedBrowserBillingPrepare =
  | {
      readonly kind: "prepared" | "already-prepared";
      readonly original: HostedBrowserBillingOriginal;
    }
  | HostedBrowserBillingRefusal;

function unavailable(): never {
  throw new HostedBrowserContinuationError("unavailable");
}

function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  rpcEnvelope = false,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) =>
      typeof key === "string"
        ? ![...required, ...optional].includes(key)
        : !(
            rpcEnvelope &&
            key === Symbol.dispose &&
            typeof Object.getOwnPropertyDescriptor(value, Symbol.dispose)?.value === "function"
          ),
    ) ||
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
    )
  )
    unavailable();
  return Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    ),
  );
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) unavailable();
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) unavailable();
  return value;
}

function refusal(raw: Record<string, unknown>): HostedBrowserBillingRefusal | null {
  if (
    typeof raw.kind !== "string" ||
    !["invalid", "denied", "conflict", "unavailable"].includes(raw.kind)
  )
    return null;
  if (Object.keys(raw).length !== 1) unavailable();
  return { kind: raw.kind as HostedBrowserBillingRefusal["kind"] };
}

function sameScope(actual: HostedBrowserBillingScope, expected: HostedBrowserBillingLookup): void {
  if (
    actual.continuationRef !== expected.continuationRef ||
    actual.canonicalAccountId !== expected.canonicalAccountId
  )
    unavailable();
}

function snapshotLookup(input: HostedBrowserBillingLookup): HostedBrowserBillingLookup {
  if (!input || typeof input !== "object" || Array.isArray(input)) unavailable();
  const selector = Object.getOwnPropertyDescriptor(input, "continuationRef");
  const account = Object.getOwnPropertyDescriptor(input, "canonicalAccountId");
  if (
    !selector ||
    !("value" in selector) ||
    typeof selector.value !== "string" ||
    !/^[0-9a-f]{64}$/u.test(selector.value) ||
    !account ||
    !("value" in account) ||
    typeof account.value !== "string" ||
    account.value.length === 0
  )
    unavailable();
  return Object.freeze({
    continuationRef: selector.value,
    canonicalAccountId: account.value,
  });
}

function assertLookupUnchanged(
  original: HostedBrowserBillingLookup,
  snapshot: HostedBrowserBillingLookup,
): void {
  const current = snapshotLookup(original);
  if (
    current.continuationRef !== snapshot.continuationRef ||
    current.canonicalAccountId !== snapshot.canonicalAccountId
  )
    unavailable();
}

function accepted(
  value: unknown,
  original: HostedBrowserBillingOriginal,
): HostedBrowserBillingAccepted {
  const raw = closed(value, ["family", "command"]);
  const claim = original.action.claim;
  if (raw.family !== original.action.family) unavailable();
  if (raw.family === "topup") {
    const command = closed(raw.command, [
      ...Object.keys(claim),
      "purpose",
      "generation",
      "previousOperationKey",
      "terminalReference",
      "terminalState",
    ]);
    for (const [key, expected] of Object.entries(claim))
      if (command[key] !== expected) unavailable();
    if (
      command.purpose !== "usd-top-up" ||
      !Number.isSafeInteger(command.generation) ||
      (command.generation as number) < 1
    )
      unavailable();
    const expectedPrevious = original.action.request.expectedOperationKey ?? null;
    if (command.previousOperationKey !== expectedPrevious) unavailable();
    if (expectedPrevious === null) {
      if (
        command.generation !== 1 ||
        command.terminalReference !== null ||
        command.terminalState !== null
      )
        unavailable();
    } else if (
      (command.generation as number) < 2 ||
      typeof command.terminalReference !== "string" ||
      /^takosumi:topup:[0-9a-f]{64}$/u.exec(command.terminalReference)?.[0] !==
        command.terminalReference ||
      command.terminalReference === original.action.claim.reference ||
      typeof command.terminalState !== "string" ||
      !["paid", "expired"].includes(command.terminalState)
    )
      unavailable();
    return Object.freeze({ family: "topup", command });
  }
  const command = closed(
    raw.command,
    [...Object.keys(claim), "generation"],
    ["previousOperationKey"],
  );
  for (const [key, expected] of Object.entries(claim)) if (command[key] !== expected) unavailable();
  const generation = integer(command.generation);
  const previous = original.action.request.expectedOperationKey;
  if ((generation === 1) !== (previous === undefined) || command.previousOperationKey !== previous)
    unavailable();
  return Object.freeze({ family: "subscription", command });
}

function receipt(
  value: unknown,
  original: HostedBrowserBillingOriginal,
): Readonly<Record<string, unknown>> {
  if (original.action.family === "topup") {
    const data = closed(value, ["reference", "state", "checkout"]);
    if (
      data.reference !== original.action.claim.reference ||
      typeof data.state !== "string" ||
      !["pending", "ready", "paid", "expired"].includes(data.state)
    )
      unavailable();
    if (data.checkout !== null) {
      const checkout = closed(data.checkout, ["url"]);
      if (!text(checkout.url).startsWith("https://")) unavailable();
    }
    return data;
  }
  const data = closed(value, [
    "contractVersion",
    "organizationId",
    "reference",
    "checkout",
    "pendingChange",
    "kind",
    "state",
    "lifecycle",
    "subscriptionRef",
    "planKey",
    "pricingRevision",
    "effectiveAt",
  ]);
  const expectedKind =
    original.action.claim.kind === "change-plan" ? "plan-change" : original.action.claim.kind;
  if (
    data.contractVersion !== "hosted-subscription-command-v1" ||
    data.organizationId !== original.scope.organizationId ||
    data.reference !== original.action.claim.reference ||
    data.kind !== expectedKind
  )
    unavailable();
  for (const name of ["subscriptionRef", "planKey", "pricingRevision", "effectiveAt"])
    if (data[name] !== null) text(data[name]);
  if (data.checkout !== null) {
    const checkout = closed(data.checkout, ["url"]);
    if (!text(checkout.url).startsWith("https://")) unavailable();
  }
  if (data.pendingChange !== null) {
    const change = closed(data.pendingChange, ["planKey", "pricingRevision", "effectiveAt"]);
    for (const field of Object.values(change)) text(field);
  }
  const allowed =
    expectedKind === "start"
      ? ["pending", "open", "associated", "expired", "invalidated"]
      : ["pending", "verified"];
  if (typeof data.state !== "string" || !allowed.includes(data.state)) unavailable();
  const lifecycle =
    expectedKind === "start"
      ? allowed
      : expectedKind === "cancel"
        ? ["pending", "scheduled"]
        : ["pending", "scheduled", "activated", "revoked"];
  if (typeof data.lifecycle !== "string" || !lifecycle.includes(data.lifecycle)) unavailable();
  const claim = original.action.claim;
  if (claim.kind === "start") {
    if (
      data.planKey !== claim.planKey ||
      data.pricingRevision === null ||
      data.effectiveAt !== null ||
      data.pendingChange !== null ||
      data.lifecycle !== data.state ||
      (data.subscriptionRef !== null &&
        /^sra_[0-9a-f]{64}$/u.exec(data.subscriptionRef as string)?.[0] !== data.subscriptionRef)
    )
      unavailable();
  } else if (claim.kind === "cancel") {
    if (
      data.subscriptionRef !== claim.expectedSubscriptionRef ||
      data.checkout !== null ||
      data.pendingChange !== null ||
      (data.state === "pending" && (data.lifecycle !== "pending" || data.effectiveAt !== null)) ||
      (data.state === "verified" && (data.lifecycle !== "scheduled" || data.effectiveAt === null))
    )
      unavailable();
  } else if (
    data.subscriptionRef !== claim.expectedSubscriptionRef ||
    data.planKey !== claim.planKey ||
    data.pricingRevision === null ||
    data.effectiveAt === null ||
    data.checkout !== null ||
    (data.state === "pending" && data.lifecycle !== "pending") ||
    (data.state === "verified" && data.lifecycle === "pending")
  )
    unavailable();
  return data;
}

export function parseHostedBrowserBillingOutcome(
  value: unknown,
  original: HostedBrowserBillingOriginal,
): HostedBrowserBillingOutcome {
  const raw = closed(value, ["kind"], ["receipt"]);
  if (raw.kind === "unknown") {
    if (Object.hasOwn(raw, "receipt")) unavailable();
    return { kind: "unknown" };
  }
  if (raw.kind !== original.action.family || !Object.hasOwn(raw, "receipt")) unavailable();
  return Object.freeze({
    kind: raw.kind as "topup" | "subscription",
    receipt: receipt(raw.receipt, original),
  });
}

function custody(
  value: unknown,
  original: HostedBrowserBillingOriginal,
): HostedBrowserBillingCustody {
  const phase = closed(value, ["phase"], ["accepted", "outcome"]);
  if (phase.phase === "prepared") {
    if (Object.keys(phase).length !== 1) unavailable();
    return { phase: "prepared" };
  }
  if (phase.phase === "dispatch-started") {
    if (Object.keys(phase).length !== 2 || !Object.hasOwn(phase, "accepted")) unavailable();
    return Object.freeze({
      phase: "dispatch-started",
      accepted: accepted(phase.accepted, original),
    });
  }
  if (phase.phase !== "outcome-recorded" || Object.keys(phase).length !== 3) unavailable();
  return Object.freeze({
    phase: "outcome-recorded",
    accepted: accepted(phase.accepted, original),
    outcome: parseHostedBrowserBillingOutcome(phase.outcome, original),
  });
}

export function parseHostedBrowserBillingRead(
  value: unknown,
  expected: HostedBrowserBillingLookup,
): HostedBrowserBillingRead {
  const root = closed(value, ["kind"], ["contractVersion", "scope", "original", "custody"], true);
  const denied = refusal(root);
  if (denied) return denied;
  if (root.kind === "view") {
    if (Object.keys(root).length !== 3 || root.contractVersion !== "hosted-browser-v1")
      unavailable();
    const selected = parseHostedBrowserBillingScope(root.scope);
    sameScope(selected, expected);
    return Object.freeze({ kind: "view", scope: selected });
  }
  if (root.kind !== "payment" || Object.keys(root).length !== 3) unavailable();
  const original = parseHostedBrowserBillingOriginal(root.original);
  sameScope(original.scope, expected);
  return Object.freeze({ kind: "payment", original, custody: custody(root.custody, original) });
}

export function parseHostedBrowserBillingClaim(
  value: unknown,
  expected: HostedBrowserBillingOriginal,
): HostedBrowserBillingClaim {
  const root = closed(value, ["kind"], ["original", "accepted", "custody"], true);
  const denied = refusal(root);
  if (denied) return denied;
  if (!sameHostedBrowserBillingOriginal(expected, root.original)) unavailable();
  const original = parseHostedBrowserBillingOriginal(root.original);
  if (root.kind === "fresh-dispatch") {
    if (Object.keys(root).length !== 3 || !Object.hasOwn(root, "accepted")) unavailable();
    return Object.freeze({
      kind: "fresh-dispatch",
      original,
      accepted: accepted(root.accepted, original),
    });
  }
  if (
    root.kind !== "accepted-history" ||
    Object.keys(root).length !== 3 ||
    !Object.hasOwn(root, "custody")
  )
    unavailable();
  const historical = custody(root.custody, original);
  if (historical.phase === "prepared") unavailable();
  return Object.freeze({ kind: "accepted-history", original, custody: historical });
}

export function parseHostedBrowserBillingOutcomeResult(
  value: unknown,
): HostedBrowserBillingOutcomeResult {
  const root = closed(value, ["kind"], [], true);
  const denied = refusal(root);
  if (denied) return denied;
  if (root.kind !== "recorded" && root.kind !== "already-recorded") unavailable();
  return { kind: root.kind };
}

function originalMatchesChoice(
  original: HostedBrowserBillingOriginal,
  choice: HostedBrowserBillingChoice,
  current: HostedBrowserBillingCurrentSelection,
): boolean {
  const action = original.action;
  if (choice.kind !== current.kind) return false;
  if (choice.kind === "topup")
    return (
      action.family === "topup" &&
      action.request.amountMinor === choice.amountMinor &&
      action.request.checkoutConsent === choice.checkoutConsent
    );
  if (action.family !== "subscription") return false;
  if (choice.kind === "start")
    return (
      action.claim.kind === "start" &&
      action.request.consent === choice.consent &&
      action.request.planKey === choice.planKey &&
      action.request.reconcileOriginalConsent === choice.reconcileOriginalConsent
    );
  if (choice.kind === "cancel")
    return (
      action.claim.kind === "cancel" &&
      action.request.consent === choice.consent &&
      current.kind === "cancel" &&
      action.claim.expectedSubscriptionRef === current.expectedSubscriptionRef
    );
  return (
    action.claim.kind === "change-plan" &&
    action.request.consent === choice.consent &&
    action.request.planKey === choice.planKey &&
    current.kind === "change-plan" &&
    action.claim.expectedSubscriptionRef === current.expectedSubscriptionRef
  );
}

export function parseHostedBrowserBillingPrepare(
  value: unknown,
  expected: {
    readonly scope: HostedBrowserBillingScope;
    readonly choice: HostedBrowserBillingChoice;
    readonly current: HostedBrowserBillingCurrentSelection;
  },
): HostedBrowserBillingPrepare {
  const root = closed(value, ["kind"], ["original"], true);
  const denied = refusal(root);
  if (denied) return denied;
  if (
    (root.kind !== "prepared" && root.kind !== "already-prepared") ||
    !Object.hasOwn(root, "original") ||
    Object.keys(root).length !== 2
  )
    unavailable();
  const original = parseHostedBrowserBillingOriginal(root.original);
  if (
    !sameHostedBrowserBillingScope(expected.scope, original.scope) ||
    !originalMatchesChoice(original, expected.choice, expected.current)
  )
    unavailable();
  return Object.freeze({ kind: root.kind, original });
}

function releaseRpcData(value: unknown): void {
  if (!value || typeof value !== "object") return;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, Symbol.dispose);
    if (!descriptor) return;
    if (!("value" in descriptor) || typeof descriptor.value !== "function") unavailable();
    Reflect.apply(descriptor.value, value, []);
  } catch {
    unavailable();
  }
}

export interface HostedBrowserBillingRpcClient {
  prepare(
    input: HostedBrowserBillingLookup,
    selection: HostedBrowserLiveSelectionTarget,
    expected: {
      readonly scope: HostedBrowserBillingScope;
      readonly choice: HostedBrowserBillingChoice;
      readonly current: HostedBrowserBillingCurrentSelection;
    },
  ): Promise<HostedBrowserBillingPrepare>;
  read(input: HostedBrowserBillingLookup): Promise<HostedBrowserBillingRead>;
  readWithCurrentOwner(
    input: HostedBrowserBillingLookup,
    ownerRead: FinancialHostedOwnerRead,
    originalRequest: Request,
  ): Promise<HostedBrowserBillingRead>;
  claim(
    input: HostedBrowserBillingLookup,
    authorization: HostedBrowserLiveAuthorizationTarget,
    original: HostedBrowserBillingOriginal,
  ): Promise<HostedBrowserBillingClaim>;
  record(input: {
    readonly continuationRef: string;
    readonly original: HostedBrowserBillingOriginal;
    readonly outcome: HostedBrowserBillingOutcome;
  }): Promise<HostedBrowserBillingOutcomeResult>;
}

/** Fixed native methods, captured from the code-selected service binding once. */
export function createHostedBrowserBillingRpcClient(
  supplier: HostedBrowserBillingRpcSupplier,
): HostedBrowserBillingRpcClient {
  const read = supplier.readBrowserBillingContinuation;
  const prepare = supplier.prepareBrowserBillingContinuation;
  const claim = supplier.claimBrowserBillingContinuation;
  const record = supplier.recordBrowserBillingContinuationOutcome;
  if ([read, claim, record].some((method) => typeof method !== "function")) unavailable();
  return Object.freeze({
    async prepare(
      input: HostedBrowserBillingLookup,
      selection: HostedBrowserLiveSelectionTarget,
      expected: {
        readonly scope: HostedBrowserBillingScope;
        readonly choice: HostedBrowserBillingChoice;
        readonly current: HostedBrowserBillingCurrentSelection;
      },
    ) {
      if (!prepare) unavailable();
      let result: unknown;
      try {
        result = await Reflect.apply(prepare, supplier, [input, selection]);
        return parseHostedBrowserBillingPrepare(result, expected);
      } catch {
        unavailable();
      } finally {
        releaseRpcData(result);
      }
    },
    async read(input: HostedBrowserBillingLookup) {
      let result: unknown;
      try {
        result = await Reflect.apply(read, supplier, [input]);
        return parseHostedBrowserBillingRead(result, input);
      } catch {
        return unavailable();
      } finally {
        releaseRpcData(result);
      }
    },
    async readWithCurrentOwner(
      input: HostedBrowserBillingLookup,
      ownerRead: FinancialHostedOwnerRead,
      originalRequest: Request,
    ) {
      let result: unknown;
      let remote: Awaited<ReturnType<typeof createHostedBrowserLiveReadTarget>> | undefined;
      try {
        const lookup = snapshotLookup(input);
        assertFinancialHostedOwnerReadSource(ownerRead, originalRequest, lookup.canonicalAccountId);
        remote = await createHostedBrowserLiveReadTarget(ownerRead, originalRequest, input, lookup);
        assertLookupUnchanged(input, lookup);
        assertFinancialHostedOwnerReadSource(ownerRead, originalRequest, lookup.canonicalAccountId);
        result = await Reflect.apply(read, supplier, [lookup, remote.target]);
        assertLookupUnchanged(input, lookup);
        assertFinancialHostedOwnerReadSource(ownerRead, originalRequest, lookup.canonicalAccountId);
        const parsed = parseHostedBrowserBillingRead(result, lookup);
        if (parsed.kind === "view" || parsed.kind === "payment") {
          const scope = parsed.kind === "view" ? parsed.scope : parsed.original.scope;
          if (!remote.completedFor(scope)) unavailable();
        }
        return parsed;
      } catch {
        return unavailable();
      } finally {
        remote?.disposeRemote();
        releaseRpcData(result);
      }
    },
    async claim(
      input: HostedBrowserBillingLookup,
      authorization: HostedBrowserLiveAuthorizationTarget,
      original: HostedBrowserBillingOriginal,
    ) {
      let result: unknown;
      try {
        result = await Reflect.apply(claim, supplier, [input, authorization]);
        return parseHostedBrowserBillingClaim(result, original);
      } catch {
        return unavailable();
      } finally {
        releaseRpcData(result);
      }
    },
    async record(input: {
      readonly continuationRef: string;
      readonly original: HostedBrowserBillingOriginal;
      readonly outcome: HostedBrowserBillingOutcome;
    }) {
      let result: unknown;
      try {
        parseHostedBrowserBillingOutcome(input.outcome, input.original);
        result = await Reflect.apply(record, supplier, [input]);
        return parseHostedBrowserBillingOutcomeResult(result);
      } catch {
        return unavailable();
      } finally {
        releaseRpcData(result);
      }
    },
  });
}

/** A request-local native prototype callback; no permission DATA is returned. */
export async function createHostedBrowserLiveReadTarget(
  ownerRead: FinancialHostedOwnerRead,
  originalRequest: Request,
  originalLookup: HostedBrowserBillingLookup,
  lookup: HostedBrowserBillingLookup,
): Promise<{
  readonly target: HostedBrowserLiveReadTarget;
  completedFor(scope: HostedBrowserBillingScope): boolean;
  disposeRemote(): void;
}> {
  assertFinancialHostedOwnerReadSource(ownerRead, originalRequest, lookup.canonicalAccountId);
  assertLookupUnchanged(originalLookup, lookup);
  try {
    const { RpcTarget } = await import("cloudflare:workers");
    assertFinancialHostedOwnerReadSource(ownerRead, originalRequest, lookup.canonicalAccountId);
    assertLookupUnchanged(originalLookup, lookup);
    let live = true;
    let parentDisposed = false;
    let pinned: HostedBrowserBillingScope | undefined;
    let completed = false;
    let failed = false;
    let pending = 0;
    class Target extends RpcTarget implements HostedBrowserLiveReadTarget {
      async assertReadCurrent(scope: HostedBrowserBillingScope): Promise<void> {
        let started = false;
        try {
          if (!live || failed || pending !== 0) unavailable();
          pending++;
          started = true;
          completed = false;
          assertFinancialHostedOwnerReadSource(
            ownerRead,
            originalRequest,
            lookup.canonicalAccountId,
          );
          assertLookupUnchanged(originalLookup, lookup);
          const selected = parseHostedBrowserBillingScope(scope);
          sameScope(selected, lookup);
          if (pinned && !sameHostedBrowserBillingScope(pinned, selected)) unavailable();
          pinned ??= selected;
          await ownerRead.assertCurrent(originalRequest, selected);
          if (!live || !sameHostedBrowserBillingScope(selected, scope)) unavailable();
          assertLookupUnchanged(originalLookup, lookup);
          assertFinancialHostedOwnerReadSource(
            ownerRead,
            originalRequest,
            lookup.canonicalAccountId,
          );
          completed = true;
        } catch {
          failed = true;
          unavailable();
        } finally {
          if (started) pending--;
        }
      }

      [Symbol.dispose](): void {
        live = false;
      }
    }
    const target = new Target();
    return Object.freeze({
      target,
      completedFor(scope: HostedBrowserBillingScope): boolean {
        // Workerd disposes a transferred target after Hosted returns. A read
        // completed before that native release remains valid; disposal during
        // its await is caught above, and parent disposal always invalidates it.
        return !!(
          !parentDisposed &&
          !failed &&
          pending === 0 &&
          completed &&
          pinned &&
          sameHostedBrowserBillingScope(pinned, scope)
        );
      },
      disposeRemote(): void {
        parentDisposed = true;
        live = false;
      },
    });
  } catch {
    unavailable();
  }
}

export interface HostedBrowserLiveSelectionTarget {
  readSelectionCurrent(
    scope: HostedBrowserBillingScope,
  ): Promise<HostedBrowserBillingCurrentSelection>;
}

/** Native prototype callback bound only to this module's real request-local producer. */
export async function createHostedBrowserLiveSelectionTarget(
  selection: FinancialHostedBrowserSelection,
  scope: HostedBrowserBillingScope,
): Promise<{ readonly target: HostedBrowserLiveSelectionTarget; disposeRemote(): void }> {
  const baseline = parseHostedBrowserBillingScope(scope);
  assertFinancialHostedBrowserSelection(selection, baseline);
  try {
    const { RpcTarget } = await import("cloudflare:workers");
    let live = true;
    class Target extends RpcTarget implements HostedBrowserLiveSelectionTarget {
      async readSelectionCurrent(
        selected: HostedBrowserBillingScope,
      ): Promise<HostedBrowserBillingCurrentSelection> {
        if (!live || !sameHostedBrowserBillingScope(baseline, selected)) unavailable();
        assertFinancialHostedBrowserSelection(selection, baseline);
        const current = await selection.readSelectionCurrent(baseline);
        if (!live) unavailable();
        return current;
      }

      [Symbol.dispose](): void {
        live = false;
      }
    }
    const target = new Target();
    return Object.freeze({
      target,
      disposeRemote() {
        live = false;
      },
    });
  } catch {
    unavailable();
  }
}

export interface HostedBrowserLiveAuthorizationTarget {
  assertOriginalCurrent(original: HostedBrowserBillingOriginal): Promise<void>;
}

/** Native prototype method; its disposal only closes the remote wrapper. */
export async function createHostedBrowserLiveAuthorizationTarget(
  authorization: FinancialHostedBrowserRequestAuthorization,
  original: HostedBrowserBillingOriginal,
): Promise<{ readonly target: HostedBrowserLiveAuthorizationTarget; disposeRemote(): void }> {
  const baseline = parseHostedBrowserBillingOriginal(original);
  const smaller = toFinancialHostedBrowserRequestOriginal(baseline);
  assertFinancialHostedBrowserRequestAuthorizationOriginal(authorization, smaller);
  try {
    const { RpcTarget } = await import("cloudflare:workers");
    let live = true;
    class Target extends RpcTarget implements HostedBrowserLiveAuthorizationTarget {
      async assertOriginalCurrent(selected: HostedBrowserBillingOriginal): Promise<void> {
        if (!live || !sameHostedBrowserBillingOriginal(baseline, selected)) unavailable();
        assertFinancialHostedBrowserRequestAuthorizationOriginal(authorization, smaller);
        await authorization.assertOriginalCurrent(smaller);
        if (!live) unavailable();
      }

      [Symbol.dispose](): void {
        live = false;
      }
    }
    const target = new Target();
    return Object.freeze({
      target,
      disposeRemote() {
        live = false;
      },
    });
  } catch {
    return unavailable();
  }
}
