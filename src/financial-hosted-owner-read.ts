import { type Accounts, AuthError } from "./auth.ts";
import { type SharedAuthSession, SharedAuthSessionError } from "./shared-auth-session.ts";

type Callable = (...args: never[]) => unknown;
type Context = NonNullable<Awaited<ReturnType<SharedAuthSession["authenticate"]>>>;
type Observation = Awaited<ReturnType<SharedAuthSession["observeFinalWorkspaceOrganization"]>>;
type Selection = ReturnType<SharedAuthSession["finalSessionSelection"]>;

/** Human ownership coordinates from the actual Server Shared RP selection. */
export interface FinancialHostedOwnerReadScope {
  readonly canonicalAccountId: string;
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly organizationId: string;
}

export class FinancialHostedOwnerReadUnavailable extends Error {
  constructor() {
    super("financial_hosted_owner_read_unavailable");
    this.name = "FinancialHostedOwnerReadUnavailable";
  }
}

function unavailable(): never {
  throw new FinancialHostedOwnerReadUnavailable();
}

function ownMethod(receiver: object, name: string): Callable {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, name);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    unavailable();
  return descriptor.value;
}

function hasNamedCookie(request: Request, name: string): boolean {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .some((part) => part.trim().split("=", 1)[0] === name);
}

interface Held {
  readonly request: Request;
  readonly signal: AbortSignal;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly sharedAuth: SharedAuthSession;
  readonly accounts: Accounts;
  readonly consoleOrigin: string;
  readonly authenticate: Callable;
  readonly observe: Callable;
  readonly selection: Callable;
  readonly principal: Callable;
  readonly requireOwner: Callable;
  readonly initial: Readonly<{
    accountId: string;
    principalId: string;
    issuer: string;
    clientId: string;
    subject: string;
    sessionId: string;
    authTime: number;
    sessionWorkspaceId: string;
  }>;
  scope?: FinancialHostedOwnerReadScope;
}

type HeldSource = Omit<Held, "initial" | "scope">;

const heldByRead = new WeakMap<object, Held>();

/** Internal source assertion for the native read wrapper; it conveys no Actor. */
export function assertFinancialHostedOwnerReadSource(
  read: FinancialHostedOwnerRead,
  originalRequest: Request,
  canonicalAccountId: string,
): void {
  try {
    const held = heldByRead.get(read) ?? unavailable();
    if (
      held.request !== originalRequest ||
      held.initial.accountId !== canonicalAccountId ||
      held.method !== "GET"
    )
      unavailable();
    assertSource(held);
  } catch {
    unavailable();
  }
}

function assertSource(held: HeldSource): void {
  const request = held.request;
  const headers = [...request.headers];
  if (
    !(request instanceof Request) ||
    request.signal !== held.signal ||
    request.signal.aborted ||
    request.method !== held.method ||
    request.url !== held.url ||
    headers.length !== held.headers.length ||
    headers.some(
      ([key, value], index) =>
        key !== held.headers[index]?.[0] || value !== held.headers[index]?.[1],
    ) ||
    request.headers.get("origin") !== held.consoleOrigin ||
    request.headers.has("authorization") ||
    hasNamedCookie(request, "takoserver_session") ||
    !hasNamedCookie(request, "__Host-takoserver_shared_session") ||
    ownMethod(held.sharedAuth, "authenticate") !== held.authenticate ||
    ownMethod(held.sharedAuth, "observeFinalWorkspaceOrganization") !== held.observe ||
    ownMethod(held.sharedAuth, "finalSessionSelection") !== held.selection ||
    ownMethod(held.accounts, "principal") !== held.principal ||
    ownMethod(held.accounts, "requireOwner") !== held.requireOwner
  )
    unavailable();
}

function mapFailure(error: unknown): never {
  if (error instanceof AuthError || error instanceof FinancialHostedOwnerReadUnavailable)
    throw error;
  if (error instanceof SharedAuthSessionError) {
    if (error.code === "session_invalid") throw new AuthError("unauthenticated");
    if (error.code === "workspace_forbidden") throw new AuthError("permission_denied");
  }
  return unavailable();
}

function scopeValue(scope: object, name: keyof FinancialHostedOwnerReadScope): string {
  const descriptor = Object.getOwnPropertyDescriptor(scope, name);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    descriptor.value.length === 0
  )
    unavailable();
  return descriptor.value;
}

function snapshotScope(scope: FinancialHostedOwnerReadScope): FinancialHostedOwnerReadScope {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) unavailable();
  return Object.freeze({
    canonicalAccountId: scopeValue(scope, "canonicalAccountId"),
    workspaceId: scopeValue(scope, "workspaceId"),
    workspaceRef: scopeValue(scope, "workspaceRef"),
    organizationId: scopeValue(scope, "organizationId"),
  });
}

function sameScope(
  left: FinancialHostedOwnerReadScope,
  right: FinancialHostedOwnerReadScope,
): boolean {
  return (
    left.canonicalAccountId === right.canonicalAccountId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRef === right.workspaceRef &&
    left.organizationId === right.organizationId
  );
}

/**
 * Financial-owned current Owner read for one actual Server Shared RP Request.
 * A caller-provided receiver is trusted composition input, not native Hosted RP
 * authority. The caller must mount the actual Server Shared RP receiver.
 */
export interface FinancialHostedOwnerRead {
  readonly accountId: string;
  assertCurrent(originalRequest: Request, scope: FinancialHostedOwnerReadScope): Promise<void>;
}

class OwnerRead implements FinancialHostedOwnerRead {
  get accountId(): string {
    return (heldByRead.get(this) ?? unavailable()).initial.accountId;
  }

  async assertCurrent(
    originalRequest: Request,
    scope: FinancialHostedOwnerReadScope,
  ): Promise<void> {
    try {
      const held = heldByRead.get(this) ?? unavailable();
      if (originalRequest !== held.request) unavailable();
      // Capture every scope field before the first asynchronous observation.
      const requested = snapshotScope(scope);
      if (held.scope && !sameScope(held.scope, requested)) unavailable();
      held.scope ??= requested;
      assertSource(held);
      const observed = (await Reflect.apply(held.observe, held.sharedAuth, [
        held.request,
        requested.workspaceId,
      ])) as Observation;
      assertSource(held);
      const selected = Reflect.apply(held.selection, held.sharedAuth, [observed]) as Selection;
      const initial = held.initial;
      if (
        !observed ||
        !selected ||
        observed.actor.kind !== "session" ||
        initial.accountId !== requested.canonicalAccountId ||
        observed.accountId !== initial.accountId ||
        selected.accountId !== initial.accountId ||
        selected.principalId !== initial.principalId ||
        observed.actor.principalId !== initial.principalId ||
        selected.identity.issuer !== initial.issuer ||
        selected.identity.clientId !== initial.clientId ||
        selected.identity.subject !== initial.subject ||
        selected.identity.sessionId !== initial.sessionId ||
        selected.identity.authTime !== initial.authTime ||
        selected.sessionWorkspaceId !== initial.sessionWorkspaceId ||
        selected.selectedWorkspaceId !== requested.workspaceId ||
        observed.workspace.id !== requested.workspaceId ||
        observed.workspaceRef !== requested.workspaceRef ||
        observed.organizationId !== requested.organizationId
      )
        unavailable();
      assertSource(held);
      const principal = await Reflect.apply(held.principal, held.accounts, [selected.principalId]);
      assertSource(held);
      if (!principal || principal.id !== selected.principalId) unavailable();
      const org = await Reflect.apply(held.requireOwner, held.accounts, [
        observed.actor,
        requested.organizationId,
      ]);
      assertSource(held);
      if (org.ownerPrincipalId !== selected.principalId) throw new AuthError("permission_denied");
    } catch (error) {
      mapFailure(error);
    }
  }
}

Object.freeze(OwnerRead.prototype);

/** No Actor or caller-selected account crosses this source-bound interface. */
export async function createFinancialHostedOwnerRead(input: {
  readonly request: Request;
  readonly sharedAuth: SharedAuthSession;
  readonly accounts: Accounts;
  readonly qualifiedConsoleOrigin: string;
}): Promise<FinancialHostedOwnerRead> {
  const { request, sharedAuth, accounts, qualifiedConsoleOrigin } = input;
  if (
    !(request instanceof Request) ||
    !sharedAuth ||
    !accounts ||
    !qualifiedConsoleOrigin ||
    request.headers.get("origin") !== qualifiedConsoleOrigin ||
    request.headers.has("authorization") ||
    hasNamedCookie(request, "takoserver_session") ||
    !hasNamedCookie(request, "__Host-takoserver_shared_session")
  )
    throw new AuthError("unauthenticated");
  try {
    const methods = {
      authenticate: ownMethod(sharedAuth, "authenticate"),
      observe: ownMethod(sharedAuth, "observeFinalWorkspaceOrganization"),
      selection: ownMethod(sharedAuth, "finalSessionSelection"),
      principal: ownMethod(accounts, "principal"),
      requireOwner: ownMethod(accounts, "requireOwner"),
    };
    const source = {
      request,
      signal: request.signal,
      method: request.method,
      url: request.url,
      headers: Object.freeze(
        [...request.headers].map(([key, value]) => Object.freeze([key, value] as const)),
      ),
      sharedAuth,
      accounts,
      consoleOrigin: qualifiedConsoleOrigin,
      ...methods,
    };
    assertSource(source);
    const context = (await Reflect.apply(methods.authenticate, sharedAuth, [
      request,
    ])) as Context | null;
    assertSource(source);
    if (context?.actor.kind !== "session") throw new AuthError("unauthenticated");
    const initial = Object.freeze({
      accountId: context.accountId,
      principalId: context.actor.principalId,
      issuer: context.provenance.issuer,
      clientId: context.provenance.clientId,
      subject: context.provenance.subject,
      sessionId: context.provenance.sessionId,
      authTime: context.provenance.authTime,
      sessionWorkspaceId: context.workspace.id,
    });
    const read = Object.freeze(new OwnerRead());
    heldByRead.set(read, { ...source, initial });
    return read;
  } catch (error) {
    mapFailure(error);
  }
}
