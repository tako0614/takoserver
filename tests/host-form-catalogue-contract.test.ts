import { expect, test } from "bun:test";
import { edgeProviderOffering } from "../src/edge-forms.ts";
import { buildApp, createEphemeralSql, createMemoryObjectStore } from "../src/index.ts";
import { openApiDocument } from "../src/openapi.ts";
import type { JsonValue } from "../src/ports.ts";
import { TAKOSERVER_INTRINSIC_HANDLER_KINDS } from "../src/provider-driver.ts";
import type { ProviderOffering } from "../src/provider-port.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { validateSchemaValue } from "../src/takoform/schema.ts";

/**
 * The published Form vocabulary and this Host's answer for each identity have
 * to survive in the same document.
 *
 * Discovery is not acceptance. A published identity no composed provider
 * backend claims — `DurableWorkflow` today — is installed and discoverable
 * here, and this Host refuses a lifecycle operation on it with
 * `form_unavailable`. The credential-free catalogue is the one Form surface a
 * client reads before it plans anything, so the answer belongs to that
 * document's contract, not only to the route's response. A client generated
 * from a document that could not read it would have no way to tell "this Host
 * has no backend for that Form" from "this Host will provision it".
 */

const HOST_ORIGIN = "https://api.takoserver.test";
const NOW = "2026-09-29T00:00:00Z";

interface FormProfile {
  readonly formRef: { readonly kind: string; readonly definitionVersion: string };
  readonly operations: readonly string[];
  readonly executable?: boolean;
  readonly activated?: boolean;
  readonly availableToPrincipal?: boolean;
}

function identity() {
  return {
    async verify() {
      return {
        providerSubject: "owner-subject",
        email: "owner@example.test",
        displayName: "Owner",
      };
    },
  };
}

function settlement() {
  return {
    async verify() {
      return { fundingRef: "unused", amountMinor: 0, currency: "USD" as const };
    },
  };
}

/** The one identity Form this composition really backs, and nothing else. */
function moduleWorkerOffering(): ProviderOffering {
  const form = currentTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  if (!form) throw new Error("published ModuleWorker Form is missing");
  return edgeProviderOffering(form, { id: "catalogue-contract.module-worker" });
}

function host() {
  const sql = createEphemeralSql();
  const candidates = currentTakoformCandidates();
  let counter = 0;
  return buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity: identity(),
    settlement: settlement(),
    publicOrigin: HOST_ORIGIN,
    forms: candidates.forms,
    bindings: candidates.bindings,
    hostForms: candidates.forms,
    hostBindings: candidates.bindings,
    providers: [
      {
        id: "catalogue-contract-provider",
        offerings: [moduleWorkerOffering()],
        async apply(): Promise<never> {
          throw new Error("the catalogue must not dispatch a provider mutation");
        },
        async observe(): Promise<never> {
          throw new Error("the catalogue must not observe a provider resource");
        },
        async delete(): Promise<never> {
          throw new Error("the catalogue must not delete a provider resource");
        },
      },
    ],
    offerings: [],
    clock: () => new Date(NOW),
    randomId: () => {
      counter += 1;
      return `catalogue_contract_${String(counter).padStart(8, "0")}`;
    },
  });
}

async function profiles(app: ReturnType<typeof buildApp>): Promise<readonly FormProfile[]> {
  const response = await app.fetch(new Request(`${HOST_ORIGIN}/v1/forms`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly profiles: readonly FormProfile[] };
  return body.profiles;
}

function resolveLocalSchemaRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveLocalSchemaRefs);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const prefix = "#/components/schemas/";
    if (!record.$ref.startsWith(prefix)) throw new Error(`unexpected schema ref: ${record.$ref}`);
    const name = record.$ref.slice(prefix.length);
    const target =
      openApiDocument.components.schemas[name as keyof typeof openApiDocument.components.schemas];
    if (!target) throw new Error(`unknown OpenAPI schema: ${name}`);
    return resolveLocalSchemaRefs(target);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, resolveLocalSchemaRefs(child)]),
  );
}

test("the published catalogue contract validates the actual control response", async () => {
  const path = openApiDocument.paths["/v1/forms"] as {
    get: {
      summary: string;
      responses: {
        "200": { content: { "application/json": { schema: { $ref: string } } } };
      };
    };
  };

  // The route returns the published vocabulary *and* this Host's answer for it.
  // A summary that promised acceptance instead was true of neither half.
  expect(path.get.summary).toBe(
    "List the published Form definitions and this Host's answer for each",
  );
  expect(path.get.summary).not.toMatch(/will accept/u);
  expect(path.get.responses["200"].content["application/json"].schema.$ref).toBe(
    "#/components/schemas/HostFormCatalogue",
  );

  const schemas = openApiDocument.components.schemas;
  const catalogue = schemas.HostFormCatalogue;
  expect(catalogue.additionalProperties).toBe(false);
  expect(catalogue.required).toEqual(["profiles"]);
  expect(catalogue.properties.profiles.items.$ref).toBe("#/components/schemas/HostFormProfile");

  const profile = schemas.HostFormProfile;
  expect(profile.additionalProperties).toBe(false);
  expect(profile.required).toEqual(["apiVersion", "kind", "formRef", "operations"]);
  expect(profile.properties.apiVersion.const).toBe("support.takoform.com/v1alpha1");
  expect(profile.properties.kind.const).toBe("FormSupport");

  // The three facts the apply path refuses from are the contract's, not an
  // undocumented extra member a generated client would drop.
  for (const member of ["executable", "activated", "availableToPrincipal"] as const) {
    expect(profile.properties[member].type).toBe("boolean");
  }
  // A composition that cannot answer for a platform-level read omits them
  // rather than guessing, so they are optional and unpromised.
  expect(profile.required).not.toContain("executable");
  expect(profile.properties.operations.type).toBe("array");

  const response = await host().fetch(new Request(`${HOST_ORIGIN}/v1/forms`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as JsonValue;
  const resolvedCatalogueSchema = resolveLocalSchemaRefs(catalogue);
  expect(validateSchemaValue(resolvedCatalogueSchema, body, "")).toEqual([]);

  const corrupted = structuredClone(body) as {
    profiles: Array<Record<string, JsonValue>>;
  };
  const firstProfile = corrupted.profiles[0];
  if (!firstProfile) throw new Error("the control catalogue has no Form profiles");
  firstProfile.executable = "yes";
  expect(
    validateSchemaValue(resolvedCatalogueSchema, corrupted as JsonValue, "").length,
  ).toBeGreaterThan(0);
});

test("a published identity with no backend is listed, and refused in the same profile", async () => {
  const listed = await profiles(host());
  const byKind = new Map(listed.map((profile) => [profile.formRef.kind, profile]));

  // The credential-free catalogue is the published vocabulary: every identity
  // is discoverable, including ones this composition cannot execute.
  expect(listed).toHaveLength(currentTakoformCandidates().forms.length);

  const workflow = byKind.get("DurableWorkflow");
  if (!workflow) throw new Error("the published DurableWorkflow identity is not listed");
  expect(workflow.executable).toBe(false);
  expect(workflow.activated).toBe(false);
  expect(workflow.availableToPrincipal).toBe(false);
  // Withholding is the answer, not concealment: the declared lifecycle stays
  // visible, and the profile states that none of it is accepted here.
  const declared = currentTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "DurableWorkflow",
  );
  expect(workflow.operations).toEqual([...(declared?.operations ?? [])]);
  expect(workflow.operations.length).toBeGreaterThan(0);

  // Nothing in the catalogue claims an acceptance the composition cannot back.
  const backed = new Set([...TAKOSERVER_INTRINSIC_HANDLER_KINDS, moduleWorkerOffering().form.kind]);
  for (const profile of listed) {
    expect(typeof profile.executable).toBe("boolean");
    if (profile.executable !== true) continue;
    expect(backed.has(profile.formRef.kind)).toBe(true);
  }
});
