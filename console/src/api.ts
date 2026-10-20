/**
 * The console's view of the Takoserver API.
 *
 * Every call goes through one function so that three things are true
 * everywhere: a failure carries the server's own error code rather than a
 * status number, an expired session is recognised as such instead of surfacing
 * as a generic denial, and no response is trusted to be JSON just because the
 * call succeeded.
 */

import type { PricePlan } from "../../src/catalog.ts";
import type { HostedPricing } from "../../src/hosted-pricing.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "../../src/interface-ref.ts";
import type { V2Operation, V2Resource } from "../../src/takoform-v2/types.ts";

/** A way in, as the server advertises it. */
export interface IdentityProvider {
  readonly id: string;
  readonly displayName: string;
  readonly method: "oidc" | "operator-assertion";
  readonly clientId?: string;
  readonly issuer?: string;
}

export interface Principal {
  readonly id: string;
  readonly provider: string;
  readonly email: string;
  readonly displayName: string;
}

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly ownerPrincipalId: string;
  readonly createdAt: string;
}

export type SharedAuthSessionStatus =
  | { readonly available: true; readonly authenticated: boolean }
  | { readonly available: false; readonly authenticated: false };

/**
 * The v2 base a Host names, only in the one shape a Host builds it: an HTTPS
 * origin (plain HTTP only on this machine) and the exact v2 path. The console
 * puts it into a command a person pastes into a shell, so anything else is
 * dropped rather than passed on.
 */
export function v2Base(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    return null;
  if (url.pathname !== "/apis/forms.takoform.com/v2") return null;
  return `${url.origin}${url.pathname}`;
}

export interface HostDiscovery {
  readonly ai: boolean;
  /** The Host API v2 base, such as `https://api.example.com/apis/forms.takoform.com/v2`. */
  readonly takoform: string | null;
}

export interface ApiKey {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface LedgerEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly type: string;
  readonly reference: string;
  readonly settledDeltaMicros: string;
  readonly heldDeltaMicros: string;
  readonly createdAt: string;
}

export interface Wallet {
  readonly organizationId: string;
  readonly currency: string;
  readonly settledMicros: string;
  readonly heldMicros: string;
  readonly availableMicros: string;
  readonly entries: readonly LedgerEntry[];
}

export interface WalletUsageSummary {
  readonly organizationId: string;
  readonly currency: "USD";
  readonly unit: "USD-micros";
  readonly effectiveIncludedMicros: string;
  readonly utilizationBasisPoints: number;
}

/** One Workspace's (or the unattributed bucket's) share of a frozen usage snapshot. */
export interface WorkspaceUsageAmounts {
  readonly usedMicros: string;
  readonly heldMicros: string;
  /** Consumed but unpaid usage; not available balance and not another debit. */
  readonly pendingMicros: string;
}

export interface WorkspaceUsageRow extends WorkspaceUsageAmounts {
  /** Opaque Workspace reference; the Console never resolves it to a name. */
  readonly workspaceRef: string;
}

/**
 * One page of the server's frozen per-Workspace usage snapshot.
 *
 * `totals` and `unattributed` describe the whole snapshot, never this page, so
 * they repeat unchanged on every page and must not be summed across pages.
 */
export interface WorkspaceUsagePage {
  readonly organizationId: string;
  readonly snapshotAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly unit: "USD-micros";
  readonly totalsScope: "organization";
  readonly totals: WorkspaceUsageAmounts;
  readonly unattributed: WorkspaceUsageAmounts;
  readonly workspaces: readonly WorkspaceUsageRow[];
  /** Opaque continuation inside the same snapshot; `null` on the last page. */
  readonly cursor: string | null;
}

export type HostedPlanTable = HostedPricing["hostedPlanTable"];

export interface HostedSubscriptionProjection {
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly subscriptionRef: string;
  readonly planKey: string;
  readonly pricingRevision: string;
  readonly status:
    | "incomplete"
    | "incomplete_expired"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "paused";
  readonly cancelAtPeriodEnd: boolean;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly paidThrough: string | null;
  readonly paidFeatures: boolean;
  readonly updatedAt: string;
}

/** What a Host with hosted billing composed declares; absent on every other Host. */
export interface HostedBillingCapabilities {
  readonly contractVersion: string;
  readonly topUps: boolean;
  readonly subscriptionStart: boolean;
  readonly subscriptionCancellation: boolean;
  readonly subscriptionPlanChange: boolean;
}

export interface OrganizationSubscription {
  readonly subscription: HostedSubscriptionProjection | null;
  readonly planTable: HostedPlanTable;
  readonly billingCapabilities?: HostedBillingCapabilities;
}

export type SubscriptionCheckoutStart =
  | {
      readonly status: 201;
      readonly checkout: { readonly state: "open"; readonly id: string; readonly url: string };
    }
  | {
      readonly status: 202;
      readonly checkout: { readonly state: "pending"; readonly id: string };
    }
  | {
      readonly status: 200;
      readonly checkout:
        | {
            readonly state: "associated";
            readonly id: string;
            readonly subscriptionRef: string;
            readonly url?: string;
          }
        | { readonly state: "expired"; readonly id: string };
    };

/** A hosted top-up Checkout begun or replayed under one durable reference. */
export interface TopUpCheckoutStart {
  readonly checkout: { readonly url: string };
}

/** The server's read of one top-up reference; never permission to settle funds. */
export interface TopUpReceipt {
  readonly reference: string;
  readonly state: "pending" | "ready" | "paid" | "expired";
  readonly checkout: { readonly url: string } | null;
}

export type SubscriptionCancellationReceipt =
  | { readonly state: "pending"; readonly subscriptionRef: string }
  | { readonly state: "verified"; readonly subscriptionRef: string; readonly effectiveAt: string };

export interface Offering {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly form: FormRef;
  readonly pricePlan: PricePlan;
  readonly resourceClass: string;
  readonly deliveryMode: string;
  readonly providedInterfaces: readonly TakoformInterfaceRef[];
  readonly bindingRefs: readonly TakoformBindingRef[];
  readonly regions: readonly string[];
  readonly portability: {
    readonly api: "native" | "portable";
    readonly exportFormats: readonly string[];
    readonly importFormats: readonly string[];
    readonly migrationModes: readonly ("offline" | "online")[];
  };
  readonly isolation: string;
  readonly digest: string;
}

export interface FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

export type ResourceSummary = V2Resource;

/** Durable accepted v2 Operation, distinct from control-plane history. */
export type ResourceOperation = V2Operation;

/**
 * The normal Host v2 lane. Form identity is one exact HTTPS URL in the body,
 * while an accepted Resource is addressed by its UID thereafter.
 */
const LANE = "/apis/forms.takoform.com/v2";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly path: string,
    /** The Host's own explanation, when its problem carries one. */
    readonly detail: string | null = null,
  ) {
    super(code);
    this.name = "ApiError";
  }

  /**
   * True when the only useful next step is to sign in again.
   *
   * Scoped to the account lane and its organization-authenticated v2 Form
   * lane. Other Host lanes may use different credentials.
   */
  get isExpiredSession(): boolean {
    return (
      (this.path.startsWith("/v1/") || this.path.startsWith(`${LANE}/`)) &&
      (this.status === 401 || this.code === "unauthenticated")
    );
  }
}

/** A resource as a person declares it in the console. */
export interface ResourceDeclaration {
  readonly form: string;
  readonly space: string;
  readonly name: string;
  readonly spec: Record<string, unknown>;
}

export interface ApiOptions {
  readonly origin: string;
  readonly token: () => string | null;
  readonly onSessionLost: () => void;
}

const MAX_SAFE_MICROS = BigInt(Number.MAX_SAFE_INTEGER);

/** The server's basis points express included usage, including outstanding holds. */
export function formatUsagePercent(value: number, locale: "en-US" | "ja-JP" = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
    usageBasisPoints(value) / 10_000,
  );
}

function usageBasisPoints(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000)
    throw new TypeError("invalid utilization basis points");
  return value;
}

/** Format canonical signed USD micros without converting money through cents. */
export function formatMicrosCurrency(
  value: string,
  currency = "USD",
  locale: "en-US" | "ja-JP" = "en-US",
): string {
  if (!/^-?(0|[1-9][0-9]*)$/u.test(value) || value === "-0") {
    throw new TypeError("invalid micros value");
  }
  const signed = BigInt(value);
  const absolute = signed < 0n ? -signed : signed;
  if (absolute > MAX_SAFE_MICROS || !/^[A-Z]{3}$/u.test(currency)) {
    throw new TypeError("micros value out of range");
  }

  const whole = absolute / 1_000_000n;
  const remainder = absolute % 1_000_000n;
  const fraction =
    remainder === 0n ? "" : remainder.toString().padStart(6, "0").replace(/0+$/u, "");
  const currencyFormatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  // Use -1 for a negative sub-dollar value so locale-specific sign/currency
  // placement survives while the integer digits are replaced with zero.
  const parts = currencyFormatter.formatToParts(
    signed < 0n ? (whole === 0n ? -1n : -whole) : whole,
  );
  const digits = new Intl.NumberFormat(locale, {
    useGrouping: false,
    maximumFractionDigits: 0,
  });
  const decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
    .formatToParts(1.1)
    .find((part) => part.type === "decimal")?.value;
  const fractionText = [...fraction].map((digit) => digits.format(Number(digit))).join("");
  const lastInteger = parts.reduce(
    (last, part, index) => (part.type === "integer" ? index : last),
    -1,
  );
  if (lastInteger < 0) throw new TypeError("currency formatter omitted integer");

  const output: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    output.push(
      signed < 0n && whole === 0n && part.type === "integer" ? digits.format(0) : part.value,
    );
    if (index === lastInteger && fraction !== "") {
      if (decimal === undefined)
        throw new TypeError("currency formatter omitted decimal separator");
      output.push(decimal, fractionText);
    }
  }
  return output.join("");
}

function decodeWallet(payload: unknown, organizationId: string): Wallet {
  if (!isRecord(payload) || !isRecord(payload.wallet)) throw new TypeError("invalid wallet");
  const wallet = payload.wallet;
  if (
    wallet.organizationId !== organizationId ||
    wallet.currency !== "USD" ||
    !Array.isArray(wallet.entries)
  ) {
    throw new TypeError("invalid wallet identity");
  }
  const settledMicros = unsignedMicros(wallet.settledMicros);
  const heldMicros = unsignedMicros(wallet.heldMicros);
  const availableMicros = unsignedMicros(wallet.availableMicros);
  if (BigInt(settledMicros) - BigInt(heldMicros) !== BigInt(availableMicros)) {
    throw new TypeError("invalid wallet conservation");
  }
  const entries = wallet.entries.map((entry): LedgerEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.organizationId !== "string" ||
      entry.organizationId !== organizationId ||
      typeof entry.type !== "string" ||
      typeof entry.reference !== "string" ||
      typeof entry.createdAt !== "string"
    ) {
      throw new TypeError("invalid wallet entry");
    }
    return {
      id: entry.id,
      organizationId,
      type: entry.type,
      reference: entry.reference,
      settledDeltaMicros: signedMicros(entry.settledDeltaMicros),
      heldDeltaMicros: signedMicros(entry.heldDeltaMicros),
      createdAt: entry.createdAt,
    };
  });
  return { organizationId, currency: "USD", settledMicros, heldMicros, availableMicros, entries };
}

const WORKSPACE_USAGE_KEYS = [
  "cursor",
  "organizationId",
  "periodEnd",
  "periodStart",
  "snapshotAt",
  "totals",
  "totalsScope",
  "unattributed",
  "unit",
  "usageSummary",
  "workspaces",
].join();
const WORKSPACE_AMOUNT_KEYS = ["heldMicros", "pendingMicros", "usedMicros"].join();
const WORKSPACE_ROW_KEYS = ["heldMicros", "pendingMicros", "usedMicros", "workspaceRef"].join();

function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join() === keys;
}

function workspaceUsageAmounts(value: unknown, keys = WORKSPACE_AMOUNT_KEYS) {
  if (!isRecord(value) || !exactKeys(value, keys)) throw new TypeError("invalid usage amounts");
  const amounts = {
    usedMicros: unsignedMicros(value.usedMicros),
    heldMicros: unsignedMicros(value.heldMicros),
    pendingMicros: unsignedMicros(value.pendingMicros),
  };
  if (
    BigInt(amounts.usedMicros) + BigInt(amounts.heldMicros) + BigInt(amounts.pendingMicros) >
    MAX_SAFE_MICROS
  )
    throw new TypeError("usage amounts out of range");
  return amounts;
}

/**
 * Decodes one page of the per-Workspace breakdown, or refuses it.
 *
 * Identity, period and snapshot instant must agree with each other and with
 * the embedded included-usage summary; rows must be the server's strictly
 * ordered opaque references; and this page's rows plus the unattributed bucket
 * can never exceed the Organization totals they are a part of.
 */
export function decodeWorkspaceUsagePage(
  payload: unknown,
  organizationId: string,
): WorkspaceUsagePage {
  if (!isRecord(payload) || !exactKeys(payload, WORKSPACE_USAGE_KEYS))
    throw new TypeError("invalid workspace usage");
  if (
    payload.organizationId !== organizationId ||
    payload.unit !== "USD-micros" ||
    payload.totalsScope !== "organization" ||
    !isCanonicalIsoTimestamp(payload.snapshotAt) ||
    !isCanonicalIsoTimestamp(payload.periodStart) ||
    !isCanonicalIsoTimestamp(payload.periodEnd) ||
    !(payload.periodStart <= payload.snapshotAt && payload.snapshotAt < payload.periodEnd)
  )
    throw new TypeError("invalid workspace usage identity");
  const summary = payload.usageSummary;
  if (
    !isRecord(summary) ||
    summary.organizationId !== organizationId ||
    summary.currency !== "USD" ||
    summary.unit !== "USD-micros" ||
    summary.periodStart !== payload.periodStart ||
    summary.periodEnd !== payload.periodEnd
  )
    throw new TypeError("invalid workspace usage summary");
  if (
    payload.cursor !== null &&
    (typeof payload.cursor !== "string" ||
      payload.cursor.length === 0 ||
      payload.cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/u.test(payload.cursor))
  )
    throw new TypeError("invalid workspace usage cursor");
  if (!Array.isArray(payload.workspaces)) throw new TypeError("invalid workspace rows");
  const totals = workspaceUsageAmounts(payload.totals);
  const unattributed = workspaceUsageAmounts(payload.unattributed);
  let previous: string | null = null;
  const workspaces = payload.workspaces.map((row): WorkspaceUsageRow => {
    const amounts = workspaceUsageAmounts(row, WORKSPACE_ROW_KEYS);
    const workspaceRef = (row as Record<string, unknown>).workspaceRef;
    if (!isWorkspaceRef(workspaceRef) || (previous !== null && workspaceRef <= previous))
      throw new TypeError("invalid workspace ref");
    previous = workspaceRef;
    return { workspaceRef, ...amounts };
  });
  if (workspaces.length > 100 || (payload.cursor !== null && workspaces.length === 0))
    throw new TypeError("invalid workspace page size");
  for (const field of ["usedMicros", "heldMicros", "pendingMicros"] as const) {
    const listed = workspaces.reduce((sum, row) => sum + BigInt(row[field]), 0n);
    if (listed + BigInt(unattributed[field]) > BigInt(totals[field]))
      throw new TypeError("workspace rows exceed totals");
  }
  return {
    organizationId,
    snapshotAt: payload.snapshotAt,
    periodStart: payload.periodStart,
    periodEnd: payload.periodEnd,
    unit: "USD-micros",
    totalsScope: "organization",
    totals,
    unattributed,
    workspaces,
    cursor: payload.cursor,
  };
}

function isWorkspaceRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function unsignedMicros(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError("invalid unsigned micros");
  }
  const amount = BigInt(value);
  if (amount > MAX_SAFE_MICROS) throw new TypeError("micros out of range");
  return value;
}

function signedMicros(value: unknown): string {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/u.test(value) || value === "-0") {
    throw new TypeError("invalid signed micros");
  }
  const amount = BigInt(value);
  if (amount < -MAX_SAFE_MICROS || amount > MAX_SAFE_MICROS) {
    throw new TypeError("micros out of range");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createApi(options: ApiOptions) {
  const request = async <Result>(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<{ readonly status: number; readonly payload: Result }> => {
    const token = options.token();
    let response: Response;
    try {
      response = await fetch(`${options.origin}${path}`, {
        method,
        credentials: "include",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // A refused connection and a rejected request are different problems and
      // a person can act on the difference, so they never share a message.
      throw new ApiError("unreachable", 0, path);
    }

    const payload = await response
      .json()
      .catch(() => null as unknown as Record<string, unknown> | null);

    if (!response.ok) {
      const envelope = (payload as { error?: { code?: unknown } } | null)?.error;
      const topLevelCode = (payload as { code?: unknown } | null)?.code;
      const code =
        typeof topLevelCode === "string"
          ? topLevelCode
          : typeof envelope?.code === "string"
            ? envelope.code
            : `http_${response.status}`;
      const detail = (payload as { detail?: unknown } | null)?.detail;
      const failure = new ApiError(
        code,
        response.status,
        path,
        typeof detail === "string" && detail.length > 0 && detail.length <= 1024 ? detail : null,
      );
      if (failure.isExpiredSession) options.onSessionLost();
      throw failure;
    }
    return { status: response.status, payload: payload as Result };
  };

  const call = async <Result>(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Result> => (await request<Result>(method, path, body, extra)).payload;

  const operation = (
    payload: unknown,
    status: number,
    path: string,
    read = false,
  ): ResourceOperation => {
    if ((read ? status !== 200 : status !== 200 && status !== 202) || !isV2Operation(payload)) {
      throw new ApiError("invalid_response", status, path);
    }
    if (
      !read &&
      (payload.status === "succeeded" || payload.status === "failed") !== (status === 200)
    ) {
      throw new ApiError("invalid_response", status, path);
    }
    return payload;
  };

  const organizationHeader = (organizationId: string) => ({
    "takoform-organization": organizationId,
  });

  return {
    async replayWindowSeconds(): Promise<number> {
      const path = "/.well-known/takoform/v2";
      const { payload, status } = await request<unknown>("GET", path);
      const seconds =
        isRecord(payload) && isRecord(payload.limits) ? payload.limits.replayWindowSeconds : null;
      if (
        status !== 200 ||
        !Number.isSafeInteger(seconds) ||
        typeof seconds !== "number" ||
        seconds < 1
      )
        throw new ApiError("invalid_response", status, path);
      return seconds;
    },
    /**
     * What this Host's own discovery document says it serves: whether it has
     * `/v1/ai`, and the Host API v2 base it names from its public origin. An
     * unreadable document answers neither rather than guessing.
     */
    async hostDiscovery(): Promise<HostDiscovery> {
      const unknown: HostDiscovery = { ai: false, takoform: null };
      try {
        const { payload, status } = await request<unknown>("GET", "/.well-known/takoserver");
        if (status !== 200 || !isRecord(payload) || !isRecord(payload.endpoints)) return unknown;
        const { ai, takoform } = payload.endpoints;
        return { ai: typeof ai === "string", takoform: v2Base(takoform) };
      } catch {
        return unknown;
      }
    },
    identityProviders: () =>
      call<{ providers: readonly IdentityProvider[] }>("GET", "/v1/identity/providers"),

    /**
     * The shared-auth session oracle is a separate authentication surface.
     * It must not receive this Console API's bearer token; the browser's
     * HttpOnly cookie is the only credential it is allowed to inspect.
     */
    async sharedAuthSession(): Promise<SharedAuthSessionStatus> {
      const path = "/auth/oidc/session";
      let response: Response;
      try {
        response = await fetch(`${options.origin}${path}`, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        });
      } catch {
        throw new ApiError("unreachable", 0, path);
      }
      const payload = await response
        .json()
        .catch(() => null as unknown as Record<string, unknown> | null);
      if (response.status === 404) return { available: false, authenticated: false };
      if (response.status === 200 || response.status === 401) {
        if (
          isRecord(payload) &&
          Object.keys(payload).sort().join() === "authenticated" &&
          payload.authenticated === (response.status === 200)
        ) {
          return { available: true, authenticated: payload.authenticated as boolean };
        }
        throw new ApiError("invalid_response", response.status, path);
      }
      if (!response.ok) {
        const code = isRecord(payload) && isRecord(payload.error) ? payload.error.code : null;
        throw new ApiError(
          typeof code === "string" ? code : `http_${response.status}`,
          response.status,
          path,
        );
      }
      throw new ApiError("invalid_response", response.status, path);
    },

    /** Logout through the shared RP's cookie owner; only a real 204 succeeds. */
    async sharedAuthSignOut(): Promise<void> {
      const path = "/auth/oidc/logout";
      let response: Response;
      try {
        response = await fetch(`${options.origin}${path}`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
        });
      } catch {
        throw new ApiError("unreachable", 0, path);
      }
      if (response.status === 204) return;
      const payload = await response
        .json()
        .catch(() => null as unknown as Record<string, unknown> | null);
      const code = isRecord(payload) && isRecord(payload.error) ? payload.error.code : null;
      throw new ApiError(
        typeof code === "string" ? code : `http_${response.status}`,
        response.status,
        path,
      );
    },

    signIn: (
      provider: string,
      assertion: string,
      method?: IdentityProvider["method"],
      nonce?: string,
    ) =>
      call<{ principal: Principal; sessionToken?: string }>("POST", "/v1/sessions", {
        provider,
        assertion,
        ...(method === undefined ? {} : { method }),
        ...(nonce === undefined ? {} : { nonce }),
      }),

    signOut: () => call<void>("DELETE", "/v1/session"),

    async me(): Promise<{ principal: Principal; organizations: readonly Organization[] }> {
      const path = "/v1/me";
      const { payload, status } = await request<unknown>("GET", path);
      try {
        if (
          !isRecord(payload) ||
          !isRecord(payload.principal) ||
          !Array.isArray(payload.organizations)
        )
          throw new TypeError("invalid identity response");
        const identity = payload.principal;
        if (
          typeof identity.id !== "string" ||
          identity.id === "" ||
          typeof identity.provider !== "string" ||
          identity.provider === "" ||
          typeof identity.email !== "string" ||
          typeof identity.displayName !== "string"
        )
          throw new TypeError("invalid principal");
        const decodedOrganizations = payload.organizations.map((value) => {
          if (
            !isRecord(value) ||
            typeof value.id !== "string" ||
            value.id === "" ||
            typeof value.name !== "string" ||
            value.name === "" ||
            typeof value.ownerPrincipalId !== "string" ||
            value.ownerPrincipalId === "" ||
            typeof value.createdAt !== "string"
          )
            throw new TypeError("invalid organization");
          return value as unknown as Organization;
        });
        return {
          principal: identity as unknown as Principal,
          organizations: decodedOrganizations,
        };
      } catch {
        throw new ApiError("invalid_response", status, path);
      }
    },

    createOrganization: (name: string) =>
      call<{ organization: Organization }>("POST", "/v1/organizations", { name }),

    apiKeys: (organizationId: string) =>
      call<{ apiKeys: readonly ApiKey[] }>(
        "GET",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
      ),

    createApiKey: (
      organizationId: string,
      input: { name: string; scopes: readonly string[]; expiresInSeconds: number },
    ) =>
      call<{ apiKey: ApiKey; secret: string }>(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        input,
      ),

    revokeApiKey: (organizationId: string, apiKeyId: string) =>
      call<{ apiKey: ApiKey }>(
        "DELETE",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys/${encodeURIComponent(apiKeyId)}`,
      ),

    wallet: async (organizationId: string) => {
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/wallet`;
      const result = await request<unknown>("GET", path);
      try {
        return { wallet: decodeWallet(result.payload, organizationId) };
      } catch {
        throw new ApiError("invalid_response", result.status, path);
      }
    },

    async usageSummary(organizationId: string): Promise<{ usageSummary: WalletUsageSummary }> {
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/wallet/usage-summary`;
      const { payload, status } = await request<unknown>("GET", path);
      try {
        if (status !== 200 || !isRecord(payload) || !isRecord(payload.usageSummary))
          throw new TypeError("invalid usage summary");
        const summary = payload.usageSummary;
        if (
          summary.organizationId !== organizationId ||
          summary.currency !== "USD" ||
          summary.unit !== "USD-micros"
        )
          throw new TypeError("invalid usage summary identity");
        const effectiveIncludedMicros = unsignedMicros(summary.effectiveIncludedMicros);
        const utilizationBasisPoints = usageBasisPoints(summary.utilizationBasisPoints);
        if (effectiveIncludedMicros === "0" && utilizationBasisPoints !== 0)
          throw new TypeError("invalid zero-allowance utilization");
        return {
          usageSummary: {
            organizationId,
            currency: "USD",
            unit: "USD-micros",
            effectiveIncludedMicros,
            utilizationBasisPoints,
          },
        };
      } catch {
        throw new ApiError("invalid_response", status, path);
      }
    },

    /**
     * Reads one page of the frozen per-Workspace usage snapshot. Without a
     * cursor the server creates a new snapshot; a cursor continues the snapshot
     * it came from and answers 409 once that snapshot has expired.
     */
    async workspaceUsage(
      organizationId: string,
      query: { readonly cursor?: string; readonly limit?: number } = {},
    ): Promise<WorkspaceUsagePage> {
      const search = new URLSearchParams();
      if (query.limit !== undefined) search.set("limit", String(query.limit));
      if (query.cursor !== undefined) search.set("cursor", query.cursor);
      const encoded = search.toString();
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/wallet/usage-summary/workspaces${encoded ? `?${encoded}` : ""}`;
      if (
        (query.limit !== undefined &&
          (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) ||
        (query.cursor !== undefined && (query.cursor.length === 0 || query.cursor.length > 1024))
      )
        throw new ApiError("invalid_request", 0, path);
      const { payload, status } = await request<unknown>("GET", path);
      try {
        if (status !== 200) throw new TypeError("unexpected status");
        const page = decodeWorkspaceUsagePage(payload, organizationId);
        if (query.limit !== undefined && page.workspaces.length > query.limit)
          throw new TypeError("page exceeds limit");
        return page;
      } catch {
        throw new ApiError("invalid_response", status, path);
      }
    },

    /** Reads the Host-authored plan table and the Organization's current projection. */
    async subscription(organizationId: string): Promise<OrganizationSubscription> {
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/payments/subscription`;
      const { payload, status } = await request<unknown>("GET", path);
      if (
        status !== 200 ||
        !isRecord(payload) ||
        !(
          payload.subscription === null ||
          isHostedSubscriptionProjection(payload.subscription, organizationId)
        )
      )
        throw new ApiError("invalid_response", status, path);
      const planTable = decodeHostedPlanTable(payload.planTable);
      if (!planTable) throw new ApiError("invalid_response", status, path);
      if (payload.billingCapabilities === undefined)
        return { subscription: payload.subscription, planTable };
      const billingCapabilities = decodeBillingCapabilities(payload.billingCapabilities);
      if (!billingCapabilities) throw new ApiError("invalid_response", status, path);
      return { subscription: payload.subscription, planTable, billingCapabilities };
    },

    /** Replays one durable caller reference against one Host-configured plan key. */
    async beginSubscription(
      organizationId: string,
      reference: string,
      planKey: string,
    ): Promise<SubscriptionCheckoutStart> {
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/payments/subscription`;
      if (!isBillingReference(reference) || !isPlanKey(planKey))
        throw new ApiError("invalid_request", 0, path);
      const { payload, status } = await request<unknown>("POST", path, { reference, planKey });
      if (!isRecord(payload) || !isRecord(payload.checkout))
        throw new ApiError("invalid_response", status, path);
      const checkout = payload.checkout;
      if (
        status === 201 &&
        checkout.state === "open" &&
        isStripeSessionId(checkout.id) &&
        isCheckoutUrl(checkout.url)
      ) {
        return {
          status: 201,
          checkout: { state: "open", id: checkout.id, url: checkout.url },
        };
      }
      if (status === 202 && checkout.state === "pending" && isSubscriptionIntentId(checkout.id)) {
        return { status: 202, checkout: { state: "pending", id: checkout.id } };
      }
      if (
        status === 200 &&
        checkout.state === "associated" &&
        isStripeSessionId(checkout.id) &&
        isSubscriptionRef(checkout.subscriptionRef) &&
        (checkout.url === undefined || isCheckoutUrl(checkout.url))
      ) {
        return {
          status: 200,
          checkout: {
            state: "associated",
            id: checkout.id,
            subscriptionRef: checkout.subscriptionRef,
            ...(checkout.url === undefined ? {} : { url: checkout.url }),
          },
        };
      }
      if (
        status === 200 &&
        checkout.state === "expired" &&
        isStripeSessionId(checkout.id) &&
        checkout.url === undefined
      ) {
        return { status: 200, checkout: { state: "expired", id: checkout.id } };
      }
      throw new ApiError("invalid_response", status, path);
    },

    /** Requests period-end cancellation only against the exact current opaque target. */
    async cancelSubscription(
      organizationId: string,
      reference: string,
      expectedSubscriptionRef: string,
    ): Promise<SubscriptionCancellationReceipt> {
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/payments/subscription`;
      if (!isBillingReference(reference) || !isSubscriptionRef(expectedSubscriptionRef))
        throw new ApiError("invalid_request", 0, path);
      const { payload, status } = await request<unknown>("PATCH", path, {
        reference,
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef,
      });
      if (!isRecord(payload) || !isRecord(payload.cancellation))
        throw new ApiError("invalid_response", status, path);
      const cancellation = payload.cancellation;
      if (
        status === 202 &&
        cancellation.state === "pending" &&
        cancellation.subscriptionRef === expectedSubscriptionRef &&
        cancellation.effectiveAt === undefined
      ) {
        return { state: "pending", subscriptionRef: expectedSubscriptionRef };
      }
      if (
        status === 200 &&
        cancellation.state === "verified" &&
        cancellation.subscriptionRef === expectedSubscriptionRef &&
        isCanonicalIsoTimestamp(cancellation.effectiveAt)
      ) {
        return {
          state: "verified",
          subscriptionRef: expectedSubscriptionRef,
          effectiveAt: cancellation.effectiveAt,
        };
      }
      throw new ApiError("invalid_response", status, path);
    },

    /**
     * Starts a legacy self-host payment. Answers 404 where this deployment
     * cannot take one, which is how the console knows not to offer it. Hosted
     * billing refuses this body; it uses `beginTopUp` with a durable reference.
     */
    beginCheckout: (organizationId: string, amountMinor: number) =>
      call<{ checkout: { url: string } }>(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/wallet/checkout`,
        { amountMinor },
      ),

    /**
     * Begins or replays one hosted top-up. The reference and amount travel
     * together because the server fingerprints the original command; a replay
     * with a different amount is a conflict, not a new payment.
     */
    async beginTopUp(
      organizationId: string,
      reference: string,
      amountMinor: number,
    ): Promise<TopUpCheckoutStart> {
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/wallet/checkout`;
      if (!isBillingReference(reference) || !isSafeIntegerAtLeast(amountMinor, 1))
        throw new ApiError("invalid_request", 0, path);
      const { payload, status } = await request<unknown>("POST", path, { reference, amountMinor });
      if (
        status !== 201 ||
        !isRecord(payload) ||
        !isRecord(payload.checkout) ||
        !isCheckoutUrl(payload.checkout.url)
      )
        throw new ApiError("invalid_response", status, path);
      return { checkout: { url: payload.checkout.url } };
    },

    /** Reads one top-up reference's receipt; never reissues the Checkout. */
    async topUpReceipt(organizationId: string, reference: string): Promise<TopUpReceipt> {
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/wallet/checkout/${encodeURIComponent(reference)}`;
      if (!isBillingReference(reference)) throw new ApiError("invalid_request", 0, path);
      const { payload, status } = await request<unknown>("GET", path);
      if (
        status !== 200 ||
        !isRecord(payload) ||
        payload.reference !== reference ||
        !["pending", "ready", "paid", "expired"].includes(String(payload.state)) ||
        !(
          payload.checkout === null ||
          (isRecord(payload.checkout) && isCheckoutUrl(payload.checkout.url))
        )
      )
        throw new ApiError("invalid_response", status, path);
      return {
        reference,
        state: payload.state as TopUpReceipt["state"],
        checkout: payload.checkout === null ? null : { url: payload.checkout.url as string },
      };
    },

    fund: (organizationId: string, settlementProof: string) =>
      call<{ wallet: Wallet }>(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/wallet/funding`,
        { settlementProof },
      ),

    catalog: (organizationId: string) =>
      call<{ offerings: readonly Offering[] }>(
        "GET",
        `/v1/catalog?organizationId=${encodeURIComponent(organizationId)}`,
      ),

    async formSupport(organizationId: string, form: string): Promise<boolean> {
      const path = `${LANE}/support?form=${encodeURIComponent(form)}`;
      const { payload, status } = await request<unknown>(
        "GET",
        path,
        undefined,
        organizationHeader(organizationId),
      );
      if (
        status !== 200 ||
        !isRecord(payload) ||
        payload.form !== form ||
        typeof payload.supported !== "boolean" ||
        !Array.isArray(payload.operations) ||
        !payload.operations.every((entry) => typeof entry === "string")
      )
        throw new ApiError("invalid_response", status, path);
      return payload.supported && payload.operations.includes("create");
    },

    resources: (organizationId: string, query: { cursor?: string; form?: string } = {}) => {
      const search = new URLSearchParams();
      search.set("space", organizationId);
      if (query.form) search.set("form", query.form);
      if (query.cursor) search.set("cursor", query.cursor);
      const path = `${LANE}/resources?${search.toString()}`;
      return request<unknown>("GET", path, undefined, organizationHeader(organizationId)).then(
        ({ payload, status }) => {
          if (
            status !== 200 ||
            !isRecord(payload) ||
            !Array.isArray(payload.items) ||
            !payload.items.every(
              (item) =>
                isV2Resource(item) &&
                item.space === organizationId &&
                (!query.form || item.form === query.form),
            ) ||
            (payload.nextCursor !== null && typeof payload.nextCursor !== "string")
          ) {
            throw new ApiError("invalid_response", status, path);
          }
          return {
            resources: payload.items as ResourceSummary[],
            cursor: payload.nextCursor as string | null,
          };
        },
      );
    },

    /** Accepts once with a caller-held key; ambiguous transport never mints a second key. */
    async createResource(
      organizationId: string,
      declaration: ResourceDeclaration,
      key: string,
    ): Promise<ResourceOperation> {
      const path = `${LANE}/resources`;
      if (declaration.space !== organizationId) throw new ApiError("invalid_request", 0, path);
      const { payload, status } = await request<unknown>("POST", path, declaration, {
        ...organizationHeader(organizationId),
        "idempotency-key": key,
      });
      const accepted = operation(payload, status, path);
      if (accepted.action !== "create" || accepted.generation !== 1)
        throw new ApiError("invalid_response", status, path);
      return accepted;
    },

    /** Updates one UID at the exact generation last read. */
    async updateResource(
      organizationId: string,
      uid: string,
      generation: number,
      spec: Record<string, unknown>,
      key: string,
    ): Promise<ResourceOperation> {
      const path = `${LANE}/resources/${encodeURIComponent(uid)}`;
      const { payload, status } = await request<unknown>(
        "PUT",
        path,
        { spec },
        {
          ...organizationHeader(organizationId),
          "idempotency-key": key,
          "takoform-expected-generation": String(generation),
        },
      );
      const accepted = operation(payload, status, path);
      if (
        accepted.action !== "update" ||
        accepted.resourceUid !== uid ||
        accepted.generation !== generation + 1
      )
        throw new ApiError("invalid_response", status, path);
      return accepted;
    },

    /** Deletes one UID at the exact generation last read. */
    async deleteResource(
      organizationId: string,
      uid: string,
      generation: number,
      key: string,
    ): Promise<ResourceOperation> {
      const path = `${LANE}/resources/${encodeURIComponent(uid)}`;
      const { payload, status } = await request<unknown>("DELETE", path, undefined, {
        ...organizationHeader(organizationId),
        "idempotency-key": key,
        "takoform-expected-generation": String(generation),
      });
      const accepted = operation(payload, status, path);
      if (
        accepted.action !== "delete" ||
        accepted.resourceUid !== uid ||
        accepted.generation !== generation + 1
      )
        throw new ApiError("invalid_response", status, path);
      return accepted;
    },

    /** Reads one accepted operation; never reissues the original mutation. */
    async resourceOperation(organizationId: string, id: string): Promise<ResourceOperation> {
      const path = `${LANE}/operations/${encodeURIComponent(id)}`;
      const { payload, status } = await request<unknown>("GET", path, undefined, {
        ...organizationHeader(organizationId),
      });
      const observed = operation(payload, status, path, true);
      if (observed.id !== id) throw new ApiError("invalid_response", status, path);
      return observed;
    },

    /** Reads a current v2 Resource by UID, independent of list pagination. */
    async resource(organizationId: string, uid: string): Promise<ResourceSummary> {
      const path = `${LANE}/resources/${encodeURIComponent(uid)}`;
      const { payload, status } = await request<unknown>(
        "GET",
        path,
        undefined,
        organizationHeader(organizationId),
      );
      if (
        status !== 200 ||
        !isV2Resource(payload) ||
        payload.uid !== uid ||
        payload.space !== organizationId
      )
        throw new ApiError("invalid_response", status, path);
      return payload;
    },
  };
}

function decodeHostedPlanTable(value: unknown): HostedPlanTable | null {
  if (
    !isRecord(value) ||
    value.scope !== "hosted" ||
    value.balanceScope !== "organization" ||
    !Array.isArray(value.products) ||
    value.products.length !== 2 ||
    value.products[0] !== "takosumi-hosted" ||
    value.products[1] !== "takoserver" ||
    !Array.isArray(value.plans) ||
    (value.plans.length !== 3 && value.plans.length !== 4)
  )
    return null;
  const free = value.plans[0];
  const subscriptions = value.plans.slice(1, -1);
  const usage = value.plans.at(-1);
  if (
    !isRecord(free) ||
    !isPlanKey(free.planId) ||
    free.tier !== "free" ||
    free.resourceScope !== "edge" ||
    free.edgeAllowance !== "pending-owner-runtime-policy" ||
    !isRecord(usage) ||
    !isPlanKey(usage.planId) ||
    usage.tier !== "usage" ||
    !isSafeIntegerAtLeast(usage.checkoutMinimumMinor, 1) ||
    !isSafeIntegerAtLeast(usage.checkoutMaximumMinor, 1) ||
    !isRecord(usage.meters) ||
    usage.checkoutMinimumMinor > usage.checkoutMaximumMinor ||
    !subscriptions.every(
      (plan) =>
        isRecord(plan) &&
        isPlanKey(plan.planId) &&
        plan.tier === "subscription" &&
        isSafeIntegerAtLeast(plan.monthlyAmountMinor, 1) &&
        isSafeIntegerAtLeast(plan.includedCreditMinor, 0) &&
        typeof plan.stripePriceId === "string" &&
        /^price_[A-Za-z0-9_]{1,240}$/u.test(plan.stripePriceId),
    )
  )
    return null;
  if (new Set(value.plans.map((plan) => plan.planId)).size !== value.plans.length) return null;
  return value as unknown as HostedPlanTable;
}

function decodeBillingCapabilities(value: unknown): HostedBillingCapabilities | null {
  if (
    !isRecord(value) ||
    typeof value.contractVersion !== "string" ||
    value.contractVersion.length === 0 ||
    typeof value.topUps !== "boolean" ||
    typeof value.subscriptionStart !== "boolean" ||
    typeof value.subscriptionCancellation !== "boolean" ||
    typeof value.subscriptionPlanChange !== "boolean"
  )
    return null;
  return {
    contractVersion: value.contractVersion,
    topUps: value.topUps,
    subscriptionStart: value.subscriptionStart,
    subscriptionCancellation: value.subscriptionCancellation,
    subscriptionPlanChange: value.subscriptionPlanChange,
  };
}

function isHostedSubscriptionProjection(
  value: unknown,
  organizationId: string,
): value is HostedSubscriptionProjection {
  if (!isRecord(value)) return false;
  return (
    value.organizationId === organizationId &&
    typeof value.subscriptionId === "string" &&
    value.subscriptionId.length > 0 &&
    isSubscriptionRef(value.subscriptionRef) &&
    isPlanKey(value.planKey) &&
    typeof value.pricingRevision === "string" &&
    value.pricingRevision.length > 0 &&
    [
      "incomplete",
      "incomplete_expired",
      "trialing",
      "active",
      "past_due",
      "canceled",
      "unpaid",
      "paused",
    ].includes(String(value.status)) &&
    typeof value.cancelAtPeriodEnd === "boolean" &&
    isCanonicalIsoTimestamp(value.periodStart) &&
    isCanonicalIsoTimestamp(value.periodEnd) &&
    (value.paidThrough === null || isCanonicalIsoTimestamp(value.paidThrough)) &&
    typeof value.paidFeatures === "boolean" &&
    isCanonicalIsoTimestamp(value.updatedAt)
  );
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isBillingReference(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isPlanKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(value);
}

function isStripeSessionId(value: unknown): value is string {
  return typeof value === "string" && /^cs_[A-Za-z0-9_]{1,240}$/u.test(value);
}

function isSubscriptionIntentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^sci_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function isSubscriptionRef(value: unknown): value is string {
  return typeof value === "string" && /^sra_[0-9a-f]{64}$/u.test(value);
}

function isCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === "https://checkout.stripe.com";
  } catch {
    return false;
  }
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isV2Operation(value: unknown): value is ResourceOperation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.resourceUid === "string" &&
    ["create", "update", "delete"].includes(String(value.action)) &&
    Number.isSafeInteger(value.generation) &&
    ["queued", "running", "waiting_input", "reconciling", "succeeded", "failed"].includes(
      String(value.status),
    ) &&
    ["none", "unknown", "partial", "complete"].includes(String(value.effect)) &&
    (value.status !== "succeeded" || value.effect === "complete") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.retainUntil === "string" &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"))
  );
}

function isV2Resource(value: unknown): value is ResourceSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.uid === "string" &&
    value.uid.length > 0 &&
    typeof value.form === "string" &&
    value.form.length > 0 &&
    typeof value.space === "string" &&
    value.space.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    Number.isSafeInteger(value.generation) &&
    Number.isSafeInteger(value.observedGeneration) &&
    (value.observedAt === null || typeof value.observedAt === "string") &&
    ["pending", "idle", "deleting", "error"].includes(String(value.phase)) &&
    isRecord(value.spec) &&
    isRecord(value.observed) &&
    isRecord(value.output) &&
    typeof value.lastOperation === "string"
  );
}

export type Api = ReturnType<typeof createApi>;
