/**
 * The sponsorship seam, observed rather than described.
 *
 * `/v1/sponsorship/tenants/**` is the one surface a different product speaks to
 * this Host through: Takosumi Hosted binds a tenant, reads its wallet and mints
 * a Takoform run credential across it. It is deliberately absent from the
 * published OpenAPI document — no browser and no customer key may reach it —
 * and for as long as that was the whole story, each side kept its own
 * transcription of the strings in its own test, with no artifact between them.
 *
 * This module scripts one coherent session against a real composed Host and
 * records what it answered. `scripts/generate-sponsorship-seam.ts` writes that
 * recording to `seams/takoserver.sponsorship-seam.json` and diffs it in the
 * gate, so the published fixture is a record of behaviour rather than a
 * description of it, and a consumer that pins the file is pinning something
 * this Host proved.
 */
import { createEphemeralSql } from "../src/compat.ts";
import type { ResourceInventory } from "../src/control.ts";
import { createLedger } from "../src/ledger.ts";
import { ROUTES } from "../src/route-table.ts";
import { createSponsorshipRoutes } from "../src/sponsorship-api.ts";
import type { TakoformHost } from "../src/takoform/types.ts";
import type { TokenService } from "../src/token.ts";

export const SPONSORSHIP_SEAM_KIND = "takoserver.sponsorship-seam@v1";
export const SPONSORSHIP_BASE_PATH = "/v1/sponsorship/tenants";

const PUBLIC_ORIGIN = "https://api.takoserver.test";
const SERVICE_TOKEN = "sponsorship-service-token";
const TENANT_REF = "tenant:opaque";
const ORGANIZATION_ID = "org_legal";
const SECOND_ORGANIZATION_ID = "org_second";
const NOW = "2026-08-20T00:00:00.000Z";
const SCHEMA_DIGEST = `sha256:${"a".repeat(64)}` as const;

const RUNTIME_MATERIALIZATION = {
  contract: "takosumi.runtime-bindings/v1",
  phase: "apply",
  workspaceId: "wsp_1",
  capsuleId: "cap_1",
  runId: "run_1",
} as const;

/** One request the seam accepts, and how it is addressed. */
interface SeamRequest {
  readonly name: string;
  readonly operation: string;
  readonly method: string;
  /** Path under the base path, with the tenant reference already URI-encoded. */
  readonly path: string;
  readonly credential: "service" | "wrong" | "absent";
  readonly body?: unknown;
}

/** The scripted session, in the order one sponsor actually performs it. */
const SESSION: readonly SeamRequest[] = [
  {
    name: "a caller without the service credential is not told the seam exists",
    operation: "bindSponsoredTenant",
    method: "POST",
    path: "",
    credential: "absent",
    body: { organizationId: ORGANIZATION_ID },
  },
  {
    name: "a wrong service credential answers the same way",
    operation: "bindSponsoredTenant",
    method: "POST",
    path: "",
    credential: "wrong",
    body: { organizationId: ORGANIZATION_ID },
  },
  {
    name: "binding names an Organization this Host does not have",
    operation: "bindSponsoredTenant",
    method: "POST",
    path: "",
    credential: "service",
    body: { organizationId: "org_absent" },
  },
  {
    name: "binding the tenant to the sponsor's Organization",
    operation: "bindSponsoredTenant",
    method: "POST",
    path: "",
    credential: "service",
    body: { organizationId: ORGANIZATION_ID },
  },
  {
    name: "rebinding the same tenant to a different Organization is refused",
    operation: "bindSponsoredTenant",
    method: "POST",
    path: "",
    credential: "service",
    body: { organizationId: SECOND_ORGANIZATION_ID },
  },
  {
    name: "the wallet of a tenant with no funding",
    operation: "readSponsoredTenantWallet",
    method: "GET",
    path: "/wallet",
    credential: "service",
  },
  {
    name: "plan-included funding must expire",
    operation: "fundSponsoredTenant",
    method: "POST",
    path: "/funding",
    credential: "service",
    body: {
      tenantRef: TENANT_REF,
      amountMinor: 1_000,
      currency: "USD",
      kind: "plan-included",
      reference: "included:never",
      expiresAt: null,
    },
  },
  {
    name: "purchased funding must not expire",
    operation: "fundSponsoredTenant",
    method: "POST",
    path: "/funding",
    credential: "service",
    body: {
      tenantRef: TENANT_REF,
      amountMinor: 1_000,
      currency: "USD",
      kind: "purchased",
      reference: "purchase:expires",
      expiresAt: "2026-09-01T00:00:00.000Z",
    },
  },
  {
    name: "crediting the wallet with expiring plan-included funding",
    operation: "fundSponsoredTenant",
    method: "POST",
    path: "/funding",
    credential: "service",
    body: {
      tenantRef: TENANT_REF,
      amountMinor: 1_000,
      currency: "USD",
      kind: "plan-included",
      reference: "included:august",
      expiresAt: "2026-09-01T00:00:00.000Z",
    },
  },
  {
    name: "crediting the wallet with purchased funding",
    operation: "fundSponsoredTenant",
    method: "POST",
    path: "/funding",
    credential: "service",
    body: {
      tenantRef: TENANT_REF,
      amountMinor: 1_000,
      currency: "USD",
      kind: "purchased",
      reference: "purchase:1",
      expiresAt: null,
    },
  },
  {
    name: "the wallet after both credits",
    operation: "readSponsoredTenantWallet",
    method: "GET",
    path: "/wallet",
    credential: "service",
  },
  {
    name: "minting a run credential",
    operation: "issueSponsoredTakoformRunCredential",
    method: "POST",
    path: "/takoform-run-credentials",
    credential: "service",
    body: { runRef: "run_1", spaceRef: "tsp_capsule", expiresInSeconds: 300 },
  },
  {
    name: "minting a run credential with the sponsor's value-free run statement",
    operation: "issueSponsoredTakoformRunCredential",
    method: "POST",
    path: "/takoform-run-credentials",
    credential: "service",
    body: {
      runRef: "run_2",
      spaceRef: "tsp_capsule",
      expiresInSeconds: 300,
      runtimeMaterialization: RUNTIME_MATERIALIZATION,
    },
  },
  {
    name: "a run statement this Host does not understand is refused whole",
    operation: "issueSponsoredTakoformRunCredential",
    method: "POST",
    path: "/takoform-run-credentials",
    credential: "service",
    body: {
      runRef: "run_3",
      spaceRef: "tsp_capsule",
      expiresInSeconds: 300,
      runtimeMaterialization: { ...RUNTIME_MATERIALIZATION, contract: "takosumi.something/v9" },
    },
  },
  {
    name: "sponsoring one Resource",
    operation: "setSponsoredResourceBillingMode",
    method: "PUT",
    path: "/resources/res_sponsored",
    credential: "service",
    body: { billingMode: "sponsored" },
  },
  {
    name: "leaving another Resource billed directly",
    operation: "setSponsoredResourceBillingMode",
    method: "PUT",
    path: "/resources/res_direct",
    credential: "service",
    body: { billingMode: "direct" },
  },
  {
    name: "a Resource this Host does not hold cannot be sponsored",
    operation: "setSponsoredResourceBillingMode",
    method: "PUT",
    path: "/resources/res_absent",
    credential: "service",
    body: { billingMode: "sponsored" },
  },
  {
    name: "only sponsored Resources are listed",
    operation: "listSponsoredResources",
    method: "GET",
    path: "/resources",
    credential: "service",
  },
  {
    name: "the first page of the tenant's Resource inventory",
    operation: "listSponsoredTenantInventory",
    method: "GET",
    path: "/inventory?limit=1",
    credential: "service",
  },
  {
    name: "an OAuth resource served by the tenant's own Worker endpoint",
    operation: "authorizeSponsoredInterfaceOauthResource",
    method: "POST",
    path: "/interface-oauth-resources/authorize",
    credential: "service",
    body: { spaceRef: "hosted-space", resource: "https://tenant.example.test/mcp" },
  },
  {
    name: "an OAuth resource the tenant does not serve",
    operation: "authorizeSponsoredInterfaceOauthResource",
    method: "POST",
    path: "/interface-oauth-resources/authorize",
    credential: "service",
    body: { spaceRef: "hosted-space", resource: "https://attacker.example.test/mcp" },
  },
  {
    name: "releasing the sponsored Resource through the Takoform lifecycle",
    operation: "deleteSponsoredResource",
    method: "DELETE",
    path: "/resources/res_sponsored",
    credential: "service",
  },
  {
    name: "a Resource that is not sponsored cannot be released across this seam",
    operation: "deleteSponsoredResource",
    method: "DELETE",
    path: "/resources/res_direct",
    credential: "service",
  },
  {
    name: "a path under the seam that is not an operation is refused, credential or not",
    operation: "bindSponsoredTenant",
    method: "GET",
    path: "/not-an-operation",
    credential: "service",
  },
];

/** One recorded exchange: the request as sent, and the answer as observed. */
export interface RecordedExchange {
  readonly name: string;
  readonly operation: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly credential: "service" | "wrong" | "absent";
    readonly body?: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly body: unknown;
  };
}

/** The published seam artifact. */
export interface SponsorshipSeamFixture {
  readonly kind: typeof SPONSORSHIP_SEAM_KIND;
  readonly summary: string;
  readonly basePath: typeof SPONSORSHIP_BASE_PATH;
  readonly credential: {
    readonly header: "authorization";
    readonly scheme: "Bearer";
    readonly note: string;
  };
  readonly requestId: { readonly note: string; readonly placeholder: string };
  readonly tenantRef: { readonly example: string; readonly encoding: string };
  readonly runtimeMaterialization: {
    readonly note: string;
    readonly exactKeys: readonly string[];
    readonly contract: string;
    readonly phases: readonly string[];
  };
  readonly operations: readonly string[];
  readonly exchanges: readonly RecordedExchange[];
}

/**
 * Runs the scripted session against a composed Host and records the answers.
 *
 * The Host state is fixed here rather than in the artifact: the artifact is a
 * statement about the wire, and a consumer reading it should not have to
 * reconstruct a database to understand a payload.
 */
export async function observeSponsorshipSeam(): Promise<SponsorshipSeamFixture> {
  const sql = createEphemeralSql();
  const now = new Date(NOW);
  const organizations: readonly (readonly [string, string])[] = [
    [ORGANIZATION_ID, "Legal Organization"],
    [SECOND_ORGANIZATION_ID, "Another Organization"],
  ];
  for (const [id, name] of organizations) {
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      [id, name, "prn_1", now.toISOString()],
    );
  }
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, updated_at, relations_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ORGANIZATION_ID,
      "hosted-space",
      "edge.forms.takoform.com/v1beta1",
      "WorkerEndpoint",
      "endpoint",
      "tfres_endpoint",
      "1",
      "1",
      JSON.stringify({}),
      now.getTime(),
      JSON.stringify([]),
    ],
  );
  await sql.run(
    `INSERT INTO tf_resource_deployments
       (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, state, observed_json, outputs_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ORGANIZATION_ID,
      "dep_endpoint",
      "tfres_endpoint",
      "compute.worker.endpoint.standard",
      "cloudflare",
      "cloudflare.primary",
      "endpoint:worker",
      "active",
      JSON.stringify({ enabled: true }),
      JSON.stringify({ hostname: "tenant.example.test", url: "https://tenant.example.test/" }),
      now.getTime(),
      now.getTime(),
    ],
  );

  const lifecycle: TakoformHost = {
    async handle() {
      return new Response(null, { status: 204 });
    },
  };
  const route = createSponsorshipRoutes({
    sql,
    ledger: createLedger(sql, () => now),
    inventory: seamInventory(),
    lifecycle,
    tokens: seamTokens(),
    serviceToken: SERVICE_TOKEN,
    publicOrigin: PUBLIC_ORIGIN,
    clock: () => now,
  });

  const tenant = encodeURIComponent(TENANT_REF);
  const exchanges: RecordedExchange[] = [];
  for (const step of SESSION) {
    const url = `${PUBLIC_ORIGIN}${SPONSORSHIP_BASE_PATH}/${tenant}${step.path}`;
    const bearer =
      step.credential === "service"
        ? SERVICE_TOKEN
        : step.credential === "wrong"
          ? "not-the-service-token"
          : null;
    const request = new Request(url, {
      method: step.method,
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(step.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
    });
    const response = (await route(request, new URL(url))) ?? new Response(null, { status: 599 });
    const text = await response.text();
    exchanges.push({
      name: step.name,
      operation: step.operation,
      request: {
        method: step.method,
        path: `${SPONSORSHIP_BASE_PATH}/${tenant}${step.path}`,
        credential: step.credential,
        ...(step.body === undefined ? {} : { body: step.body }),
      },
      response: {
        status: response.status,
        body: text === "" ? null : withStableRequestId(JSON.parse(text) as unknown),
      },
    });
  }

  return {
    kind: SPONSORSHIP_SEAM_KIND,
    summary:
      "The private product-to-product seam Takosumi Hosted speaks to this Host through. " +
      "Every exchange below was recorded from a composed Takoserver, not written by hand. " +
      "A request without the service credential is answered `not_found`, so the seam does " +
      "not disclose that it exists.",
    basePath: SPONSORSHIP_BASE_PATH,
    credential: {
      header: "authorization",
      scheme: "Bearer",
      note: "The sponsorship service credential. One first-party product holds it.",
    },
    requestId: {
      note:
        "Every refusal carries a fresh `requestId`. It is replaced with a placeholder here so " +
        "the recording is reproducible; a consumer must accept any value and must not treat " +
        "the member as optional.",
      placeholder: RECORDED_REQUEST_ID,
    },
    tenantRef: {
      example: TENANT_REF,
      encoding:
        "One URI path component. The reference may contain characters that must be encoded; " +
        "the Host decodes exactly one component and refuses a value containing a slash.",
    },
    runtimeMaterialization: {
      note:
        "The sponsor's value-free statement of which run is asking. It is validated for this " +
        "exact shape and then carried nowhere: not into the credential, the token claims, the " +
        "ledger, or a provider. A shape this Host does not understand refuses the whole request.",
      exactKeys: ["capsuleId", "contract", "phase", "runId", "workspaceId"],
      contract: RUNTIME_MATERIALIZATION.contract,
      phases: ["plan", "apply", "destroy"],
    },
    operations: ROUTES.filter((route) => route.internal).map((route) => route.operation),
    exchanges,
  };
}

/**
 * `requestId` is minted fresh for every refusal, so recording the real one
 * would make this artifact differ from itself on every run. The placeholder
 * keeps the recording reproducible while still showing that the member is
 * always present — a consumer that drops it reads a protocol-invalid envelope.
 */
export const RECORDED_REQUEST_ID = "req_<fresh per response>";

function withStableRequestId(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return body;
  const errorRecord = error as Record<string, unknown>;
  if (typeof errorRecord.requestId !== "string") return body;
  return { ...record, error: { ...errorRecord, requestId: RECORDED_REQUEST_ID } };
}

function seamInventory(): ResourceInventory {
  const listing = (uid: string) => ({
    space: "hosted-space",
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "ObjectBucket" as const,
    name: uid,
    uid,
    generation: "3",
    revision: "7",
    updatedAt: NOW,
    resource: {
      apiVersion: "edge.forms.takoform.com/v1beta1",
      kind: "ObjectBucket",
      form: {
        formRef: {
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "ObjectBucket",
          definitionVersion: "0.1.0",
          schemaDigest: SCHEMA_DIGEST,
        },
      },
      metadata: {
        name: uid,
        space: "hosted-space",
        uid,
        generation: "3",
        revision: "7",
      },
      spec: {},
      status: { observedGeneration: "3", conditions: [] },
    },
  });
  return {
    async listResources() {
      return { resources: [listing("res_sponsored"), listing("res_direct")], cursor: null };
    },
    async resourceByUid(_tenantId: string, uid: string) {
      return uid === "res_sponsored" || uid === "res_direct" ? listing(uid) : null;
    },
    async listOperations() {
      return [];
    },
  } as unknown as ResourceInventory;
}

function seamTokens(): TokenService {
  const unavailable = async (): Promise<never> => {
    throw new Error("not reached by the seam session");
  };
  return {
    issueProvisionToken: unavailable,
    verifyProvisionToken: unavailable,
    consumeProvisionToken: unavailable,
    issueTakoformRunToken: unavailable,
    verifyTakoformTenantRunToken: unavailable,
    verifyTakoformRunToken: unavailable,
    claimTakoformRunTokenForCreate: unavailable,
    async issueTakoformTenantRunToken() {
      return { token: "runner-only-secret", expiresAt: "2026-08-20T00:05:00.000Z" };
    },
  } as unknown as TokenService;
}
