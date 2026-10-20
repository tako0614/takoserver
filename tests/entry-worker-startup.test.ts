import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { buildMoneyCutoverImportSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import worker, {
  createWorkerEntry,
  resolvePublicWorkerImplementationIdentity,
  workerIntegrationOrganizationBootstrap,
} from "../src/entry-worker.ts";
import {
  INTEGRATION_E2E_ORGANIZATION_ID,
  type IntegrationE2eCredentialAuthorityConfig,
} from "../src/integration-e2e-credential-authority.ts";
import type { SqlParam } from "../src/ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import {
  EDGE_ONLY_RESOURCE_CLASSES,
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";
import { migratedDatabase } from "./helpers/migrated-database.ts";

const ORIGIN = "https://api.integration.example.test";
const readyDatabase = databaseThrough(98);
readyDatabase.exec(
  "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at) VALUES (1, 'test', '2026-10-14T00:00:00.000Z')",
);
afterAll(() => readyDatabase.close());

function databaseThrough(count: number): Database {
  const database = migratedDatabase(count);
  return database;
}

function d1(database: Database) {
  return {
    prepare(sql: string) {
      let values: SqlParam[] = [];
      return {
        bind(...params: SqlParam[]) {
          values = params;
          return this;
        },
        async all() {
          return {
            results: database
              .query(sql)
              .all(
                ...values.map((value) =>
                  value instanceof ArrayBuffer ? new Uint8Array(value) : value,
                ),
              ),
          };
        },
      };
    },
    async batch(statements: readonly { all(): Promise<unknown> }[]) {
      return await Promise.all(statements.map((statement) => statement.all()));
    },
  };
}

/** Enough of a binding surface to reach composition, and nothing more. */
function workerEnv(
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<typeof worker.fetch>[1] {
  return {
    PUBLIC_ORIGIN: ORIGIN,
    STATE_DB: d1(readyDatabase),
    OBJECTS: {
      put: () => null,
      get: () => null,
      head: () => null,
      delete: () => null,
      list: () => null,
    },
    WORKER_VERSION: { id: "00000000-0000-4000-8000-0000000000a1" },
    TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
    }),
    TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
    ...overrides,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function envelope(response: Response) {
  return (await response.json()) as {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly details?: { readonly reason?: string };
    };
  };
}

describe("Worker startup diagnostics", () => {
  test("the code-selected shared-login entry refuses foreign origins before opening a primary", async () => {
    let sessions = 0;
    const entry = createWorkerEntry({
      sharedAuthStaging: {
        kind: "shared-auth-staging-v1",
        clientSecret: "test-only-selected-entry-secret",
        encryptionKey: new Uint8Array(32).fill(7),
        principals: {
          async resolve(): Promise<never> {
            throw new Error("no test principal authority");
          },
        },
      },
    });
    const env = workerEnv({
      STATE_DB: {
        ...d1(readyDatabase),
        withSession() {
          sessions += 1;
          throw new Error("foreign origin opened a primary");
        },
      },
      PUBLIC_ORIGIN: "https://foreign-staging.example.test",
      TAKOSERVER_CONSOLE_ORIGIN: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY: "transaction-fenced-usd-micros-v1",
      TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: `sha256:${"b".repeat(64)}`,
    });
    const response = await entry.fetch(new Request(`${env.PUBLIC_ORIGIN}/auth/oidc/session`), env);
    expect(response.status).toBe(503);
    expect(sessions).toBe(0);
  });

  test("selected money Worker returns exact guarded 503 and refuses missing guards", async () => {
    const policy = "transaction-fenced-usd-micros-v1";
    const writerEpoch = `sha256:${"b".repeat(64)}`;
    const bare = databaseThrough(94);
    const files = readMigrationArtifact().files;
    const frozen = new Database(":memory:");
    const marker = `sha256:${"a".repeat(64)}`;
    const importSql = (phase: "freeze" | "prepare" | "convert") =>
      buildMoneyCutoverImportSql({
        phase,
        files,
        anchor: marker,
        originDigest: marker,
        backupDigest: marker,
        writerDigest: marker,
        writerEpoch,
        classifications: [],
      });
    try {
      frozen.exec(buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql);
      for (const phase of ["freeze", "prepare", "convert"] as const) frozen.exec(importSql(phase));
      const selected = workerEnv({
        STATE_DB: d1(frozen),
        TAKOSERVER_ENVIRONMENT: "integration",
        TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY: policy,
        TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: writerEpoch,
      });
      for (const path of ["/healthz", "/.well-known/takoserver"]) {
        const response = await worker.fetch(new Request(`${ORIGIN}${path}`), selected);
        expect(response.status).toBe(503);
        expect((await envelope(response)).error.details?.reason).toBe("money-cutover-freeze");
      }
      const revoked = await worker.fetch(new Request(`${ORIGIN}/healthz`), {
        ...selected,
        TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: `sha256:${"c".repeat(64)}`,
      });
      expect(revoked.status).toBe(503);
      expect((await envelope(revoked)).error.details?.reason).not.toBe("money-cutover-freeze");
      frozen.exec("DROP TRIGGER money_cutover_fence_stripe_events_update");
      const drift = await worker.fetch(new Request(`${ORIGIN}/healthz`), selected);
      expect(drift.status).toBe(503);
      expect((await envelope(drift)).error.details?.reason).not.toBe("money-cutover-freeze");
      const unguarded = await worker.fetch(
        new Request(`${ORIGIN}/healthz`),
        workerEnv({
          STATE_DB: d1(bare),
          TAKOSERVER_ENVIRONMENT: "integration",
          TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY: policy,
          TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: writerEpoch,
        }),
      );
      expect(unguarded.status).toBe(503);
      expect((await envelope(unguarded)).error.details?.reason).not.toBe("money-cutover-freeze");
    } finally {
      frozen.close();
      bare.close();
    }
  });

  test("normal serving refuses a configured Stripe mode that disagrees with the pinned realm", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/healthz`),
      workerEnv({ TAKOSERVER_STRIPE_MODE: "live" }),
    );
    expect(response.status).toBe(503);
    expect((await envelope(response)).error.details?.reason).toBe("runtime-configuration");
  });

  test("normal serving refuses a Stripe pin whose immutability trigger is missing", async () => {
    const database = databaseThrough(98);
    try {
      database.exec(
        "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at) VALUES (1, 'test', '2026-10-14T00:00:00.000Z')",
      );
      database.exec("DROP TRIGGER stripe_mode_realm_no_update");
      const response = await worker.fetch(
        new Request(`${ORIGIN}/healthz`),
        workerEnv({ STATE_DB: d1(database) }),
      );
      expect(response.status).toBe(503);
      expect((await envelope(response)).error.details?.reason).toBe("runtime-configuration");
    } finally {
      database.close();
    }
  });

  test("normal serving refuses an unqualified pre-realm D1 with no billing configuration", async () => {
    const oldDatabase = databaseThrough(92);
    try {
      const env = workerEnv({ STATE_DB: d1(oldDatabase) });
      const response = await worker.fetch(new Request(`${ORIGIN}/healthz`), env);
      expect(response.status).toBe(503);
      expect((await envelope(response)).error.details?.reason).toBe("runtime-configuration");
      await expect(worker.scheduled({}, env)).rejects.toThrow("0094 USD-micros D1 schema");
    } finally {
      oldDatabase.close();
    }
  });

  test("normal serving refuses a tampered USD-micros money-unit policy", async () => {
    const database = databaseThrough(98);
    try {
      database.exec(
        "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at) VALUES (1, 'test', '2026-10-14T00:00:00.000Z')",
      );
      database.exec("DROP TRIGGER money_unit_policy_no_delete");
      database.exec("DELETE FROM money_unit_policy");
      const response = await worker.fetch(
        new Request(`${ORIGIN}/healthz`),
        workerEnv({ STATE_DB: d1(database) }),
      );
      expect(response.status).toBe(503);
      expect((await envelope(response)).error.details?.reason).toBe("runtime-configuration");
    } finally {
      database.close();
    }
  });

  test("requires explicit v2 startup config before touching durable bindings", async () => {
    const env = workerEnv({ TAKOSERVER_TAKOFORM_V2_CONFIG: undefined });
    let storageReads = 0;
    Object.defineProperty(env, "STATE_DB", {
      get() {
        storageReads += 1;
        throw new Error("storage must not be composed");
      },
    });
    const response = await worker.fetch(new Request(`${ORIGIN}/.well-known/takoserver`), env);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("missing_configuration");
    expect(body).not.toContain("storage must not be composed");
    expect(storageReads).toBe(0);
  });

  test("rejects an invalid SQLiteMigrationSet source grant before touching Worker storage", async () => {
    const env = workerEnv({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
        sqliteMigrationSet: {
          targetKey: "operator-sqlite-primary",
          heldArtifacts: [
            {
              url: "https://artifacts.example.test/sqlite/manifest.json",
              sha256: "a".repeat(64),
              objectKey: "held/sqlite/manifest",
              grants: [],
            },
          ],
        },
      }),
    });
    let storageReads = 0;
    for (const name of ["STATE_DB", "OBJECTS"] as const) {
      Object.defineProperty(env, name, {
        get() {
          storageReads += 1;
          throw new Error("storage must not be composed");
        },
      });
    }

    const response = await worker.fetch(new Request(`${ORIGIN}/.well-known/takoserver`), env);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("runtime-configuration");
    expect(body).toContain("invalid_configuration");
    expect(body).not.toContain("storage must not be composed");
    expect(storageReads).toBe(0);
  });

  test("rejects an invalid WorkerBundle source grant before touching Worker storage", async () => {
    const env = workerEnv({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
        workerBundle: {
          targetKey: "operator-worker-bundle-target",
          heldArtifacts: [
            {
              url: "https://artifacts.example.test/worker/manifest.json",
              sha256: "a".repeat(64),
              objectKey: "held/worker/manifest",
              grants: [],
            },
          ],
        },
      }),
    });
    let storageReads = 0;
    for (const name of ["STATE_DB", "OBJECTS"] as const) {
      Object.defineProperty(env, name, {
        get() {
          storageReads += 1;
          throw new Error("storage must not be composed");
        },
      });
    }

    const response = await worker.fetch(new Request(`${ORIGIN}/.well-known/takoserver`), env);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("runtime-configuration");
    expect(body).toContain("invalid_configuration");
    expect(body).not.toContain("storage must not be composed");
    expect(storageReads).toBe(0);
  });

  test("rejects an invalid StaticAssetBundle source grant before touching Worker storage", async () => {
    const env = workerEnv({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
        staticAssetBundle: {
          targetKey: "operator-static-assets-target",
          heldArtifacts: [
            {
              url: "https://artifacts.example.test/assets/manifest.json",
              sha256: "a".repeat(64),
              objectKey: "held/assets/manifest",
              grants: [],
            },
          ],
        },
      }),
    });
    let storageReads = 0;
    for (const name of ["STATE_DB", "OBJECTS"] as const) {
      Object.defineProperty(env, name, {
        get() {
          storageReads += 1;
          throw new Error("storage must not be composed");
        },
      });
    }

    const response = await worker.fetch(new Request(`${ORIGIN}/.well-known/takoserver`), env);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("runtime-configuration");
    expect(body).toContain("invalid_configuration");
    expect(body).not.toContain("storage must not be composed");
    expect(storageReads).toBe(0);
  });

  test("selects unpublished Actor source only by exact opt-in and keeps absent supply non-sellable", async () => {
    const env = workerEnv({ TAKOSERVER_FORM_SOURCE_CANDIDATE: "actor-forward" });
    const discovery = await worker.fetch(new Request(`${ORIGIN}/.well-known/takoserver`), env);
    expect(discovery.status).toBe(200);
    const rejected = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/takoserver`),
      workerEnv({ TAKOSERVER_FORM_SOURCE_CANDIDATE: "actor" }),
    );
    expect(rejected.status).toBe(503);
    expect((await envelope(rejected)).error.details?.reason).toBe("runtime-configuration");
  });

  test("composes organization bootstrap only from exact integration identity and JIT closures", () => {
    const exact = {
      OPERATOR_IDENTITY_PUBLIC_JWK: JSON.stringify({
        kty: "OKP",
        crv: "Ed25519",
        x: "A".repeat(43),
      }),
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_SOURCE_COMMIT: "e".repeat(40),
      TAKOSERVER_WORKER_ARTIFACT_DIGEST: `sha256:${"f".repeat(64)}`,
      WORKER_VERSION: { id: "00000000-0000-4000-8000-0000000000a1" },
    } as const;
    const credentialAuthority: IntegrationE2eCredentialAuthorityConfig = {
      environment: "integration" as const,
      publicJwk: {
        kty: "OKP" as const,
        crv: "Ed25519" as const,
        x: "E".repeat(43),
      },
      organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
      sourceCommit: exact.TAKOSERVER_SOURCE_COMMIT,
      artifactDigest: exact.TAKOSERVER_WORKER_ARTIFACT_DIGEST as `sha256:${string}`,
      publicWorkerVersionId: exact.WORKER_VERSION.id,
    };
    expect(workerIntegrationOrganizationBootstrap(exact, ORIGIN, credentialAuthority)).toEqual({
      environment: "integration",
      hostId: ORIGIN,
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
      sourceCommit: "e".repeat(40),
      artifactDigest: `sha256:${"f".repeat(64)}`,
      publicWorkerVersionId: "00000000-0000-4000-8000-0000000000a1",
    });

    for (const incomplete of [
      { ...exact, OPERATOR_IDENTITY_PUBLIC_JWK: undefined },
      { ...exact, TAKOSERVER_SOURCE_COMMIT: undefined },
      { ...exact, TAKOSERVER_WORKER_ARTIFACT_DIGEST: "wrong" },
      { ...exact, WORKER_VERSION: { id: "wrong" } },
      { ...exact, TAKOSERVER_ENVIRONMENT: "production" },
      { ...exact, TAKOSERVER_ENVIRONMENT: "rehearsal" },
    ]) {
      expect(
        workerIntegrationOrganizationBootstrap(
          incomplete as Parameters<typeof workerIntegrationOrganizationBootstrap>[0],
          ORIGIN,
          credentialAuthority,
        ),
      ).toBeUndefined();
    }
    for (const unavailable of [
      undefined,
      { ...credentialAuthority, organizationId: "org_other" },
      { ...credentialAuthority, sourceCommit: "d".repeat(40) },
      { ...credentialAuthority, publicJwk: undefined },
      {
        ...credentialAuthority,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
      },
    ]) {
      expect(
        workerIntegrationOrganizationBootstrap(
          exact,
          ORIGIN,
          unavailable as Parameters<typeof workerIntegrationOrganizationBootstrap>[2],
        ),
      ).toBeUndefined();
    }
  });

  test("a JIT-enabled Host without Form authority serves discovery and OpenAPI", async () => {
    const signing = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jit = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey("jwk", jit.publicKey);
    const env = workerEnv({
      TAKOSERVER_SIGNING_KEY_ID: "startup-signing",
      TAKOSERVER_SIGNING_KEY: JSON.stringify(
        await crypto.subtle.exportKey("jwk", signing.privateKey),
      ),
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify({
        kty: "OKP",
        crv: "Ed25519",
        x: publicJwk.x,
      }),
      TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: INTEGRATION_E2E_ORGANIZATION_ID,
      TAKOSERVER_SOURCE_COMMIT: "e".repeat(40),
      TAKOSERVER_WORKER_ARTIFACT_DIGEST: `sha256:${"f".repeat(64)}`,
    });
    const discovery = await worker.fetch(new Request(`${ORIGIN}/.well-known/takoserver`), env);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      product: "takoserver",
      apiVersion: "v1",
      endpoints: { api: ORIGIN, openapi: `${ORIGIN}/openapi.json` },
    });
    const openapi = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
    expect(openapi.status).toBe(200);
    expect(await openapi.json()).toMatchObject({ servers: [{ url: ORIGIN }] });
    expect(resolvePublicWorkerImplementationIdentity(env)).toBeUndefined();

    let storageReads = 0;
    const incomplete = {
      ...env,
      TAKOSERVER_SOURCE_COMMIT: undefined,
      get STATE_DB(): never {
        storageReads += 1;
        throw new Error("invalid JIT must refuse before storage");
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    const refused = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), incomplete);
    expect(refused.status).toBe(503);
    expect((await envelope(refused)).error.message).toBe(
      "integration E2E credential authority configuration is incomplete",
    );
    expect(storageReads).toBe(0);
  });

  test("the pre-0043 compatibility mode blocks all traffic before storage composition", async () => {
    const env = {
      PUBLIC_ORIGIN: ORIGIN,
      TAKOSERVER_ARTIFACT_BLOB_IO_MODE: "pre-0043-quiesced",
    } as Parameters<typeof worker.fetch>[1];
    const digest = `sha256:${"a".repeat(64)}`;
    for (const [method, path] of [
      ["GET", "/healthz"],
      ["POST", "/apis/forms.takoform.com/v1/artifacts/uploads"],
      ["PUT", `/apis/forms.takoform.com/v1/artifacts/uploads/up_old/blobs/${digest}`],
      ["POST", "/apis/forms.takoform.com/v1/artifacts/uploads/up_old/commit"],
      ["DELETE", "/apis/forms.takoform.com/v1/artifacts/uploads/up_old"],
    ] as const) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method }), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("60");
      const body = await envelope(response);
      expect(body.error.code).toBe("backend_unavailable");
      expect(body.error.details?.reason).toBe("runtime-configuration");
      expect(body.error.message).toContain("artifact blob I/O is quiesced");
    }
  });

  test("the pre-0043 compatibility mode suppresses scheduled artifact collection before composition", async () => {
    await expect(
      worker.scheduled({}, {
        TAKOSERVER_ARTIFACT_BLOB_IO_MODE: "pre-0043-quiesced",
      } as Parameters<typeof worker.scheduled>[1]),
    ).resolves.toBeUndefined();
  });

  test("the pre-0058 schema maintenance mode blocks every route and scheduled work before composition", async () => {
    const env = {
      TAKOSERVER_SCHEMA_MAINTENANCE_MODE: "pre-0058-quiesced",
      get STATE_DB(): never {
        throw new Error("maintenance read storage");
      },
      get PUBLIC_ORIGIN(): never {
        throw new Error("maintenance read origin");
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    for (const [method, path] of [
      ["GET", "/healthz"],
      ["GET", "/.well-known/takoserver"],
      ["POST", "/v1/resources"],
      ["PUT", "/anything"],
      ["DELETE", "/anything"],
    ] as const) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method }), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("60");
      const body = await envelope(response);
      expect(body.error.code).toBe("backend_unavailable");
      expect(body.error.details?.reason).toBe("runtime-configuration");
      expect(body.error.message).toContain("0058");
    }
    await expect(worker.scheduled({}, env)).resolves.toBeUndefined();
  });

  test("the pre-v2-0088 maintenance mode blocks HTTP and scheduled work before v2 composition", async () => {
    const env = {
      TAKOSERVER_SCHEMA_MAINTENANCE_MODE: "pre-v2-0088-quiesced",
      get STATE_DB(): never {
        throw new Error("maintenance read storage");
      },
      get TAKOSERVER_TAKOFORM_V2_CONFIG(): never {
        throw new Error("maintenance read v2 config");
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    const response = await worker.fetch(new Request(`${ORIGIN}/healthz`), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await envelope(response)).error.message).toContain("0088");
    await expect(worker.scheduled({}, env)).resolves.toBeUndefined();
  });

  test("wallet unit maintenance closes payment/deploy/webhook admission and every scheduled money pass", async () => {
    let compositions = 0;
    let lifetimes = 0;
    const env = {
      TAKOSERVER_SCHEMA_MAINTENANCE_MODE: "pre-wallet-usd-micros-quiesced",
      get STATE_DB(): never {
        compositions++;
        throw new Error("money maintenance reached storage");
      },
      get STRIPE_SECRET_KEY(): never {
        compositions++;
        throw new Error("money maintenance reached payment credentials");
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    for (const path of [
      "/v1/resources",
      "/v1/organizations/org/wallet/holds",
      "/v1/payments/checkout",
      "/v1/stripe/webhook",
      "/healthz",
    ]) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}${path}`, { method: "POST" }),
        env,
        {
          waitUntil() {
            lifetimes++;
          },
        },
      );
      expect(response.status).toBe(503);
      expect((await envelope(response)).error.message).toContain("wallet USD-micros");
    }
    await worker.scheduled({}, env);
    expect(compositions).toBe(0);
    expect(lifetimes).toBe(0);
  });

  test("invalid or conflicting maintenance selectors refuse before composition", async () => {
    for (const selected of ["", "pre-0058", "PRE-0058-QUIESCED", null, 7]) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}/healthz`),
        workerEnv({ TAKOSERVER_SCHEMA_MAINTENANCE_MODE: selected }),
      );
      expect(response.status).toBe(503);
      expect((await envelope(response)).error.details?.reason).toBe("runtime-configuration");
      await expect(
        worker.scheduled({}, workerEnv({ TAKOSERVER_SCHEMA_MAINTENANCE_MODE: selected })),
      ).rejects.toThrow();
    }
    const both = workerEnv({
      TAKOSERVER_SCHEMA_MAINTENANCE_MODE: "pre-0058-quiesced",
      TAKOSERVER_ARTIFACT_BLOB_IO_MODE: "pre-0043-quiesced",
    });
    const response = await worker.fetch(new Request(`${ORIGIN}/healthz`), both);
    expect(response.status).toBe(503);
    expect((await envelope(response)).error.message).toContain("conflict");
    await expect(worker.scheduled({}, both)).rejects.toThrow();
  });

  test("an unknown artifact blob I/O mode fails closed as runtime configuration", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/healthz`),
      workerEnv({ TAKOSERVER_ARTIFACT_BLOB_IO_MODE: "typo" }),
    );
    expect(response.status).toBe(503);
    expect((await envelope(response)).error.details?.reason).toBe("runtime-configuration");
  });

  test("answers a composition refusal with its reason class, not a bare exception", async () => {
    // The live incident: one Cloudflare SupplyContract declared twice, the edge
    // half without `storage.object`. Composition is lazy and per request, so
    // the Worker went live and then threw on every route.
    const env = workerEnv({
      CLOUDFLARE_PROVIDER_EXECUTOR: {},
      TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
      TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(edgeSuppliesFixture(EDGE_ONLY_RESOURCE_CLASSES)),
      TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectBucketSuppliesFixture()),
    });

    for (const path of ["/healthz", "/.well-known/takoserver"]) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await envelope(response);
      expect(body.error.code).toBe("backend_unavailable");
      expect(body.error.details?.reason).toBe("supply-composition");
      expect(body.error.message).toBe("Cloudflare supply contract is ambiguous");
    }
  });

  test("classifies a missing public origin without echoing the request host", async () => {
    const response = await worker.fetch(
      new Request("https://alias.takoserver.com/openapi.json"),
      {} as Parameters<typeof worker.fetch>[1],
    );

    expect(response.status).toBe(503);
    const body = await envelope(response);
    expect(body.error.details?.reason).toBe("public-origin");
    expect(body.error.message).toContain("PUBLIC_ORIGIN");
    expect(JSON.stringify(body)).not.toContain("alias.takoserver.com");
  });

  test("classifies a configuration refusal without publishing an unreadable failure", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/healthz`), {
      PUBLIC_ORIGIN: ORIGIN,
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
    } as Parameters<typeof worker.fetch>[1]);

    expect(response.status).toBe(503);
    const body = await envelope(response);
    expect(body.error.details?.reason).toBe("runtime-configuration");
    expect(body.error.message).toBe("a D1 database binding is required");
  });
});
