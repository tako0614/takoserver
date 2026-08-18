import type { JsonObject } from "../ports.ts";
import type { TakoformArtifactTransport } from "./artifacts.ts";
import { ArtifactInputError } from "./artifacts.ts";
import type { EngineContext, TakoformEngine } from "./engine.ts";
import { exactInstalledForm, type FormRegistry, formSupportProfile } from "./forms.ts";
import type { OperationRecord, TakoformStore } from "./store.ts";
import {
  type InstalledTakoformForm,
  type TakoformBindingRef,
  type TakoformHost,
  TakoformHostError,
  type TakoformHostPrincipal,
  type TakoformInterfaceRef,
} from "./types.ts";
import {
  etag,
  exactQuery,
  failure,
  parsedResourcePath,
  requiredQuery,
  resourceResponse,
  safeSegment,
} from "./wire.ts";

/**
 * The Takoform Host HTTP surface.
 *
 * Two lanes are served from one engine. `v1beta1` is the released lane a
 * published Terraform provider pins; `v1alpha3` is the current one. They are
 * wire-identical, so the released lane is adapted by rewriting the path prefix
 * only — Form references inside bodies are never rewritten, because a FormRef
 * identifies a definition, not a lane.
 */

const CURRENT_LANE = "/apis/forms.takoform.com/v1alpha3";
const RELEASED_LANE = "/apis/forms.takoform.com/v1beta1";

const SUPPORT_FORM = new RegExp(
  `^${escaped(CURRENT_LANE)}/support/forms/([^/]+)/([^/]+)/([^/]+)/([^/]+)$`,
  "u",
);
const SUPPORT_CONTRACT = new RegExp(
  `^${escaped(CURRENT_LANE)}/support/(interfaces|bindings)/([^/]+)/([^/]+)$`,
  "u",
);
const FORM_DEFINITION = new RegExp(
  `^${escaped(CURRENT_LANE)}/form-definitions/([^/]+)/([^/]+)/([^/]+)$`,
  "u",
);
const RESOURCE = new RegExp(
  `^${escaped(CURRENT_LANE)}/resources/([^/]+)/([^/]+)/([^/]+)/([^/]+)(?:/(import|observe))?$`,
  "u",
);
const OPERATION = new RegExp(`^${escaped(CURRENT_LANE)}/operations/([^/]+)(/cancel)?$`, "u");

/**
 * The provision-token redemption lane.
 *
 * A reseller's runtime enters here with a single-use provision token instead
 * of an organization credential. The token pins one offering — and through it
 * one exact Form — and one opaque tenant, so the lane accepts exactly the
 * resource the reservation paid for: validate and prepare read the token,
 * the one apply spends it. Resources land in the reseller organization's
 * tenancy under a space named by the opaque tenantRef, which is what keeps
 * one reseller customer from seeing another's resources.
 */
const PROVISION_LANE = "/provision/v1";
const PROVISION_RESOURCE = new RegExp(
  `^${escaped(PROVISION_LANE)}/resources/([^/]+)/([^/]+)/([^/]+)/([^/]+)$`,
  "u",
);

export interface ProvisionTokenClaimsView {
  readonly organizationId: string;
  readonly tenantRef: string;
  readonly reservationId: string;
  readonly offeringId: string;
  readonly offeringDigest: string;
  readonly tokenId: string;
}

export interface ProvisionOfferingView {
  readonly form: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  };
}

export interface ProvisionLanePorts {
  readonly tokens: {
    verifyProvisionToken(token: string): Promise<ProvisionTokenClaimsView>;
    consumeProvisionToken(token: string): Promise<ProvisionTokenClaimsView>;
  };
  readonly catalog: {
    findOffering(offeringId: string): ProvisionOfferingView | undefined;
    digest(offering: ProvisionOfferingView): Promise<string>;
  };
}

export interface CreateTakoformRoutesOptions {
  readonly authenticate: (request: Request) => Promise<TakoformHostPrincipal | null>;
  readonly engine: TakoformEngine;
  readonly store: TakoformStore;
  readonly forms: FormRegistry;
  readonly artifacts: TakoformArtifactTransport;
  readonly provision?: ProvisionLanePorts;
}

export function createTakoformRoutes(options: CreateTakoformRoutesOptions): TakoformHost {
  const { authenticate, engine, store, forms, artifacts, provision } = options;

  return {
    async handle(incoming): Promise<Response | null> {
      const request = currentLaneRequest(incoming);
      const url = new URL(request.url);
      if (url.pathname.startsWith(`${PROVISION_LANE}/`)) {
        if (url.pathname.includes("%")) return failure("invalid_argument", 400);
        if (!provision) return failure("not_found", 404);
        try {
          return await provisionRoute(provision, engine, request, url);
        } catch (error) {
          return hostErrorResponse(error, request, url);
        }
      }
      if (!url.pathname.startsWith(CURRENT_LANE)) return null;
      if (url.pathname.includes("%")) return failure("invalid_argument", 400);

      const principal = await authenticate(request);
      if (!principal) return failure("unauthenticated", 401);
      const context: EngineContext = {
        request,
        url,
        tenantId: boundedTenantReference(principal.tenantId),
        principalId: boundedTenantReference(principal.principalId),
        ...(principal.scope?.mode === "provision" && principal.scope.claimCreate
          ? { beforeCreate: principal.scope.claimCreate, provisionOnly: true }
          : {}),
        ...(principal.scope?.expectedResourceUid
          ? { expectedResourceUid: principal.scope.expectedResourceUid }
          : {}),
        ...(principal.scope?.commercialAuthority
          ? { commercialAuthority: principal.scope.commercialAuthority }
          : {}),
      };

      try {
        if (principal.scope) await assertPrincipalScope(principal.scope, request, url);
        const artifactResponse = await artifacts.handle(request, context, failure);
        if (artifactResponse) return artifactResponse;
        return await route(context, url, request);
      } catch (error) {
        return hostErrorResponse(error, request, url);
      }
    },
  };

  async function route(context: EngineContext, url: URL, request: Request): Promise<Response> {
    if (request.method === "GET" && url.pathname === `${CURRENT_LANE}/support/forms`) {
      return Response.json({ profiles: [...forms.values()].map(formSupportProfile) });
    }

    const supportForm = SUPPORT_FORM.exec(url.pathname);
    if (request.method === "GET" && supportForm) {
      const apiVersion = `${safeSegment(supportForm[1])}/${safeSegment(supportForm[2])}`;
      const kind = safeSegment(supportForm[3]);
      const definitionVersion = safeSegment(supportForm[4]);
      const candidates = [...forms.values()].filter(
        (form) =>
          form.identity.formRef.apiVersion === apiVersion &&
          form.identity.formRef.kind === kind &&
          form.identity.formRef.definitionVersion === definitionVersion,
      );
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      if (!candidate) return failure("form_unknown", 404);
      return Response.json(formSupportProfile(candidate));
    }

    const supportContract = SUPPORT_CONTRACT.exec(url.pathname);
    if (request.method === "GET" && supportContract) {
      const route = supportContract[1];
      const name = safeSegment(supportContract[2]);
      const version = safeSegment(supportContract[3]);
      const references: readonly (TakoformInterfaceRef | TakoformBindingRef)[] = [
        ...forms.values(),
      ].flatMap((form): readonly (TakoformInterfaceRef | TakoformBindingRef)[] =>
        route === "interfaces" ? (form.providedInterfaces ?? []) : (form.acceptedBindings ?? []),
      );
      const matches = references.filter(
        (reference) => reference.name === name && reference.version === version,
      );
      const reference = matches[0];
      // An ambiguous contract is treated as absent: the Host will not pick one
      // definition of a name that two Forms disagree about.
      if (
        !reference ||
        matches.some((candidate) => candidate.schemaDigest !== reference.schemaDigest)
      ) {
        return failure("resource_not_found", 404);
      }
      return Response.json(
        route === "interfaces"
          ? {
              apiVersion: "support.takoform.com/v1alpha1",
              kind: "InterfaceSupport",
              interfaceRef: structuredClone(reference),
            }
          : {
              apiVersion: "support.takoform.com/v1alpha1",
              kind: "BindingSupport",
              bindingRef: structuredClone(reference),
            },
      );
    }

    if (request.method === "GET" && url.pathname === `${CURRENT_LANE}/forms`) {
      exactQuery(url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
      requiredQuery(url, "space");
      const form = exactInstalledForm(
        {
          apiVersion: requiredQuery(url, "group"),
          kind: requiredQuery(url, "kind"),
          definitionVersion: requiredQuery(url, "definitionVersion"),
          schemaDigest: requiredQuery(url, "schemaDigest"),
        },
        forms,
      );
      if (!form) return failure("form_unknown", 404);
      return Response.json({
        forms: [
          {
            identity: structuredClone(form.identity),
            definitionKnown: true,
            installed: true,
            executable: true,
            activated: true,
            availableToPrincipal: true,
            operations: [...form.operations],
          },
        ],
      });
    }

    const definition = FORM_DEFINITION.exec(url.pathname);
    if (request.method === "GET" && definition) {
      exactQuery(url, ["definitionVersion", "schemaDigest"]);
      const form = exactInstalledForm(
        {
          apiVersion: `${safeSegment(definition[1])}/${safeSegment(definition[2])}`,
          kind: safeSegment(definition[3]),
          definitionVersion: requiredQuery(url, "definitionVersion"),
          schemaDigest: requiredQuery(url, "schemaDigest"),
        },
        forms,
      );
      if (!form) return failure("form_unknown", 404);
      return Response.json(formDefinition(form));
    }

    if (
      request.method === "POST" &&
      (url.pathname === `${CURRENT_LANE}/resources/validate` ||
        url.pathname === `${CURRENT_LANE}/resources/prepare`)
    ) {
      const result = await engine.validateOrPrepare(
        context,
        url.pathname.endsWith("/validate") ? "validate" : "prepare",
      );
      if (result.kind === "validated") {
        return Response.json({ valid: result.valid, diagnostics: result.diagnostics });
      }
      if (result.kind !== "prepared") throw new TakoformHostError();
      return Response.json({ resource: result.resource, review: result.review });
    }

    const resource = RESOURCE.exec(url.pathname);
    if (resource) {
      const path = parsedResourcePath(resource);
      if (request.method === "GET" && !path.action) {
        return shaped(await engine.read(context, path));
      }
      if (request.method === "PUT" && !path.action) {
        return shaped(await engine.apply(context, path));
      }
      if (request.method === "POST" && path.action === "observe") {
        // Observation answers in an envelope while apply and read answer with
        // the bare resource. That asymmetry is part of the released contract,
        // so it is reproduced rather than tidied away.
        const result = await engine.observe(context, path);
        if (result.kind !== "resource") throw new TakoformHostError();
        return Response.json(
          { resource: result.resource },
          { status: result.status, headers: etag(result.resource) },
        );
      }
      if (request.method === "POST" && path.action === "import") {
        return shaped(await engine.importResource(context, path));
      }
      if (request.method === "DELETE" && !path.action) {
        return shaped(await engine.remove(context, path));
      }
    }

    const operation = OPERATION.exec(url.pathname);
    if (operation) {
      const id = safeSegment(operation[1]);
      const record = await store.readOperation(context.tenantId, id);
      if (!record) return failure("operation_not_found", 404);
      if (operation[2]) {
        if (request.method !== "POST") return failure("invalid_argument", 404);
        // A settled operation has nothing left to withdraw, and saying so is
        // more useful than pretending it was never there.
        return failure("operation_not_cancellable", 409);
      }
      if (request.method !== "GET") return failure("invalid_argument", 404);
      return Response.json({ operation: operationView(record) });
    }

    return failure("invalid_argument", 404);
  }
}

async function assertPrincipalScope(
  scope: NonNullable<TakoformHostPrincipal["scope"]>,
  request: Request,
  url: URL,
): Promise<void> {
  const formPath = `${scope.formRef.apiVersion}/${scope.formRef.kind}`;
  if (request.method === "GET" && url.pathname === `${CURRENT_LANE}/forms`) {
    if (!scopeQueryMatches(scope, url)) throw new TakoformHostError("resource_not_found", 404);
    return;
  }

  const definition = FORM_DEFINITION.exec(url.pathname);
  if (request.method === "GET" && definition) {
    const candidate = `${safeSegment(definition[1])}/${safeSegment(definition[2])}/${safeSegment(definition[3])}`;
    if (
      candidate !== formPath ||
      url.searchParams.get("definitionVersion") !== scope.formRef.definitionVersion ||
      url.searchParams.get("schemaDigest") !== scope.formRef.schemaDigest
    ) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    return;
  }

  if (
    request.method === "POST" &&
    (url.pathname === `${CURRENT_LANE}/resources/validate` ||
      url.pathname === `${CURRENT_LANE}/resources/prepare`)
  ) {
    if (!(await scopeBodyMatches(scope, request))) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    return;
  }

  const resource = RESOURCE.exec(url.pathname);
  if (resource) {
    const path = parsedResourcePath(resource);
    const bodyMutation = request.method === "PUT" || path.action === "import";
    if (
      path.apiVersion !== scope.formRef.apiVersion ||
      path.kind !== scope.formRef.kind ||
      path.name !== scope.resourceName ||
      (bodyMutation ? url.search !== "" : !scopeQueryMatches(scope, url))
    ) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    if (bodyMutation && !(await scopeBodyMatches(scope, request))) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    const create = request.method === "PUT" && request.headers.get("if-none-match") === "*";
    if (create) {
      if (scope.mode !== "provision" || !scope.claimCreate) {
        throw new TakoformHostError("resource_not_found", 404);
      }
    } else if (scope.mode !== "manage") {
      throw new TakoformHostError("resource_not_found", 404);
    }
    return;
  }

  // Support profiles are public protocol metadata and carry no tenant state.
  if (request.method === "GET" && url.pathname.startsWith(`${CURRENT_LANE}/support/`)) return;

  throw new TakoformHostError("resource_not_found", 404);
}

function scopeQueryMatches(scope: NonNullable<TakoformHostPrincipal["scope"]>, url: URL): boolean {
  return (
    url.searchParams.get("space") === scope.space &&
    url.searchParams.get("group") === scope.formRef.apiVersion &&
    url.searchParams.get("kind") === scope.formRef.kind &&
    url.searchParams.get("definitionVersion") === scope.formRef.definitionVersion &&
    url.searchParams.get("schemaDigest") === scope.formRef.schemaDigest
  );
}

async function scopeBodyMatches(
  scope: NonNullable<TakoformHostPrincipal["scope"]>,
  request: Request,
): Promise<boolean> {
  let value: unknown;
  try {
    value = await request.clone().json();
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const metadata = body.metadata;
  const form = body.form;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    typeof form !== "object" ||
    form === null ||
    Array.isArray(form)
  ) {
    return false;
  }
  const formRef = (form as Record<string, unknown>).formRef;
  if (typeof formRef !== "object" || formRef === null || Array.isArray(formRef)) return false;
  const ref = formRef as Record<string, unknown>;
  return (
    body.apiVersion === scope.formRef.apiVersion &&
    body.kind === scope.formRef.kind &&
    (metadata as Record<string, unknown>).space === scope.space &&
    (metadata as Record<string, unknown>).name === scope.resourceName &&
    ref.apiVersion === scope.formRef.apiVersion &&
    ref.kind === scope.formRef.kind &&
    ref.definitionVersion === scope.formRef.definitionVersion &&
    ref.schemaDigest === scope.formRef.schemaDigest
  );
}

function hostErrorResponse(error: unknown, request: Request, url: URL): Response {
  if (error instanceof ArtifactInputError) return failure(error.code, error.status);
  if (error instanceof TakoformHostError) {
    if (process.env.TAKOSERVER_TRACE_HOST_ERRORS) {
      console.error("host error", error.code, error.status, error.stack);
    }
    return failure(error.code, error.status, error.details);
  }
  // Anything else is a driver or runtime fault. The caller gets an
  // internal error with a fresh request id and no borrowed message, so a
  // provider's own words never leak — but the operator needs to see what
  // happened, so it is logged here rather than swallowed.
  console.error(
    JSON.stringify({
      event: "takoform.host.unhandled_error",
      method: request.method,
      path: url.pathname,
      error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
    }),
  );
  return failure("internal_error", 500);
}

async function provisionRoute(
  ports: ProvisionLanePorts,
  engine: TakoformEngine,
  request: Request,
  url: URL,
): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return failure("unauthenticated", 401);
  const token = authorization.slice("Bearer ".length);

  let claims: ProvisionTokenClaimsView;
  try {
    claims = await ports.tokens.verifyProvisionToken(token);
  } catch (error) {
    return provisionTokenFailure(error);
  }

  // The digest pins the commercial terms the reservation paid for. An
  // offering that changed or left the catalog is refused, never substituted.
  const offering = ports.catalog.findOffering(claims.offeringId);
  if (!offering) return failure("offering_unavailable", 409);
  if ((await ports.catalog.digest(offering)) !== claims.offeringDigest) {
    return failure("offering_changed", 409);
  }

  const context: EngineContext = {
    request,
    url,
    tenantId: boundedTenantReference(claims.organizationId),
    principalId: boundedTenantReference(`provision:${claims.tokenId}`),
  };

  if (
    request.method === "POST" &&
    (url.pathname === `${PROVISION_LANE}/resources/validate` ||
      url.pathname === `${PROVISION_LANE}/resources/prepare`)
  ) {
    await assertProvisionBody(request, offering, claims);
    const result = await engine.validateOrPrepare(
      context,
      url.pathname.endsWith("/validate") ? "validate" : "prepare",
    );
    if (result.kind === "validated") {
      return Response.json({ valid: result.valid, diagnostics: result.diagnostics });
    }
    if (result.kind !== "prepared") throw new TakoformHostError();
    return Response.json({ resource: result.resource, review: result.review });
  }

  const resource = PROVISION_RESOURCE.exec(url.pathname);
  if (resource && request.method === "PUT") {
    // The token provisions exactly one new resource. Updates and deletes need
    // the organization's own credentials, so the create precondition is
    // demanded before the token is spent.
    if (request.headers.get("if-none-match") !== "*") {
      return failure("invalid_argument", 400);
    }
    const path = parsedResourcePath(resource);
    await assertProvisionBody(request, offering, claims);
    try {
      await ports.tokens.consumeProvisionToken(token);
    } catch (error) {
      return provisionTokenFailure(error);
    }
    return shaped(await engine.apply(context, path));
  }

  return failure("not_found", 404);
}

/** The body must be the resource the token paid for, in the token's space. */
async function assertProvisionBody(
  request: Request,
  offering: ProvisionOfferingView,
  claims: ProvisionTokenClaimsView,
): Promise<void> {
  let probe: unknown;
  try {
    probe = await request.clone().json();
  } catch {
    throw new TakoformHostError();
  }
  const body = probe as {
    readonly form?: { readonly formRef?: Record<string, unknown> };
    readonly metadata?: { readonly space?: unknown };
  };
  const ref = body?.form?.formRef;
  const pinned =
    ref !== undefined &&
    ref !== null &&
    ref.apiVersion === offering.form.apiVersion &&
    ref.kind === offering.form.kind &&
    ref.definitionVersion === offering.form.definitionVersion &&
    ref.schemaDigest === offering.form.schemaDigest;
  if (!pinned) throw new TakoformHostError("offering_mismatch", 409);
  if (body?.metadata?.space !== claims.tenantRef) {
    throw new TakoformHostError("space_mismatch", 409);
  }
}

function provisionTokenFailure(error: unknown): Response {
  const code = (error as { readonly code?: unknown }).code;
  if (code === "token_replayed") return failure("token_replayed", 409);
  if (code === "state_unavailable") return failure("unavailable", 503);
  return failure("unauthenticated", 401);
}

function shaped(result: Awaited<ReturnType<TakoformEngine["read"]>>): Response {
  if (result.kind === "resource") return resourceResponse(result.resource, result.status);
  if (result.kind === "deleted") return new Response(null, { status: 204 });
  throw new TakoformHostError();
}

function operationView(record: OperationRecord): JsonObject {
  return {
    id: record.id,
    operation: record.operation,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.resource ? { resource: record.resource as unknown as JsonObject } : {}),
  };
}

function formDefinition(form: InstalledTakoformForm): JsonObject {
  return {
    identity: structuredClone(form.identity) as unknown as JsonObject,
    ...(form.displayName ? { displayName: form.displayName } : {}),
    ...(form.description ? { description: form.description } : {}),
    ...(form.role ? { role: form.role } : {}),
    desiredSchema: structuredClone(form.desiredSchema),
    ...(form.observedSchema ? { observedSchema: structuredClone(form.observedSchema) } : {}),
    ...(form.outputSchema ? { outputSchema: structuredClone(form.outputSchema) } : {}),
    ...(form.providedInterfaces
      ? { providedInterfaces: structuredClone(form.providedInterfaces) as unknown as JsonObject[] }
      : {}),
    ...(form.acceptedBindings
      ? { acceptedBindings: structuredClone(form.acceptedBindings) as unknown as JsonObject[] }
      : {}),
  };
}

/**
 * Adapts the released lane onto the current engine. Only the path prefix moves;
 * the body, headers, and every FormRef inside them are passed through
 * unchanged.
 */
function currentLaneRequest(request: Request): Request {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${RELEASED_LANE}/`) && url.pathname !== RELEASED_LANE) {
    return request;
  }
  url.pathname = `${CURRENT_LANE}${url.pathname.slice(RELEASED_LANE.length)}`;
  return new Request(url, request);
}

function boundedTenantReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new TakoformHostError();
  return value;
}

function escaped(value: string): string {
  return value.replaceAll(".", "\\.");
}
