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

export type ResourceSummary = V2Resource;

export interface Operation {
  readonly id: string;
  readonly operation: string;
  readonly state: string;
  readonly createdAt: string;
}

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
      const failure = new ApiError(code, response.status, path);
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

    resources: (organizationId: string, query: { cursor?: string } = {}) => {
      const search = new URLSearchParams();
      search.set("space", organizationId);
      if (query.cursor) search.set("cursor", query.cursor);
      const path = `${LANE}/resources?${search.toString()}`;
      return request<unknown>("GET", path, undefined, organizationHeader(organizationId)).then(
        ({ payload, status }) => {
          if (
            status !== 200 ||
            !isRecord(payload) ||
            !Array.isArray(payload.items) ||
            !payload.items.every((item) => isV2Resource(item) && item.space === organizationId) ||
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

    operations: (organizationId: string) =>
      call<{ operations: readonly Operation[] }>(
        "GET",
        `/v1/organizations/${encodeURIComponent(organizationId)}/operations`,
      ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
