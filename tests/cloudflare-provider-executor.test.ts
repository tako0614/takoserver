import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import type { ProviderMeterDeployment } from "../src/provider-meter-port.ts";
import type {
  ApplyInput,
  Provider,
  ProviderExecutionAuthority,
  ProviderNativeReadbackInput,
  ProviderOffering,
  ProviderSqliteMigration,
  ProviderTicket,
} from "../src/provider-port.ts";
import { derivedProviderResourceIncarnationName } from "../src/provider-worker-endpoint-origin.ts";
import { CloudflareProvider } from "../src/providers/cloudflare.ts";
import { CLOUDFLARE_PROVIDER_METER_SOURCES } from "../src/providers/cloudflare-edge-meter-contract.ts";
import {
  type CloudflareProviderExecutorRpc,
  createCloudflareProviderExecutor,
  isCloudflareProviderArtifactConsumption,
} from "../src/providers/cloudflare-provider-executor-rpc.ts";
import {
  CloudflareProviderProxy,
  createCloudflareProviderMeterProxySources,
} from "../src/providers/cloudflare-provider-proxy.ts";
import {
  cloudflareExecutorDirectOwnsOffering,
  cloudflareWfpOwnsOffering,
} from "../src/providers/cloudflare-readback-descriptor.ts";
import type { CloudflareManagedObjectReceiptAuthority } from "../src/providers/cloudflare-worker-backend.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

mock.module("cloudflare:workers", () => ({
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

const { createCloudflareProviderExecutorFromEnv } = (await import(
  "../src/entry-cloudflare-provider-executor.ts"
)) as typeof import("../src/entry-cloudflare-provider-executor.ts");
type CloudflareProviderExecutorEnvironment = Parameters<
  typeof createCloudflareProviderExecutorFromEnv
>[0];

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;

function offering(kind: string, formKind = kind): ProviderOffering {
  return {
    id: `cloudflare.test.${formKind.toLowerCase()}`,
    kind,
    displayName: formKind,
    form: {
      apiVersion: "edge.forms.takoform.com",
      kind: formKind,
      definitionVersion: "1.0.0",
      schemaDigest: DIGEST,
    },
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "update", "delete", "observe"],
  };
}

const MODULE_WORKER = offering("takoform.ModuleWorker", "ModuleWorker");
const VERSION = offering("takoform.WorkerVersion", "WorkerVersion");
const SQLITE_DATABASE = offering("takoform.SQLiteDatabase", "SQLiteDatabase");
const OBJECT_BUCKET: ProviderOffering = {
  ...offering("object_bucket", "ObjectBucket"),
  capabilities: ["create", "delete", "import", "observe"],
};
const IDENTITY = {
  tenantRef: "tenant-a",
  space: "main",
  name: "worker",
  uid: "resource-worker",
  incarnationId: "deployment-worker",
  generation: "1",
};
const SUCCEEDED: ProviderTicket = {
  phase: "succeeded",
  result: { nativeId: "worker:managed-worker", observed: {}, outputs: {} },
};

function compositionEnvironment(
  environment: string | undefined,
): CloudflareProviderExecutorEnvironment {
  const statement = {
    bind(..._values: readonly unknown[]) {
      return statement;
    },
    async all() {
      return { results: [], meta: { changes: 0 } };
    },
  };
  const stateDb = {
    prepare() {
      return statement;
    },
    async batch() {
      return [];
    },
  };
  const objects = {
    async put() {
      return { key: "object", size: 0, etag: "etag" };
    },
    async get() {
      return null;
    },
    async head() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
  };
  return {
    STATE_DB: stateDb,
    OBJECTS: objects,
    DISPATCHER: {},
    MANAGED_WORKER_AUTHORITY: {},
    SQLITE_DATABASES: {},
    MANAGED_OBJECT_RECEIPT_AUTHORITY: {},
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "token",
    ...(environment === undefined ? {} : { TAKOSERVER_ENVIRONMENT: environment }),
    TAKOSERVER_ZONES: "[]",
    TAKOSERVER_CLOUDFLARE_DISPATCH_NAMESPACE: "takoserver-customers-staging",
    TAKOSERVER_MANAGED_WORKER_GATEWAY_NAME: "takoserver-gateway-staging",
    TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
    TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID: "cloudflare.staging",
    TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_NAME: "takoserver-receipts-staging",
    TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: "{}",
    PUBLIC_ORIGIN: "https://api.example.test",
    TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(edgeSuppliesFixture()),
    TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectBucketSuppliesFixture()),
  } as unknown as CloudflareProviderExecutorEnvironment;
}

test("Cloudflare provider executor composition gates qualification on the exact environment", async () => {
  for (const environment of ["rehearsal", "production"]) {
    await expect(
      createCloudflareProviderExecutorFromEnv(compositionEnvironment(environment)),
    ).rejects.toThrow("releaseReadbackQualification");
  }
  await expect(
    createCloudflareProviderExecutorFromEnv(compositionEnvironment("staging")),
  ).rejects.toThrow("environment is invalid");
  await expect(
    createCloudflareProviderExecutorFromEnv(compositionEnvironment(undefined)),
  ).rejects.toThrow("environment is invalid");
});

const artifacts = {
  async manifest() {
    return null;
  },
  async blob() {
    return null;
  },
};

const sql: Sql = {
  async query() {
    return [];
  },
  async run() {
    return { rows: [], changes: 0 };
  },
  async batch() {
    return [];
  },
};

function managedProvider(offerings: readonly ProviderOffering[]): CloudflareProvider {
  return new CloudflareProvider({
    accountId: "account-a",
    offerings,
    artifacts,
    authorize: () => "Bearer parent-secret",
    workerBackend: {
      kind: "workers-for-platforms",
      dispatchNamespace: "dispatch-a",
      gatewayWorkerName: "gateway-a",
      providerInstallationId: "cloudflare.primary",
      managedBaseDomain: "workers.example.test",
      sql,
      inspectRelease: async (input) => ({
        ok: true,
        ...input,
        handlers: input.declaredHandlers,
      }),
      deriveSqliteInstanceName: async () => "sqlite-instance",
      sealSqliteAdminProof: async () => "proof",
      sqliteNamespace: {
        getByName() {
          throw new Error("unused");
        },
      },
    },
  });
}

const unavailableReceiptAuthority: CloudflareManagedObjectReceiptAuthority = {
  async takoserverObjectReceiptRuntimeBinding() {
    return { ok: false, error: { code: "not_found" } };
  },
  async takoserverObjectReceiptInspect() {
    return { ok: false, error: { code: "not_found" } };
  },
  async takoserverObjectReceiptPrepareDestroy() {
    return { ok: false, error: { code: "not_found" } };
  },
  async takoserverObjectReceiptCommitDestroy() {
    return { ok: false, error: { code: "not_found" } };
  },
};

function managedObjectProvider(fetch: (request: Request) => Promise<Response>): CloudflareProvider {
  return new CloudflareProvider({
    accountId: "account-a",
    offerings: [OBJECT_BUCKET],
    artifacts,
    authorize: () => "Bearer parent-secret",
    fetch,
    workerBackend: {
      kind: "workers-for-platforms",
      dispatchNamespace: "dispatch-a",
      gatewayWorkerName: "gateway-a",
      providerInstallationId: "cloudflare.primary",
      managedBaseDomain: "workers.example.test",
      sql,
      inspectRelease: async (input) => ({
        ok: true,
        ...input,
        handlers: input.declaredHandlers,
      }),
      deriveSqliteInstanceName: async () => "sqlite-instance",
      sealSqliteAdminProof: async () => "proof",
      sqliteNamespace: {
        getByName() {
          throw new Error("unused");
        },
      },
      objectReceiptWorkerName: "receipt-a",
      objectReceiptAuthority: unavailableReceiptAuthority,
    },
  });
}

describe("credential-free Cloudflare provider proxy", () => {
  test("requires explicit nonempty sorted artifact-consumption RPC output", async () => {
    expect(
      isCloudflareProviderArtifactConsumption({
        outcome: "present",
        consumption: "none",
        evidence: {},
      }),
    ).toBe(true);
    expect(
      isCloudflareProviderArtifactConsumption({
        outcome: "present",
        consumption: "identified",
        manifestDigests: [DIGEST, DIGEST_B],
        evidence: {},
      }),
    ).toBe(true);
    for (const malformed of [
      { outcome: "present", manifestDigests: [DIGEST], evidence: {} },
      { outcome: "present", consumption: "identified", manifestDigests: [], evidence: {} },
      {
        outcome: "present",
        consumption: "identified",
        manifestDigests: [DIGEST, DIGEST],
        evidence: {},
      },
      {
        outcome: "present",
        consumption: "identified",
        manifestDigests: [DIGEST_B, DIGEST],
        evidence: {},
      },
      {
        outcome: "present",
        consumption: "none",
        manifestDigests: [DIGEST],
        evidence: {},
      },
    ]) {
      expect(isCloudflareProviderArtifactConsumption(malformed)).toBe(false);
    }

    const proxy = new CloudflareProviderProxy({
      offerings: [MODULE_WORKER],
      managedBaseDomain: "workers.example.test",
      runtimeInputs: true,
      binding: {
        async verifyArtifactConsumption() {
          return { outcome: "present", manifestDigests: [DIGEST], evidence: {} };
        },
      } as never,
    });
    expect(await proxy.verifyArtifactConsumption?.({} as never)).toEqual({
      outcome: "unknown",
      reason: "malformed",
      retryable: false,
    });
  });

  test("keeps direct parent APIs on a closed non-Worker offering allowlist", () => {
    const kv = offering("takoform.EdgeKVNamespace", "EdgeKVNamespace");
    const queue = offering("takoform.AtLeastOnceQueue", "AtLeastOnceQueue");
    const unknown = offering("takoform.UnknownCloudThing", "UnknownCloudThing");

    expect([MODULE_WORKER, VERSION, SQLITE_DATABASE].every(cloudflareWfpOwnsOffering)).toBe(true);
    expect([kv, queue, OBJECT_BUCKET].every(cloudflareExecutorDirectOwnsOffering)).toBe(true);
    expect(cloudflareExecutorDirectOwnsOffering(MODULE_WORKER)).toBe(false);
    expect(cloudflareExecutorDirectOwnsOffering(unknown)).toBe(false);
  });

  test("keeps synchronous descriptor construction byte-for-byte equal to the real WfP provider", () => {
    const executorProvider = managedProvider([VERSION]);
    const proxy = new CloudflareProviderProxy({
      offerings: [VERSION],
      managedBaseDomain: "workers.example.test",
      runtimeInputs: true,
      binding: {} as CloudflareProviderExecutorRpc,
    });
    const input: ProviderNativeReadbackInput = {
      offering: VERSION,
      nativeId: "version:managed-worker:version-one",
      identity: IDENTITY,
    };

    const actual = proxy.createNativeReadbackDescriptor(input);
    expect(actual).not.toBeInstanceOf(Promise);
    expect(actual).toEqual(executorProvider.createNativeReadbackDescriptor(input));
    expect(actual).toEqual({
      apiVersion: "providers.takoserver.com/readback/v1",
      provider: "cloudflare",
      kind: "WorkerVersion",
      nativeId: "version:managed-worker:version-one",
      data: { resourceUid: "resource-worker" },
    });
  });

  test("maps only the typed RPC operations and derives endpoints without provider credentials", async () => {
    const calls: string[] = [];
    let sqliteRpcInput: unknown;
    const binding = {
      async apply() {
        calls.push("apply");
        return SUCCEEDED;
      },
      async recoverApply() {
        calls.push("recoverApply");
        return SUCCEEDED;
      },
      async convergeApply() {
        calls.push("convergeApply");
        return SUCCEEDED;
      },
      async poll() {
        calls.push("poll");
        return SUCCEEDED;
      },
      async observe() {
        calls.push("observe");
        return SUCCEEDED;
      },
      async delete() {
        calls.push("delete");
        return SUCCEEDED;
      },
      async recoverDelete() {
        calls.push("recoverDelete");
        return SUCCEEDED;
      },
      async adopt() {
        calls.push("adopt");
        return SUCCEEDED;
      },
      async recoverAdopt() {
        calls.push("recoverAdopt");
        return SUCCEEDED;
      },
      async verifyNativeAbsence() {
        calls.push("verifyNativeAbsence");
        return { outcome: "absent", evidence: {} } as const;
      },
      async verifyArtifactConsumption() {
        calls.push("verifyArtifactConsumption");
        return {
          outcome: "present",
          consumption: "identified",
          manifestDigests: [DIGEST],
          evidence: {},
        } as const;
      },
      async readSqliteMigrationLedger() {
        calls.push("readSqliteMigrationLedger");
        return { ok: true, value: [] } as const;
      },
      async applySqliteMigrationSuffix(input) {
        calls.push("applySqliteMigrationSuffix");
        sqliteRpcInput = input;
        return { ok: false, failure: deniedFailure() } as const;
      },
      async readMeterUsage() {
        calls.push("readMeterUsage");
        return {
          ok: true,
          value: [{ meter: "compute.worker.requests.million", quantity: 0.25 }],
        } as const;
      },
    } satisfies CloudflareProviderExecutorRpc;
    const proxy = new CloudflareProviderProxy({
      offerings: [MODULE_WORKER],
      recoveryOfferings: [VERSION],
      managedBaseDomain: "workers.example.test",
      runtimeInputs: true,
      binding,
    });
    const apply: ApplyInput = {
      operationId: "operation-apply",
      operationMode: "initial",
      offering: MODULE_WORKER,
      identity: IDENTITY,
      spec: {},
    };

    expect(proxy.id).toBe("cloudflare");
    expect(proxy.runtimeInputCapabilities).toEqual({ maximumBindings: 64 });
    expect(
      await proxy.workerEndpointOriginReservations.derive({
        tenantRef: "tenant-a",
        requestedSubdomain: "hello",
      }),
    ).toEqual({ canonicalPublicOrigin: "https://hello.workers.example.test" });
    expect(
      await proxy.workerEndpointOriginReservations.hostMintedSubdomain?.({
        tenantRef: "tenant-a",
        space: "main",
        workerName: "worker",
      }),
    ).toBeNull();

    await proxy.apply(apply);
    await proxy.recoverApply?.({ ...apply, operationMode: "recovery" });
    await proxy.convergeApply?.({ ...apply, operationMode: "recovery" });
    await proxy.poll?.({ operationId: apply.operationId, handle: "handle-a" });
    await proxy.observe({
      offering: MODULE_WORKER,
      nativeId: "worker:a",
      identity: IDENTITY,
      spec: {},
    });
    await proxy.delete({ ...apply, nativeId: "worker:a" });
    await proxy.recoverDelete?.({ ...apply, nativeId: "worker:a", operationMode: "recovery" });
    await proxy.adopt?.({ ...apply, nativeId: "worker:a" });
    await proxy.recoverAdopt?.({
      ...apply,
      nativeId: "worker:a",
      operationMode: "recovery",
    });
    await proxy.verifyNativeAbsence?.({
      offering: MODULE_WORKER,
      descriptor: proxy.createNativeReadbackDescriptor({
        offering: MODULE_WORKER,
        nativeId: "worker:a",
        identity: IDENTITY,
      }),
      target: {
        tenantId: IDENTITY.tenantRef,
        resourceUid: IDENTITY.uid,
        incarnationId: IDENTITY.incarnationId,
        generation: IDENTITY.generation,
      },
    });
    await proxy.verifyArtifactConsumption?.({
      offering: MODULE_WORKER,
      nativeId: "worker:a",
      target: {
        tenantId: "tenant-a",
        resourceUid: "resource-worker",
        incarnationId: "deployment-worker",
        state: "active",
        updatedAt: 500,
      },
      identity: {
        tenantRef: "tenant-a",
        resourceUid: "resource-worker",
        address: { space: "main", name: "worker" },
      },
      candidateManifestDigests: [DIGEST],
      currentResource: {
        revision: "1",
        relationsDigest: DIGEST,
        providerOperationIds: ["operation-apply"],
      },
    });
    await proxy.sqliteMigrations?.readLedger({
      nativeId: "d1:database-a",
      target: {
        tenantId: "tenant-a",
        resourceUid: "resource-database",
        incarnationId: "deployment-database",
        generation: "1",
      },
    });
    await proxy.sqliteMigrations?.applySuffix({
      operationId: "operation-sqlite",
      operationMode: "initial",
      executionAuthority: {
        tenantId: "tenant-a",
        resourceUid: "resource-application",
        leaseToken: "lease-sqlite",
        fingerprint: "{}",
      },
      nativeId: "d1:database-a",
      target: {
        resourceUid: "resource-database",
        incarnationId: "deployment-database",
        generation: "1",
      },
      desired: [{ path: "0001.sql", digest: DIGEST, sql: new Uint8Array([1]) }],
      expectedPrefix: [],
      migrations: [{ path: "0001.sql", digest: DIGEST, sql: new Uint8Array([1]) }],
    });
    const meterSources = createCloudflareProviderMeterProxySources({
      offerings: [MODULE_WORKER],
      binding,
    });
    const meterDeployment: ProviderMeterDeployment = {
      tenantId: "tenant-a",
      id: "deployment-worker",
      resourceUid: "resource-worker",
      offeringId: MODULE_WORKER.id,
      providerPackRef: "cloudflare",
      providerInstallationRef: "cloudflare.primary",
      nativeId: "worker:a",
      createdAt: "2026-09-04T00:00:00.000Z",
    };
    expect(
      await meterSources[0]?.read({
        tenantId: "tenant-a",
        deployment: meterDeployment,
        from: "2026-09-04T00:00:00.000Z",
        until: "2026-09-04T00:15:00.000Z",
      }),
    ).toEqual([{ meter: "compute.worker.requests.million", quantity: 0.25 }]);

    expect(calls).toEqual([
      "apply",
      "recoverApply",
      "convergeApply",
      "poll",
      "observe",
      "delete",
      "recoverDelete",
      "adopt",
      "recoverAdopt",
      "verifyNativeAbsence",
      "verifyArtifactConsumption",
      "readSqliteMigrationLedger",
      "applySqliteMigrationSuffix",
      "readMeterUsage",
    ]);
    expect(sqliteRpcInput).toMatchObject({
      desired: [{ path: "0001.sql", digest: DIGEST }],
      migrations: [{ path: "0001.sql", digest: DIGEST }],
    });
    expect(JSON.stringify(sqliteRpcInput)).not.toContain('"sql":');
  });
});

describe("Cloudflare provider executor authority fence", () => {
  test("rejects read and mutation operations without exact durable Host authority", async () => {
    let mutations = 0;
    let observations = 0;
    const provider = {
      id: "cloudflare",
      offerings: [MODULE_WORKER],
      async apply() {
        mutations += 1;
        return SUCCEEDED;
      },
      async convergeApply() {
        mutations += 1;
        return SUCCEEDED;
      },
      async poll() {
        mutations += 1;
        return SUCCEEDED;
      },
      async observe() {
        observations += 1;
        return SUCCEEDED;
      },
      async delete() {
        mutations += 1;
        return SUCCEEDED;
      },
      async recoverDelete() {
        mutations += 1;
        return SUCCEEDED;
      },
      async adopt() {
        mutations += 1;
        return SUCCEEDED;
      },
      async recoverAdopt() {
        mutations += 1;
        return SUCCEEDED;
      },
    } satisfies Provider;
    const executor = createCloudflareProviderExecutor({
      provider: async () => provider,
      sql,
      providerInstallationId: "cloudflare.primary",
    });
    const input: ApplyInput = {
      operationId: "operation-missing-saga",
      operationMode: "initial",
      offering: MODULE_WORKER,
      identity: IDENTITY,
      spec: {},
    };

    expect(await executor.apply(input)).toEqual({ phase: "failed", failure: deniedFailure() });
    expect(await executor.convergeApply({ ...input, operationMode: "recovery" })).toEqual({
      phase: "failed",
      failure: deniedFailure(),
    });
    expect(await executor.poll({ operationId: input.operationId, handle: "handle-a" })).toEqual({
      phase: "failed",
      failure: deniedFailure(),
    });
    expect(await executor.delete({ ...input, nativeId: "worker:a" })).toEqual({
      phase: "failed",
      failure: deniedFailure(),
    });
    expect(
      await executor.recoverDelete({
        ...input,
        nativeId: "worker:a",
        operationMode: "recovery",
      }),
    ).toEqual({ phase: "failed", failure: deniedFailure() });
    expect(await executor.adopt({ ...input, nativeId: "worker:a" })).toEqual({
      phase: "failed",
      failure: deniedFailure(),
    });
    expect(
      await executor.recoverAdopt({
        ...input,
        nativeId: "worker:a",
        operationMode: "recovery",
      }),
    ).toEqual({ phase: "failed", failure: deniedFailure() });
    expect(mutations).toBe(0);

    expect(
      await executor.observe({
        offering: MODULE_WORKER,
        nativeId: "worker:a",
        identity: IDENTITY,
        spec: {},
      }),
    ).toEqual({ phase: "failed", failure: deniedFailure() });
    expect(observations).toBe(0);
  });

  test("authorizes observe and SQLite ledger reads only for one exact active deployment", async () => {
    const database = migratedDatabase();
    try {
      seedResource(database, {
        uid: "resource-worker",
        kind: "ModuleWorker",
        name: "worker",
        generation: "1",
      });
      seedDeployment(database, {
        id: "deployment-worker",
        resourceUid: "resource-worker",
        offeringId: MODULE_WORKER.id,
        nativeId: "worker:a",
      });
      seedResource(database, {
        uid: "resource-database",
        kind: "SQLiteDatabase",
        name: "database",
        generation: "7",
      });
      seedDeployment(database, {
        id: "deployment-database",
        resourceUid: "resource-database",
        offeringId: SQLITE_DATABASE.id,
        nativeId: "sqlite:database-native",
      });
      let observations = 0;
      let ledgerReads = 0;
      const provider = providerStub({
        offerings: [MODULE_WORKER, SQLITE_DATABASE],
        async observe() {
          observations += 1;
          return SUCCEEDED;
        },
        sqliteMigrations: {
          async readLedger() {
            ledgerReads += 1;
            return { ok: true, value: [] };
          },
          async applySuffix() {
            return { ok: true, value: undefined };
          },
        },
      });
      const executor = createCloudflareProviderExecutor({
        provider: async () => provider,
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
      });

      expect(
        await executor.observe({
          offering: MODULE_WORKER,
          nativeId: "worker:a",
          identity: IDENTITY,
          spec: {},
        }),
      ).toBe(SUCCEEDED);
      expect(
        await executor.observe({
          offering: MODULE_WORKER,
          nativeId: "worker:other",
          identity: IDENTITY,
          spec: {},
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(observations).toBe(1);

      const read = {
        nativeId: "sqlite:database-native",
        target: {
          tenantId: "tenant-a",
          resourceUid: "resource-database",
          incarnationId: "deployment-database",
          generation: "7",
        },
      } as const;
      expect(await executor.readSqliteMigrationLedger(read)).toEqual({ ok: true, value: [] });
      expect(
        await executor.readSqliteMigrationLedger({
          ...read,
          target: { ...read.target, generation: "8" },
        }),
      ).toEqual({ ok: false, failure: deniedFailure() });
      expect(ledgerReads).toBe(1);
    } finally {
      database.close();
    }
  });

  test("meters only the exact active installation, Offering, source, and Deployment", async () => {
    const database = migratedDatabase();
    try {
      seedResource(database, {
        uid: "resource-worker",
        kind: "ModuleWorker",
        name: "worker",
        generation: "1",
      });
      seedDeployment(database, {
        id: "deployment-worker",
        resourceUid: "resource-worker",
        offeringId: MODULE_WORKER.id,
        nativeId: "worker:a",
      });
      let reads = 0;
      const source = {
        ...CLOUDFLARE_PROVIDER_METER_SOURCES.worker,
        async read() {
          reads += 1;
          return [{ meter: "compute.worker.requests.million", quantity: 0.5 }];
        },
      };
      const executor = createCloudflareProviderExecutor({
        provider: async () => providerStub({ offerings: [MODULE_WORKER] }),
        meterSources: [source],
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
      });
      const deployment: ProviderMeterDeployment = {
        tenantId: "tenant-a",
        id: "deployment-worker",
        resourceUid: "resource-worker",
        offeringId: MODULE_WORKER.id,
        providerPackRef: "cloudflare",
        providerInstallationRef: "cloudflare.primary",
        nativeId: "worker:a",
        createdAt: "1970-01-01T00:00:00.500Z",
      };
      const input = {
        meterSourceId: source.id,
        meters: source.meters,
        offering: MODULE_WORKER,
        tenantId: "tenant-a",
        deployment,
        from: "2026-09-04T00:00:00.000Z",
        until: "2026-09-04T00:15:00.000Z",
      } as const;

      for (const stale of [
        { ...input, meterSourceId: "cloudflare-kv-analytics" },
        { ...input, meters: ["storage.kv.operations.million"] },
        {
          ...input,
          deployment: { ...deployment, providerInstallationRef: "cloudflare.other" },
        },
        { ...input, deployment: { ...deployment, id: "deployment-stale" } },
        { ...input, deployment: { ...deployment, nativeId: "worker:other" } },
      ]) {
        expect(await executor.readMeterUsage(stale)).toEqual({
          ok: false,
          error: { code: "upstream_invalid" },
        });
      }
      expect(reads).toBe(0);
      expect(await executor.readMeterUsage(input)).toEqual({
        ok: true,
        value: [{ meter: "compute.worker.requests.million", quantity: 0.5 }],
      });
      expect(reads).toBe(1);
    } finally {
      database.close();
    }
  });

  test("attributes artifacts only for the exact recorded Cloudflare Deployment custody", async () => {
    const database = migratedDatabase();
    try {
      seedResource(database, {
        uid: "resource-worker",
        kind: "ModuleWorker",
        name: "worker",
        generation: "1",
      });
      seedDeployment(database, {
        id: "deployment-worker",
        resourceUid: "resource-worker",
        offeringId: MODULE_WORKER.id,
        nativeId: "worker:a",
        outputs: {
          __takoserver: {
            resourceUid: "resource-worker",
            space: "main",
            name: "worker",
            generation: "1",
          },
        },
      });
      let reads = 0;
      const provider = providerStub({
        async verifyArtifactConsumption() {
          reads += 1;
          return {
            outcome: "present",
            consumption: "identified",
            manifestDigests: [DIGEST],
            evidence: {},
          };
        },
      });
      const options = {
        provider: async () => provider,
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
      } as const;
      const executor = createCloudflareProviderExecutor(options);
      const input = {
        offering: MODULE_WORKER,
        nativeId: "worker:a",
        target: {
          tenantId: "tenant-a",
          resourceUid: "resource-worker",
          incarnationId: "deployment-worker",
          state: "active" as const,
          updatedAt: 500,
        },
        identity: {
          tenantRef: "tenant-a",
          resourceUid: "resource-worker",
          address: { space: "main", name: "worker" },
        },
        candidateManifestDigests: [DIGEST],
        currentResource: {
          revision: "1",
          relationsDigest: DIGEST,
          providerOperationIds: ["operation-apply"],
        },
      } as const;

      for (const stale of [
        { ...input, nativeId: "worker:other" },
        { ...input, target: { ...input.target, tenantId: "tenant-b" } },
        { ...input, target: { ...input.target, incarnationId: "deployment-stale" } },
        { ...input, target: { ...input.target, updatedAt: 499 } },
      ]) {
        expect(await executor.verifyArtifactConsumption(stale)).toEqual({
          outcome: "unknown",
          reason: "authority_unavailable",
          retryable: false,
        });
      }
      expect(
        await createCloudflareProviderExecutor({
          ...options,
          providerInstallationId: "cloudflare.other",
        }).verifyArtifactConsumption(input),
      ).toEqual({
        outcome: "unknown",
        reason: "authority_unavailable",
        retryable: false,
      });
      expect(reads).toBe(0);
      expect(await executor.verifyArtifactConsumption(input)).toEqual({
        outcome: "present",
        consumption: "identified",
        manifestDigests: [DIGEST],
        evidence: {},
      });
      expect(reads).toBe(1);
    } finally {
      database.close();
    }
  });

  test("authorizes native absence readback only from exact closed tombstone custody", async () => {
    const database = migratedDatabase();
    try {
      seedDeployment(database, {
        id: "deployment-worker",
        resourceUid: "resource-worker",
        offeringId: MODULE_WORKER.id,
        nativeId: "worker:a",
        state: "deleted",
        outputs: {
          __takoserver: {
            resourceUid: "resource-worker",
            space: "main",
            name: "worker",
            generation: "3",
          },
        },
      });
      seedDeletionTombstone(database, {
        resourceUid: "resource-worker",
        offering: MODULE_WORKER,
        name: "worker",
      });
      let reads = 0;
      const provider = providerStub({
        async verifyNativeAbsence() {
          reads += 1;
          return { outcome: "absent", evidence: {} };
        },
      });
      const executor = createCloudflareProviderExecutor({
        provider: async () => provider,
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
      });
      const input = {
        offering: MODULE_WORKER,
        descriptor: {
          apiVersion: "providers.takoserver.com/readback/v1" as const,
          provider: "cloudflare",
          kind: "ModuleWorker",
          nativeId: "worker:a",
          data: { resourceUid: "resource-worker" },
        },
        target: {
          tenantId: "tenant-a",
          resourceUid: "resource-worker",
          incarnationId: "deployment-worker",
          generation: "3",
        },
      };

      expect(await executor.verifyNativeAbsence(input)).toEqual({
        outcome: "absent",
        evidence: {},
      });
      expect(
        await executor.verifyNativeAbsence({
          ...input,
          target: { ...input.target, generation: "4" },
        }),
      ).toEqual({ outcome: "unknown", reason: "authority_unavailable", retryable: false });
      expect(
        await executor.verifyNativeAbsence({
          ...input,
          descriptor: {
            ...input.descriptor,
            provider: "attacker-selected-provider",
          },
        }),
      ).toEqual({ outcome: "unknown", reason: "authority_unavailable", retryable: false });
      expect(
        await executor.verifyNativeAbsence({
          ...input,
          descriptor: {
            ...input.descriptor,
            data: { resourceUid: "resource-other" },
          },
        }),
      ).toEqual({ outcome: "unknown", reason: "authority_unavailable", retryable: false });
      expect(reads).toBe(1);
    } finally {
      database.close();
    }
  });

  test("never falls back to generic parent REST for ObjectBucket recovery", async () => {
    let recoveries = 0;
    const provider = providerStub({
      offerings: [],
      recoveryOfferings: [OBJECT_BUCKET],
      async recoverApply() {
        recoveries += 1;
        return SUCCEEDED;
      },
      async recoverDelete() {
        recoveries += 1;
        return SUCCEEDED;
      },
    });
    const authorizedSql: Sql = {
      async query() {
        return [{ authorized: 1 }];
      },
      async run() {
        return { rows: [], changes: 0 };
      },
      async batch() {
        return [];
      },
    };
    const executor = createCloudflareProviderExecutor({
      provider: async () => provider,
      sql: authorizedSql,
      providerInstallationId: "cloudflare.primary",
    });
    const input = {
      operationId: "operation-object-recovery",
      operationMode: "recovery" as const,
      executionAuthority: authority("resource-bucket", "lease-bucket"),
      offering: OBJECT_BUCKET,
      identity: {
        tenantRef: "tenant-a",
        space: "main",
        name: "bucket",
        uid: "resource-bucket",
        incarnationId: "deployment-bucket",
        generation: "1",
      },
      spec: {},
    };

    expect(await executor.recoverApply(input)).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    expect(await executor.recoverDelete({ ...input, nativeId: "r2:bucket-native" })).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    expect(recoveries).toBe(0);
  });

  test("atomically binds one initial apply and admits only same-intent recovery under a fresh lease", async () => {
    const database = migratedDatabase();
    try {
      seedSaga(database, {
        operationId: "operation-apply",
        resourceUid: "resource-worker",
        kind: "ModuleWorker",
        name: "worker",
        leaseToken: "lease-initial",
      });
      let applyCalls = 0;
      let convergeCalls = 0;
      const provider = providerStub({
        async apply() {
          applyCalls += 1;
          return SUCCEEDED;
        },
        async convergeApply() {
          convergeCalls += 1;
          return SUCCEEDED;
        },
      });
      const executor = createCloudflareProviderExecutor({
        provider: async () => provider,
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
        clock: () => new Date(1_000),
      });
      const initial: ApplyInput = {
        operationId: "operation-apply",
        operationMode: "initial",
        executionAuthority: authority("resource-worker", "lease-initial"),
        offering: MODULE_WORKER,
        identity: IDENTITY,
        spec: { compatibilityDate: "2026-09-01" },
      };

      expect(await executor.apply(initial)).toBe(SUCCEEDED);
      expect(applyCalls).toBe(1);
      expect(
        database
          .query(
            "SELECT mutation_kind FROM tf_cloudflare_provider_executor_operations WHERE operation_id = ?",
          )
          .get("operation-apply"),
      ).toEqual({ mutation_kind: "apply" });

      // The insert-only claim never authorizes a second initial provider call.
      expect(await executor.apply(initial)).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(applyCalls).toBe(1);

      database
        .query(
          `UPDATE tf_provider_mutation_sagas
           SET execution_lease_token = ?, execution_lease_until = ?, provider_outcome = 'indeterminate'
           WHERE operation_id = ?`,
        )
        .run("lease-recovery", 2_000, "operation-apply");
      const recovery = {
        ...initial,
        operationMode: "recovery" as const,
        executionAuthority: authority("resource-worker", "lease-recovery"),
      };
      expect(await executor.convergeApply(recovery)).toBe(SUCCEEDED);
      expect(convergeCalls).toBe(1);

      expect(
        await executor.convergeApply({
          ...recovery,
          spec: { compatibilityDate: "2026-09-02" },
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(
        await executor.convergeApply({
          ...recovery,
          executionAuthority: authority("resource-worker", "wrong-lease"),
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(convergeCalls).toBe(1);
    } finally {
      database.close();
    }
  });

  test("adopts and readback-recovers one managed ObjectBucket under the exact saga claim", async () => {
    const database = migratedDatabase();
    try {
      seedSaga(database, {
        operationId: "operation-adopt-bucket",
        resourceUid: "resource-bucket",
        kind: "ObjectBucket",
        name: "bucket",
        leaseToken: "lease-adopt",
      });
      const identity = {
        tenantRef: "tenant-a",
        space: "main",
        name: "bucket",
        uid: "resource-bucket",
      } as const;
      const bucketName = await derivedProviderResourceIncarnationName("ts", identity);
      const calls: string[] = [];
      const provider = managedObjectProvider(async (request) => {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response(
          JSON.stringify({ success: true, errors: [], result: { name: bucketName } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const executor = createCloudflareProviderExecutor({
        provider: async () => provider,
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
        clock: () => new Date(1_000),
      });
      const initial = {
        operationId: "operation-adopt-bucket",
        operationMode: "initial" as const,
        executionAuthority: authority("resource-bucket", "lease-adopt"),
        offering: OBJECT_BUCKET,
        nativeId: `r2:${bucketName}`,
        identity,
        spec: {},
      };

      expect(
        await executor.adopt({
          ...initial,
          executionAuthority: authority("resource-bucket", "wrong-lease"),
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(await executor.adopt(initial)).toMatchObject({
        phase: "succeeded",
        result: { nativeId: `r2:${bucketName}` },
      });
      expect(await executor.adopt(initial)).toEqual({
        phase: "failed",
        failure: deniedFailure(),
      });
      expect(
        database
          .query(
            `SELECT mutation_kind FROM tf_cloudflare_provider_executor_operations
             WHERE operation_id = ?`,
          )
          .get("operation-adopt-bucket"),
      ).toEqual({ mutation_kind: "adopt" });

      database
        .query(
          `UPDATE tf_provider_mutation_sagas
           SET execution_lease_token = ?, execution_lease_until = ?, provider_outcome = 'indeterminate'
           WHERE operation_id = ?`,
        )
        .run("lease-adopt-recovery", 2_000, "operation-adopt-bucket");
      const recovery = {
        ...initial,
        operationMode: "recovery" as const,
        executionAuthority: authority("resource-bucket", "lease-adopt-recovery"),
      };
      expect(await executor.recoverAdopt(recovery)).toMatchObject({
        phase: "succeeded",
        result: { nativeId: `r2:${bucketName}` },
      });
      expect(
        await executor.recoverAdopt({
          ...recovery,
          nativeId: "r2:other-bucket",
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(calls).toEqual([
        `GET /client/v4/accounts/account-a/r2/buckets/${bucketName}`,
        `GET /client/v4/accounts/account-a/r2/buckets/${bucketName}`,
      ]);
    } finally {
      database.close();
    }
  });

  test("binds adopt updates to the incumbent deployment and Resource generation", async () => {
    const database = migratedDatabase();
    try {
      seedResource(database, {
        uid: "resource-bucket",
        kind: "ObjectBucket",
        name: "bucket",
        generation: "7",
      });
      seedDeployment(database, {
        id: "deployment-bucket",
        resourceUid: "resource-bucket",
        offeringId: OBJECT_BUCKET.id,
        nativeId: "r2:bucket-native",
      });
      seedSaga(database, {
        operationId: "operation-adopt-update",
        resourceUid: "resource-bucket",
        kind: "ObjectBucket",
        name: "bucket",
        leaseToken: "lease-adopt-update",
      });
      database
        .query(
          `UPDATE tf_provider_mutation_sagas
           SET accepted_uid = ?, accepted_generation = ?, accepted_revision = ?
           WHERE operation_id = ?`,
        )
        .run("resource-bucket", "7", "1", "operation-adopt-update");
      let calls = 0;
      const executor = createCloudflareProviderExecutor({
        provider: async () =>
          providerStub({
            offerings: [OBJECT_BUCKET],
            async adopt() {
              calls += 1;
              return {
                ...SUCCEEDED,
                result: { ...SUCCEEDED.result, nativeId: "r2:bucket-native" },
              };
            },
            async recoverAdopt() {
              calls += 1;
              return {
                ...SUCCEEDED,
                result: { ...SUCCEEDED.result, nativeId: "r2:bucket-native" },
              };
            },
          }),
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
        clock: () => new Date(1_000),
      });
      const input = {
        operationId: "operation-adopt-update",
        operationMode: "initial" as const,
        executionAuthority: authority("resource-bucket", "lease-adopt-update"),
        offering: OBJECT_BUCKET,
        nativeId: "r2:bucket-native",
        identity: {
          tenantRef: "tenant-a",
          space: "main",
          name: "bucket",
          uid: "resource-bucket",
          incarnationId: "deployment-bucket",
          generation: "7",
        },
        spec: {},
      };

      expect(
        await executor.adopt({
          ...input,
          identity: { ...input.identity, incarnationId: "deployment-stale" },
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(
        await executor.adopt({
          ...input,
          identity: { ...input.identity, generation: "6" },
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(calls).toBe(0);
      expect(await executor.adopt(input)).toMatchObject({
        phase: "succeeded",
        result: { nativeId: "r2:bucket-native" },
      });
      expect(calls).toBe(1);

      database
        .query(
          `UPDATE tf_provider_mutation_sagas
           SET execution_lease_token = ?, execution_lease_until = ?, provider_outcome = 'indeterminate'
           WHERE operation_id = ?`,
        )
        .run("lease-adopt-recovery", 2_000, "operation-adopt-update");
      const recovery = {
        ...input,
        operationMode: "recovery" as const,
        executionAuthority: authority("resource-bucket", "lease-adopt-recovery"),
      };
      expect(
        await executor.recoverAdopt({
          ...recovery,
          identity: { ...recovery.identity, incarnationId: "deployment-stale" },
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(
        await executor.recoverAdopt({
          ...recovery,
          identity: { ...recovery.identity, generation: "6" },
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(calls).toBe(1);
      expect(await executor.recoverAdopt(recovery)).toMatchObject({
        phase: "succeeded",
        result: { nativeId: "r2:bucket-native" },
      });
      expect(calls).toBe(2);
    } finally {
      database.close();
    }
  });

  test("binds updates to the exact incumbent deployment and Resource generation", async () => {
    const database = migratedDatabase();
    try {
      seedResource(database, {
        uid: "resource-worker",
        kind: "ModuleWorker",
        name: "worker",
        generation: "7",
      });
      seedDeployment(database, {
        id: "deployment-worker",
        resourceUid: "resource-worker",
        offeringId: MODULE_WORKER.id,
        nativeId: "worker:a",
      });
      seedSaga(database, {
        operationId: "operation-update",
        resourceUid: "resource-worker",
        kind: "ModuleWorker",
        name: "worker",
        leaseToken: "lease-update",
      });
      database
        .query(
          `UPDATE tf_provider_mutation_sagas
           SET accepted_uid = ?, accepted_generation = ?, accepted_revision = ?
           WHERE operation_id = ?`,
        )
        .run("resource-worker", "7", "1", "operation-update");
      let calls = 0;
      const executor = createCloudflareProviderExecutor({
        provider: async () =>
          providerStub({
            async apply() {
              calls += 1;
              return SUCCEEDED;
            },
          }),
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
        clock: () => new Date(1_000),
      });
      const update: ApplyInput = {
        operationId: "operation-update",
        operationMode: "initial",
        executionAuthority: authority("resource-worker", "lease-update"),
        offering: MODULE_WORKER,
        identity: { ...IDENTITY, generation: "7" },
        spec: { compatibilityDate: "2026-09-04" },
        previous: { nativeId: "worker:a", spec: { compatibilityDate: "2026-09-03" } },
      };

      expect(
        await executor.apply({
          ...update,
          identity: { ...update.identity, incarnationId: "deployment-stale" },
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(
        await executor.apply({
          ...update,
          identity: { ...update.identity, generation: "6" },
        }),
      ).toEqual({ phase: "failed", failure: deniedFailure() });
      expect(calls).toBe(0);
      expect(await executor.apply(update)).toBe(SUCCEEDED);
      expect(calls).toBe(1);
    } finally {
      database.close();
    }
  });

  test("binds SQLite CAS to full desired history while allowing deterministic prefix advancement", async () => {
    const database = migratedDatabase();
    try {
      const firstSql = new TextEncoder().encode("CREATE TABLE first(id INTEGER);");
      const secondSql = new TextEncoder().encode("ALTER TABLE first ADD COLUMN name TEXT;");
      const changedSql = new TextEncoder().encode("DROP TABLE first;");
      const first = { path: "0001.sql", digest: await bytesDigest(firstSql) };
      const second = { path: "0002.sql", digest: await bytesDigest(secondSql) };
      const changed = { path: "0002.sql", digest: await bytesDigest(changedSql) };
      const blobs = new Map([
        [first.digest, firstSql],
        [second.digest, secondSql],
        [changed.digest, changedSql],
      ]);
      seedResource(database, {
        uid: "resource-database",
        kind: "SQLiteDatabase",
        name: "database",
        generation: "7",
      });
      seedDeployment(database, {
        id: "deployment-database",
        resourceUid: "resource-database",
        offeringId: "cloudflare.edge.stable-v1.sqlitedatabase",
        nativeId: "sqlite:database-native",
      });
      seedSaga(database, {
        operationId: "operation-app-a",
        resourceUid: "resource-application-a",
        kind: "SQLiteMigrationApplication",
        name: "application-a",
        leaseToken: "lease-app-a-initial",
      });
      seedSaga(database, {
        operationId: "operation-app-b",
        resourceUid: "resource-application-b",
        kind: "SQLiteMigrationApplication",
        name: "application-b",
        leaseToken: "lease-app-b-initial",
      });

      const ledger: { path: string; digest: `sha256:${string}` }[] = [];
      const suffixes: (readonly ProviderSqliteMigration[])[] = [];
      const provider = providerStub({
        sqliteMigrations: {
          async readLedger() {
            return { ok: true, value: structuredClone(ledger) };
          },
          async applySuffix(input) {
            suffixes.push(structuredClone(input.migrations));
            if (input.operationId === "operation-app-a" && input.operationMode === "initial") {
              return { ok: false, failure: deniedFailure() };
            }
            if (!sameLedger(ledger, input.expectedPrefix)) {
              return { ok: false, failure: deniedFailure() };
            }
            ledger.push(...input.migrations.map(({ path, digest }) => ({ path, digest })));
            return { ok: true, value: undefined };
          },
        },
      });
      const executor = createCloudflareProviderExecutor({
        provider: async () => provider,
        sql: createSqliteSql(database),
        providerInstallationId: "cloudflare.primary",
        migrationSql: async (_tenantId, digest) => blobs.get(digest) ?? null,
        clock: () => new Date(1_000),
      });
      const target = {
        resourceUid: "resource-database",
        incarnationId: "deployment-database",
        generation: "7",
      };
      const appAInitial = {
        operationId: "operation-app-a",
        operationMode: "initial" as const,
        executionAuthority: authority("resource-application-a", "lease-app-a-initial"),
        nativeId: "sqlite:database-native",
        target,
        desired: [first, second],
        expectedPrefix: [],
        migrations: [first, second],
      };
      expect(await executor.applySqliteMigrationSuffix(appAInitial)).toEqual({
        ok: false,
        failure: deniedFailure(),
      });

      // A distinct application legitimately advances the same database by m1.
      expect(
        await executor.applySqliteMigrationSuffix({
          operationId: "operation-app-b",
          operationMode: "initial",
          executionAuthority: authority("resource-application-b", "lease-app-b-initial"),
          nativeId: "sqlite:database-native",
          target,
          desired: [first],
          expectedPrefix: [],
          migrations: [first],
        }),
      ).toEqual({ ok: true, value: undefined });
      expect(ledger).toEqual([first]);

      database
        .query(
          `UPDATE tf_provider_mutation_sagas
           SET execution_lease_token = ?, execution_lease_until = ?, provider_outcome = 'indeterminate'
           WHERE operation_id = ?`,
        )
        .run("lease-app-a-recovery", 2_000, "operation-app-a");
      const appARecovery = {
        ...appAInitial,
        operationMode: "recovery" as const,
        executionAuthority: authority("resource-application-a", "lease-app-a-recovery"),
        expectedPrefix: [first],
        migrations: [second],
      };
      expect(await executor.applySqliteMigrationSuffix(appARecovery)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(ledger).toEqual([first, second]);
      expect(suffixes.at(-1)?.map(({ path }) => path)).toEqual(["0002.sql"]);

      // Same operation cannot change desired bytes or the database realization.
      expect(
        await executor.applySqliteMigrationSuffix({
          ...appARecovery,
          desired: [first, changed],
          migrations: [changed],
        }),
      ).toEqual({ ok: false, failure: deniedFailure() });
      expect(
        await executor.applySqliteMigrationSuffix({
          ...appARecovery,
          target: { ...target, generation: "8" },
        }),
      ).toEqual({ ok: false, failure: deniedFailure() });

      // Divergent/longer prefix projections are rejected before provider dispatch.
      const callsBeforeProjectionFailures = suffixes.length;
      expect(
        await executor.applySqliteMigrationSuffix({
          ...appARecovery,
          expectedPrefix: [second],
          migrations: [second],
        }),
      ).toEqual({ ok: false, failure: deniedFailure() });
      expect(
        executor.applySqliteMigrationSuffix({
          ...appARecovery,
          expectedPrefix: [first, second, changed],
          migrations: [],
        } as never),
      ).rejects.toThrow("invalid Cloudflare provider executor RPC input");
      expect(suffixes).toHaveLength(callsBeforeProjectionFailures);

      // If the authoritative prefix advances after the caller read it, the
      // provider's atomic prefix guard refuses rather than replaying m2.
      expect(await executor.applySqliteMigrationSuffix(appARecovery)).toEqual({
        ok: false,
        failure: deniedFailure(),
      });
      expect(ledger).toEqual([first, second]);
    } finally {
      database.close();
    }
  });

  test("rejects extra RPC input members instead of relying on structural typing", async () => {
    const executor = createCloudflareProviderExecutor({
      provider: async () => managedProvider([MODULE_WORKER]),
      sql,
      providerInstallationId: "cloudflare.primary",
    });
    await expect(
      executor.observe({
        offering: MODULE_WORKER,
        nativeId: "worker:a",
        identity: IDENTITY,
        spec: {},
        surprise: true,
      } as never),
    ).rejects.toThrow("invalid Cloudflare provider executor RPC input");
  });
});

function providerStub(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "cloudflare",
    offerings: [MODULE_WORKER],
    async apply() {
      return SUCCEEDED;
    },
    async observe() {
      return SUCCEEDED;
    },
    async delete() {
      return SUCCEEDED;
    },
    ...overrides,
  };
}

function migratedDatabase(): Database {
  const database = new Database(":memory:");
  migrateSqlite(database);
  return database;
}

function authority(resourceUid: string, leaseToken: string): ProviderExecutionAuthority {
  return {
    tenantId: "tenant-a",
    resourceUid,
    leaseToken,
    fingerprint: "{}",
  };
}

function seedSaga(
  database: Database,
  input: {
    readonly operationId: string;
    readonly resourceUid: string;
    readonly kind: string;
    readonly name: string;
    readonly leaseToken: string;
  },
): void {
  database
    .query(
      `INSERT INTO tf_provider_mutation_sagas
         (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
          target_space, target_api_version, target_kind, target_name,
          accepted_uid, accepted_generation, accepted_revision, phase,
          receipt_json, created_at, updated_at, expires_at,
          execution_lease_token, execution_lease_until, execution_started_at,
          provider_outcome)
       VALUES (?, ?, 'tenant-a', '{}', ?, 'main', 'edge.forms.takoform.com', ?, ?,
               NULL, NULL, NULL, 'planned', NULL, 500, 900, 100000,
               ?, 2000, 900, 'running')`,
    )
    .run(
      input.operationId,
      `replay-${input.operationId}`,
      input.resourceUid,
      input.kind,
      input.name,
      input.leaseToken,
    );
}

function seedResource(
  database: Database,
  input: {
    readonly uid: string;
    readonly kind: string;
    readonly name: string;
    readonly generation: string;
  },
): void {
  database
    .query(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation,
          revision, resource_json, updated_at)
       VALUES ('tenant-a', 'main', 'edge.forms.takoform.com', ?, ?, ?, ?, '1', '{}', 500)`,
    )
    .run(input.kind, input.name, input.uid, input.generation);
}

function seedDeployment(
  database: Database,
  input: {
    readonly id: string;
    readonly resourceUid: string;
    readonly offeringId: string;
    readonly nativeId: string;
    readonly state?: "active" | "retained" | "deleted";
    readonly outputs?: JsonObject;
  },
): void {
  database
    .query(
      `INSERT INTO tf_resource_deployments
         (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
          provider_installation_ref, native_id, state, observed_json,
          outputs_json, created_at, updated_at)
       VALUES ('tenant-a', ?, ?, ?, 'cloudflare', 'cloudflare.primary', ?,
               ?, '{}', ?, 500, 500)`,
    )
    .run(
      input.id,
      input.resourceUid,
      input.offeringId,
      input.nativeId,
      input.state ?? "active",
      JSON.stringify(input.outputs ?? {}),
    );
}

function seedDeletionTombstone(
  database: Database,
  input: {
    readonly resourceUid: string;
    readonly offering: ProviderOffering;
    readonly name: string;
  },
): void {
  database
    .query(
      `INSERT INTO tf_resource_deletion_attestations
         (tenant_id, resource_uid, space, api_version, kind, name,
          form_ref_json, state, closure_fence, effects_json, created_at, updated_at)
       VALUES ('tenant-a', ?, 'main', ?, ?, ?, ?, 'closed', 1, '[]', 500, 500)`,
    )
    .run(
      input.resourceUid,
      input.offering.form.apiVersion,
      input.offering.form.kind,
      input.name,
      JSON.stringify(input.offering.form),
    );
}

function sameLedger(
  left: readonly { readonly path: string; readonly digest: string }[],
  right: readonly { readonly path: string; readonly digest: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (migration, index) =>
        migration.path === right[index]?.path && migration.digest === right[index]?.digest,
    )
  );
}

function deniedFailure() {
  return {
    code: "unavailable" as const,
    message: "the Cloudflare provider mutation authority is unavailable",
    retryable: true,
  };
}

void ({} satisfies JsonObject);
