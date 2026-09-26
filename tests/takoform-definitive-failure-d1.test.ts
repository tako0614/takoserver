import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  buildApp,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  type InstalledTakoformForm,
  type Offering,
} from "../src/index.ts";
import type { Sql, SqlParam } from "../src/ports.ts";
import {
  type ApplyInput,
  failed,
  failedWithoutProviderOperationMutation,
} from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { TAKOFORM_APPLY_SELECTION_VERSION } from "../src/takoform/apply-selection.ts";
import { createResourceDependencySet } from "../src/takoform/dependency-fence.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const TENANT_PREFIX = "d1-definitive-failure";
const SPACE = "default";
const ORIGIN = "https://api.takoserver.com";
const NOW = new Date("2026-09-13T00:00:00.000Z");
const FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
} as const;
const FORM: InstalledTakoformForm = {
  identity: { formRef: FORM_REF },
  desiredSchema: {
    type: "object",
    properties: { location: { type: "string" } },
    additionalProperties: false,
  },
  observedSchema: { type: "object", additionalProperties: true },
  operations: ["create", "read", "update", "delete", "observe"],
};
const PROVIDER_OFFERING = {
  id: "storage.object.standard",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: FORM_REF,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "observe"],
} as const;
const SOLD: Offering = {
  id: PROVIDER_OFFERING.id,
  providerPackRef: "fake",
  providerInstallationRef: "fake.primary",
  supplyContractRef: "fake.test-contract",
  pricePlanRef: "storage.object.standard.price-v1",
  resourceClass: "storage.object",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "support:test",
  abusePolicyRef: "abuse:test",
  kind: PROVIDER_OFFERING.kind,
  displayName: PROVIDER_OFFERING.displayName,
  form: FORM_REF,
  pricePlan: {
    id: "storage.object.standard.price-v1",
    currency: "USD",
    provisioning: { meter: "resource.create", amountMinor: 500 },
    meters: [],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: ["test"],
  portability: {
    api: "portable",
    exportFormats: [],
    importFormats: [],
    migrationModes: ["offline"],
  },
  isolation: "dedicated-resource",
  available: true,
};

const identity: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
  },
};
const settlement: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "funding:d1-definitive-failure", amountMinor: 2_000, currency: "USD" };
  },
};

const LANE = "/apis/forms.takoform.com/v1";
const QUERY =
  `space=${SPACE}&definitionVersion=${FORM_REF.definitionVersion}` +
  `&schemaDigest=${encodeURIComponent(FORM_REF.schemaDigest)}`;

test("native D1 settles whole-operation apply abort with an atomic exact hold release", async () => {
  for (const injectReleaseConstraint of [false, true]) {
    await withNativeD1(
      { failOn: [], recoveryAbort: true, injectReleaseConstraint },
      async ({ app, sql, observe }) => {
        const tenant = await createTenant(app.fetch);
        const initial = await applyResource(app.fetch, tenant.provider, "d1-recovery-abort");
        expect(initial.status).toBe(202);
        const operationId = operationIdFrom(initial.body);
        expect(await walletAt(app.fetch, tenant.organizationId, tenant.owner)).toMatchObject({
          heldMinor: 500,
        });
        const recovered = (await app.tick()).providerRepairs;
        expect(recovered).toMatchObject(
          injectReleaseConstraint ? { settled: 0, pending: 1 } : { settled: 1, pending: 0 },
        );
        expect(await walletAt(app.fetch, tenant.organizationId, tenant.owner)).toMatchObject({
          settledMinor: 2_000,
          heldMinor: injectReleaseConstraint ? 500 : 0,
        });
        expect(
          await sql.query(
            "SELECT provider_outcome FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
            [operationId],
          ),
        ).toEqual(injectReleaseConstraint ? [{ provider_outcome: "indeterminate" }] : []);
        expect(
          await sql.query("SELECT phase FROM tf_deferred_operations_selection_v1 WHERE id = ?", [
            operationId,
          ]),
        ).toEqual([{ phase: injectReleaseConstraint ? "committing" : "failed" }]);
        expect(observe.releaseIntercepts).toBe(1);
        expect(observe.maxBindParams).toBeLessThanOrEqual(100);
      },
    );
  }
}, 30_000);

test("native D1 terminalizes a definitive refusal and releases its exact hold", async () => {
  await withNativeD1({ failOn: ["d1-success"] }, async ({ app, sql, observe }) => {
    const tenant = await createTenant(app.fetch);
    const applied = await applyResource(app.fetch, tenant.provider, "d1-success");
    expect(applied.status).toBe(503);
    expect(applied.body).toMatchObject({
      // The immediate HTTP error uses the stable retryable error envelope;
      // the terminal Operation below independently sets retryable=false.
      error: { code: "backend_unavailable", retryable: true },
    });

    const operationId = await latestDeferredOperationId(sql, tenant.organizationId);
    const wallet = await walletAt(app.fetch, tenant.organizationId, tenant.owner);
    expect(wallet).toMatchObject({ settledMinor: 2_000, heldMinor: 0, availableMinor: 2_000 });
    expect(wallet.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "release",
          reference: operationId,
          settledDeltaMinor: 0,
          heldDeltaMinor: -500,
        }),
      ]),
    );

    const terminal = await call(
      app.fetch,
      "GET",
      `${LANE}/operations/${operationId}`,
      undefined,
      tenant.provider,
    );
    expect(terminal.status).toBe(200);
    expect(terminal.body).toMatchObject({
      id: operationId,
      done: true,
      error: { code: "backend_unavailable", retryable: false },
    });

    expect(
      await sql.query(
        "SELECT operation_id FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
        [operationId],
      ),
    ).toEqual([]);
    expect(
      await sql.query("SELECT operation, state FROM tf_operations WHERE id = ?", [operationId]),
    ).toEqual([{ operation: "apply", state: "failed" }]);
    expect(
      await sql.query(
        "SELECT phase, terminal_json, lease_token FROM tf_deferred_operations_selection_v1 WHERE id = ?",
        [operationId],
      ),
    ).toEqual([{ phase: "failed", terminal_json: expect.any(String), lease_token: null }]);
    expect(
      await sql.query("SELECT uid FROM tf_resources WHERE tenant_id = ?", [tenant.organizationId]),
    ).toEqual([]);
    expect(
      await sql.query(
        "SELECT resource_uid FROM tf_resource_deletion_attestations WHERE tenant_id = ?",
        [tenant.organizationId],
      ),
    ).toEqual([]);
    expect(
      await sql.query("SELECT resource_uid FROM tf_resource_provider_effects WHERE tenant_id = ?", [
        tenant.organizationId,
      ]),
    ).toEqual([]);
    expect(
      await sql.query("SELECT claim_key FROM tf_resource_claims WHERE tenant_id = ?", [
        tenant.organizationId,
      ]),
    ).toEqual([]);
    expect(observe.releaseIntercepts).toBe(1);
    expect(observe.releaseReference).toBe(operationId);
    expect(observe.maxBindParams).toBeLessThanOrEqual(100);
  });
}, 30_000);

test("native D1 rolls back the whole definitive-failure batch on an exact release constraint", async () => {
  await withNativeD1(
    { failOn: ["d1-rollback"], injectReleaseConstraint: true },
    async ({ app, sql, observe }) => {
      const tenant = await createTenant(app.fetch);
      const applied = await applyResource(app.fetch, tenant.provider, "d1-rollback");
      expect(applied.status).toBe(202);
      const operationId = operationIdFrom(applied.body);

      const wallet = await walletAt(app.fetch, tenant.organizationId, tenant.owner);
      expect(wallet).toMatchObject({
        settledMinor: 2_000,
        heldMinor: 500,
        availableMinor: 1_500,
      });
      expect(wallet.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "hold",
            reference: operationId,
            heldDeltaMinor: 500,
          }),
        ]),
      );
      expect(wallet.entries).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "release", reference: operationId }),
        ]),
      );

      expect(
        await sql.query(
          "SELECT operation_id FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
          [operationId],
        ),
      ).toEqual([{ operation_id: operationId }]);
      expect(
        await sql.query(
          "SELECT phase, receipt_json, provider_outcome " +
            "FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
          [operationId],
        ),
      ).toEqual([
        {
          phase: "planned",
          receipt_json: null,
          provider_outcome: "running",
        },
      ]);
      expect(
        await sql.query(
          "SELECT phase, terminal_json, lease_token, lease_until " +
            "FROM tf_deferred_operations_selection_v1 WHERE id = ?",
          [operationId],
        ),
      ).toEqual([
        { phase: "committing", terminal_json: null, lease_token: null, lease_until: null },
      ]);
      expect(
        await sql.query(
          "SELECT effect_id, phase FROM tf_resource_provider_effects " +
            "WHERE tenant_id = ? AND effect_id = ? ORDER BY phase",
          [tenant.organizationId, operationId],
        ),
      ).toEqual([
        { effect_id: operationId, phase: "dispatched" },
        { effect_id: operationId, phase: "planned" },
      ]);
      expect(
        await sql.query(
          "SELECT state FROM tf_resource_deletion_attestations " +
            "WHERE tenant_id = ? AND resource_uid = ?",
          [tenant.organizationId, await resourceUidFor(sql, operationId)],
        ),
      ).toEqual([{ state: "live" }]);
      expect(await sql.query("SELECT id FROM tf_operations WHERE id = ?", [operationId])).toEqual(
        [],
      );
      expect(observe.releaseIntercepts).toBe(1);
      expect(observe.releaseReference).toBe(operationId);
      expect(observe.maxBindParams).toBeLessThanOrEqual(100);
    },
  );
}, 30_000);

test("native D1 compiles every generated compensated-create settlement statement", async () => {
  await withNativeD1({ failOn: [] }, async ({ sql }) => {
    const statements = await capturedCompensatedCreateStatements();
    expect(statements).toHaveLength(10);
    for (const [index, statement] of statements.entries()) {
      try {
        await sql.query(`EXPLAIN ${statement.sql}`, statement.params);
      } catch (error) {
        throw new Error(`compensated-create statement ${index + 1} did not compile`, {
          cause: error,
        });
      }
    }
  });
}, 30_000);

interface NativeD1Options {
  readonly recoveryAbort?: boolean;
  readonly failOn: readonly string[];
  readonly injectReleaseConstraint?: boolean;
}

async function capturedCompensatedCreateStatements() {
  const operationId = "op_d1_compensation_compile";
  const tenantId = "tenant_d1_compensation_compile";
  const resourceUid = "uid_d1_compensation_compile";
  const targetUid = "uid_d1_compensation_target";
  const providerLeaseToken = "provider_lease_d1_compensation_compile";
  const hostLeaseToken = "host_lease_d1_compensation_compile";
  const relation = {
    pointer: "/spec/worker",
    relation: "worker",
    targetApiVersion: FORM_REF.apiVersion,
    targetKind: FORM_REF.kind,
    targetName: "dependency",
    targetUid,
    targetRevision: "1",
    targetFormRef: FORM_REF,
  } as const;
  const dependencies = await createResourceDependencySet({
    tenantId,
    space: SPACE,
    holderUid: resourceUid,
    operationId,
    relations: [relation],
  });
  const selection = {
    version: TAKOFORM_APPLY_SELECTION_VERSION,
    kind: "provider",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    technicalOffering: PROVIDER_OFFERING,
    relations: [
      {
        pointer: relation.pointer,
        relation: relation.relation,
        targetUid,
        resource: {
          apiVersion: FORM_REF.apiVersion,
          kind: FORM_REF.kind,
          formRef: FORM_REF,
          name: relation.targetName,
          space: SPACE,
          uid: targetUid,
          generation: "1",
          revision: "1",
        },
      },
    ],
  } as const;
  const target = {
    tenantId,
    space: SPACE,
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    name: "compensated-create",
  } as const;
  let captured: Parameters<Sql["batch"]>[0] | undefined;
  const captureSql: Sql = {
    async query() {
      return [{ committed: 0 }];
    },
    async run() {
      throw new Error("compensation statement capture does not execute writes");
    },
    async batch(statements) {
      captured = statements;
      return statements.map(() => ({ rows: [], changes: 1 }));
    },
  };
  const store = createTakoformStore(captureSql, () => NOW);
  await store.commitDefinitiveProviderMutationFailure({
    recoveryAction: "compensateApply",
    saga: {
      operationId,
      operationKind: "apply",
      replayKey: "replay_d1_compensation_compile",
      tenantId,
      fingerprint: "fingerprint_d1_compensation_compile",
      resourceUid,
      target,
    },
    providerLeaseToken,
    claimOwnerId: hostLeaseToken,
    operation: "create",
    compensation: { selection, dependencies },
    hostOperation: {
      kind: "deferred",
      leaseToken: hostLeaseToken,
      terminalJson: JSON.stringify({ done: true }),
      operation: {
        id: operationId,
        tenantId,
        principalId: "principal_d1_compensation_compile",
        operation: "apply",
        phase: "committing",
        requestPath: "/compile-only",
        requestQuery: "",
        requestHeaders: {},
        requestBody: "{}",
        fingerprint: "fingerprint_d1_compensation_compile",
        replayKey: "replay_d1_compensation_compile",
        target: { ...target, formRef: FORM_REF },
        resourceUid,
        pollsRemaining: 0,
        leaseToken: hostLeaseToken,
        leaseUntil: NOW.getTime() + 60_000,
        createdAt: NOW.toISOString(),
      },
    },
  });
  if (!captured) throw new Error("compensated-create settlement produced no batch");
  return captured;
}

interface NativeD1Observation {
  releaseIntercepts: number;
  releaseReference?: string;
  maxBindParams: number;
}

interface NativeD1Fixture {
  readonly app: ReturnType<typeof buildApp>;
  readonly sql: Sql;
  readonly observe: NativeD1Observation;
}

async function withNativeD1(
  options: NativeD1Options,
  callback: (fixture: NativeD1Fixture) => Promise<void>,
): Promise<void> {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "takoform-definitive-failure-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "definitive-failure-d1" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    await applyMigrations(database);
    const base = createD1Sql(database);
    const observe: NativeD1Observation = { releaseIntercepts: 0, maxBindParams: 0 };
    const sql = observeSql(base, observe, options.injectReleaseConstraint === true);
    class AbortProvider extends FakeProvider {
      override async apply(_input: ApplyInput) {
        return failed("unavailable", "initial response lost before claim", true);
      }
      async convergeApply(input: ApplyInput) {
        return failedWithoutProviderOperationMutation(
          input.operationId,
          "conflict",
          "exact apply durably fenced",
        );
      }
    }
    const ProviderClass = options.recoveryAbort ? AbortProvider : FakeProvider;
    const provider = new ProviderClass({
      offerings: [PROVIDER_OFFERING],
      failOn: options.failOn,
    });
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: ORIGIN,
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      providers: [provider],
      offerings: [SOLD],
      clock: () => new Date(NOW),
    });
    await callback({ app, sql, observe });
  } finally {
    await runtime.dispose();
  }
}

function observeSql(
  base: Sql,
  observe: NativeD1Observation,
  injectReleaseConstraint: boolean,
): Sql {
  const releaseSql = normalize(
    `INSERT INTO ledger
      (id, org_id, type, ref, settled_delta, held_delta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    query: base.query,
    run: base.run,
    async batch(statements) {
      observe.maxBindParams = Math.max(
        observe.maxBindParams,
        ...statements.map((statement) => statement.params?.length ?? 0),
      );
      const transformed = statements.map((statement) => {
        const params = statement.params ?? [];
        const isRelease =
          normalize(statement.sql) === releaseSql &&
          params[2] === "release" &&
          params[4] === 0 &&
          params[5] === -500;
        if (!isRelease) return statement;
        observe.releaseIntercepts += 1;
        if (typeof params[3] !== "string") throw new Error("release reference was not a string");
        observe.releaseReference = params[3];
        if (!injectReleaseConstraint) return statement;
        const invalidParams = [...params] as SqlParam[];
        invalidParams[2] = "not-a-ledger-entry";
        return { ...statement, params: invalidParams };
      });
      return await base.batch(transformed);
    },
  };
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

interface TenantFixture {
  readonly organizationId: string;
  readonly owner: Record<string, string>;
  readonly provider: Record<string, string>;
}

async function createTenant(
  fetch: (request: Request) => Promise<Response>,
): Promise<TenantFixture> {
  const suffix = TENANT_PREFIX;
  const session = await call(fetch, "POST", "/v1/sessions", {
    provider: "google",
    assertion: "verified",
  });
  const sessionToken = session.body.sessionToken;
  if (typeof sessionToken !== "string") throw new Error("test session was not issued");
  const owner = { authorization: `Bearer ${sessionToken}` };
  const organization = await call(
    fetch,
    "POST",
    "/v1/organizations",
    { name: `Acme-${suffix}` },
    owner,
  );
  const organizationValue = organization.body.organization;
  if (typeof organizationValue !== "object" || organizationValue === null) {
    throw new Error("test organization was not created");
  }
  const organizationId = (organizationValue as { id?: unknown }).id;
  if (typeof organizationId !== "string") throw new Error("test organization has no id");
  await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/wallet/funding`,
    { settlementProof: `proof-${suffix}` },
    owner,
  );
  const key = await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name: "takoform", scopes: ["resources:write"], expiresInSeconds: 3_600 },
    owner,
  );
  const secret = key.body.secret;
  if (typeof secret !== "string") throw new Error("test provider key was not issued");
  return {
    organizationId,
    owner,
    provider: { authorization: `Bearer ${secret}` },
  };
}

async function applyResource(
  fetch: (request: Request) => Promise<Response>,
  authorization: Record<string, string>,
  name: string,
) {
  const resource = {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF },
    metadata: { name, space: SPACE },
    spec: {},
  };
  const prepared = await call(fetch, "POST", `${LANE}/resources/prepare`, resource, authorization);
  const review = prepared.body.review;
  if (typeof review !== "object" || review === null) throw new Error("test prepare failed");
  const prepareDigest = (review as { prepareDigest?: unknown }).prepareDigest;
  if (typeof prepareDigest !== "string") throw new Error("test prepare digest missing");
  return await call(
    fetch,
    "PUT",
    `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/${name}?${QUERY}`,
    { ...resource, review: { prepareDigest } },
    { ...authorization, "idempotency-key": `d1-${name}-0001`, "if-none-match": "*" },
  );
}

async function walletAt(
  fetch: (request: Request) => Promise<Response>,
  organizationId: string,
  authorization: Record<string, string>,
): Promise<Record<string, unknown> & { entries: readonly Record<string, unknown>[] }> {
  const result = await call(
    fetch,
    "GET",
    `/v1/organizations/${organizationId}/wallet`,
    undefined,
    authorization,
  );
  const wallet = result.body.wallet;
  if (typeof wallet !== "object" || wallet === null) {
    throw new Error("test wallet was not returned");
  }
  return wallet as Record<string, unknown> & { entries: readonly Record<string, unknown>[] };
}

async function latestDeferredOperationId(sql: Sql, tenantId: string): Promise<string> {
  const rows = await sql.query(
    "SELECT id FROM tf_deferred_operations_selection_v1 " +
      "WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    [tenantId],
  );
  const id = rows[0]?.id;
  if (typeof id !== "string") throw new Error("test deferred operation was not recorded");
  return id;
}

async function resourceUidFor(sql: Sql, operationId: string): Promise<string> {
  const rows = await sql.query(
    "SELECT resource_uid FROM tf_deferred_operations_selection_v1 WHERE id = ? LIMIT 1",
    [operationId],
  );
  const uid = rows[0]?.resource_uid;
  if (typeof uid !== "string") throw new Error("test deferred operation has no resource uid");
  return uid;
}

function operationIdFrom(body: Record<string, unknown>): string {
  const operation = body.operation;
  if (typeof operation !== "object" || operation === null) {
    throw new Error("test operation missing");
  }
  const id = (operation as { id?: unknown }).id;
  if (typeof id !== "string") throw new Error("test operation id missing");
  return id;
}

async function call(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function applyMigrations(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
): Promise<void> {
  for (const migration of MIGRATIONS) {
    for (const statement of splitMigration(migration.sql)) {
      await database.prepare(statement).run();
    }
  }
}

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement.length > 0) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
