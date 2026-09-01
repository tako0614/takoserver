import type { JsonObject } from "../ports.ts";
import type { TakoformArtifactTransport } from "./artifacts.ts";
import { ArtifactInputError } from "./artifacts.ts";
import { type BindingRegistry, installedBindings } from "./bindings.ts";
import type { EngineContext, TakoformEngine } from "./engine.ts";
import {
  DIGEST,
  exactInstalledForm,
  type FormRegistry,
  formKey,
  formSupportProfile,
  installedForms,
  isDefinitionVersion,
  isFormApiVersion,
  isFormGroup,
  isKind,
} from "./forms.ts";
import type {
  TakoformAuthorityCatalog,
  TakoformAuthoritySupportLookup,
  TakoformHostAuthority,
} from "./host-authority.ts";
import type { DeferredOperations } from "./operations.ts";
import type { OperationRecord, TakoformStore } from "./store.ts";
import {
  type InstalledTakoformForm,
  type TakoformBindingRef,
  type TakoformFormAvailability,
  type TakoformFormAvailabilityResolver,
  type TakoformHost,
  TakoformHostError,
  type TakoformHostPrincipal,
  type TakoformHostResourceScope,
  type TakoformInterfaceRef,
  type TakoformRuntimeInputPolicy,
} from "./types.ts";
import {
  etag,
  exactQuery,
  failure,
  parsedResourcePath,
  portableResourceView,
  requiredQuery,
  resourceResponse,
  safeSegment,
  spaceId,
} from "./wire.ts";

/**
 * The Takoform Host HTTP surface.
 *
 * The default composition serves the one literal stable Host API lane. Retired
 * alpha/beta paths are deliberately not aliases: a stale client must receive
 * an exact 404 rather than believe it is still speaking its old contract.
 * FormRef versions remain independent of this route identity.
 */

const STABLE_LANE = "/apis/forms.takoform.com/v1";

export interface TakoformRouteConfiguration {
  readonly hostApiVersion: string;
  readonly apiPath: `/apis/${string}`;
  readonly aliases?: readonly `/apis/${string}`[];
  readonly supportProfileApiVersion:
    | "support.takoform.com/v1alpha1"
    | "support.takoform.com/v1alpha2"
    | "support.takoform.com/v1";
  readonly enumerateForms?: boolean;
  readonly exposeDefinitionConstraints?: boolean;
  readonly omitObservedStatus?: boolean;
  readonly bodyGenerationFence?: boolean;
  readonly reviewSpecDigest?: boolean;
}

export const DEFAULT_TAKOFORM_ROUTES: TakoformRouteConfiguration = Object.freeze({
  hostApiVersion: "forms.takoform.com/v1",
  apiPath: STABLE_LANE,
  supportProfileApiVersion: "support.takoform.com/v1",
  enumerateForms: true,
  exposeDefinitionConstraints: true,
  omitObservedStatus: true,
  bodyGenerationFence: true,
  reviewSpecDigest: true,
});

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
  readonly offeringDigest: `sha256:${string}`;
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
  readonly bindings: BindingRegistry;
  readonly artifacts: TakoformArtifactTransport;
  readonly routes?: TakoformRouteConfiguration;
  readonly provision?: ProvisionLanePorts;
  readonly deferredOperations?: DeferredOperations;
  readonly availability?: TakoformFormAvailabilityResolver;
  readonly runtimeInputPolicy?: Pick<TakoformRuntimeInputPolicy, "guaranteedMaximum">;
  /** Durable public discovery/support/activation authority. */
  readonly authority?: TakoformHostAuthority;
}

export function createTakoformRoutes(options: CreateTakoformRoutesOptions): TakoformHost {
  const {
    authenticate,
    engine,
    store,
    forms,
    bindings,
    artifacts,
    provision,
    deferredOperations,
    availability,
    runtimeInputPolicy,
    authority,
  } = options;
  const configuration = options.routes ?? DEFAULT_TAKOFORM_ROUTES;
  const lane = configuration.apiPath;
  const strictStableLane = lane === STABLE_LANE;
  // The stable lane carries the complete versionless Form family as one path
  // segment. Retained historical lanes keep their predecessor's optional
  // family-version segment so their old fixtures remain reachable only when
  // explicitly composed.
  const groupPath = strictStableLane
    ? "([^/]+)"
    : "([^/]+)(?:/(v[0-9]+(?:(?:alpha|beta)[0-9]+)?))?";
  const supportFormPattern = new RegExp(
    `^${escaped(lane)}/support/forms/${groupPath}/([^/]+)/([^/]+)$`,
    "u",
  );
  const supportContractPattern = new RegExp(
    `^${escaped(lane)}/support/(interfaces|bindings)/([^/]+)/([^/]+)$`,
    "u",
  );
  const formDefinitionPattern = new RegExp(
    `^${escaped(lane)}/form-definitions/${groupPath}/([^/]+)$`,
    "u",
  );
  const resourcePattern = new RegExp(
    `^${escaped(lane)}/resources/${groupPath}/([^/]+)/([^/]+)(?:/(import|observe))?$`,
    "u",
  );
  const operationPattern = new RegExp(`^${escaped(lane)}/operations/([^/]+)(/cancel)?$`, "u");

  const catalogRegistry = (
    catalog: TakoformAuthorityCatalog,
    supportedOnly: boolean,
  ): {
    readonly forms: FormRegistry;
    readonly bindings: BindingRegistry;
    readonly availability: ReadonlyMap<string, TakoformFormAvailability>;
  } => {
    const entries = supportedOnly
      ? catalog.forms.filter((entry) => entry.supported)
      : catalog.forms;
    return {
      forms: installedForms(
        entries.map((entry) => entry.form),
        configuration.hostApiVersion,
      ),
      bindings: installedBindings(catalog.bindings),
      availability: new Map(
        entries.map((entry) => [formKey(entry.form.identity.formRef), entry.availability]),
      ),
    };
  };

  const supportRegistry = async (context: EngineContext) =>
    authority
      ? catalogRegistry(
          await authority.supportCatalog({
            tenantId: context.tenantId,
            principalId: context.principalId,
          }),
          true,
        )
      : {
          forms,
          bindings,
          availability: new Map<string, TakoformFormAvailability>(),
        };

  const targetedSupportRegistry = async (
    context: EngineContext,
    query: TakoformAuthoritySupportLookup,
  ) => {
    if (!authority?.lookupSupport) return await supportRegistry(context);
    const projected = await authority.lookupSupport(
      {
        tenantId: context.tenantId,
        principalId: context.principalId,
      },
      query,
    );
    // A durable query may expose two supported schema digests for one Form
    // definition. The regular registry intentionally rejects that shape, but
    // a targeted support route must turn it into the route's ordinary absent
    // result (404), not an internal error or an arbitrary winner.
    if (hasAmbiguousSupportedForms(projected.forms)) {
      return catalogRegistry({ forms: [], bindings: [] }, true);
    }
    return catalogRegistry(projected, true);
  };

  const requestCatalog = async (context: EngineContext, space: string | null) => {
    if (!authority) {
      return {
        forms,
        bindings,
        availability: new Map<string, TakoformFormAvailability>(),
      };
    }
    if (space === null) {
      const support = await authority.supportCatalog({
        tenantId: context.tenantId,
        principalId: context.principalId,
      });
      const inactive: TakoformAuthorityCatalog = {
        ...support,
        forms: support.forms.map((entry) => ({
          ...entry,
          availability: {
            executable: entry.supported && entry.availability.executable,
            activated: false,
            availableToPrincipal: false,
          },
        })),
      };
      return catalogRegistry(inactive, false);
    }
    return catalogRegistry(
      await authority.catalog({
        tenantId: context.tenantId,
        principalId: context.principalId,
        space: spaceId(space),
      }),
      false,
    );
  };

  return {
    ...(deferredOperations
      ? {
          maintenance: {
            drainProviderRepairs: async (limit?: number) =>
              await deferredOperations.drainProviderRepairs(limit),
          },
        }
      : {}),
    async handle(incoming): Promise<Response | null> {
      const request = laneRequest(incoming, configuration);
      const url = new URL(request.url);
      if (url.pathname.startsWith(`${PROVISION_LANE}/`)) {
        if (url.pathname.includes("%")) return failure("invalid_argument", 400);
        if (!provision) return failure("not_found", 404);
        try {
          return await provisionRoute(provision, engine, request, url);
        } catch (error) {
          return hostErrorResponse(error, request, url, true);
        }
      }
      if (url.pathname !== lane && !url.pathname.startsWith(`${lane}/`)) return null;
      if (url.pathname.includes("%")) return failure("invalid_argument", 400);

      const principal = await authenticate(request);
      if (!principal) return failure("unauthenticated", 401);
      const requiredScope = requiredResourceScope(request, url, lane);
      if (
        requiredScope !== undefined &&
        principal.scopes !== undefined &&
        !principalGrants(principal.scopes, requiredScope)
      ) {
        return failure("permission_denied", 403);
      }
      const exactScope = principal.scope?.mode === "tenant-run" ? undefined : principal.scope;
      const context: EngineContext = {
        request,
        url,
        tenantId: boundedTenantReference(principal.tenantId),
        principalId: boundedTenantReference(principal.principalId),
        ...(principal.scope?.mode === "tenant-run" &&
        principal.scope.workerEndpointOriginReservationId
          ? {
              workerEndpointOriginReservationId: principal.scope.workerEndpointOriginReservationId,
            }
          : {}),
        ...(exactScope?.mode === "provision" && exactScope.claimCreate
          ? { beforeCreate: exactScope.claimCreate, provisionOnly: true }
          : {}),
        ...(exactScope?.expectedResourceUid
          ? { expectedResourceUid: exactScope.expectedResourceUid }
          : {}),
        ...(exactScope?.commercialAuthority
          ? { commercialAuthority: exactScope.commercialAuthority }
          : {}),
      };

      try {
        if (principal.scope) {
          await assertPrincipalScope(
            principal.scope,
            request,
            url,
            lane,
            formDefinitionPattern,
            resourcePattern,
          );
        }
        const artifactResponse = await artifacts.handle(request, context, failure);
        if (artifactResponse) return artifactResponse;
        return await route(context, url, request);
      } catch (error) {
        return hostErrorResponse(error, request, url, principal.scope !== undefined);
      }
    },
  };

  async function route(context: EngineContext, url: URL, request: Request): Promise<Response> {
    if (request.method === "GET" && url.pathname === `${lane}/support/forms`) {
      const registry = await supportRegistry(context);
      return Response.json({
        profiles: [...registry.forms.values()].map((form) =>
          formSupportProfile(
            form,
            configuration.supportProfileApiVersion,
            runtimeInputPolicy?.guaranteedMaximum(form) ?? 0,
          ),
        ),
      });
    }

    const supportForm = supportFormPattern.exec(url.pathname);
    if (request.method === "GET" && supportForm) {
      const apiVersion = joinedGroup(
        supportForm[1],
        strictStableLane ? undefined : supportForm[2],
        strictStableLane,
      );
      const kind = safeSegment(strictStableLane ? supportForm[2] : supportForm[3]);
      const definitionVersion = safeSegment(strictStableLane ? supportForm[3] : supportForm[4]);
      const registry = await targetedSupportRegistry(context, {
        target: "form",
        apiVersion,
        kind,
        definitionVersion,
      });
      const candidates = [...registry.forms.values()].filter(
        (form) =>
          form.identity.formRef.apiVersion === apiVersion &&
          form.identity.formRef.kind === kind &&
          form.identity.formRef.definitionVersion === definitionVersion,
      );
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      if (!candidate) return failure("form_unknown", 404);
      return Response.json(
        formSupportProfile(
          candidate,
          configuration.supportProfileApiVersion,
          runtimeInputPolicy?.guaranteedMaximum(candidate) ?? 0,
        ),
      );
    }

    const supportContract = supportContractPattern.exec(url.pathname);
    if (request.method === "GET" && supportContract) {
      const route = supportContract[1];
      const name = safeSegment(supportContract[2]);
      const version = safeSegment(supportContract[3]);
      const registry = await targetedSupportRegistry(context, {
        target: route === "interfaces" ? "interface" : "binding",
        name,
        version,
      });
      const references: readonly (TakoformInterfaceRef | TakoformBindingRef)[] =
        route === "interfaces"
          ? [
              ...[...registry.forms.values()].flatMap((form) => form.providedInterfaces ?? []),
              ...[...registry.bindings.values()].map((binding) => binding.targetInterface),
            ]
          : [...registry.bindings.values()].map((binding) => binding.bindingRef);
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
              apiVersion: configuration.supportProfileApiVersion,
              kind: "InterfaceSupport",
              interfaceRef: structuredClone(reference),
            }
          : {
              apiVersion: configuration.supportProfileApiVersion,
              kind: "BindingSupport",
              bindingRef: structuredClone(reference),
            },
      );
    }

    if (request.method === "GET" && url.pathname === `${lane}/forms`) {
      const catalog = await requestCatalog(context, url.searchParams.get("space"));
      if (configuration.enumerateForms) {
        validateFormsFilters(url);
        const filters = {
          group: url.searchParams.get("group"),
          kind: url.searchParams.get("kind"),
          definitionVersion: url.searchParams.get("definitionVersion"),
          schemaDigest: url.searchParams.get("schemaDigest"),
        };
        return Response.json({
          forms: await Promise.all(
            [...catalog.forms.values()]
              .filter(
                (form) =>
                  (filters.group === null || form.identity.formRef.apiVersion === filters.group) &&
                  (filters.kind === null || form.identity.formRef.kind === filters.kind) &&
                  (filters.definitionVersion === null ||
                    form.identity.formRef.definitionVersion === filters.definitionVersion) &&
                  (filters.schemaDigest === null ||
                    form.identity.formRef.schemaDigest === filters.schemaDigest),
              )
              .map(async (form) =>
                formAvailability(
                  form,
                  catalog.availability.get(formKey(form.identity.formRef)) ??
                    (await availabilityOf(availability, context, form)),
                ),
              ),
          ),
        });
      }
      exactQuery(url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
      requiredQuery(url, "space");
      const form = exactInstalledForm(
        {
          apiVersion: requiredQuery(url, "group"),
          kind: requiredQuery(url, "kind"),
          definitionVersion: requiredQuery(url, "definitionVersion"),
          schemaDigest: requiredQuery(url, "schemaDigest"),
        },
        catalog.forms,
      );
      if (!form) return failure("form_unknown", 404);
      return Response.json({
        forms: [
          formAvailability(
            form,
            catalog.availability.get(formKey(form.identity.formRef)) ??
              (await availabilityOf(availability, context, form)),
          ),
        ],
      });
    }

    const definition = formDefinitionPattern.exec(url.pathname);
    if (request.method === "GET" && definition) {
      exactQuery(
        url,
        strictStableLane
          ? ["space", "definitionVersion", "schemaDigest"]
          : ["space", "group", "kind", "definitionVersion", "schemaDigest"],
      );
      requiredQuery(url, "space");
      const catalog = await requestCatalog(context, requiredQuery(url, "space"));
      const apiVersion = joinedGroup(
        definition[1],
        strictStableLane ? undefined : definition[2],
        strictStableLane,
      );
      const kind = safeSegment(strictStableLane ? definition[2] : definition[3]);
      if (
        !strictStableLane &&
        (requiredQuery(url, "group") !== apiVersion || requiredQuery(url, "kind") !== kind)
      ) {
        throw new TakoformHostError();
      }
      const form = exactInstalledForm(
        {
          apiVersion,
          kind,
          definitionVersion: requiredQuery(url, "definitionVersion"),
          schemaDigest: requiredQuery(url, "schemaDigest"),
        },
        catalog.forms,
      );
      if (!form) return failure("form_unknown", 404);
      return Response.json(formDefinition(form, configuration.exposeDefinitionConstraints));
    }

    if (
      request.method === "POST" &&
      (url.pathname === `${lane}/resources/validate` ||
        url.pathname === `${lane}/resources/prepare`)
    ) {
      const result = await engine.validateOrPrepare(
        context,
        url.pathname.endsWith("/validate") ? "validate" : "prepare",
      );
      if (result.kind === "validated") {
        return Response.json({
          valid: result.valid,
          diagnostics: result.diagnostics,
        });
      }
      if (result.kind !== "prepared") throw new TakoformHostError();
      return Response.json({
        resource: renderedResource(result.resource, configuration.omitObservedStatus),
        review: result.review,
      });
    }

    const resource = resourcePattern.exec(url.pathname);
    if (resource) {
      const path = parsedResourcePathForLane(resource, strictStableLane);
      if (request.method === "GET" && !path.action) {
        return shaped(await engine.read(context, path), configuration.omitObservedStatus);
      }
      if (request.method === "PUT" && !path.action) {
        const deferred = await deferredOperations?.accept(context, path, "apply");
        if (deferred) return deferred;
        return shaped(await engine.apply(context, path), configuration.omitObservedStatus);
      }
      if (request.method === "POST" && path.action === "observe") {
        // Observation answers in an envelope while apply and read answer with
        // the bare resource. That asymmetry is part of the released contract,
        // so it is reproduced rather than tidied away.
        const result = await engine.observe(context, path);
        if (result.kind !== "resource") throw new TakoformHostError();
        const resourceView = renderedResource(result.resource, configuration.omitObservedStatus);
        return Response.json(
          { resource: resourceView },
          { status: result.status, headers: etag(resourceView) },
        );
      }
      if (request.method === "POST" && path.action === "import") {
        const deferred = await deferredOperations?.accept(context, path, "import");
        if (deferred) return deferred;
        return shaped(await engine.importResource(context, path), configuration.omitObservedStatus);
      }
      if (request.method === "DELETE" && !path.action) {
        const deferred = await deferredOperations?.accept(context, path, "delete");
        if (deferred) return deferred;
        return shaped(await engine.remove(context, path), configuration.omitObservedStatus);
      }
    }

    const operation = operationPattern.exec(url.pathname);
    if (operation) {
      const id = safeSegment(operation[1]);
      const deferred = await deferredOperations?.handle(context, id, operation[2] === "/cancel");
      if (deferred) return deferred;
      const record = await store.readOperation(context.tenantId, id);
      if (!record) return failure("operation_not_found", 404);
      if (operation[2]) {
        if (request.method !== "POST") return failure("invalid_argument", 404);
        // A settled operation has nothing left to withdraw, and saying so is
        // more useful than pretending it was never there.
        return failure("operation_not_cancellable", 409);
      }
      if (request.method !== "GET") return failure("invalid_argument", 404);
      return Response.json({
        operation: operationView(record, configuration.omitObservedStatus),
      });
    }

    return failure("invalid_argument", 404);
  }
}

function requiredResourceScope(
  request: Request,
  url: URL,
  lane: string,
): TakoformHostResourceScope | undefined {
  if (url.pathname !== lane && !url.pathname.startsWith(`${lane}/`)) return undefined;
  if (request.method === "GET") return "resources:read";
  if (
    request.method === "POST" &&
    (url.pathname === `${lane}/resources/validate` || url.pathname.endsWith("/observe"))
  ) {
    return "resources:read";
  }
  return "resources:write";
}

function principalGrants(
  scopes: readonly TakoformHostResourceScope[],
  wanted: TakoformHostResourceScope,
): boolean {
  return (
    scopes.includes(wanted) || (wanted === "resources:read" && scopes.includes("resources:write"))
  );
}

async function assertPrincipalScope(
  scope: NonNullable<TakoformHostPrincipal["scope"]>,
  request: Request,
  url: URL,
  lane: string,
  formDefinitionPattern: RegExp,
  resourcePattern: RegExp,
): Promise<void> {
  if (scope.mode === "tenant-run") {
    await assertTenantRunScope(
      scope.space,
      request,
      url,
      lane,
      formDefinitionPattern,
      resourcePattern,
    );
    return;
  }
  const formPath = `${scope.formRef.apiVersion}/${scope.formRef.kind}`;
  if (request.method === "GET" && url.pathname === `${lane}/forms`) {
    if (!scopeQueryMatches(scope, url)) throw new TakoformHostError("resource_not_found", 404);
    return;
  }

  const definition = formDefinitionPattern.exec(url.pathname);
  if (request.method === "GET" && definition) {
    const candidate = `${joinedGroup(
      definition[1],
      lane === STABLE_LANE ? undefined : definition[2],
      lane === STABLE_LANE,
    )}/${safeSegment(lane === STABLE_LANE ? definition[2] : definition[3])}`;
    if (
      candidate !== formPath ||
      url.searchParams.get("space") !== scope.space ||
      url.searchParams.get("definitionVersion") !== scope.formRef.definitionVersion ||
      url.searchParams.get("schemaDigest") !== scope.formRef.schemaDigest
    ) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    return;
  }

  if (
    request.method === "POST" &&
    (url.pathname === `${lane}/resources/validate` || url.pathname === `${lane}/resources/prepare`)
  ) {
    if (!(await scopeBodyMatches(scope, request))) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    return;
  }

  const resource = resourcePattern.exec(url.pathname);
  if (resource) {
    const path = parsedResourcePathForLane(resource, lane === STABLE_LANE);
    const bodyMutation = request.method === "PUT" || path.action === "import";
    if (
      path.apiVersion !== scope.formRef.apiVersion ||
      path.kind !== scope.formRef.kind ||
      path.name !== scope.resourceName ||
      (bodyMutation
        ? url.search !== ""
        : !scopeResourceQueryMatches(scope, url, lane === STABLE_LANE))
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
  if (request.method === "GET" && url.pathname.startsWith(`${lane}/support/`)) return;

  throw new TakoformHostError("resource_not_found", 404);
}

async function assertTenantRunScope(
  space: string,
  request: Request,
  url: URL,
  lane: string,
  formDefinitionPattern: RegExp,
  resourcePattern: RegExp,
): Promise<void> {
  if (
    request.method === "GET" &&
    (url.pathname === `${lane}/forms` || formDefinitionPattern.test(url.pathname))
  ) {
    if (url.searchParams.get("space") !== space) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    return;
  }
  // Support profiles are public protocol metadata and carry no tenant state.
  if (request.method === "GET" && url.pathname.startsWith(`${lane}/support/`)) {
    return;
  }
  // Artifact access is already bound by the transport to tenantId and the
  // run-token's unique principalId. A normal multi-Resource provider run must
  // be able to upload Worker, asset, and migration bundles before applying the
  // Resources that reference them.
  if (url.pathname.startsWith(`${lane}/artifacts/`)) return;
  if (
    request.method === "POST" &&
    (url.pathname === `${lane}/resources/validate` || url.pathname === `${lane}/resources/prepare`)
  ) {
    if (!(await bodySpaceMatches(space, request))) {
      throw new TakoformHostError("resource_not_found", 404);
    }
    return;
  }
  const resource = resourcePattern.exec(url.pathname);
  if (resource) {
    const path = parsedResourcePathForLane(resource, lane === STABLE_LANE);
    const bodyMutation = request.method === "PUT" || path.action === "import";
    const matches = bodyMutation
      ? url.search === "" && (await bodySpaceMatches(space, request))
      : url.searchParams.get("space") === space;
    if (!matches) throw new TakoformHostError("resource_not_found", 404);
    return;
  }
  if (/\/operations\/[A-Za-z0-9._:-]+(?:\/cancel)?$/u.test(url.pathname)) return;
  throw new TakoformHostError("resource_not_found", 404);
}

async function bodySpaceMatches(space: string, request: Request): Promise<boolean> {
  try {
    const value = await request.clone().json();
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).metadata === "object" &&
      (value as { metadata?: { space?: unknown } }).metadata?.space === space
    );
  } catch {
    return false;
  }
}

type ExactResourcePrincipalScope = Exclude<
  NonNullable<TakoformHostPrincipal["scope"]>,
  { readonly mode: "tenant-run" }
>;

function scopeQueryMatches(scope: ExactResourcePrincipalScope, url: URL): boolean {
  return (
    url.searchParams.get("space") === scope.space &&
    url.searchParams.get("group") === scope.formRef.apiVersion &&
    url.searchParams.get("kind") === scope.formRef.kind &&
    url.searchParams.get("definitionVersion") === scope.formRef.definitionVersion &&
    url.searchParams.get("schemaDigest") === scope.formRef.schemaDigest
  );
}

function scopeResourceQueryMatches(
  scope: ExactResourcePrincipalScope,
  url: URL,
  stableLane: boolean,
): boolean {
  return (
    url.searchParams.get("space") === scope.space &&
    url.searchParams.get("definitionVersion") === scope.formRef.definitionVersion &&
    url.searchParams.get("schemaDigest") === scope.formRef.schemaDigest &&
    (stableLane ||
      (url.searchParams.get("group") === scope.formRef.apiVersion &&
        url.searchParams.get("kind") === scope.formRef.kind))
  );
}

async function scopeBodyMatches(
  scope: ExactResourcePrincipalScope,
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

function hostErrorResponse(
  error: unknown,
  request: Request,
  url: URL,
  redactClaimHolder = false,
): Response {
  if (error instanceof ArtifactInputError) return failure(error.code, error.status);
  if (error instanceof TakoformHostError) {
    if (process.env.TAKOSERVER_TRACE_HOST_ERRORS) {
      console.error("host error", error.code, error.status, error.stack);
    }
    return failure(
      error.code,
      error.status,
      redactClaimHolder ? withoutClaimHolder(error.details) : error.details,
    );
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

function withoutClaimHolder(details: unknown): unknown {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return details;
  const entries = Object.entries(details).filter(([key]) => key !== "holder");
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
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
    // The reservation already holds this exact Offering's price. Without this
    // authority the provider driver treats redemption as an ordinary direct
    // organization apply and charges the wallet a second time.
    commercialAuthority: {
      reservationId: claims.reservationId,
      offeringId: claims.offeringId,
      offeringDigest: claims.offeringDigest,
    },
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
      return Response.json({
        valid: result.valid,
        diagnostics: result.diagnostics,
      });
    }
    if (result.kind !== "prepared") throw new TakoformHostError();
    return Response.json({
      resource: renderedResource(result.resource),
      review: result.review,
    });
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

function shaped(
  result: Awaited<ReturnType<TakoformEngine["read"]>>,
  omitObservedStatus = false,
): Response {
  if (result.kind === "resource") {
    return resourceResponse(result.resource, result.status, omitObservedStatus);
  }
  if (result.kind === "deleted") return new Response(null, { status: 204 });
  throw new TakoformHostError();
}

function operationView(record: OperationRecord, omitObservedStatus = false): JsonObject {
  return {
    id: record.id,
    operation: record.operation,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.resource
      ? {
          resource: renderedResource(record.resource, omitObservedStatus) as unknown as JsonObject,
        }
      : {}),
  };
}

function formDefinition(form: InstalledTakoformForm, exposeConstraints = false): JsonObject {
  return {
    identity: portableFormIdentity(form),
    ...(form.displayName ? { displayName: form.displayName } : {}),
    ...(form.description ? { description: form.description } : {}),
    desiredSchema: structuredClone(form.desiredSchema),
    ...(exposeConstraints && form.constraints
      ? {
          constraints: structuredClone(form.constraints) as unknown as JsonObject,
        }
      : {}),
  };
}

function formAvailability(
  form: InstalledTakoformForm,
  availability: TakoformFormAvailability,
): JsonObject {
  return {
    identity: portableFormIdentity(form),
    definitionKnown: true,
    installed: true,
    executable: availability.executable,
    activated: availability.activated,
    availableToPrincipal: availability.availableToPrincipal,
    operations: [...form.operations],
  };
}

/**
 * Host implementation identity is admission and execution authority, not part
 * of the portable Host API v1 FormReference. Keep it inside the durable Host
 * projection while exposing only the immutable FormRef and package audit
 * evidence accepted by released clients.
 */
function portableFormIdentity(form: InstalledTakoformForm): JsonObject {
  return {
    formRef: structuredClone(form.identity.formRef) as unknown as JsonObject,
    ...(form.identity.packageDigest ? { packageDigest: form.identity.packageDigest } : {}),
  };
}

async function availabilityOf(
  resolver: TakoformFormAvailabilityResolver | undefined,
  context: EngineContext,
  form: InstalledTakoformForm,
): Promise<TakoformFormAvailability> {
  return resolver
    ? await resolver.resolve({
        tenantId: context.tenantId,
        principalId: context.principalId,
        form,
      })
    : { executable: true, activated: true, availableToPrincipal: true };
}

function renderedResource<
  T extends {
    readonly form: {
      readonly formRef: unknown;
      readonly implementationDigest?: string;
    };
    readonly status?: { readonly observed?: JsonObject };
  },
>(resource: T, omitObservedStatus = false): T {
  return portableResourceView(resource, omitObservedStatus);
}

/**
 * Adapts the released lane onto the current engine. Only the path prefix moves;
 * the body, headers, and every FormRef inside them are passed through
 * unchanged.
 */
function laneRequest(request: Request, configuration: TakoformRouteConfiguration): Request {
  const url = new URL(request.url);
  for (const alias of configuration.aliases ?? []) {
    if (!url.pathname.startsWith(`${alias}/`) && url.pathname !== alias) continue;
    url.pathname = `${configuration.apiPath}${url.pathname.slice(alias.length)}`;
    return new Request(url, request);
  }
  return request;
}

function parsedResourcePathForLane(
  match: RegExpExecArray,
  strictStableLane: boolean,
): ReturnType<typeof parsedResourcePath> {
  if (!strictStableLane) return parsedResourcePath(match);
  // `parsedResourcePath` also serves retained lanes and therefore keeps the
  // historical group/version/kind/name capture positions. Supply the omitted
  // stable version slot explicitly rather than making the stable matcher
  // consume a second path segment.
  return parsedResourcePath([
    match[0],
    match[1],
    undefined,
    match[2],
    match[3],
    match[4],
  ] as unknown as RegExpExecArray);
}

function joinedGroup(
  group: string | undefined,
  version: string | undefined,
  strictStableLane = false,
): string {
  const safeGroup = safeSegment(group);
  if (strictStableLane && !isFormGroup(safeGroup)) throw new TakoformHostError();
  return version === undefined ? safeGroup : `${safeGroup}/${safeSegment(version)}`;
}

function validateFormsFilters(url: URL): void {
  const allowed = new Set(["space", "group", "kind", "definitionVersion", "schemaDigest"]);
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) {
    throw new TakoformHostError();
  }
  const space = url.searchParams.get("space");
  if (space !== null) spaceId(space);
  const group = url.searchParams.get("group");
  const kind = url.searchParams.get("kind");
  const definitionVersion = url.searchParams.get("definitionVersion");
  const schemaDigest = url.searchParams.get("schemaDigest");
  if (
    (group !== null && !isFormApiVersion(group)) ||
    (kind !== null && !isKind(kind)) ||
    (definitionVersion !== null && !isDefinitionVersion(definitionVersion)) ||
    (schemaDigest !== null && !DIGEST.test(schemaDigest))
  ) {
    throw new TakoformHostError();
  }
}

function hasAmbiguousSupportedForms(
  entries: readonly TakoformAuthorityCatalog["forms"][number][],
): boolean {
  const definitions = new Map<string, string>();
  const identities = new Set<string>();
  for (const entry of entries) {
    if (!entry.supported) continue;
    const ref = entry.form.identity.formRef;
    const definitionKey = `${ref.apiVersion}\u0000${ref.kind}\u0000${ref.definitionVersion}`;
    const previousDigest = definitions.get(definitionKey);
    if (previousDigest !== undefined && previousDigest !== ref.schemaDigest) return true;
    definitions.set(definitionKey, ref.schemaDigest);
    const identity = formKey(ref);
    if (identities.has(identity)) return true;
    identities.add(identity);
  }
  return false;
}

function boundedTenantReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new TakoformHostError();
  return value;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
