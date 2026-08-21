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
import type { TakoformBindingRef, TakoformInterfaceRef } from "../../src/interface-ref.ts";

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
  readonly settledDeltaMinor: number;
  readonly heldDeltaMinor: number;
  readonly createdAt: string;
}

export interface Wallet {
  readonly organizationId: string;
  readonly currency: string;
  readonly settledMinor: number;
  readonly heldMinor: number;
  readonly availableMinor: number;
  readonly entries: readonly LedgerEntry[];
}

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

export interface Condition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly observedGeneration?: string;
}

export interface ResourceStatus {
  readonly conditions?: readonly Condition[];
  readonly observed?: Record<string, unknown>;
  readonly outputs?: Record<string, unknown>;
  readonly observedGeneration?: string;
}

export interface ResourceSummary {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly space: string;
    readonly name: string;
    readonly uid: string;
    readonly generation: string;
    readonly revision: string;
    readonly updatedAt: string;
  };
  readonly spec?: Record<string, unknown>;
  readonly status?: ResourceStatus;
  readonly form?: { readonly formRef: FormRef };
}

export interface Operation {
  readonly id: string;
  readonly operation: string;
  readonly state: string;
  readonly createdAt: string;
}

/** The exact-pin lane this console speaks. */
const LANE = "/apis/forms.takoform.com/v1alpha3";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(code);
    this.name = "ApiError";
  }

  /**
   * True when the only useful next step is to sign in again.
   *
   * Scoped to the control plane on purpose. Takoserver serves other lanes with
   * their own credentials, and a 401 from one of those means the console asked
   * the wrong door — not that the person's session died. Treating every 401 as
   * a dead session logs somebody out for a mistake this code made.
   */
  get isExpiredSession(): boolean {
    return this.path.startsWith("/v1/") && (this.status === 401 || this.code === "unauthenticated");
  }
}

/** A resource as a person declares it in the console. */
export interface ResourceDeclaration {
  readonly form: FormRef;
  readonly space: string;
  readonly name: string;
  readonly spec: Record<string, unknown>;
}

export interface ApiOptions {
  readonly origin: string;
  readonly token: () => string | null;
  readonly onSessionLost: () => void;
}

export function createApi(options: ApiOptions) {
  const call = async <Result>(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Result> => {
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
      const code = typeof envelope?.code === "string" ? envelope.code : `http_${response.status}`;
      const failure = new ApiError(code, response.status, path);
      if (failure.isExpiredSession) options.onSessionLost();
      throw failure;
    }
    return payload as Result;
  };

  return {
    identityProviders: () =>
      call<{ providers: readonly IdentityProvider[] }>("GET", "/v1/identity/providers"),

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

    me: () =>
      call<{ principal: Principal; organizations: readonly Organization[] }>("GET", "/v1/me"),

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

    wallet: (organizationId: string) =>
      call<{ wallet: Wallet }>(
        "GET",
        `/v1/organizations/${encodeURIComponent(organizationId)}/wallet`,
      ),

    /**
     * Starts a payment. Answers 404 where this deployment cannot take one,
     * which is how the console knows not to offer it.
     */
    beginCheckout: (organizationId: string, amountMinor: number) =>
      call<{ checkout: { url: string } }>(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/wallet/checkout`,
        { amountMinor },
      ),

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

    resources: (organizationId: string, query: { space?: string; cursor?: string } = {}) => {
      const search = new URLSearchParams();
      if (query.space) search.set("space", query.space);
      if (query.cursor) search.set("cursor", query.cursor);
      const suffix = search.size === 0 ? "" : `?${search.toString()}`;
      return call<{ resources: readonly ResourceSummary[]; cursor?: string }>(
        "GET",
        `/v1/organizations/${encodeURIComponent(organizationId)}/resources${suffix}`,
      );
    },

    /**
     * Creates a resource through the exact-pin lane.
     *
     * Two calls, because the protocol is reviewed: the Host says exactly what
     * it read, and the apply must present that digest back. A console that
     * skipped the review would be one that could apply something other than
     * what it showed.
     */
    async createResource(organizationId: string, declaration: ResourceDeclaration) {
      const body = {
        apiVersion: declaration.form.apiVersion,
        kind: declaration.form.kind,
        form: { formRef: declaration.form },
        metadata: { name: declaration.name, space: declaration.space },
        spec: declaration.spec,
      };
      const naming = { "takoform-organization": organizationId };
      const prepared = await call<{ review: { prepareDigest: string } }>(
        "POST",
        `${LANE}/resources/prepare`,
        body,
        naming,
      );
      const [group, version] = declaration.form.apiVersion.split("/");
      return await call<ResourceSummary>(
        "PUT",
        `${LANE}/resources/${group}/${version}/${declaration.form.kind}/${encodeURIComponent(declaration.name)}`,
        { ...body, review: { prepareDigest: prepared.review.prepareDigest } },
        {
          ...naming,
          "idempotency-key": `console-${declaration.space}-${declaration.name}-${Date.now()}`,
          "if-none-match": "*",
        },
      );
    },

    /** Deletes a resource, fenced on the generation the console last read. */
    deleteResource(
      organizationId: string,
      declaration: Omit<ResourceDeclaration, "spec">,
      generation: string,
    ) {
      const [group, version] = declaration.form.apiVersion.split("/");
      const query = new URLSearchParams({
        space: declaration.space,
        group: declaration.form.apiVersion,
        kind: declaration.form.kind,
        definitionVersion: declaration.form.definitionVersion,
        schemaDigest: declaration.form.schemaDigest,
      });
      return call<void>(
        "DELETE",
        `${LANE}/resources/${group}/${version}/${declaration.form.kind}/${encodeURIComponent(declaration.name)}?${query}`,
        undefined,
        {
          "takoform-organization": organizationId,
          "idempotency-key": `console-delete-${declaration.name}-${Date.now()}`,
          "takoform-expected-generation": generation,
        },
      );
    },

    operations: (organizationId: string) =>
      call<{ operations: readonly Operation[] }>(
        "GET",
        `/v1/organizations/${encodeURIComponent(organizationId)}/operations`,
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
