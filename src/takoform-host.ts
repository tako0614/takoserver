import type { JsonObject, JsonValue } from "./backends.ts";
import { executionIntentDigest } from "./runtime-grants.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";
import {
  ArtifactInputError,
  createInMemoryTakoformArtifactTransport,
  TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES,
  type TakoformArtifactTransport,
} from "./takoform-artifacts.ts";

const HOST_API_PATH = "/apis/forms.takoform.com/v1alpha3";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FORM_GROUP =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const FORM_VERSION = /^v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/u;
const KIND = /^[A-Z][A-Za-z0-9]{0,63}$/u;
const NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const SPEC_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_COUNTER = 9_223_372_036_854_775_807n;
const GENERATION = /^[1-9][0-9]{0,18}$/u;

export interface TakoformV1Alpha3FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: `sha256:${string}`;
}

export interface TakoformInterfaceRef {
  readonly apiVersion: "interfaces.takoform.com/v1alpha1";
  readonly name: string;
  readonly version: string;
  readonly schemaDigest: `sha256:${string}`;
}

export interface TakoformBindingRef {
  readonly apiVersion: "bindings.takoform.com/v1alpha1";
  readonly name: string;
  readonly version: string;
  readonly schemaDigest: `sha256:${string}`;
}

export interface InstalledTakoformForm {
  readonly identity: {
    readonly formRef: TakoformV1Alpha3FormRef;
    readonly packageDigest?: `sha256:${string}`;
  };
  readonly displayName?: string;
  readonly description?: string;
  readonly role?: "identity" | "revision" | "deployment" | "attachment" | "policy";
  readonly providedInterfaces?: readonly TakoformInterfaceRef[];
  readonly acceptedBindings?: readonly TakoformBindingRef[];
  readonly desiredSchema: JsonObject;
  readonly observedSchema?: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly operations: readonly ("create" | "read" | "update" | "delete" | "import" | "observe")[];
  readonly artifactRequirement?: {
    /** Spec field containing a committed, tenant-held artifact manifest digest. */
    readonly specField: string;
    readonly kind: "WorkerBundle" | "StaticAssetBundle" | "MigrationBundle";
  };
  readonly validateDesired?: (spec: JsonObject) => readonly TakoformDiagnostic[];
}

export interface TakoformDiagnostic {
  readonly severity: "error" | "warning";
  readonly field?: string;
  readonly message: string;
}

export interface TakoformHostPrincipal {
  readonly tenantId: string;
  readonly principalId: string;
}

export interface TakoformDriverReceipt {
  readonly observed?: JsonObject;
  readonly outputs?: JsonObject;
}

export interface TakoformResourceDriver {
  apply(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly previous?: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt>;
  observe(input: {
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt>;
  delete(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
  }): Promise<void>;
  import?(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly nativeId: string;
    readonly previous?: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt>;
}

export interface TakoformStoredResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly form: InstalledTakoformForm["identity"];
  readonly metadata: {
    readonly name: string;
    readonly space: string;
    readonly uid: string;
    readonly generation: string;
    readonly revision: string;
  };
  readonly spec: JsonObject;
  readonly status: {
    readonly observedGeneration: string;
    readonly conditions: readonly {
      readonly type: "Ready";
      readonly status: "True";
      readonly reason: "Available";
      readonly lastTransitionTime: string;
    }[];
    readonly observed?: JsonObject;
    readonly outputs?: JsonObject;
  };
}

export interface TakoformHost {
  handle(request: Request): Promise<Response | null>;
}

export interface CreateTakoformHostOptions {
  readonly authenticate: (authorization: string | null) => Promise<TakoformHostPrincipal | null>;
  readonly forms: readonly InstalledTakoformForm[];
  readonly driver: TakoformResourceDriver;
  readonly artifacts?: TakoformArtifactTransport;
  readonly clock?: () => Date;
  readonly randomId?: () => string;
}

export function createTakoformHost(options: CreateTakoformHostOptions): TakoformHost {
  const forms = installedForms(options.forms);
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const resources = new Map<string, TakoformStoredResource>();
  const prepares = new Map<string, PreparedReview>();
  const replays = new Map<string, Replay>();
  const nativeClaims = new Map<string, string>();
  const resourceNativeIds = new Map<string, string>();
  const artifacts = options.artifacts ?? createInMemoryTakoformArtifactTransport({ randomId });

  return {
    async handle(request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(HOST_API_PATH)) return null;
      if (url.pathname.includes("%")) return failure("invalid_argument", 400);
      const principal = await options.authenticate(request.headers.get("authorization"));
      if (!principal) return failure("unauthenticated", 401);
      const tenantId = boundedReference(principal.tenantId);
      const principalId = boundedReference(principal.principalId);

      try {
        const artifactResponse = await artifacts.handle(
          request,
          { tenantId, principalId },
          failure,
        );
        if (artifactResponse) return artifactResponse;
      } catch (error) {
        if (error instanceof ArtifactInputError) return failure(error.code, error.status);
        throw error;
      }

      if (request.method === "GET" && url.pathname === `${HOST_API_PATH}/support/forms`) {
        return Response.json({
          profiles: [...forms.values()].map(formSupportProfile),
        });
      }
      const supportMatch =
        /^\/apis\/forms\.takoform\.com\/v1alpha3\/support\/forms\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(
          url.pathname,
        );
      if (request.method === "GET" && supportMatch) {
        const apiVersion = `${safeSegment(supportMatch[1])}/${safeSegment(supportMatch[2])}`;
        const kind = safeSegment(supportMatch[3]);
        const definitionVersion = safeSegment(supportMatch[4]);
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
      const contractSupportMatch =
        /^\/apis\/forms\.takoform\.com\/v1alpha3\/support\/(interfaces|bindings)\/([^/]+)\/([^/]+)$/u.exec(
          url.pathname,
        );
      if (request.method === "GET" && contractSupportMatch) {
        const route = contractSupportMatch[1];
        const name = safeSegment(contractSupportMatch[2]);
        const version = safeSegment(contractSupportMatch[3]);
        const references: readonly (TakoformInterfaceRef | TakoformBindingRef)[] = [
          ...forms.values(),
        ].flatMap((form): readonly (TakoformInterfaceRef | TakoformBindingRef)[] =>
          route === "interfaces" ? (form.providedInterfaces ?? []) : (form.acceptedBindings ?? []),
        );
        const matches = references.filter(
          (reference) => reference.name === name && reference.version === version,
        );
        const reference = matches[0];
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
                interfaceRef: clone(reference),
              }
            : {
                apiVersion: "support.takoform.com/v1alpha1",
                kind: "BindingSupport",
                bindingRef: clone(reference),
              },
        );
      }

      if (request.method === "GET" && url.pathname === `${HOST_API_PATH}/forms`) {
        exactQuery(url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
        const form = exactFormFromQuery(url, forms);
        if (!form) return failure("form_unknown", 404);
        return Response.json({
          forms: [
            {
              identity: clone(form.identity),
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

      let match =
        /^\/apis\/forms\.takoform\.com\/v1alpha3\/form-definitions\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(
          url.pathname,
        );
      if (request.method === "GET" && match) {
        exactQuery(url, ["definitionVersion", "schemaDigest"]);
        const form = exactFormFromPathAndQuery(url, match, forms);
        if (!form) return failure("form_unknown", 404);
        return Response.json({
          identity: clone(form.identity),
          ...(form.displayName ? { displayName: form.displayName } : {}),
          ...(form.description ? { description: form.description } : {}),
          ...(form.role ? { role: form.role } : {}),
          desiredSchema: clone(form.desiredSchema),
          ...(form.observedSchema ? { observedSchema: clone(form.observedSchema) } : {}),
          ...(form.outputSchema ? { outputSchema: clone(form.outputSchema) } : {}),
          ...(form.providedInterfaces
            ? { providedInterfaces: clone(form.providedInterfaces) }
            : {}),
          ...(form.acceptedBindings ? { acceptedBindings: clone(form.acceptedBindings) } : {}),
        });
      }

      if (
        request.method === "POST" &&
        (url.pathname === `${HOST_API_PATH}/resources/validate` ||
          url.pathname === `${HOST_API_PATH}/resources/prepare`)
      ) {
        const parsedResource = resourceRequest(await jsonBody(request));
        const form = exactInstalledForm(parsedResource.form.formRef, forms);
        if (!form) return failure("form_unknown", 404);
        const requestResource = {
          ...parsedResource,
          spec: materializeDefaults(form.desiredSchema, parsedResource.spec),
        };
        const diagnostics = validateDesired(form, requestResource.spec);
        if (url.pathname.endsWith("/validate")) {
          return Response.json({
            valid: !diagnostics.some((entry) => entry.severity === "error"),
            diagnostics,
          });
        }
        if (diagnostics.some((entry) => entry.severity === "error")) {
          return failure("invalid_argument", 400, { diagnostics });
        }
        if (!hasRequiredArtifact(form, requestResource.spec, tenantId, artifacts)) {
          return failure("artifact_missing", 404);
        }
        const expectedGeneration = optionalGeneration(
          request.headers.get("takoform-expected-generation"),
        );
        const address = resourceAddress(tenantId, requestResource);
        const current = resources.get(address);
        if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
          return failure("resource_not_found", 404);
        }
        if (current && expectedGeneration !== current.metadata.generation) {
          return failure("generation_conflict", 412);
        }
        if (!current && expectedGeneration !== undefined) {
          return failure("resource_not_found", 404);
        }
        const specDigest = await executionIntentDigest(requestResource.spec);
        const prepareDigest = await executionIntentDigest({
          tenantId,
          resource: requestResource,
          expectedGeneration: expectedGeneration ?? null,
          currentUid: current?.metadata.uid ?? null,
        });
        prepares.set(`${tenantId}:${prepareDigest}`, {
          fingerprint: canonicalJson(requestResource),
          ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
          ...(current ? { currentUid: current.metadata.uid } : {}),
          expiresAt: clock().getTime() + 5 * 60_000,
        });
        return Response.json({
          resource: clone(requestResource),
          review: { prepareDigest, specDigest },
        });
      }

      match =
        /^\/apis\/forms\.takoform\.com\/v1alpha3\/resources\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(import|observe))?$/u.exec(
          url.pathname,
        );
      if (match) {
        const pathIdentity = parsedResourcePath(match);
        if (request.method === "GET" && !pathIdentity.action) {
          exactQuery(url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
          const form = exactFormFromResourceQuery(url, pathIdentity, forms);
          if (!form) return failure("form_unknown", 404);
          const resource = resources.get(
            addressFromParts(tenantId, requiredQuery(url, "space"), pathIdentity),
          );
          if (!resource || !sameFormRef(resource.form.formRef, form.identity.formRef)) {
            return failure("resource_not_found", 404);
          }
          if (!form.operations.includes("read")) return failure("unsupported_capability", 422);
          return resourceResponse(resource);
        }
        if (request.method === "PUT" && !pathIdentity.action) {
          const rawBodyDigest = await requestBodyDigest(request);
          const parsedBody = applyRequest(await jsonBody(request));
          const form = exactInstalledForm(parsedBody.form.formRef, forms);
          if (!form || !samePathResource(parsedBody, pathIdentity)) {
            return failure("form_unknown", 404);
          }
          const body = {
            ...parsedBody,
            spec: materializeDefaults(form.desiredSchema, parsedBody.spec),
          };
          const address = resourceAddress(tenantId, body);
          const current = resources.get(address);
          if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
            return failure("resource_not_found", 404);
          }
          if (!hasRequiredArtifact(form, body.spec, tenantId, artifacts)) {
            return failure("artifact_missing", 404);
          }
          const replayKey = replayAddress(
            tenantId,
            principalId,
            request,
            body.metadata.space,
            "apply",
          );
          const replayFingerprint = mutationFingerprint(request, rawBodyDigest);
          const replay = replays.get(replayKey);
          if (replay) {
            const response = replayResponse(replay, replayFingerprint, current?.metadata.uid);
            if (response) return response;
            replays.delete(replayKey);
          }
          const create = current === undefined;
          if (!form.operations.includes(create ? "create" : "update")) {
            return failure("unsupported_capability", 422);
          }
          if (create && request.headers.get("if-none-match") !== "*") {
            return failure("invalid_argument", 400);
          }
          if (!create) {
            const expected = requiredExpectedGeneration(request, body.expectedGeneration);
            if (expected !== current.metadata.generation) {
              return failure("generation_conflict", 412);
            }
            if (body.expectedUid && body.expectedUid !== current.metadata.uid) {
              return failure("uid_mismatch", 409);
            }
            const ifMatch = request.headers.get("if-match");
            if (ifMatch && ifMatch !== `"${current.metadata.revision}"`) {
              return failure("revision_conflict", 412);
            }
          }
          const review = prepares.get(`${tenantId}:${body.review.prepareDigest}`);
          if (
            !review ||
            review.expiresAt <= clock().getTime() ||
            review.fingerprint !== canonicalJson(stripApplyReview(body)) ||
            review.expectedGeneration !== (current?.metadata.generation ?? undefined) ||
            review.currentUid !== current?.metadata.uid
          ) {
            return failure("invalid_argument", 400);
          }
          const operationId = `op_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`;
          const receipt = await options.driver.apply({
            operationId,
            tenantId,
            form,
            name: body.metadata.name,
            space: body.metadata.space,
            spec: clone(body.spec),
            ...(current ? { previous: clone(current) } : {}),
          });
          const next = materializeResource(body, form, receipt, current, clock, randomId);
          resources.set(address, next);
          const status = create ? 201 : 200;
          replays.set(replayKey, {
            fingerprint: replayFingerprint,
            status,
            resource: clone(next),
            boundUid: next.metadata.uid,
          });
          return resourceResponse(next, status);
        }
        if (request.method === "POST" && pathIdentity.action === "observe") {
          exactQuery(url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
          const form = exactFormFromResourceQuery(url, pathIdentity, forms);
          if (!form) return failure("form_unknown", 404);
          const address = addressFromParts(tenantId, requiredQuery(url, "space"), pathIdentity);
          const current = resources.get(address);
          if (!current || !sameFormRef(current.form.formRef, form.identity.formRef)) {
            return failure("resource_not_found", 404);
          }
          if (!form.operations.includes("observe")) return failure("unsupported_capability", 422);
          const expected = requiredExpectedGeneration(request);
          if (expected !== current.metadata.generation) {
            return failure("generation_conflict", 412);
          }
          const replayKey = replayAddress(
            tenantId,
            principalId,
            request,
            current.metadata.space,
            "observe",
          );
          const replayFingerprint = mutationFingerprint(request, await requestBodyDigest(request));
          const replay = replays.get(replayKey);
          if (replay) return replayEnvelope(replay, replayFingerprint, current.metadata.uid);
          const receipt = await options.driver.observe({ tenantId, resource: clone(current) });
          const next = withObservation(current, form, receipt, clock);
          resources.set(address, next);
          replays.set(replayKey, {
            fingerprint: replayFingerprint,
            status: 200,
            resource: clone(next),
            boundUid: next.metadata.uid,
          });
          return Response.json({ resource: next }, { headers: etag(next) });
        }
        if (request.method === "POST" && pathIdentity.action === "import") {
          const rawBodyDigest = await requestBodyDigest(request);
          const parsedBody = importRequest(await jsonBody(request));
          const form = exactInstalledForm(parsedBody.form.formRef, forms);
          if (!form || !samePathResource(parsedBody, pathIdentity))
            return failure("form_unknown", 404);
          const body = {
            ...parsedBody,
            spec: materializeDefaults(form.desiredSchema, parsedBody.spec),
          };
          if (!form.operations.includes("import") || !options.driver.import) {
            return failure("unsupported_capability", 422);
          }
          const diagnostics = validateDesired(form, body.spec);
          if (diagnostics.some((entry) => entry.severity === "error")) {
            return failure("invalid_argument", 400, { diagnostics });
          }
          const address = resourceAddress(tenantId, body);
          const current = resources.get(address);
          if (current && !sameFormRef(current.form.formRef, form.identity.formRef)) {
            return failure("resource_not_found", 404);
          }
          if (!hasRequiredArtifact(form, body.spec, tenantId, artifacts)) {
            return failure("artifact_missing", 404);
          }
          const replayKey = replayAddress(
            tenantId,
            principalId,
            request,
            body.metadata.space,
            "import",
          );
          const replayFingerprint = mutationFingerprint(request, rawBodyDigest);
          const replay = replays.get(replayKey);
          if (replay) {
            const response = replayResponse(replay, replayFingerprint, current?.metadata.uid);
            if (response) return response;
            replays.delete(replayKey);
          }
          const create = current === undefined;
          if (create && request.headers.get("if-none-match") !== "*") {
            return failure("invalid_argument", 400);
          }
          if (!create) {
            const expected = requiredExpectedGeneration(request);
            if (expected !== current.metadata.generation)
              return failure("generation_conflict", 412);
          }
          const claimKey = `${tenantId}\0${body.nativeId}`;
          const claim = nativeClaims.get(claimKey);
          if (
            (claim && claim !== address) ||
            (current && resourceNativeIds.get(address) !== body.nativeId)
          ) {
            return failure("import_conflict", 409);
          }
          const receipt = await options.driver.import({
            operationId: `op_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`,
            tenantId,
            form,
            name: body.metadata.name,
            space: body.metadata.space,
            spec: clone(body.spec),
            nativeId: body.nativeId,
            ...(current ? { previous: clone(current) } : {}),
          });
          const next = materializeResource(body, form, receipt, current, clock, randomId);
          resources.set(address, next);
          nativeClaims.set(claimKey, address);
          resourceNativeIds.set(address, body.nativeId);
          const status = create ? 201 : 200;
          replays.set(replayKey, {
            fingerprint: replayFingerprint,
            status,
            resource: clone(next),
            boundUid: next.metadata.uid,
          });
          return resourceResponse(next, status);
        }
        if (request.method === "DELETE" && !pathIdentity.action) {
          exactQuery(url, ["space", "group", "kind", "definitionVersion", "schemaDigest"]);
          const form = exactFormFromResourceQuery(url, pathIdentity, forms);
          if (!form) return failure("form_unknown", 404);
          const address = addressFromParts(tenantId, requiredQuery(url, "space"), pathIdentity);
          const expected = requiredExpectedGeneration(request);
          const replayKey = replayAddress(
            tenantId,
            principalId,
            request,
            requiredQuery(url, "space"),
            "delete",
          );
          const replayFingerprint = mutationFingerprint(request, await requestBodyDigest(request));
          const replay = replays.get(replayKey);
          const current = resources.get(address);
          if (replay) {
            if (replay.fingerprint !== replayFingerprint) return failure("invalid_argument", 400);
            return new Response(null, { status: 204 });
          }
          if (!current || !sameFormRef(current.form.formRef, form.identity.formRef)) {
            return failure("resource_not_found", 404);
          }
          if (!form.operations.includes("delete")) return failure("unsupported_capability", 422);
          if (expected !== current.metadata.generation) {
            return failure("generation_conflict", 412);
          }
          const ifMatch = request.headers.get("if-match");
          if (ifMatch && ifMatch !== `"${current.metadata.revision}"`) {
            return failure("revision_conflict", 412);
          }
          await options.driver.delete({
            operationId: `op_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`,
            tenantId,
            resource: clone(current),
          });
          resources.delete(address);
          const nativeId = resourceNativeIds.get(address);
          if (nativeId) nativeClaims.delete(`${tenantId}\0${nativeId}`);
          resourceNativeIds.delete(address);
          replays.set(replayKey, {
            fingerprint: replayFingerprint,
            status: 204,
          });
          return new Response(null, { status: 204 });
        }
      }

      if (
        (request.method === "GET" || request.method === "POST") &&
        /^\/apis\/forms\.takoform\.com\/v1alpha3\/operations\/[^/]+(?:\/cancel)?$/u.test(
          url.pathname,
        )
      ) {
        return failure("operation_not_found", 404);
      }
      return failure("invalid_argument", 404);
    },
  };
}

export function createInMemoryTakoformHost(
  options: Omit<CreateTakoformHostOptions, "driver">,
): TakoformHost {
  return createTakoformHost({ ...options, driver: new InMemoryTakoformResourceDriver() });
}

export class InMemoryTakoformResourceDriver implements TakoformResourceDriver {
  async apply(
    input: Parameters<TakoformResourceDriver["apply"]>[0],
  ): Promise<TakoformDriverReceipt> {
    return { observed: clone(input.spec) };
  }

  async observe(
    input: Parameters<TakoformResourceDriver["observe"]>[0],
  ): Promise<TakoformDriverReceipt> {
    return {
      observed: clone(input.resource.status.observed ?? input.resource.spec),
      ...(input.resource.status.outputs ? { outputs: clone(input.resource.status.outputs) } : {}),
    };
  }

  async import(
    input: Parameters<NonNullable<TakoformResourceDriver["import"]>>[0],
  ): Promise<TakoformDriverReceipt> {
    return { observed: clone(input.spec) };
  }

  async delete(): Promise<void> {}
}

interface ParsedResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly form: InstalledTakoformForm["identity"];
  readonly metadata: { readonly name: string; readonly space: string };
  readonly spec: JsonObject;
}

interface ParsedApply extends ParsedResource {
  readonly review: { readonly prepareDigest: `sha256:${string}` };
  readonly expectedUid?: string;
  readonly expectedGeneration?: string;
}

interface ParsedImport extends ParsedResource {
  readonly nativeId: string;
}

interface ResourcePath {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly action?: "import" | "observe";
}

interface PreparedReview {
  readonly fingerprint: string;
  readonly expectedGeneration?: string;
  readonly currentUid?: string;
  readonly expiresAt: number;
}

interface Replay {
  readonly fingerprint: string;
  readonly status: number;
  readonly resource?: TakoformStoredResource;
  readonly boundUid?: string;
}

function installedForms(
  input: readonly InstalledTakoformForm[],
): ReadonlyMap<string, InstalledTakoformForm> {
  const result = new Map<string, InstalledTakoformForm>();
  const definitionDigests = new Map<string, string>();
  for (const form of input) {
    validateFormRef(form.identity.formRef);
    if (form.identity.packageDigest && !DIGEST.test(form.identity.packageDigest)) {
      throw new TypeError("invalid package digest");
    }
    if (
      form.artifactRequirement !== undefined &&
      !SPEC_FIELD.test(form.artifactRequirement.specField)
    ) {
      throw new TypeError("invalid artifact manifest spec field");
    }
    if (form.role === "revision" && form.operations.includes("update")) {
      throw new TypeError("revision Form cannot declare update");
    }
    const definitionKey = `${form.identity.formRef.apiVersion}\0${form.identity.formRef.kind}\0${form.identity.formRef.definitionVersion}`;
    const installedDigest = definitionDigests.get(definitionKey);
    if (installedDigest !== undefined && installedDigest !== form.identity.formRef.schemaDigest) {
      throw new TypeError("ambiguous installed Form definition");
    }
    definitionDigests.set(definitionKey, form.identity.formRef.schemaDigest);
    const key = formKey(form.identity.formRef);
    if (result.has(key)) throw new TypeError("duplicate installed Form identity");
    result.set(key, clone(form));
  }
  return result;
}

function exactFormFromQuery(
  url: URL,
  forms: ReadonlyMap<string, InstalledTakoformForm>,
): InstalledTakoformForm | undefined {
  const apiVersion = requiredQuery(url, "group");
  const kind = requiredQuery(url, "kind");
  const definitionVersion = requiredQuery(url, "definitionVersion");
  const schemaDigest = requiredQuery(url, "schemaDigest");
  requiredQuery(url, "space");
  return exactInstalledForm({ apiVersion, kind, definitionVersion, schemaDigest }, forms);
}

function exactFormFromPathAndQuery(
  url: URL,
  match: RegExpExecArray,
  forms: ReadonlyMap<string, InstalledTakoformForm>,
): InstalledTakoformForm | undefined {
  const group = safeSegment(match[1]);
  const version = safeSegment(match[2]);
  const kind = safeSegment(match[3]);
  return exactInstalledForm(
    {
      apiVersion: `${group}/${version}`,
      kind,
      definitionVersion: requiredQuery(url, "definitionVersion"),
      schemaDigest: requiredQuery(url, "schemaDigest"),
    },
    forms,
  );
}

function exactFormFromResourceQuery(
  url: URL,
  path: ResourcePath,
  forms: ReadonlyMap<string, InstalledTakoformForm>,
): InstalledTakoformForm | undefined {
  if (requiredQuery(url, "group") !== path.apiVersion || requiredQuery(url, "kind") !== path.kind) {
    return undefined;
  }
  return exactInstalledForm(
    {
      apiVersion: path.apiVersion,
      kind: path.kind,
      definitionVersion: requiredQuery(url, "definitionVersion"),
      schemaDigest: requiredQuery(url, "schemaDigest"),
    },
    forms,
  );
}

function exactInstalledForm(
  input: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  },
  forms: ReadonlyMap<string, InstalledTakoformForm>,
): InstalledTakoformForm | undefined {
  try {
    validateFormRef(input);
    return forms.get(formKey(input));
  } catch {
    return undefined;
  }
}

function formKey(input: {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}): string {
  return `${input.apiVersion}\0${input.kind}\0${input.definitionVersion}\0${input.schemaDigest}`;
}

function validateFormRef(input: {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}): void {
  const [group, version, ...rest] = input.apiVersion.split("/");
  if (
    rest.length !== 0 ||
    !group ||
    !version ||
    !FORM_GROUP.test(group) ||
    !FORM_VERSION.test(version) ||
    input.apiVersion === "forms.takoform.com/v1alpha1" ||
    input.apiVersion === "forms.takoform.com/v1alpha2" ||
    !KIND.test(input.kind) ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(
      input.definitionVersion,
    ) ||
    !DIGEST.test(input.schemaDigest)
  ) {
    throw new TypeError("invalid Form identity");
  }
}

function resourceRequest(input: unknown): ParsedResource {
  const value = record(input);
  exactKeys(value, ["apiVersion", "kind", "form", "metadata", "spec"]);
  const form = record(value.form);
  exactKeys(form, ["formRef", ...(form.packageDigest === undefined ? [] : ["packageDigest"])]);
  const formRef = record(form.formRef);
  exactKeys(formRef, ["apiVersion", "kind", "definitionVersion", "schemaDigest"]);
  const metadata = record(value.metadata);
  exactKeys(metadata, ["name", "space"]);
  const parsed: ParsedResource = {
    apiVersion: string(value.apiVersion),
    kind: string(value.kind),
    form: {
      formRef: {
        apiVersion: string(formRef.apiVersion),
        kind: string(formRef.kind),
        definitionVersion: string(formRef.definitionVersion),
        schemaDigest: digest(string(formRef.schemaDigest)),
      },
      ...(form.packageDigest === undefined
        ? {}
        : { packageDigest: digest(string(form.packageDigest)) }),
    },
    metadata: { name: string(metadata.name), space: string(metadata.space) },
    spec: jsonObject(value.spec),
  };
  validateResource(parsed);
  return parsed;
}

function applyRequest(input: unknown): ParsedApply {
  const value = record(input);
  const baseKeys = ["apiVersion", "kind", "form", "metadata", "spec", "review"];
  const keys = [
    ...baseKeys,
    ...(value.expectedUid === undefined ? [] : ["expectedUid"]),
    ...(value.expectedGeneration === undefined ? [] : ["expectedGeneration"]),
  ];
  exactKeys(value, keys);
  const base = resourceRequest(
    Object.fromEntries(baseKeys.filter((key) => key !== "review").map((key) => [key, value[key]])),
  );
  const review = record(value.review);
  exactKeys(review, ["prepareDigest"]);
  return {
    ...base,
    review: { prepareDigest: digest(string(review.prepareDigest)) },
    ...(value.expectedUid === undefined
      ? {}
      : { expectedUid: boundedReference(string(value.expectedUid)) }),
    ...(value.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: generation(string(value.expectedGeneration)) }),
  };
}

function importRequest(input: unknown): ParsedImport {
  const value = record(input);
  const baseKeys = ["apiVersion", "kind", "form", "metadata", "spec"];
  exactKeys(value, [...baseKeys, "nativeId"]);
  const base = resourceRequest(Object.fromEntries(baseKeys.map((key) => [key, value[key]])));
  const nativeId = string(value.nativeId);
  if (nativeId.length === 0 || nativeId.length > 4_096) throw new TakoformHostError();
  return { ...base, nativeId };
}

function stripApplyReview(input: ParsedApply): ParsedResource {
  return {
    apiVersion: input.apiVersion,
    kind: input.kind,
    form: clone(input.form),
    metadata: clone(input.metadata),
    spec: clone(input.spec),
  };
}

function validateResource(input: ParsedResource): void {
  validateFormRef(input.form.formRef);
  if (
    input.apiVersion !== input.form.formRef.apiVersion ||
    input.kind !== input.form.formRef.kind ||
    !NAME.test(input.metadata.name) ||
    spaceId(input.metadata.space) !== input.metadata.space
  ) {
    throw new TakoformHostError();
  }
}

function validateDesired(
  form: InstalledTakoformForm,
  spec: JsonObject,
): readonly TakoformDiagnostic[] {
  if (form.validateDesired) return clone(form.validateDesired(clone(spec)));
  return validateSchemaValue(form.desiredSchema, spec, "");
}

function validateSchemaValue(
  schemaValue: unknown,
  value: JsonValue,
  pointer: string,
): TakoformDiagnostic[] {
  if (!isRecord(schemaValue)) return [];
  const diagnostics: TakoformDiagnostic[] = [];
  const error = (message: string, field = pointer): void => {
    diagnostics.push({ severity: "error", ...(field ? { field } : {}), message });
  };
  if (
    schemaValue.const !== undefined &&
    canonicalJson(schemaValue.const) !== canonicalJson(value)
  ) {
    error("value does not match const");
  }
  if (
    Array.isArray(schemaValue.enum) &&
    !schemaValue.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))
  ) {
    error("value is not in enum");
  }
  const type = schemaValue.type;
  if (typeof type === "string" && !matchesJsonType(type, value)) {
    error(`value must be ${type}`);
    return diagnostics;
  }
  if (type === "object" && isRecord(value)) {
    const properties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
    const required = Array.isArray(schemaValue.required)
      ? schemaValue.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    for (const key of required) {
      if (!(key in value))
        error("required field is missing", `${pointer}/${jsonPointerSegment(key)}`);
    }
    if (schemaValue.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) error("unknown field", `${pointer}/${jsonPointerSegment(key)}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] !== undefined) {
        diagnostics.push(
          ...validateSchemaValue(properties[key], child, `${pointer}/${jsonPointerSegment(key)}`),
        );
      } else if (isRecord(schemaValue.additionalProperties)) {
        diagnostics.push(
          ...validateSchemaValue(
            schemaValue.additionalProperties,
            child,
            `${pointer}/${jsonPointerSegment(key)}`,
          ),
        );
      }
    }
  }
  if (type === "array" && Array.isArray(value)) {
    if (Number.isInteger(schemaValue.minItems) && value.length < Number(schemaValue.minItems)) {
      error("array has too few items");
    }
    if (Number.isInteger(schemaValue.maxItems) && value.length > Number(schemaValue.maxItems)) {
      error("array has too many items");
    }
    if (isRecord(schemaValue.items)) {
      value.forEach((entry, index) => {
        diagnostics.push(...validateSchemaValue(schemaValue.items, entry, `${pointer}/${index}`));
      });
    }
  }
  if (type === "string" && typeof value === "string") {
    const length = [...value].length;
    if (Number.isInteger(schemaValue.minLength) && length < Number(schemaValue.minLength)) {
      error("string is too short");
    }
    if (Number.isInteger(schemaValue.maxLength) && length > Number(schemaValue.maxLength)) {
      error("string is too long");
    }
    if (typeof schemaValue.pattern === "string") {
      try {
        if (!new RegExp(schemaValue.pattern, "u").test(value))
          error("string does not match pattern");
      } catch {
        throw new TypeError("invalid installed schema pattern");
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schemaValue.minimum === "number" && value < schemaValue.minimum) {
      error("number is below minimum");
    }
    if (typeof schemaValue.maximum === "number" && value > schemaValue.maximum) {
      error("number is above maximum");
    }
    if (typeof schemaValue.exclusiveMinimum === "number" && value <= schemaValue.exclusiveMinimum) {
      error("number is below exclusive minimum");
    }
    if (typeof schemaValue.exclusiveMaximum === "number" && value >= schemaValue.exclusiveMaximum) {
      error("number is above exclusive maximum");
    }
  }
  return diagnostics;
}

function matchesJsonType(type: string, value: JsonValue): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function materializeDefaults(schemaValue: JsonObject, spec: JsonObject): JsonObject {
  return materializeValue(schemaValue, spec) as JsonObject;
}

function materializeValue(schemaValue: unknown, value: JsonValue): JsonValue {
  if (!isRecord(schemaValue)) return clone(value);
  if (schemaValue.type === "object" && isRecord(value)) {
    const properties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
    const next: Record<string, JsonValue> = {};
    for (const [key, propertyValue] of Object.entries(properties)) {
      if (!isRecord(propertyValue)) continue;
      if (value[key] === undefined && propertyValue.default !== undefined) {
        next[key] = clone(propertyValue.default) as JsonValue;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      next[key] = materializeValue(properties[key], child);
    }
    return next;
  }
  if (schemaValue.type === "array" && Array.isArray(value) && isRecord(schemaValue.items)) {
    return value.map((entry) => materializeValue(schemaValue.items, entry));
  }
  return clone(value);
}

function materializeResource(
  input: ParsedResource,
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
  current: TakoformStoredResource | undefined,
  clock: () => Date,
  randomId: () => string,
): TakoformStoredResource {
  const generation = current
    ? canonicalJson(current.spec) === canonicalJson(input.spec)
      ? current.metadata.generation
      : increment(current.metadata.generation)
    : "1";
  const revision = current ? increment(current.metadata.revision) : "1";
  const projected = projectReceipt(form, receipt);
  return {
    apiVersion: input.apiVersion,
    kind: input.kind,
    form: clone(form.identity),
    metadata: {
      name: input.metadata.name,
      space: input.metadata.space,
      uid: current?.metadata.uid ?? `uid_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`,
      generation,
      revision,
    },
    spec: clone(input.spec),
    status: {
      observedGeneration: generation,
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: clock().toISOString(),
        },
      ],
      ...projected,
    },
  };
}

function withObservation(
  current: TakoformStoredResource,
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
  clock: () => Date,
): TakoformStoredResource {
  const projected = projectReceipt(form, receipt);
  const candidate = {
    ...clone(current),
    status: {
      ...clone(current.status),
      ...projected,
      conditions: [
        {
          type: "Ready" as const,
          status: "True" as const,
          reason: "Available" as const,
          lastTransitionTime: clock().toISOString(),
        },
      ],
    },
  };
  const oldComparable = {
    ...current,
    metadata: { ...current.metadata, revision: "" },
    status: { ...current.status, conditions: [] },
  };
  const nextComparable = {
    ...candidate,
    metadata: { ...candidate.metadata, revision: "" },
    status: { ...candidate.status, conditions: [] },
  };
  if (canonicalJson(oldComparable) === canonicalJson(nextComparable)) return clone(current);
  return {
    ...candidate,
    metadata: { ...candidate.metadata, revision: increment(current.metadata.revision) },
  };
}

function projectReceipt(
  form: InstalledTakoformForm,
  receipt: TakoformDriverReceipt,
): { readonly observed?: JsonObject; readonly outputs?: JsonObject } {
  if (form.observedSchema && !receipt.observed) throw new TakoformHostError();
  if (form.outputSchema && !receipt.outputs) throw new TakoformHostError();
  if (
    form.observedSchema &&
    receipt.observed &&
    validateSchemaValue(form.observedSchema, receipt.observed, "").length > 0
  ) {
    throw new TakoformHostError();
  }
  if (
    form.outputSchema &&
    receipt.outputs &&
    validateSchemaValue(form.outputSchema, receipt.outputs, "").length > 0
  ) {
    throw new TakoformHostError();
  }
  return {
    ...(form.observedSchema && receipt.observed ? { observed: clone(receipt.observed) } : {}),
    ...(form.outputSchema && receipt.outputs ? { outputs: clone(receipt.outputs) } : {}),
  };
}

function parsedResourcePath(match: RegExpExecArray): ResourcePath {
  const group = safeSegment(match[1]);
  const version = safeSegment(match[2]);
  const kind = safeSegment(match[3]);
  const name = safeSegment(match[4]);
  if (
    !FORM_GROUP.test(group) ||
    !FORM_VERSION.test(version) ||
    !KIND.test(kind) ||
    !NAME.test(name)
  ) {
    throw new TakoformHostError();
  }
  const action = match[5];
  return {
    apiVersion: `${group}/${version}`,
    kind,
    name,
    ...(action === "import" || action === "observe" ? { action } : {}),
  };
}

function samePathResource(resource: ParsedResource, path: ResourcePath): boolean {
  return (
    resource.apiVersion === path.apiVersion &&
    resource.kind === path.kind &&
    resource.metadata.name === path.name
  );
}

function resourceAddress(tenantId: string, resource: ParsedResource): string {
  return `${tenantId}\0${resource.metadata.space}\0${resource.apiVersion}\0${resource.kind}\0${resource.metadata.name}`;
}

function addressFromParts(tenantId: string, space: string, path: ResourcePath): string {
  return `${tenantId}\0${spaceId(space)}\0${path.apiVersion}\0${path.kind}\0${path.name}`;
}

function replayAddress(
  tenantId: string,
  principalId: string,
  request: Request,
  space: string,
  operation: string,
): string {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(key)) throw new TakoformHostError();
  return `${tenantId}\0${principalId}\0${space}\0${operation}\0${key}`;
}

function formSupportProfile(form: InstalledTakoformForm): JsonObject {
  return {
    apiVersion: "support.takoform.com/v1alpha1",
    kind: "FormSupport",
    formRef: clone(form.identity.formRef) as unknown as JsonObject,
    operations: [...form.operations],
    ...(form.acceptedBindings && form.acceptedBindings.length > 0
      ? {
          supportedBindings: form.acceptedBindings.map(
            (binding) => `${binding.name}@${binding.version}`,
          ),
        }
      : {}),
    ...(form.artifactRequirement?.kind === "WorkerBundle"
      ? { limits: { maximumBundleBytes: TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES } }
      : {}),
  };
}

function replayResponse(replay: Replay, fingerprint: string, currentUid?: string): Response | null {
  if (!replay.resource || !replay.boundUid) {
    return failure("resource_not_found", 404);
  }
  if (currentUid === undefined) return null;
  if (replay.fingerprint !== fingerprint) return failure("invalid_argument", 400);
  if (replay.boundUid !== currentUid) return failure("resource_not_found", 404);
  return resourceResponse(replay.resource, replay.status);
}

function replayEnvelope(replay: Replay, fingerprint: string, currentUid?: string): Response {
  if (replay.fingerprint !== fingerprint) return failure("invalid_argument", 400);
  if (!replay.resource || replay.boundUid !== currentUid) return failure("resource_not_found", 404);
  return Response.json(
    { resource: replay.resource },
    { status: replay.status, headers: etag(replay.resource) },
  );
}

function mutationFingerprint(request: Request, rawBodyDigest: `sha256:${string}`): string {
  const url = new URL(request.url);
  return canonicalJson({
    method: request.method,
    target: `${url.pathname}${url.search}`,
    preconditions: {
      ifMatch: request.headers.get("if-match"),
      ifNoneMatch: request.headers.get("if-none-match"),
      expectedGeneration: request.headers.get("takoform-expected-generation"),
    },
    rawBodyDigest,
  });
}

async function requestBodyDigest(request: Request): Promise<`sha256:${string}`> {
  const bytes = await request.clone().arrayBuffer();
  if (bytes.byteLength > 1_048_576) throw new TakoformHostError();
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function resourceResponse(resource: TakoformStoredResource, status = 200): Response {
  return Response.json(resource, { status, headers: etag(resource) });
}

function etag(resource: TakoformStoredResource): HeadersInit {
  return { etag: `"${resource.metadata.revision}"` };
}

function requiredExpectedGeneration(request: Request, body?: string): string {
  const header = request.headers.get("takoform-expected-generation");
  if (!header) throw new TakoformHostError();
  const parsed = generation(header);
  if (body !== undefined && body !== parsed) throw new TakoformHostError();
  return parsed;
}

function optionalGeneration(value: string | null): string | undefined {
  return value === null ? undefined : generation(value);
}

function generation(value: string): string {
  if (!GENERATION.test(value) || BigInt(value) > MAX_COUNTER) throw new TakoformHostError();
  return value;
}

function increment(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > MAX_COUNTER) throw new TakoformHostError("resource_busy", 409);
  return next.toString();
}

function sameFormRef(left: TakoformV1Alpha3FormRef, right: TakoformV1Alpha3FormRef): boolean {
  return formKey(left) === formKey(right);
}

function hasRequiredArtifact(
  form: InstalledTakoformForm,
  spec: JsonObject,
  tenantId: string,
  artifacts: TakoformArtifactTransport,
): boolean {
  const requirement = form.artifactRequirement;
  if (requirement === undefined) return true;
  const manifestDigest = spec[requirement.specField];
  if (typeof manifestDigest !== "string") return false;
  return artifacts.resolveManifest(tenantId, manifestDigest)?.kind === requirement.kind;
}

async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new TakoformHostError();
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 1_048_576) throw new TakoformHostError();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576) throw new TakoformHostError();
  try {
    return parseStrictJson(new Uint8Array(bytes), 1_048_576);
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    throw new TakoformHostError();
  }
}

function requiredQuery(url: URL, key: string): string {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0]) throw new TakoformHostError();
  return values[0];
}

function exactQuery(url: URL, expected: readonly string[]): void {
  const actual = [...url.searchParams.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new TakoformHostError();
  }
}

function spaceId(value: string): string {
  const points = [...value];
  const white = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/u;
  if (
    points.length === 0 ||
    points.length > 255 ||
    white.test(points[0] ?? "") ||
    white.test(points.at(-1) ?? "") ||
    points.some((point) => {
      const code = point.codePointAt(0) ?? 0;
      return point === "/" || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw new TakoformHostError();
  }
  return value;
}

function safeSegment(value: string | undefined): string {
  if (!value || value.includes("%")) throw new TakoformHostError();
  return value;
}

function boundedReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new TakoformHostError();
  return value;
}

function digest(value: string): `sha256:${string}` {
  if (!DIGEST.test(value)) throw new TakoformHostError();
  return value as `sha256:${string}`;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new TakoformHostError();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TakoformHostError();
  return value;
}

function jsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) throw new TakoformHostError();
  JSON.stringify(value);
  return value as JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new TakoformHostError();
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class TakoformHostError extends Error {
  constructor(
    readonly code = "invalid_argument",
    readonly status = 400,
  ) {
    super(code.replaceAll("_", " "));
    this.name = "TakoformHostError";
  }
}

function failure(code: string, status: number, details?: unknown): Response {
  return Response.json(
    {
      error: {
        code,
        message: code.replaceAll("_", " "),
        requestId: `req_${crypto.randomUUID()}`,
        retryable: [
          "resource_busy",
          "backend_unavailable",
          "rate_limited",
          "deadline_exceeded",
        ].includes(code),
        ...(details === undefined ? {} : { details }),
      },
    },
    { status },
  );
}
