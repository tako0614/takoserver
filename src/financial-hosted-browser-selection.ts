import type { Accounts, Principal } from "./auth.ts";
import type { Checkout } from "./control.ts";
import {
  type HostedBrowserBillingChoice,
  type HostedBrowserBillingCurrentSelection,
  type HostedBrowserBillingScope,
  parseHostedBrowserBillingChoice,
  parseHostedBrowserBillingScope,
  sameHostedBrowserBillingScope,
} from "./financial-hosted-browser-continuation.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "./shared-auth-oidc-client.ts";
import type { SharedAuthSession } from "./shared-auth-session.ts";
import { parseStrictJson } from "./strict-json.ts";
import type { SubscriptionPayments } from "./stripe-billing.ts";

type Callable = (...args: never[]) => unknown;
type Context = NonNullable<Awaited<ReturnType<SharedAuthSession["authenticate"]>>>;
type Final = NonNullable<
  Awaited<ReturnType<SharedAuthSession["observeFinalWorkspaceOrganization"]>>
>;
type Selection = NonNullable<ReturnType<SharedAuthSession["finalSessionSelection"]>>;

export class FinancialHostedBrowserSelectionUnavailable extends Error {
  constructor() {
    super("financial_hosted_browser_selection_unavailable");
    this.name = "FinancialHostedBrowserSelectionUnavailable";
  }
}

function unavailable(): never {
  throw new FinancialHostedBrowserSelectionUnavailable();
}

function ownMethod(receiver: object, name: string): Callable {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, name);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    unavailable();
  return descriptor.value;
}

interface Held {
  readonly request: Request;
  readonly url: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly scope: HostedBrowserBillingScope;
  readonly choice: HostedBrowserBillingChoice;
  readonly sharedAuth: SharedAuthSession;
  readonly accounts: Accounts;
  readonly consoleOrigin: string;
  readonly authenticate: Callable;
  readonly observe: Callable;
  readonly selection: Callable;
  readonly principal: Callable;
  readonly requireOwner: Callable;
  readonly subscriptions: SubscriptionPayments | undefined;
  readonly subscriptionRead: Callable | undefined;
  readonly planTableSnapshot: string | undefined;
  readonly checkout: Checkout | undefined;
  readonly boundsSnapshot: string | undefined;
  first?: Selection;
  principalRow?: Principal;
  current?: HostedBrowserBillingCurrentSelection;
  active: boolean;
}

const heldBySelection = new WeakMap<object, Held>();

function sameIdentity(left: Selection, right: Selection): boolean {
  return (
    left.sessionDigest === right.sessionDigest &&
    left.createdAt === right.createdAt &&
    left.sessionWorkspaceId === right.sessionWorkspaceId &&
    left.accountId === right.accountId &&
    left.principalId === right.principalId &&
    left.selectedWorkspaceId === right.selectedWorkspaceId &&
    left.identity.issuer === right.identity.issuer &&
    left.identity.clientId === right.identity.clientId &&
    left.identity.subject === right.identity.subject &&
    left.identity.sessionId === right.identity.sessionId &&
    left.identity.authTime === right.identity.authTime
  );
}

function samePrincipal(left: Principal, right: Principal): boolean {
  return (
    left.id === right.id &&
    left.provider === right.provider &&
    left.providerSubject === right.providerSubject &&
    left.email === right.email &&
    left.displayName === right.displayName
  );
}

function assertRequest(held: Held): void {
  const { request } = held;
  const headers = [...request.headers];
  if (
    !held.active ||
    !(request instanceof Request) ||
    request.signal.aborted ||
    request.url !== held.url ||
    request.method !== held.method ||
    request.method !== "POST" ||
    new URL(request.url).origin !== SHARED_AUTH_STAGING_PROFILE.publicOrigin ||
    new URL(request.url).pathname !==
      `/v1/billing/hosted-continuations/${held.scope.continuationRef}` ||
    new URL(request.url).search !== "" ||
    headers.length !== held.headers.length ||
    headers.some(
      ([key, value], index) =>
        key !== held.headers[index]?.[0] || value !== held.headers[index]?.[1],
    ) ||
    request.headers.get("origin") !== held.consoleOrigin ||
    request.headers.has("authorization") ||
    /(?:^|;)\s*takoserver_session\s*=/iu.test(request.headers.get("cookie") ?? "") ||
    !/(?:^|;)\s*__Host-takoserver_shared_session=/u.test(request.headers.get("cookie") ?? "") ||
    ownMethod(held.sharedAuth, "authenticate") !== held.authenticate ||
    ownMethod(held.sharedAuth, "observeFinalWorkspaceOrganization") !== held.observe ||
    ownMethod(held.sharedAuth, "finalSessionSelection") !== held.selection ||
    ownMethod(held.accounts, "principal") !== held.principal ||
    ownMethod(held.accounts, "requireOwner") !== held.requireOwner ||
    (held.subscriptionRead !== undefined &&
      (!held.subscriptions || ownMethod(held.subscriptions, "read") !== held.subscriptionRead)) ||
    (held.planTableSnapshot !== undefined &&
      JSON.stringify(held.subscriptions?.planTable) !== held.planTableSnapshot) ||
    (held.boundsSnapshot !== undefined &&
      JSON.stringify(held.checkout?.bounds) !== held.boundsSnapshot)
  )
    unavailable();
}

function currentTarget(row: unknown, organizationId: string): string {
  if (!row || typeof row !== "object" || Array.isArray(row)) unavailable();
  const organization = Object.getOwnPropertyDescriptor(row, "organizationId");
  if (!organization || !("value" in organization) || organization.value !== organizationId)
    unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(row, "subscriptionRef");
  const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof value !== "string" || /^sra_[0-9a-f]{64}$/u.exec(value)?.[0] !== value) unavailable();
  return value;
}

function selectionData(
  held: Held,
  target: string | undefined,
): HostedBrowserBillingCurrentSelection {
  const choice = held.choice;
  if (choice.kind === "topup") {
    const bounds = held.checkout?.bounds;
    if (
      !held.checkout?.referenceRequired ||
      !bounds ||
      !Number.isSafeInteger(bounds.minimumMinor) ||
      !Number.isSafeInteger(bounds.maximumMinor) ||
      choice.amountMinor < bounds.minimumMinor ||
      choice.amountMinor > bounds.maximumMinor
    )
      unavailable();
    return choice;
  }
  if (!held.subscriptions) unavailable();
  if (choice.kind === "start" || choice.kind === "change-plan") {
    const table = held.subscriptions.planTable;
    if (
      table.scope !== "hosted" ||
      !table.plans.some((plan) => plan.tier === "subscription" && plan.planId === choice.planKey)
    )
      unavailable();
  }
  if (choice.kind === "start") return choice;
  if (!target) unavailable();
  return Object.freeze({ ...choice, expectedSubscriptionRef: target });
}

async function currentOwner(
  held: Held,
  before?: { readonly selected: Selection; readonly principal: Principal },
): Promise<{ readonly selected: Selection; readonly principal: Principal }> {
  assertRequest(held);
  const initial = (await Reflect.apply(held.authenticate, held.sharedAuth, [
    held.request,
  ])) as Context | null;
  assertRequest(held);
  const observed = (await Reflect.apply(held.observe, held.sharedAuth, [
    held.request,
    held.scope.workspaceId,
  ])) as Final | null;
  assertRequest(held);
  const selected = Reflect.apply(held.selection, held.sharedAuth, [observed]) as Selection | null;
  if (
    !initial ||
    !observed ||
    !selected ||
    initial.actor.kind !== "session" ||
    observed.actor.kind !== "session" ||
    initial.accountId !== held.scope.canonicalAccountId ||
    observed.accountId !== initial.accountId ||
    selected.accountId !== initial.accountId ||
    selected.principalId !== initial.actor.principalId ||
    observed.actor.principalId !== initial.actor.principalId ||
    selected.sessionWorkspaceId !== initial.workspace.id ||
    selected.selectedWorkspaceId !== held.scope.workspaceId ||
    observed.workspace.id !== held.scope.workspaceId ||
    observed.workspaceRef !== held.scope.workspaceRef ||
    observed.organizationId !== held.scope.organizationId ||
    selected.identity.issuer !== initial.provenance.issuer ||
    selected.identity.clientId !== initial.provenance.clientId ||
    selected.identity.subject !== initial.provenance.subject ||
    selected.identity.sessionId !== initial.provenance.sessionId ||
    selected.identity.authTime !== initial.provenance.authTime ||
    (held.first && !sameIdentity(selected, held.first)) ||
    (before && !sameIdentity(selected, before.selected))
  )
    unavailable();
  const principal = (await Reflect.apply(held.principal, held.accounts, [
    selected.principalId,
  ])) as Principal | null;
  assertRequest(held);
  if (
    !principal ||
    principal.id !== selected.principalId ||
    (held.principalRow && !samePrincipal(principal, held.principalRow)) ||
    (before && !samePrincipal(principal, before.principal))
  )
    unavailable();
  const organization = await Reflect.apply(held.requireOwner, held.accounts, [
    observed.actor,
    held.scope.organizationId,
  ]);
  assertRequest(held);
  if (
    !organization ||
    organization.id !== held.scope.organizationId ||
    organization.ownerPrincipalId !== selected.principalId
  )
    unavailable();
  return { selected, principal };
}

async function readCurrent(held: Held): Promise<HostedBrowserBillingCurrentSelection> {
  // The first Owner check admits the private subscription read. A second
  // check after that await prevents a stale target from returning if its
  // session, selected binding, or Owner was revoked while the read waited.
  const before = await currentOwner(held);
  let target: string | undefined;
  if (held.choice.kind === "cancel" || held.choice.kind === "change-plan") {
    if (!held.subscriptions || !held.subscriptionRead) unavailable();
    target = currentTarget(
      await Reflect.apply(held.subscriptionRead, held.subscriptions, [held.scope.organizationId]),
      held.scope.organizationId,
    );
    assertRequest(held);
    await currentOwner(held, before);
  }
  const current = selectionData(held, target);
  if (held.current && JSON.stringify(current) !== JSON.stringify(held.current)) unavailable();
  if (!held.first) held.first = before.selected;
  if (!held.principalRow) held.principalRow = before.principal;
  if (!held.current) held.current = current;
  return current;
}

export interface FinancialHostedBrowserSelection {
  readSelectionCurrent(
    scope: HostedBrowserBillingScope,
  ): Promise<HostedBrowserBillingCurrentSelection>;
  dispose(): void;
}

export function assertFinancialHostedBrowserSelection(
  selection: FinancialHostedBrowserSelection,
  scope: HostedBrowserBillingScope,
): void {
  const held = heldBySelection.get(selection) ?? unavailable();
  assertRequest(held);
  if (!sameHostedBrowserBillingScope(held.scope, scope)) unavailable();
}

class SelectionProducer implements FinancialHostedBrowserSelection {
  async readSelectionCurrent(
    scope: HostedBrowserBillingScope,
  ): Promise<HostedBrowserBillingCurrentSelection> {
    const held = heldBySelection.get(this) ?? unavailable();
    assertRequest(held);
    if (!sameHostedBrowserBillingScope(held.scope, scope)) unavailable();
    try {
      return await readCurrent(held);
    } catch {
      unavailable();
    }
  }

  dispose(): void {
    const held = heldBySelection.get(this);
    if (held) held.active = false;
  }
}

/** Original Server request and actual receivers are captured before any authority await. */
export async function createFinancialHostedBrowserSelection(input: {
  readonly request: Request;
  readonly scope: HostedBrowserBillingScope;
  readonly choice: HostedBrowserBillingChoice;
  readonly sharedAuth: SharedAuthSession;
  readonly accounts: Accounts;
  readonly qualifiedConsoleOrigin: string;
  readonly checkout?: Checkout | undefined;
  readonly subscriptions?: SubscriptionPayments | undefined;
}): Promise<FinancialHostedBrowserSelection> {
  try {
    const scope = parseHostedBrowserBillingScope(input.scope);
    const choice = parseHostedBrowserBillingChoice(input.choice);
    const request = input.request;
    const held: Held = {
      request,
      url: request.url,
      method: request.method,
      headers: Object.freeze(
        [...request.headers].map(([key, value]) => Object.freeze([key, value] as const)),
      ),
      scope,
      choice,
      sharedAuth: input.sharedAuth,
      accounts: input.accounts,
      consoleOrigin: input.qualifiedConsoleOrigin,
      authenticate: ownMethod(input.sharedAuth, "authenticate"),
      observe: ownMethod(input.sharedAuth, "observeFinalWorkspaceOrganization"),
      selection: ownMethod(input.sharedAuth, "finalSessionSelection"),
      principal: ownMethod(input.accounts, "principal"),
      requireOwner: ownMethod(input.accounts, "requireOwner"),
      subscriptions: input.subscriptions,
      subscriptionRead: input.subscriptions ? ownMethod(input.subscriptions, "read") : undefined,
      planTableSnapshot: input.subscriptions
        ? JSON.stringify(input.subscriptions.planTable)
        : undefined,
      checkout: input.checkout,
      boundsSnapshot: input.checkout ? JSON.stringify(input.checkout.bounds) : undefined,
      active: true,
    };
    if (held.consoleOrigin !== SHARED_AUTH_STAGING_PROFILE.consoleOrigin) unavailable();
    assertRequest(held);
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const body = parseHostedBrowserBillingChoice(parseStrictJson(bytes, 64 * 1024));
    assertRequest(held);
    if (JSON.stringify(body) !== JSON.stringify(choice)) unavailable();
    await readCurrent(held);
    assertRequest(held);
    const producer = new SelectionProducer();
    heldBySelection.set(producer, held);
    return producer;
  } catch {
    unavailable();
  }
}
