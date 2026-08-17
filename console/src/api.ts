/**
 * The console's view of the Takoserver API.
 *
 * Every call goes through one function so that three things are true
 * everywhere: a failure carries the server's own error code rather than a
 * status number, an expired session is recognised as such instead of surfacing
 * as a generic denial, and no response is trusted to be JSON just because the
 * call succeeded.
 */

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
  readonly price: {
    readonly currency: string;
    readonly unit: string;
    readonly unitPriceMinor: number;
  };
  readonly protocols: readonly string[];
  readonly regions?: readonly string[];
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
}

export interface Operation {
  readonly id: string;
  readonly operation: string;
  readonly state: string;
  readonly createdAt: string;
}

/** What the Host says it can do with one installed Form definition. */
export interface FormSupport {
  readonly formRef: FormRef;
  readonly operations: readonly string[];
  readonly supportedBindings?: readonly string[];
  readonly limits?: { readonly maximumBundleBytes?: number };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "ApiError";
  }

  /** True when the only useful next step is to sign in again. */
  get isExpiredSession(): boolean {
    return this.status === 401 || this.code === "unauthenticated";
  }
}

export interface ApiOptions {
  readonly origin: string;
  readonly token: () => string | null;
  readonly onSessionLost: () => void;
}

export function createApi(options: ApiOptions) {
  const call = async <Result>(method: string, path: string, body?: unknown): Promise<Result> => {
    const token = options.token();
    let response: Response;
    try {
      response = await fetch(`${options.origin}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // A refused connection and a rejected request are different problems and
      // a person can act on the difference, so they never share a message.
      throw new ApiError("unreachable", 0);
    }

    const payload = await response
      .json()
      .catch(() => null as unknown as Record<string, unknown> | null);

    if (!response.ok) {
      const envelope = (payload as { error?: { code?: unknown } } | null)?.error;
      const code = typeof envelope?.code === "string" ? envelope.code : `http_${response.status}`;
      const failure = new ApiError(code, response.status);
      if (failure.isExpiredSession) options.onSessionLost();
      throw failure;
    }
    return payload as Result;
  };

  return {
    identityProviders: () =>
      call<{ providers: readonly string[] }>("GET", "/v1/identity/providers"),

    signIn: (provider: string, assertion: string) =>
      call<{ principal: Principal; sessionToken: string }>("POST", "/v1/sessions", {
        provider,
        assertion,
      }),

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

    operations: (organizationId: string) =>
      call<{ operations: readonly Operation[] }>(
        "GET",
        `/v1/organizations/${encodeURIComponent(organizationId)}/operations`,
      ),

    // The Host's own account of what it will accept. It needs no organization:
    // which Forms exist is a property of the platform, not of a tenant.
    forms: () =>
      call<{ profiles: readonly FormSupport[] }>(
        "GET",
        "/apis/forms.takoform.com/v1alpha3/support/forms",
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
