import { expect, test } from "bun:test";
import type { Accounts } from "../src/auth.ts";
import { AuthError } from "../src/auth.ts";
import { ControlError, controlErrorResponse, createControlRoutes } from "../src/control.ts";
import { isStableErrorEnvelope } from "../src/error-envelope.ts";
import {
  createEphemeralSql,
  createMemoryObjectStore,
  createRuntimeInputAuthority,
  InMemoryTakoformResourceDriver,
  openApiDocument,
} from "../src/index.ts";
import { RuntimeInputPreparationError } from "../src/runtime-input-preparations.ts";
import { DEFAULT_TAKOFORM_ROUTES } from "../src/takoform/routes.ts";
import type { InstalledTakoformForm, TakoformResourceDriver } from "../src/takoform/types.ts";
import { TakoformHostError } from "../src/takoform/types.ts";
import { WorkerEndpointOriginReservationError } from "../src/worker-endpoint-origin-reservations.ts";
import { createConfiguredHistoricalTakoformHost } from "./helpers/historical-takoform-host.ts";

/**
 * The `/v1/*` control lane answers the same closed envelope the stable Takoform
 * Host lane does.
 *
 * It did not. `controlErrorResponse` rendered `{code, message}` while the
 * released provider's `parseAPIError` accepts an envelope only when `code`,
 * `message`, `requestId` and a non-nil `retryable` are all present. The private
 * runtime-input route's `operation_not_found` 404 is the answer that tells the
 * provider "no handoff exists yet, send one", so a two-member 404 made the
 * whole sealed runtime-input path unreachable from the released provider: it
 * failed with `preparation_lookup_failed` before a single value was sent.
 */

const HOST_ORIGIN = "https://api.takoserver.test";
const PREPARATION_TIME = "2026-08-31T18:00:00Z";
const OPERATION_KEY = `takoform-worker-runtime-v1-${"c".repeat(64)}`;
const WORKER_RESOURCE_UID = "uid-worker-01";
const OFFERING_ID = "worker.module.test";
const CLAIM_TARGET = {
  space: "default",
  workerName: "yurucommu",
  workerResourceUid: WORKER_RESOURCE_UID,
  bundleName: "bundle-01",
} as const;
const ORGANIZATION_ID = "org_01";
/**
 * The public apply's Form. It is deliberately a small one: what this test is
 * about is the three-request sequence and the envelope, and the WorkerVersion
 * fences over the same seam are proved in `runtime-input-preparations.test.ts`.
 */
const PUBLIC_FORM: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "edge.forms.takoform.com",
      kind: "ObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"7".repeat(64)}`,
    },
  },
  requiresHostApi: "forms.takoform.com/v1",
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "read", "update", "delete", "observe"],
};
const WORKER_FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ModuleWorker",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:049df2fb1eda53e4ccb0d646022a3ded8bc17c44eb433fa2e5ac0861efe42ac7" as const,
};

/** Exactly `parseAPIError`'s acceptance rule from `internal/clientv3/errors.go`. */
function providerDecodes(status: number, body: unknown): { code: string } | "protocol_invalid" {
  const envelope = body as { error?: Record<string, unknown> } | null;
  const error = envelope?.error;
  if (
    !error ||
    typeof error.code !== "string" ||
    error.code.trim() === "" ||
    typeof error.message !== "string" ||
    error.message.trim() === "" ||
    typeof error.requestId !== "string" ||
    error.requestId.trim() === "" ||
    typeof error.retryable !== "boolean" ||
    !isStableErrorEnvelope(error.code, status, error.retryable)
  ) {
    return "protocol_invalid";
  }
  return { code: error.code };
}

/** `runtimeInputPreparationAbsent`, which is what makes the first PUT happen. */
function readsAsPreparationAbsent(status: number, body: unknown): boolean {
  const decoded = providerDecodes(status, body);
  return status === 404 && decoded !== "protocol_invalid" && decoded.code === "operation_not_found";
}

test("every control-lane failure carries the four members the released provider requires", async () => {
  const failures: readonly [unknown, string, number][] = [
    [new AuthError("unauthenticated"), "unauthenticated", 401],
    [new AuthError("permission_denied"), "permission_denied", 403],
    [new ControlError("not_found", 404), "not_found", 404],
    [new RuntimeInputPreparationError("operation_not_found", 404), "operation_not_found", 404],
    [new RuntimeInputPreparationError("conflict", 409), "conflict", 409],
    [new RuntimeInputPreparationError("invalid_argument", 400), "invalid_argument", 400],
    [
      new RuntimeInputPreparationError("apply_commitment_mismatch", 409),
      "apply_commitment_mismatch",
      409,
    ],
    [new RuntimeInputPreparationError("backend_unavailable", 503), "backend_unavailable", 503],
    [
      new WorkerEndpointOriginReservationError("unsupported_capability", 422),
      "unsupported_capability",
      422,
    ],
    [new TakoformHostError("resource_busy", 409), "resource_busy", 409],
    [new Error("something internal"), "internal_error", 500],
  ];

  for (const [error, code, status] of failures) {
    const response = controlErrorResponse(error);
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "requestId", "retryable"]);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(code.replaceAll("_", " "));
    expect(body.error.requestId).toMatch(/^req_[0-9a-f-]{36}$/u);
    expect(typeof body.error.retryable).toBe("boolean");
  }

  // A fresh identity per failure: a caller can never choose the identity its
  // failure is recorded under, and two failures are never the same event.
  const first = (await controlErrorResponse(new AuthError("unauthenticated")).json()) as {
    error: { requestId: string };
  };
  const second = (await controlErrorResponse(new AuthError("unauthenticated")).json()) as {
    error: { requestId: string };
  };
  expect(first.error.requestId).not.toBe(second.error.requestId);
});

test("the published document pins the envelope the provider decodes", () => {
  const schema = openApiDocument.components.schemas.Error as {
    readonly required: readonly string[];
    readonly additionalProperties: boolean;
    readonly properties: { readonly error: { readonly required: readonly string[] } };
  };
  expect(schema.required).toEqual(["error"]);
  expect(schema.additionalProperties).toBe(false);
  expect([...schema.properties.error.required].sort()).toEqual([
    "code",
    "message",
    "requestId",
    "retryable",
  ]);

  // Every documented failure on the private runtime-input route and on both
  // reservation routes names it, so the wire contract pins the shape instead of
  // leaving a status with a prose description and no schema — which is how the
  // two lanes came to disagree.
  const paths = openApiDocument.paths as Record<
    string,
    Record<string, { readonly responses: Record<string, Record<string, unknown>> }>
  >;
  for (const path of [
    "/v1/takoform/worker-runtime-input-preparations/{operationKey}",
    "/v1/worker-endpoint-origin-reservations/{reservationId}",
    "/v1/worker-endpoint-origin-reservations/{reservationId}/activation",
  ]) {
    const route = paths[path];
    if (!route) throw new TypeError(`${path} is not documented`);
    for (const operation of Object.values(route)) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (status.startsWith("2")) continue;
        expect({ path, status, response }).toEqual({
          path,
          status,
          response: {
            description: expect.any(String),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
        });
      }
    }
  }
});

test("the provider's exact private-PUT/public-apply/private-GET sequence completes", async () => {
  const sql = createEphemeralSql();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const now = new Date(PREPARATION_TIME);
  await seedWorkerLifecycle(sql, ORGANIZATION_ID, now.getTime());
  const runtimeInputs = createRuntimeInputAuthority({
    sql,
    sealKeys: { current: { keyId: "runtime-input-test-key", key } },
    canonicalPublicOrigin: HOST_ORIGIN,
    clock: () => now,
  });

  // The adapter half of the seam, doing exactly what a real one does: acquire
  // against the executing apply, dispatch (which erases the ciphertext), then
  // settle from a receipt digest. Nothing else about it needs to be real for
  // the sequence to be the provider's.
  const inner = new InMemoryTakoformResourceDriver();
  const spent: { bindings?: Readonly<Record<string, string>> } = {};
  const driver: TakoformResourceDriver = {
    ...inner,
    apply: async (input) => {
      if (input.publicApply) {
        const lease = await runtimeInputs.leases.acquire({
          organizationId: input.tenantId,
          operationId: input.operationId,
          resourceUid: input.resourceUid,
          reference: input.operationKey as string,
          target: CLAIM_TARGET,
          bindingNames: ["ENCRYPTION_KEY"],
          publicApply: input.publicApply,
        });
        spent.bindings = { ...lease.bindings };
        const dispatched = await lease.dispatch();
        await dispatched.settle(`sha256:${"1".repeat(64)}`);
      }
      return await inner.apply(input);
    },
    observe: (input) => inner.observe(input),
    delete: (input) => inner.delete(input),
  };

  const host = createConfiguredHistoricalTakoformHost({
    sql,
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: ORGANIZATION_ID, principalId: "principal_01" }),
    forms: [PUBLIC_FORM],
    driver,
    routes: DEFAULT_TAKOFORM_ROUTES,
    clock: () => now,
  });
  const control = createControlRoutes({
    accounts: {
      async authenticate(authorization: string | null) {
        if (authorization !== "Bearer organization-key" && authorization !== "Bearer reader-key") {
          return null;
        }
        return {
          hostPrincipalId: "api-key-principal",
          principalId: "principal_01",
          organizationId: ORGANIZATION_ID,
          scopes: authorization === "Bearer reader-key" ? ["resources:read"] : ["resources:write"],
          kind: "api_key",
        } as const;
      },
    } as Pick<Accounts, "authenticate"> as Accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {} as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    clock: () => now,
    runtimeInputs: runtimeInputs.preparations,
  });

  const call = async (
    method: string,
    path: string,
    options: {
      readonly body?: string;
      readonly idempotencyKey?: string;
      readonly ifNoneMatch?: string;
      readonly authorization?: string | null;
    } = {},
  ): Promise<Response> => {
    const authorization =
      options.authorization === undefined ? "Bearer organization-key" : options.authorization;
    const request = new Request(`${HOST_ORIGIN}${path}`, {
      method,
      headers: {
        ...(authorization === null ? {} : { authorization }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        ...(options.ifNoneMatch ? { "if-none-match": options.ifNoneMatch } : {}),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    const response = path.startsWith("/v1/")
      ? await control(request, new URL(request.url))
      : await host.handle(request);
    if (!response) throw new TypeError(`no route answered ${method} ${path}`);
    return response;
  };

  const privatePath = `/v1/takoform/worker-runtime-input-preparations/${OPERATION_KEY}`;

  // 1. The lookup the provider always does first. Absence is the answer that
  //    lets it send the values at all — and the answer that was unreadable.
  const lookup = await call("GET", privatePath, { idempotencyKey: OPERATION_KEY });
  expect(lookup.status).toBe(404);
  expect(readsAsPreparationAbsent(lookup.status, await lookup.json())).toBe(true);

  // The public apply the provider is about to send, byte for byte.
  const lane = "/apis/forms.takoform.com/v1";
  const formRef = PUBLIC_FORM.identity.formRef;
  const resource = {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: { formRef },
    metadata: { space: "default", name: "media" },
    spec: {},
  };
  const prepare = await call("POST", `${lane}/resources/prepare`, {
    body: JSON.stringify(resource),
  });
  expect(prepare.status).toBe(200);
  const review = ((await prepare.json()) as { review: { prepareDigest: string } }).review;
  const publicPath = `${lane}/resources/${formRef.apiVersion}/${formRef.kind}/media`;
  const publicBody = JSON.stringify({ ...resource, review: { ...review } });

  // 2. The one private PUT, carrying the exact apply it authorizes.
  const prepared = await call("PUT", privatePath, {
    idempotencyKey: OPERATION_KEY,
    body: JSON.stringify({
      format: "takoserver.worker-runtime-input-preparation@v2",
      canonicalPublicOrigin: HOST_ORIGIN,
      publicApply: {
        method: "PUT",
        path: publicPath,
        fences: { ifNoneMatch: "*" },
        body: publicBody,
      },
      bindings: { ENCRYPTION_KEY: "placeholder-encryption-value" },
    }),
  });
  expect(prepared.status).toBe(200);
  const preparedBody = (await prepared.json()) as { applyCommitment: string; status: string };
  expect(preparedBody.status).toBe("prepared");

  // 3. The public apply, under the same operation key and the create fence.
  const applied = await call("PUT", publicPath, {
    idempotencyKey: OPERATION_KEY,
    ifNoneMatch: "*",
    body: publicBody,
  });
  expect(applied.status).toBe(201);
  expect(spent.bindings).toEqual({ ENCRYPTION_KEY: "placeholder-encryption-value" });

  // 4. The value-free readback. The handoff is spent and says so, and no value
  //    survives anywhere the caller or the database can reach.
  const readback = await call("GET", privatePath, { idempotencyKey: OPERATION_KEY });
  expect(readback.status).toBe(200);
  expect(await readback.json()).toMatchObject({
    format: "takoserver.worker-runtime-input-preparation@v2",
    status: "consumed",
    operationKey: OPERATION_KEY,
    applyCommitment: preparedBody.applyCommitment,
    canonicalPublicOrigin: HOST_ORIGIN,
    bindingNames: ["ENCRYPTION_KEY"],
  });
  const rows = await sql.query(
    "SELECT * FROM worker_runtime_input_preparations WHERE operation_key = ?",
    [OPERATION_KEY],
  );
  expect(JSON.stringify(rows)).not.toContain("placeholder-encryption-value");

  // 5. Every refusal this route can answer, on the route itself, in the shape
  //    the released provider decodes. A `conflict` is deliberately not in the
  //    provider's closed code table: it reads as an opaque rejection, which is
  //    the correct outcome for a spent handoff and is never auto-retried.
  const refusals: readonly [string, Response][] = [
    ["unauthenticated", await call("GET", privatePath, { authorization: null })],
    ["permission_denied", await call("GET", privatePath, { authorization: "Bearer reader-key" })],
    [
      "operation_not_found",
      await call("GET", `/v1/takoform/worker-runtime-input-preparations/${"z".repeat(40)}`, {
        idempotencyKey: "z".repeat(40),
      }),
    ],
    [
      "invalid_argument",
      await call("PUT", privatePath, { idempotencyKey: "a-different-operation-key", body: "{}" }),
    ],
    [
      "conflict",
      await call("PUT", privatePath, {
        idempotencyKey: OPERATION_KEY,
        body: JSON.stringify({
          format: "takoserver.worker-runtime-input-preparation@v2",
          canonicalPublicOrigin: HOST_ORIGIN,
          publicApply: {
            method: "PUT",
            path: publicPath,
            fences: { ifNoneMatch: "*" },
            body: '{"different":"apply"}',
          },
          bindings: { ENCRYPTION_KEY: "placeholder-encryption-value" },
        }),
      }),
    ],
  ];
  const seen: Record<string, { status: number; decodes: boolean }> = {};
  for (const [expected, response] of refusals) {
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "requestId", "retryable"]);
    expect(body.error.code).toBe(expected);
    seen[expected] = {
      status: response.status,
      decodes: providerDecodes(response.status, body) !== "protocol_invalid",
    };
  }
  expect(seen).toEqual({
    unauthenticated: { status: 401, decodes: true },
    permission_denied: { status: 403, decodes: true },
    operation_not_found: { status: 404, decodes: true },
    invalid_argument: { status: 400, decodes: true },
    conflict: { status: 409, decodes: false },
  });
});

async function seedWorkerLifecycle(
  sql: ReturnType<typeof createEphemeralSql>,
  organizationId: string,
  now: number,
): Promise<void> {
  const resource = {
    apiVersion: WORKER_FORM_REF.apiVersion,
    kind: WORKER_FORM_REF.kind,
    form: { formRef: WORKER_FORM_REF },
    metadata: {
      name: CLAIM_TARGET.workerName,
      space: CLAIM_TARGET.space,
      uid: WORKER_RESOURCE_UID,
      generation: "1",
      revision: "1",
    },
    spec: {},
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: new Date(now).toISOString(),
        },
      ],
    },
  };
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, updated_at)
     VALUES (?, 'default', 'edge.forms.takoform.com', 'ModuleWorker', 'yurucommu', ?,
             '1', '1', ?, ?)`,
    [organizationId, WORKER_RESOURCE_UID, JSON.stringify(resource), now],
  );
  await sql.run(
    `INSERT INTO tf_resource_deployments
       (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, native_claimed, state,
        observed_json, outputs_json, created_at, updated_at)
     VALUES (?, 'deployment-worker-01', ?, ?, 'fake', 'fake.primary',
             'worker:native-01', 0, 'active', '{}', '{}', ?, ?)`,
    [organizationId, WORKER_RESOURCE_UID, OFFERING_ID, now, now],
  );
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, evidence_json, evidence_ref,
        evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
     VALUES (?, ?, 'default', 'edge.forms.takoform.com', 'ModuleWorker', 'yurucommu', ?,
             'live', 1, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [organizationId, WORKER_RESOURCE_UID, JSON.stringify(WORKER_FORM_REF), now, now],
  );
}
