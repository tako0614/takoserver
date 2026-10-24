import type { Accounts, Principal } from "./auth.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "./shared-auth-oidc-client.ts";
import type { createSharedAuthSession } from "./shared-auth-session.ts";
import {
  parseSharedFinancialAction,
  type SharedFinancialAction,
} from "./shared-financial-action.ts";

type SharedAuthSession = ReturnType<typeof createSharedAuthSession>;
type Context = NonNullable<
  Awaited<ReturnType<SharedAuthSession["observeFinalWorkspaceOrganization"]>>
>;
type Selection = NonNullable<ReturnType<SharedAuthSession["finalSessionSelection"]>>;
type Callable = (...args: never[]) => unknown;

/** Confirmed request DATA. The caller must separately establish its Financial original. */
export interface FinancialHostedBrowserRequestOriginal {
  readonly action: SharedFinancialAction;
  readonly workspaceId: string;
  readonly workspaceRef: string;
}

/** This local custody has no consent, money, dispatch, or RPC authority. */
export class FinancialHostedBrowserRequestUnavailable extends Error {
  readonly code = "unavailable" as const;
  constructor() {
    super("financial_hosted_browser_request_unavailable");
    this.name = "FinancialHostedBrowserRequestUnavailable";
  }
}

function unavailable(): never {
  throw new FinancialHostedBrowserRequestUnavailable();
}

function ownMethod(receiver: object, name: string): Callable {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, name);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    unavailable();
  return descriptor.value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) unavailable();
  return value;
}

function detachOriginal(
  input: FinancialHostedBrowserRequestOriginal,
): FinancialHostedBrowserRequestOriginal {
  if (!input || typeof input !== "object" || Array.isArray(input)) unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== 3 ||
    !["action", "workspaceId", "workspaceRef"].every((key) => Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    unavailable();
  try {
    return Object.freeze({
      action: parseSharedFinancialAction(input.action),
      workspaceId: text(input.workspaceId),
      workspaceRef: text(input.workspaceRef),
    });
  } catch {
    return unavailable();
  }
}

function sameOriginal(
  left: FinancialHostedBrowserRequestOriginal,
  right: FinancialHostedBrowserRequestOriginal,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.workspaceRef === right.workspaceRef &&
    JSON.stringify(left.action) === JSON.stringify(right.action)
  );
}

interface Held {
  readonly request: Request;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly original: FinancialHostedBrowserRequestOriginal;
  readonly sharedAuth: SharedAuthSession;
  readonly accounts: Accounts;
  readonly consoleOrigin: string;
  readonly observe: Callable;
  readonly authenticate: Callable;
  readonly selection: Callable;
  readonly principal: Callable;
  readonly requireOwner: Callable;
  readonly first: Selection;
  readonly principalRow: Principal;
  active: boolean;
}

const heldByAuthorization = new WeakMap<object, Held>();

function sameHeaders(request: Request, held: Held): boolean {
  const current = [...request.headers];
  return (
    current.length === held.headers.length &&
    current.every(
      ([key, value], index) =>
        key === held.headers[index]?.[0] && value === held.headers[index]?.[1],
    )
  );
}

function assertRequest(held: Held): void {
  const request = held.request;
  if (
    !held.active ||
    !(request instanceof Request) ||
    request.signal.aborted ||
    request.method !== held.method ||
    request.url !== held.url ||
    new URL(request.url).origin !== SHARED_AUTH_STAGING_PROFILE.publicOrigin ||
    !sameHeaders(request, held) ||
    held.original.action.kind === "card-setup" ||
    request.method !==
      (held.original.action.kind === "cancel" || held.original.action.kind === "plan-change"
        ? "PATCH"
        : "POST") ||
    request.headers.get("origin") !== held.consoleOrigin ||
    request.headers.has("authorization") ||
    /(?:^|;)\s*takoserver_session\s*=/iu.test(request.headers.get("cookie") ?? "") ||
    !/(?:^|;)\s*__Host-takoserver_shared_session=/u.test(request.headers.get("cookie") ?? "") ||
    ownMethod(held.sharedAuth, "observeFinalWorkspaceOrganization") !== held.observe ||
    ownMethod(held.sharedAuth, "authenticate") !== held.authenticate ||
    ownMethod(held.sharedAuth, "finalSessionSelection") !== held.selection ||
    ownMethod(held.accounts, "principal") !== held.principal ||
    ownMethod(held.accounts, "requireOwner") !== held.requireOwner
  )
    unavailable();
}

function sameIdentity(a: Selection, b: Selection): boolean {
  return (
    a.sessionDigest === b.sessionDigest &&
    a.createdAt === b.createdAt &&
    a.sessionWorkspaceId === b.sessionWorkspaceId &&
    a.accountId === b.accountId &&
    a.principalId === b.principalId &&
    a.selectedWorkspaceId === b.selectedWorkspaceId &&
    a.identity.issuer === b.identity.issuer &&
    a.identity.clientId === b.identity.clientId &&
    a.identity.subject === b.identity.subject &&
    a.identity.sessionId === b.identity.sessionId &&
    a.identity.authTime === b.identity.authTime
  );
}

function samePrincipal(a: Principal, b: Principal): boolean {
  return (
    a.id === b.id &&
    a.provider === b.provider &&
    a.providerSubject === b.providerSubject &&
    a.email === b.email &&
    a.displayName === b.displayName
  );
}

async function readCurrent(held: Held): Promise<{ selection: Selection; principal: Principal }> {
  assertRequest(held);
  const observed = (await Reflect.apply(held.observe, held.sharedAuth, [
    held.request,
    held.original.workspaceId,
  ])) as Context | null;
  assertRequest(held);
  if (!observed) unavailable();
  const selected = Reflect.apply(held.selection, held.sharedAuth, [observed]) as Selection | null;
  if (!selected) unavailable();
  const authenticated = (await Reflect.apply(held.authenticate, held.sharedAuth, [
    held.request,
    held.original.workspaceId,
  ])) as Awaited<ReturnType<SharedAuthSession["authenticate"]>>;
  assertRequest(held);
  if (
    !authenticated ||
    observed.actor.kind !== "session" ||
    authenticated.actor.kind !== "session" ||
    observed.accountId !== authenticated.accountId ||
    observed.actor.principalId !== authenticated.actor.principalId ||
    observed.actor.hostPrincipalId !== authenticated.actor.hostPrincipalId ||
    observed.workspace.id !== held.original.workspaceId ||
    authenticated.workspace.id !== held.original.workspaceId ||
    observed.workspaceId !== held.original.workspaceId ||
    observed.workspaceRef !== held.original.workspaceRef ||
    observed.organizationId !== held.original.action.organizationId ||
    selected.accountId !== observed.accountId ||
    selected.principalId !== observed.actor.principalId ||
    selected.selectedWorkspaceId !== held.original.workspaceId ||
    selected.identity.subject !== observed.accountId ||
    observed.provenance.issuer !== selected.identity.issuer ||
    observed.provenance.clientId !== selected.identity.clientId ||
    observed.provenance.subject !== selected.identity.subject ||
    observed.provenance.sessionId !== selected.identity.sessionId ||
    observed.provenance.authTime !== selected.identity.authTime ||
    authenticated.provenance.subject !== observed.provenance.subject ||
    (held.first && !sameIdentity(selected, held.first))
  )
    unavailable();
  const principal = (await Reflect.apply(held.principal, held.accounts, [
    selected.principalId,
  ])) as Principal | null;
  assertRequest(held);
  if (
    !principal ||
    principal.id !== selected.principalId ||
    (held.principalRow && !samePrincipal(principal, held.principalRow))
  )
    unavailable();
  const organization = await Reflect.apply(held.requireOwner, held.accounts, [
    observed.actor,
    held.original.action.organizationId,
  ]);
  assertRequest(held);
  if (
    !organization ||
    organization.id !== held.original.action.organizationId ||
    organization.ownerPrincipalId !== selected.principalId
  )
    unavailable();
  return { selection: selected, principal };
}

export interface FinancialHostedBrowserRequestAuthorization {
  /** Re-read actual same-factory RP, canonical account, Principal and Owner. */
  assertOriginalCurrent(original: FinancialHostedBrowserRequestOriginal): Promise<void>;
  /** End this original request's lifetime. */
  dispose(): void;
}

/** Owning-module provenance check for the native wrapper, never a permission by itself. */
export function assertFinancialHostedBrowserRequestAuthorizationOriginal(
  authorization: FinancialHostedBrowserRequestAuthorization,
  original: FinancialHostedBrowserRequestOriginal,
): void {
  try {
    const held = heldByAuthorization.get(authorization) ?? unavailable();
    assertRequest(held);
    if (!sameOriginal(detachOriginal(original), held.original)) unavailable();
  } catch {
    unavailable();
  }
}

class Authorization implements FinancialHostedBrowserRequestAuthorization {
  async assertOriginalCurrent(original: FinancialHostedBrowserRequestOriginal): Promise<void> {
    try {
      const held = heldByAuthorization.get(this) ?? unavailable();
      assertRequest(held);
      if (!sameOriginal(detachOriginal(original), held.original)) unavailable();
      await readCurrent(held);
      assertRequest(held);
    } catch {
      unavailable();
    }
  }

  dispose(): void {
    const held = heldByAuthorization.get(this);
    if (held) held.active = false;
  }
}

/** Code-selected internal producer. Never mount this as a public authorization route. */
export async function createFinancialHostedBrowserRequestAuthorization(input: {
  readonly request: Request;
  readonly sharedAuth: SharedAuthSession;
  readonly accounts: Accounts;
  readonly qualifiedConsoleOrigin: string;
  readonly original: FinancialHostedBrowserRequestOriginal;
}): Promise<FinancialHostedBrowserRequestAuthorization> {
  try {
    const original = detachOriginal(input.original);
    const request = input.request;
    const held: Held = {
      request,
      method: request.method,
      url: request.url,
      headers: Object.freeze(
        [...request.headers].map(([key, value]) => Object.freeze([key, value] as const)),
      ),
      original,
      sharedAuth: input.sharedAuth,
      accounts: input.accounts,
      consoleOrigin: input.qualifiedConsoleOrigin,
      observe: ownMethod(input.sharedAuth, "observeFinalWorkspaceOrganization"),
      authenticate: ownMethod(input.sharedAuth, "authenticate"),
      selection: ownMethod(input.sharedAuth, "finalSessionSelection"),
      principal: ownMethod(input.accounts, "principal"),
      requireOwner: ownMethod(input.accounts, "requireOwner"),
      first: undefined as unknown as Selection,
      principalRow: undefined as unknown as Principal,
      active: true,
    };
    if (held.consoleOrigin !== SHARED_AUTH_STAGING_PROFILE.consoleOrigin) unavailable();
    assertRequest(held);
    const first = await readCurrent(held);
    assertRequest(held);
    const authorization = new Authorization();
    heldByAuthorization.set(authorization, {
      ...held,
      first: first.selection,
      principalRow: first.principal,
    });
    return authorization;
  } catch {
    return unavailable();
  }
}
