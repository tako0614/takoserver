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

export interface CreateTakoformRoutesOptions {
  readonly authenticate: (authorization: string | null) => Promise<TakoformHostPrincipal | null>;
  readonly engine: TakoformEngine;
  readonly store: TakoformStore;
  readonly forms: FormRegistry;
  readonly artifacts: TakoformArtifactTransport;
}

export function createTakoformRoutes(options: CreateTakoformRoutesOptions): TakoformHost {
  const { authenticate, engine, store, forms, artifacts } = options;

  return {
    async handle(incoming): Promise<Response | null> {
      const request = currentLaneRequest(incoming);
      const url = new URL(request.url);
      if (!url.pathname.startsWith(CURRENT_LANE)) return null;
      if (url.pathname.includes("%")) return failure("invalid_argument", 400);

      const principal = await authenticate(request.headers.get("authorization"));
      if (!principal) return failure("unauthenticated", 401);
      const context: EngineContext = {
        request,
        url,
        tenantId: boundedTenantReference(principal.tenantId),
        principalId: boundedTenantReference(principal.principalId),
      };

      try {
        const artifactResponse = await artifacts.handle(request, context, failure);
        if (artifactResponse) return artifactResponse;
        return await route(context, url, request);
      } catch (error) {
        if (error instanceof ArtifactInputError) return failure(error.code, error.status);
        if (error instanceof TakoformHostError) {
          return failure(error.code, error.status, error.details);
        }
        throw error;
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
