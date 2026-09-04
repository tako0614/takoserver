import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import {
  buildEdgeForms,
  edgeProviderOffering,
  objectBucketProviderOffering,
} from "../src/edge-forms.ts";
import type { JsonObject, Row, Sql } from "../src/ports.ts";
import type {
  ApplyInput,
  ProviderOffering,
  ProviderRelation,
  ProviderTicket,
} from "../src/provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import { type ArtifactBytes, CloudflareProvider } from "../src/providers/cloudflare.ts";
import {
  type ManagedObjectReceiptAdminOperation,
  type ManagedObjectReceiptAuthority,
  managedObjectReceiptAdminProof,
  managedObjectReceiptInstanceName,
  managedObjectReceiptRuntimeProof,
} from "../src/providers/cloudflare-managed-object-receipt.ts";
import {
  managedWorkerHostRouteKey,
  TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS,
} from "../src/providers/cloudflare-managed-worker-gateway.ts";
import {
  type ManagedWorkerSqliteAdminOperation,
  type ManagedWorkerSqliteAuthority,
  type ManagedWorkerSqliteMigrationIdentity,
  managedWorkerSqliteAdminProof,
} from "../src/providers/cloudflare-managed-worker-sqlite.ts";
import type {
  CloudflareManagedObjectReceiptAdminRequest,
  CloudflareManagedObjectReceiptAuthority,
  CloudflareManagedObjectReceiptStub,
  CloudflareManagedSqliteAdminRequest,
  CloudflareManagedSqliteNamespace,
  CloudflareManagedSqliteStub,
  CloudflareWorkersForPlatformsBackendOptions,
} from "../src/providers/cloudflare-worker-backend.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";

/** Stands in for the gateway's `TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET`. */
const TEST_SQLITE_ADMIN_SECRET = "test-managed-sqlite-admin-secret";
const TEST_OBJECT_RECEIPT_SECRET = "test-managed-object-receipt-secret";

import { ManagedWorkerState } from "../src/providers/managed-worker-state.ts";

const released = await buildEdgeForms();
function technical(kind: string): ProviderOffering {
  const form = released.forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!form) throw new Error(`released ${kind} Form is missing`);
  return edgeProviderOffering(form, {
    id: `cloudflare.wfp.integration.${kind}`,
    regions: ["global"],
  });
}

const offering = technical("ModuleWorker");
const versionOffering = technical("WorkerVersion");
const deploymentOffering = technical("WorkerDeployment");
const endpointOffering = technical("WorkerEndpoint");
const customDomainOffering = technical("WorkerCustomDomain");
const cronOffering = technical("WorkerCronTrigger");
const queueConsumerOffering = technical("QueueConsumer");
const sqliteOffering = technical("SQLiteDatabase");
const objectBucketForm = currentTakoformCandidates().forms.find(
  (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
);
if (!objectBucketForm) throw new Error("current ObjectBucket Form is missing");
const objectBucketOffering = objectBucketProviderOffering(objectBucketForm, {
  id: "storage.object.cloudflare",
  displayName: "Cloudflare Object Storage",
  regions: ["global"],
});

const moduleBytes = new TextEncoder().encode(
  "export default { fetch() { return new Response('ok') } }",
);
const bundleDigest = `sha256:${"d".repeat(64)}`;
const moduleDigest = `sha256:${"e".repeat(64)}`;

const artifacts: ArtifactBytes = {
  async manifest(_tenantRef, digest) {
    return digest === bundleDigest
      ? {
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: [
            {
              name: "index.js",
              mediaType: "application/javascript+module",
              digest: moduleDigest,
            },
          ],
        }
      : null;
  },
  async blob(digest) {
    return digest === moduleDigest ? moduleBytes : null;
  },
};

test("managed Cloudflare reservations are official origins, never workers.dev", async () => {
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [offering],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: managedBackend(createEphemeralSql()),
    fetch: async () => {
      throw new Error("origin derivation must not call Cloudflare");
    },
  });

  const reservation = await provider.workerEndpointOriginReservations.derive({
    tenantRef: "organization_yurucommu",
    requestedSubdomain: "tsw-yurucommu-reserved",
  });

  expect(reservation?.canonicalPublicOrigin).toBe(
    "https://tsw-yurucommu-reserved.app-staging.takos.jp",
  );
  expect(reservation?.canonicalPublicOrigin).not.toContain("workers.dev");

  // This backend sells its base domain rather than deriving an address from
  // the Worker, so it mints nothing on a caller's behalf and the reservation
  // stays the thing the sponsor supplies.
  expect(
    await provider.workerEndpointOriginReservations.hostMintedSubdomain?.({
      tenantRef: "organization_yurucommu",
      space: "production",
      workerName: "server",
    }),
  ).toBeNull();

  const allocated = await provider.apply({
    operationId: "allocate-worker-yurucommu",
    operationMode: "initial",
    offering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: "server",
      uid: "worker_yurucommu",
    },
    spec: {},
  });
  expect(allocated).toMatchObject({
    phase: "succeeded",
    result: {
      nativeId: expect.stringMatching(/^worker:tsw-[0-9a-f]{40}$/u),
      outputs: { scriptName: expect.stringMatching(/^tsw-[0-9a-f]{40}$/u) },
    },
  });
});

test("managed ObjectBucket destruction drains receipt authority before R2 and commits only after absence", async () => {
  const bucketName = "tsb-managed-destroy-order";
  const authority: ManagedObjectReceiptAuthority = {
    schema: "takoserver.managed-object-receipt-authority@v1",
    providerId: "cloudflare.wfp.integration",
    resourceUid: "bucket_destroy_order",
    incarnationId: "dep_bucket_destroy_order",
    generation: "7",
  };
  const receipt = new ManagedObjectReceiptFake(authority, bucketName);
  receipt.prepareStates = ["draining", "prepared"];
  const events = receipt.events;
  const provider = new CloudflareProvider({
    id: authority.providerId,
    accountId: "acct_1",
    offerings: [objectBucketOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: managedObjectBackend(createEphemeralSql(), receipt),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      events.push(`cloudflare.${request.method} ${path}`);
      if (request.method === "DELETE" && path.endsWith(`/r2/buckets/${bucketName}`)) {
        return Response.json({ success: true, result: {} });
      }
      if (request.method === "GET" && path.endsWith(`/r2/buckets/${bucketName}`)) {
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      throw new Error(`unexpected Cloudflare call: ${request.method} ${path}`);
    },
  });
  const identity = {
    tenantRef: "organization_yurucommu",
    space: "production",
    name: "media",
    uid: authority.resourceUid,
    incarnationId: authority.incarnationId,
    generation: authority.generation,
  };

  const draining = await provider.delete({
    operationId: "destroy-bucket-order",
    operationMode: "initial",
    offering: objectBucketOffering,
    nativeId: `r2:${bucketName}`,
    identity,
    spec: {},
  });
  expect(draining.phase).toBe("running");
  if (draining.phase !== "running") throw new Error("expected receipt drain handle");
  expect(events).toEqual(["receipt.prepare"]);

  const tampered = mutateManagedObjectDestroyHandle(draining.handle, (value) => {
    const identity = value.identity as Record<string, unknown>;
    identity.generation = "8";
  });
  expect(
    await provider.poll({ operationId: "destroy-bucket-order", handle: tampered }),
  ).toMatchObject({ phase: "failed", failure: { code: "conflict", retryable: false } });
  expect(events).toEqual(["receipt.prepare"]);

  expect(
    await provider.poll({ operationId: "destroy-bucket-order", handle: draining.handle }),
  ).toMatchObject({
    phase: "succeeded",
    result: { nativeId: `r2:${bucketName}`, disposition: "deleted" },
  });
  expect(events).toEqual([
    "receipt.prepare",
    "receipt.prepare",
    `cloudflare.DELETE /client/v4/accounts/acct_1/r2/buckets/${bucketName}`,
    `cloudflare.GET /client/v4/accounts/acct_1/r2/buckets/${bucketName}`,
    "receipt.commit",
  ]);
  expect(receipt.destroyed).toBe(true);
  const expectedInstanceName = await managedObjectReceiptInstanceName(authority);
  const rejectedInstanceName = await managedObjectReceiptInstanceName({
    ...authority,
    generation: "8",
  });
  expect(receipt.instanceNames.filter((value) => value === expectedInstanceName)).toHaveLength(3);
  expect(receipt.instanceNames.filter((value) => value === rejectedInstanceName)).toHaveLength(1);
  expect(new Set(receipt.instanceNames)).toEqual(
    new Set([expectedInstanceName, rejectedInstanceName]),
  );
});

test("managed ObjectBucket destruction reconciles lost R2 and receipt acknowledgements without replay", async () => {
  const bucketName = "tsb-managed-destroy-lost-ack";
  const authority: ManagedObjectReceiptAuthority = {
    schema: "takoserver.managed-object-receipt-authority@v1",
    providerId: "cloudflare.wfp.integration",
    resourceUid: "bucket_destroy_lost_ack",
    incarnationId: "dep_bucket_destroy_lost_ack",
    generation: "2",
  };
  const receipt = new ManagedObjectReceiptFake(authority, bucketName);
  receipt.commitLosesAck = true;
  const events = receipt.events;
  let deleteCalls = 0;
  const provider = new CloudflareProvider({
    id: authority.providerId,
    accountId: "acct_1",
    offerings: [objectBucketOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: managedObjectBackend(createEphemeralSql(), receipt),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      events.push(`cloudflare.${request.method} ${path}`);
      if (request.method === "DELETE") {
        deleteCalls += 1;
        throw new Error("R2 transport closed after delete");
      }
      if (request.method === "GET" && path.endsWith(`/r2/buckets/${bucketName}`)) {
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      throw new Error(`unexpected Cloudflare call: ${request.method} ${path}`);
    },
  });
  const operationId = "destroy-bucket-lost-ack";
  const identity = {
    tenantRef: "organization_yurucommu",
    space: "production",
    name: "media",
    uid: authority.resourceUid,
    incarnationId: authority.incarnationId,
    generation: authority.generation,
  };

  const indeterminate = await provider.delete({
    operationId,
    operationMode: "initial",
    offering: objectBucketOffering,
    nativeId: `r2:${bucketName}`,
    identity,
    spec: {},
  });
  expect(indeterminate.phase).toBe("running");
  if (indeterminate.phase !== "running") throw new Error("expected R2 confirmation handle");

  const commitAckLost = await provider.poll({ operationId, handle: indeterminate.handle });
  expect(commitAckLost).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  if (commitAckLost.phase !== "failed" || !commitAckLost.handle) {
    throw new Error("expected retryable receipt commit handle");
  }
  const commitHandle = commitAckLost.handle;
  expect(commitHandle).toMatch(/^tsobjd1\./u);
  expect(receipt.destroyed).toBe(true);

  expect(
    await provider.recoverDelete({
      operationId,
      operationMode: "recovery",
      providerHandle: commitHandle,
      offering: objectBucketOffering,
      nativeId: `r2:${bucketName}`,
      identity,
      spec: {},
    }),
  ).toMatchObject({
    phase: "succeeded",
    result: { nativeId: `r2:${bucketName}`, disposition: "deleted" },
  });
  expect(deleteCalls).toBe(1);
  expect(events).toEqual([
    "receipt.prepare",
    `cloudflare.DELETE /client/v4/accounts/acct_1/r2/buckets/${bucketName}`,
    `cloudflare.GET /client/v4/accounts/acct_1/r2/buckets/${bucketName}`,
    "receipt.commit",
    "receipt.commit",
  ]);
});

test("ambiguous managed ObjectBucket delete stays visibly fenced and never replays DELETE", async () => {
  const bucketName = "tsb-managed-destroy-ambiguous";
  const authority: ManagedObjectReceiptAuthority = {
    schema: "takoserver.managed-object-receipt-authority@v1",
    providerId: "cloudflare.wfp.integration",
    resourceUid: "bucket_destroy_ambiguous",
    incarnationId: "dep_bucket_destroy_ambiguous",
    generation: "4",
  };
  const receipt = new ManagedObjectReceiptFake(authority, bucketName);
  let present = true;
  let deleteCalls = 0;
  const provider = new CloudflareProvider({
    id: authority.providerId,
    accountId: "acct_1",
    offerings: [objectBucketOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: managedObjectBackend(createEphemeralSql(), receipt),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "DELETE") {
        deleteCalls += 1;
        throw new Error("R2 transport closed after delete");
      }
      if (request.method === "GET" && path.endsWith(`/r2/buckets/${bucketName}`)) {
        return present
          ? Response.json({ success: true, result: { name: bucketName } })
          : Response.json({ success: false, errors: [] }, { status: 404 });
      }
      throw new Error(`unexpected Cloudflare call: ${request.method} ${path}`);
    },
  });
  const operationId = "destroy-bucket-ambiguous";
  const identity = {
    tenantRef: "organization_yurucommu",
    space: "production",
    name: "media",
    uid: authority.resourceUid,
    incarnationId: authority.incarnationId,
    generation: authority.generation,
  };

  const started = await provider.delete({
    operationId,
    operationMode: "initial",
    offering: objectBucketOffering,
    nativeId: `r2:${bucketName}`,
    identity,
    spec: {},
  });
  expect(started.phase).toBe("running");
  if (started.phase !== "running") throw new Error("expected R2 confirmation handle");
  expect(deleteCalls).toBe(1);
  expect(await provider.managedObjectBucketReceiptStatus({ identity, bucketName })).toEqual({
    ok: true,
    value: {
      lifecycle: "destroying",
      receiptCount: 0,
      operatorReconciliationRequired: 0,
      repairRequired: true,
      nextActionAt: null,
    },
  });

  const fenced = await provider.poll({ operationId, handle: started.handle });
  expect(fenced).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
    handle: started.handle,
  });
  expect(deleteCalls).toBe(1);

  present = false;
  expect(
    await provider.recoverDelete({
      operationId,
      operationMode: "recovery",
      providerHandle: started.handle,
      offering: objectBucketOffering,
      nativeId: `r2:${bucketName}`,
      identity,
      spec: {},
    }),
  ).toMatchObject({
    phase: "succeeded",
    result: { nativeId: `r2:${bucketName}`, disposition: "deleted" },
  });
  expect(deleteCalls).toBe(1);
});

test("managed ObjectBucket operator status exposes the permanent receipt repair fence", async () => {
  const bucketName = "tsb-managed-receipt-status";
  const authority: ManagedObjectReceiptAuthority = {
    schema: "takoserver.managed-object-receipt-authority@v1",
    providerId: "cloudflare.wfp.integration",
    resourceUid: "bucket_receipt_status",
    incarnationId: "dep_bucket_receipt_status",
    generation: "9",
  };
  const receipt = new ManagedObjectReceiptFake(authority, bucketName);
  receipt.receiptCount = 3;
  receipt.operatorReconciliationRequired = 2;
  receipt.nextActionAt = 1_788_480_000_000;
  const provider = new CloudflareProvider({
    id: authority.providerId,
    accountId: "acct_1",
    offerings: [objectBucketOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: managedObjectBackend(createEphemeralSql(), receipt),
    fetch: async () => {
      throw new Error("receipt status must not call a tenant or R2 API");
    },
  });
  const identity = {
    tenantRef: "organization_yurucommu",
    space: "production",
    name: "media",
    uid: authority.resourceUid,
    incarnationId: authority.incarnationId,
    generation: authority.generation,
  };

  expect(await provider.managedObjectBucketReceiptStatus({ identity, bucketName })).toEqual({
    ok: true,
    value: {
      lifecycle: "active",
      receiptCount: 3,
      operatorReconciliationRequired: 2,
      repairRequired: true,
      nextActionAt: 1_788_480_000_000,
    },
  });
  expect(receipt.events).toEqual(["receipt.inspect"]);

  receipt.lifecycle = "destroying";
  receipt.receiptCount = 0;
  receipt.operatorReconciliationRequired = 0;
  receipt.nextActionAt = null;
  expect(await provider.managedObjectBucketReceiptStatus({ identity, bucketName })).toEqual({
    ok: true,
    value: {
      lifecycle: "destroying",
      receiptCount: 0,
      operatorReconciliationRequired: 0,
      repairRequired: true,
      nextActionAt: null,
    },
  });
  expect(receipt.events).toEqual(["receipt.inspect", "receipt.inspect"]);

  expect(
    await provider.managedObjectBucketReceiptStatus({
      identity: { ...identity, generation: "10" },
      bucketName,
    }),
  ).toMatchObject({ ok: false, failure: { code: "conflict", retryable: false } });
  expect(receipt.events).toEqual(["receipt.inspect", "receipt.inspect"]);
});

test("managed ObjectBucket support refuses incomplete receipt authority at composition", () => {
  const backend = managedBackend(createEphemeralSql());
  const {
    objectReceiptWorkerName: _receiptWorkerName,
    objectReceiptAuthority: _receiptAuthority,
    ...withoutReceiptAuthority
  } = backend;
  expect(
    () =>
      new CloudflareProvider({
        id: "cloudflare.wfp.integration",
        accountId: "acct_1",
        offerings: [objectBucketOffering],
        artifacts,
        authorize: () => "Bearer test-token",
        workerBackend: withoutReceiptAuthority,
      }),
  ).toThrow("managed ObjectBucket offerings require complete receipt authority");

  expect(
    () =>
      new CloudflareProvider({
        id: "cloudflare.wfp.integration",
        accountId: "acct_1",
        offerings: [offering],
        artifacts,
        authorize: () => "Bearer test-token",
        workerBackend: {
          ...withoutReceiptAuthority,
          objectReceiptAuthority: missingObjectReceiptAuthority,
        },
      }),
  ).toThrow("managed ObjectBucket receipt authority must be configured as one complete capability");
});

test("managed backend mode captures legacy and drifted Worker offerings before ordinary APIs", async () => {
  const calls: string[] = [];
  const legacyWorker: ProviderOffering = {
    ...offering,
    id: "cloudflare.legacy.worker",
    kind: "worker_script",
  };
  const driftedModule: ProviderOffering = {
    ...offering,
    id: "cloudflare.drifted.module-worker",
    form: { ...offering.form, apiVersion: "untrusted.forms.test/v1" },
  };
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [legacyWorker, customDomainOffering, driftedModule],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: managedBackend(createEphemeralSql()),
    async fetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      throw new Error("managed mode must reject ordinary Worker placement before Cloudflare I/O");
    },
  });
  const identity = {
    tenantRef: "organization_yurucommu",
    space: "production",
    name: "legacy",
    uid: "worker_legacy",
  };

  for (const managedOnlyOffering of [legacyWorker, customDomainOffering, driftedModule]) {
    const applyInput = {
      operationId: `reject-${managedOnlyOffering.id}`,
      operationMode: "initial" as const,
      offering: managedOnlyOffering,
      identity,
      spec: {},
    };
    expect(await provider.apply(applyInput)).toMatchObject({ phase: "failed" });
    expect(await provider.recoverApply({ ...applyInput, operationMode: "recovery" })).toMatchObject(
      { phase: "failed" },
    );
    expect(
      await provider.observe({
        offering: managedOnlyOffering,
        nativeId: "worker:legacy",
        identity,
        spec: {},
      }),
    ).toMatchObject({ phase: "failed" });
    const deleteInput = {
      operationId: `delete-${managedOnlyOffering.id}`,
      operationMode: "initial" as const,
      offering: managedOnlyOffering,
      nativeId: "worker:legacy",
      identity,
      spec: {},
    };
    expect(await provider.delete(deleteInput)).toMatchObject({ phase: "failed" });
    expect(
      await provider.recoverDelete?.({ ...deleteInput, operationMode: "recovery" }),
    ).toMatchObject({ phase: "failed" });
  }
  expect(calls).toEqual([]);
});

test("every managed Worker lifecycle avoids ordinary customer Worker APIs", async () => {
  const calls: string[] = [];
  const managedOfferings = [
    offering,
    versionOffering,
    deploymentOffering,
    endpointOffering,
    cronOffering,
    queueConsumerOffering,
  ];
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: managedOfferings,
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: managedBackend(createEphemeralSql()),
    async fetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      throw new Error("incomplete managed resources must not reach ordinary Worker APIs");
    },
  });

  for (const [index, managedOffering] of managedOfferings.entries()) {
    const identity = {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: `managed-${index}`,
      uid: `managed_resource_${index}`,
    };
    const applyInput = {
      operationId: `managed-lifecycle-${index}`,
      operationMode: "initial" as const,
      offering: managedOffering,
      identity,
      spec: {},
    };
    await provider.apply(applyInput);
    await provider.recoverApply({ ...applyInput, operationMode: "recovery" });
    await provider.observe({
      offering: managedOffering,
      nativeId: `managed:absent-${index}`,
      identity,
      spec: {},
    });
    const deleteInput = {
      operationId: `managed-delete-${index}`,
      operationMode: "initial" as const,
      offering: managedOffering,
      nativeId: `managed:absent-${index}`,
      identity,
      spec: {},
    };
    await provider.delete(deleteInput);
    await provider.recoverDelete?.({ ...deleteInput, operationMode: "recovery" });
  }

  expect(calls).toEqual([]);
});

test("managed lifecycle maps malformed durable authority to fail-closed provider evidence", async () => {
  const malformedReceiptSql = readSql(() => [
    {
      resource_uid: "worker_broken",
      native_id: "worker:broken",
      kind: "worker",
      logical_worker_id: "broken",
      operation_id: "allocate-broken",
      generation: 1,
      descriptor_digest: `sha256:${"1".repeat(64)}`,
      state: "committed",
      provider_etag: null,
      observed_json: "[]",
      previous_json: null,
    },
  ]);
  const receiptProvider = providerWithSql(malformedReceiptSql);
  const workerIdentity = {
    tenantRef: "organization_yurucommu",
    space: "production",
    name: "broken",
    uid: "worker_broken",
  };
  expect(
    await receiptProvider.observe({
      offering,
      nativeId: "worker:broken",
      identity: workerIdentity,
      spec: {},
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "provider_error" } });
  const descriptor = receiptProvider.createNativeReadbackDescriptor?.({
    offering,
    nativeId: "worker:broken",
    identity: workerIdentity,
    spec: {},
  });
  if (!descriptor) throw new Error("readback descriptor is unavailable");
  expect(await receiptProvider.verifyNativeAbsence?.({ offering, descriptor })).toEqual({
    outcome: "unknown",
    reason: "malformed",
    retryable: false,
  });

  const validReceipt = {
    resource_uid: "worker_valid",
    native_id: "worker:valid",
    kind: "worker",
    logical_worker_id: "valid",
    operation_id: "allocate-valid",
    generation: 1,
    descriptor_digest: `sha256:${"2".repeat(64)}`,
    state: "committed",
    provider_etag: null,
    observed_json: '{"allocated":true,"scriptName":"valid"}',
    previous_json: null,
  };
  const malformedRouteSql = readSql((statement) =>
    statement.includes("cloudflare_managed_worker_receipts")
      ? [validReceipt]
      : [
          {
            route_key: "worker/v1/valid",
            owner_native_id: "deployment:valid",
            generation: 1,
            operation_id: "route-valid",
            state: "active",
            value_json: "[]",
          },
        ],
  );
  const routeProvider = providerWithSql(malformedRouteSql);
  expect(
    await routeProvider.delete({
      operationId: "delete-valid",
      operationMode: "initial",
      offering,
      nativeId: "worker:valid",
      identity: { ...workerIdentity, uid: "worker_valid", name: "valid" },
      spec: {},
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "provider_error" } });
});

test("managed Worker Versions use immutable dispatch scripts and exact readback paths", async () => {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  let settings: Readonly<Record<string, unknown>> | undefined;
  let releaseScript: string | undefined;
  let uploadedContent: ArrayBuffer | undefined;
  let uploadedContentType: string | undefined;
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [offering, versionOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(createEphemeralSql()),
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.clone().text();
      calls.push({ method: request.method, path: url.pathname, body });
      const scriptMatch = url.pathname.match(
        /\/workers\/dispatch\/namespaces\/takoserver-customers\/scripts\/([^/]+)$/u,
      );
      if (request.method === "PUT" && scriptMatch) {
        releaseScript = decodeURIComponent(scriptMatch[1] ?? "");
        uploadedContent = await request.clone().arrayBuffer();
        uploadedContentType = request.headers.get("content-type") ?? undefined;
        const form = await request.formData();
        const metadata = form.get("metadata");
        settings = JSON.parse(
          typeof metadata === "string" ? metadata : await (metadata as Blob).text(),
        ) as Readonly<Record<string, unknown>>;
        expect(settings.main_module).toMatch(/^__takoserver_managed_worker_entrypoint/u);
        expect(await (form.get(String(settings.main_module)) as Blob).text()).toContain(
          "takoserver.managed-worker-event@v1",
        );
        return Response.json({
          success: true,
          result: { script: { id: releaseScript, etag: "etag-release-1" } },
        });
      }
      if (request.method === "GET" && url.pathname.endsWith("/content")) {
        return new Response(uploadedContent, {
          headers: { "content-type": uploadedContentType ?? "application/octet-stream" },
        });
      }
      if (request.method === "GET" && url.pathname.endsWith("/settings")) {
        return Response.json({ success: true, result: settings });
      }
      if (request.method === "GET" && url.pathname.endsWith("/secrets")) {
        return Response.json({ success: true, result: [] });
      }
      if (request.method === "GET" && scriptMatch) {
        return Response.json({
          success: true,
          result: { script: { id: releaseScript, etag: "etag-release-1" } },
        });
      }
      throw new Error(`unexpected Cloudflare call: ${request.method} ${url.pathname}`);
    },
  });

  const ticket = await provider.apply({
    operationId: "release-yurucommu-v1",
    operationMode: "initial",
    offering: versionOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: "v1",
      uid: "version_yurucommu_v1",
    },
    spec: { handlers: ["fetch", "queue", "scheduled"] },
    relations: [
      related("/worker", stored("ModuleWorker", "worker_yurucommu", {}), {
        nativeId: "worker:tsw-logical-yurucommu",
        offeringId: offering.id,
        outputs: { scriptName: "tsw-logical-yurucommu" },
      }),
      related(
        "/bundle",
        stored("WorkerBundle", "bundle_yurucommu_v1", { manifestDigest: bundleDigest }),
      ),
    ],
  });

  expect(ticket).toMatchObject({
    phase: "succeeded",
    result: {
      nativeId: expect.stringMatching(/^version:tsw-logical-yurucommu:tsr-[0-9a-f]{64}$/u),
      outputs: {
        scriptName: "tsw-logical-yurucommu",
        versionId: expect.stringMatching(/^tsr-[0-9a-f]{64}$/u),
      },
    },
  });
  expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    expect.stringMatching(
      /^PUT \/client\/v4\/accounts\/acct_1\/workers\/dispatch\/namespaces\/takoserver-customers\/scripts\/tsr-/u,
    ),
    expect.stringMatching(
      /^GET \/client\/v4\/accounts\/acct_1\/workers\/dispatch\/namespaces\/takoserver-customers\/scripts\/tsr-/u,
    ),
    expect.stringMatching(/\/content$/u),
    expect.stringMatching(/\/settings$/u),
    expect.stringMatching(/\/secrets$/u),
  ]);
  expect(calls.every(({ path }) => !path.includes("/workers/scripts/"))).toBe(true);
  expect(JSON.stringify(ticket)).not.toContain("workers.dev");
  // ADR 0007's managed-lane amendment: the tenant user Worker is uploaded with
  // `disallow_importable_env`, and the readback refuses a release whose
  // settings do not carry it, so the raw internal bindings the wrapper holds
  // cannot be read back out of `cloudflare:workers`.
  expect(settings?.compatibility_flags).toEqual(["disallow_importable_env"]);
});

test("a managed release readback without the import fence is refused", async () => {
  const api = new ManagedReleaseApi();
  const provider = releaseProvider(api, createEphemeralSql());
  const input = managedVersionInput("version_no_fence", "release-no-fence", "tsw-no-fence");
  expect(await provider.apply(input)).toMatchObject({ phase: "succeeded" });

  const held = [...api.scripts.entries()][0];
  if (!held) throw new Error("managed release was not uploaded");
  const [scriptName, release] = held;
  const observeInput = {
    offering: versionOffering,
    identity: input.identity,
    spec: input.spec,
    nativeId: `version:tsw-no-fence:${scriptName}`,
    ...(input.relations === undefined ? {} : { relations: input.relations }),
  };
  expect(release.settings.compatibility_flags).toEqual(["disallow_importable_env"]);
  expect(await provider.observe(observeInput)).toMatchObject({ phase: "succeeded" });

  const { compatibility_flags: _dropped, ...withoutFence } = release.settings;
  api.scripts.set(scriptName, { ...release, settings: withoutFence });
  expect(await provider.observe(observeInput)).toMatchObject({
    phase: "failed",
    failure: { code: "provider_error" },
  });
});

test("managed Worker Versions bind SQLite through the gateway's exact exported DO class", async () => {
  const api = new ManagedReleaseApi();
  const provider = releaseProvider(api, createEphemeralSql());
  const input = managedVersionInput(
    "version_sqlite_binding",
    "release-sqlite-binding",
    "tsw-sqlite-binding",
  );
  const sqlite = related(
    "/sqliteBindings/0/resource",
    stored("SQLiteDatabase", "sqlite_binding", {}),
    {
      nativeId: "sqlite:sqlite-binding-instance",
      offeringId: sqliteOffering.id,
      outputs: { databaseId: "sqlite-binding-instance" },
    },
  );

  expect(
    await provider.apply({
      ...input,
      spec: { handlers: ["fetch"], sqliteBindings: [{ name: "DATABASE" }] },
      relations: [...(input.relations ?? []), sqlite],
    }),
  ).toMatchObject({ phase: "succeeded" });

  const release = [...api.scripts.values()][0];
  if (!release) throw new Error("managed release was not uploaded");
  expect(release.settings.bindings).toContainEqual({
    type: "durable_object_namespace",
    name: "__TAKOSERVER_SQLITE_0",
    class_name: "TakoserverManagedWorkerSqlite",
    script_name: "takoserver-dispatch",
  });
});

/**
 * The managed wrapper projects the public `edge.objects` facade over hidden R2
 * and provider-owned receipt capabilities. The receipt Durable Object, rather
 * than the customer Worker isolate, owns the multipart lifecycle across
 * eviction and restart.
 */
test("managed Worker Versions bind ObjectBucket through hidden R2 and receipt capabilities", async () => {
  const api = new ManagedReleaseApi();
  // The Provider Pack id (`cloudflare`) and installed authority id are distinct.
  // ObjectBucket relations are fenced by the latter, not by the adapter id.
  const provider = releaseProvider(api, createEphemeralSql(), true, "cloudflare");
  const input = managedVersionInput(
    "version_objects_binding",
    "release-objects-binding",
    "tsw-objects-binding",
  );
  const bucketName = `ts-${"a".repeat(40)}`;
  const bindingRef = {
    apiVersion: "bindings.takoform.com/v1alpha2",
    name: "module-worker.object-bucket",
    version: "1.1.0",
    schemaDigest: "sha256:ff8661459b73a8d229e0915c698afad2aa297b5db90fe5e1693d346a7ae3adfb",
  } as const;
  const bucket: ProviderRelation = {
    ...related("/bucketBindings/0/resource", stored("ObjectBucket", "bucket_binding", {}), {
      nativeId: `r2:${bucketName}`,
      offeringId: "storage.object.cloudflare",
      outputs: { bucketName },
    }),
    bindingRef,
  };
  const bucketBindings = [
    {
      name: "MEDIA",
      resource: {
        apiVersion: "edge.forms.takoform.com",
        kind: "ObjectBucket",
        name: "objectbucket",
      },
    },
  ];
  const runtimeBindings = [
    {
      name: "MEDIA",
      targetUid: "bucket_binding",
      bindingRef,
      material: { kind: "takoserver.cloudflare-r2.edge-objects@v1", bucketName },
    },
  ];

  const versionSpec = {
    ...input.spec,
    bucketBindings,
  };
  const versionRelations = [...(input.relations ?? []), bucket];
  const ticket = await provider.apply({
    ...input,
    spec: versionSpec,
    relations: versionRelations,
    runtimeBindings,
  });

  expect(ticket).toMatchObject({ phase: "succeeded" });
  const release = [...api.scripts.values()][0];
  expect(release?.settings).toMatchObject({
    compatibility_flags: ["disallow_importable_env"],
    bindings: [
      {
        type: "r2_bucket",
        name: "__TAKOSERVER_OBJECTS_0",
        bucket_name: bucketName,
      },
      {
        type: "durable_object_namespace",
        name: "__TAKOSERVER_OBJECT_RECEIPTS_0",
        class_name: "TakoserverManagedObjectReceipt",
        script_name: "takoserver-managed-object-receipt-authority",
      },
    ],
  });
  // Provider-native bucket identity stays out of the public ticket.
  expect(JSON.stringify(ticket)).not.toContain(bucketName);
  const versionNativeId = succeededNativeId(ticket);

  // Observe reconstructs the provider-private binding closure from the same
  // pinned Resource relation. Runtime material is intentionally an apply-only
  // input and cannot be required for later lifecycle readback.
  expect(
    await provider.observe({
      offering: versionOffering,
      nativeId: versionNativeId,
      identity: input.identity,
      spec: versionSpec,
      relations: versionRelations,
    }),
  ).toMatchObject({ phase: "succeeded" });

  // A materialized Binding the Version never declared is refused before an
  // upload or any other Cloudflare mutation.
  api.scripts.clear();
  const undeclared = managedVersionInput(
    "version_objects_undeclared",
    "release-objects-undeclared",
    "tsw-objects-undeclared",
  );
  expect(
    await provider.apply({
      ...undeclared,
      relations: [...(undeclared.relations ?? []), bucket],
      runtimeBindings: [
        {
          name: "MEDIA",
          targetUid: "bucket_binding",
          bindingRef,
          material: { kind: "takoserver.cloudflare-r2.edge-objects@v1", bucketName },
        },
      ],
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
  expect(api.scripts.size).toBe(0);

  // A relation for another tenant is not authority over this Version even
  // when its R2 material is otherwise internally consistent.
  const malformed = managedVersionInput(
    "version_objects_malformed",
    "release-objects-malformed",
    "tsw-objects-malformed",
  );
  const foreign = {
    ...bucket,
    deployment: { ...bucket.deployment, tenantId: "organization_other" },
  } as ProviderRelation;
  expect(foreign.deployment?.tenantId).toBe("organization_other");
  expect(
    await provider.apply({
      ...malformed,
      spec: { ...malformed.spec, bucketBindings },
      relations: [...(malformed.relations ?? []), foreign],
      runtimeBindings,
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
  expect(api.scripts.size).toBe(0);

  // Namespace/kind text is insufficient authority: a retained or fabricated
  // Form definition cannot be used to materialize the current ObjectBucket
  // Binding even when every provider-native field still matches.
  const staleForm = {
    ...bucket,
    resource: {
      ...bucket.resource,
      form: {
        formRef: {
          ...bucket.resource.form.formRef,
          definitionVersion: "0.0.1",
        },
      },
    },
  } as ProviderRelation;
  expect(
    await provider.apply({
      ...malformed,
      operationId: "release-objects-stale-form",
      spec: { ...malformed.spec, bucketBindings },
      relations: [...(malformed.relations ?? []), staleForm],
      runtimeBindings,
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
  expect(api.scripts.size).toBe(0);

  // An otherwise-valid relation cannot hide a second claimant for the same
  // pointer. Authority is a unique Host relation, never first-match wins.
  expect(
    await provider.apply({
      ...malformed,
      operationId: "release-objects-duplicate-relation",
      spec: { ...malformed.spec, bucketBindings },
      relations: [...versionRelations, foreign],
      runtimeBindings,
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
  expect(api.scripts.size).toBe(0);

  // Relation closure also precedes a one-shot runtime-input lease claim. A
  // malformed ObjectBucket relation must not consume or erase unrelated
  // secret material while failing the Version before Cloudflare I/O.
  let acquireCalls = 0;
  const guardedApi = new ManagedReleaseApi();
  const runtimeInputs: ProviderRuntimeInputLeasePort = {
    async acquire() {
      acquireCalls++;
      throw new Error("malformed relation must not acquire a runtime-input lease");
    },
    async recover() {
      throw new Error("initial apply must not recover a runtime-input lease");
    },
    async abandon() {
      throw new Error("unclaimed runtime-input material must not be abandoned");
    },
  };
  const guardedProvider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [offering, versionOffering, objectBucketOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(createEphemeralSql(), guardedApi.inspectRelease),
    runtimeInputs,
    fetch: guardedApi.fetch,
  });
  const guardedMalformed = managedVersionInput(
    "version_objects_guarded_malformed",
    "release-objects-guarded-malformed",
    "tsw-objects-guarded-malformed",
  );
  expect(
    await guardedProvider.apply({
      ...guardedMalformed,
      operationKey: `takoform-worker-runtime-v1-${"e".repeat(64)}`,
      publicApply: {
        method: "PUT",
        path: "/apis/forms.takoform.com/v1/resources/edge.forms.takoform.com/WorkerVersion/version_objects_guarded_malformed",
        ifNoneMatch: "*",
        body: "{}",
      },
      spec: {
        ...guardedMalformed.spec,
        requiredSensitiveVars: ["API_KEY"],
        bucketBindings,
      },
      relations: [...(guardedMalformed.relations ?? []), foreign],
      runtimeBindings,
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
  expect(acquireCalls).toBe(0);
  expect(guardedApi.scripts.size).toBe(0);

  // Deletion has the same durable reconstruction path and does not need the
  // ephemeral apply-time material after the native release is already absent.
  expect(
    await provider.delete({
      operationId: "delete-release-objects-binding",
      operationMode: "initial",
      offering: versionOffering,
      nativeId: versionNativeId,
      identity: input.identity,
      spec: versionSpec,
      relations: versionRelations,
    }),
  ).toMatchObject({ phase: "succeeded", result: { disposition: "deleted" } });
});

test("release readiness failure cleans the exact artifact and permits a fresh operation", async () => {
  const api = new ManagedReleaseApi();
  api.inspectionFailure = true;
  const sql = createEphemeralSql();
  const provider = releaseProvider(api, sql);
  const input = managedVersionInput("version_readiness", "release-readiness", "tsw-readiness");
  expect(await provider.apply(input)).toMatchObject({
    phase: "failed",
    failure: { code: "provider_error" },
  });
  expect(api.scripts.size).toBe(0);
  expect(api.calls.some((call) => call.startsWith("DELETE "))).toBe(true);
  expect(
    await sql.query(
      "SELECT resource_uid FROM cloudflare_managed_worker_receipts WHERE provider_id = ?",
      ["cloudflare.wfp.integration"],
    ),
  ).toEqual([]);

  api.inspectionFailure = false;
  expect(
    await provider.apply({ ...input, operationId: "release-readiness-restart" }),
  ).toMatchObject({ phase: "succeeded" });
});

test("release pending receipts recover from no upload and definitive 4xx without poisoning identity", async () => {
  const api = new ManagedReleaseApi();
  const sql = createEphemeralSql();
  const provider = releaseProvider(api, sql);
  const lost = managedVersionInput("version_lost", "release-lost", "tsw-lost");
  api.uploadFailure = "transport";
  expect(await provider.apply(lost)).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  api.uploadFailure = "none";
  expect(await provider.recoverApply?.({ ...lost, operationMode: "recovery" })).toMatchObject({
    phase: "failed",
    failure: { code: "not_found" },
  });
  expect(await provider.apply({ ...lost, operationId: "release-lost-too-early" })).toMatchObject({
    phase: "failed",
    failure: { code: "conflict" },
  });
  expect(await provider.convergeApply?.({ ...lost, operationMode: "recovery" })).toMatchObject({
    phase: "failed",
    failure: { code: "not_found" },
  });
  expect(await provider.apply({ ...lost, operationId: "release-lost-restart" })).toMatchObject({
    phase: "succeeded",
  });

  const rejected = managedVersionInput("version_4xx", "release-4xx", "tsw-4xx");
  api.uploadFailure = "rejected";
  expect(await provider.apply(rejected)).toMatchObject({
    phase: "failed",
    failure: { code: "provider_error" },
  });
  api.uploadFailure = "none";
  expect(await provider.apply({ ...rejected, operationId: "release-4xx-restart" })).toMatchObject({
    phase: "succeeded",
  });
});

test("pending upload adoption stays closed until the exact namespace readback is rehearsed", async () => {
  const api = new ManagedReleaseApi();
  const sql = createEphemeralSql();
  const input = managedVersionInput("version_ack_lost", "release-ack-lost", "tsw-ack-lost");
  const unqualified = releaseProvider(api, sql, false);
  api.uploadFailure = "lost-ack";
  expect(await unqualified.apply(input)).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(api.scripts.size).toBe(1);
  expect(await unqualified.recoverApply?.({ ...input, operationMode: "recovery" })).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(api.calls.some((call) => call.endsWith("/content"))).toBe(false);

  const qualified = releaseProvider(api, sql, true);
  expect(await qualified.recoverApply?.({ ...input, operationMode: "recovery" })).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(api.calls.some((call) => call.endsWith("/content"))).toBe(false);
  expect(await qualified.convergeApply?.({ ...input, operationMode: "recovery" })).toMatchObject({
    phase: "succeeded",
  });
  expect(api.calls.some((call) => call.endsWith("/content"))).toBe(true);
});

test("committed releases fence ETag/content drift and delete ack loss by GET absence", async () => {
  const api = new ManagedReleaseApi();
  const sql = createEphemeralSql();
  const provider = releaseProvider(api, sql);
  const input = managedVersionInput("version_delete", "release-delete", "tsw-delete");
  const applied = await provider.apply(input);
  const nativeId = succeededNativeId(applied);
  const scriptName = nativeId.split(":").at(-1);
  if (!scriptName) throw new Error("release script is missing");
  const original = api.scripts.get(scriptName);
  if (!original) throw new Error("release script is missing");
  api.scripts.set(scriptName, {
    ...original,
    etag: "etag-recreated",
  });
  expect(await provider.apply(input)).toMatchObject({
    phase: "failed",
    failure: { code: "provider_error" },
  });
  const held = api.scripts.get(scriptName);
  if (!held) throw new Error("release script is missing");
  api.scripts.set(scriptName, { ...held, etag: "etag-1" });
  const drifted = api.scripts.get(scriptName);
  if (!drifted) throw new Error("release script is missing");
  api.scripts.set(scriptName, {
    ...drifted,
    content: new TextEncoder().encode("not multipart").buffer,
    contentType: "multipart/form-data; boundary=broken",
  });
  expect(await provider.apply(input)).toMatchObject({
    phase: "failed",
    failure: { code: "provider_error" },
  });
  api.scripts.set(scriptName, original);

  api.deleteLosesAck = true;
  expect(
    await provider.delete({
      operationId: "release-delete-operation",
      operationMode: "initial",
      offering: versionOffering,
      nativeId,
      identity: input.identity,
      spec: input.spec,
      ...(input.relations ? { relations: input.relations } : {}),
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });
  expect(
    await provider.recoverDelete?.({
      operationId: "release-delete-operation",
      operationMode: "recovery",
      offering: versionOffering,
      nativeId,
      identity: input.identity,
      spec: input.spec,
      ...(input.relations ? { relations: input.relations } : {}),
    }),
  ).toMatchObject({
    phase: "succeeded",
    result: { disposition: "deleted" },
  });
  expect(api.calls.some((call) => call.startsWith("DELETE "))).toBe(true);
  expect(api.calls.some((call) => call.includes("if-match"))).toBe(false);
});

test("managed SQLite lifecycle uses one closed direct authority and byte migrations", async () => {
  const sql = createEphemeralSql();
  const sqlite = new ManagedSqliteFake();
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [sqliteOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: {
      ...managedBackend(sql),
      sqliteNamespace: { getByName: () => sqlite },
    },
    fetch: async () => {
      throw new Error("managed SQLite must not call D1 or a public HTTP admin path");
    },
  });
  const identity = {
    tenantRef: "organization_yurucommu",
    space: "production",
    name: "main",
    uid: "sqlite_main",
  };
  const applied = await provider.apply({
    operationId: "sqlite-create",
    operationMode: "initial",
    offering: sqliteOffering,
    identity,
    spec: {},
  });
  const nativeId = succeededNativeId(applied);
  expect(nativeId).toBe("sqlite:sqlite-sqlite_main");
  expect(sqlite.authority).toEqual({
    providerId: "cloudflare.wfp.integration",
    resourceUid: "sqlite_main",
    generation: "1",
    operationId: expect.stringMatching(/^sqlite-[0-9a-f]{64}$/u),
    descriptorDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
  });
  expect(sqlite.unsealedCalls).toBe(0);

  const migrationSql = new TextEncoder().encode("CREATE TABLE notes (id TEXT PRIMARY KEY)");
  const migrationDigest = `sha256:${hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", migrationSql)),
  )}` as const;
  expect(
    await provider.sqliteMigrations?.applySuffix({
      nativeId,
      expectedPrefix: [],
      migrations: [{ path: "0001_notes.sql", digest: migrationDigest, sql: migrationSql }],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(sqlite.lastMigrationBytes).toBeInstanceOf(Uint8Array);
  expect(await provider.sqliteMigrations?.readLedger({ nativeId })).toEqual({
    ok: true,
    value: [{ path: "0001_notes.sql", digest: migrationDigest }],
  });
  expect(
    await provider.observe({
      offering: sqliteOffering,
      nativeId,
      identity,
      spec: {},
    }),
  ).toMatchObject({ phase: "succeeded" });
  sqlite.destroyLosesAck = true;
  const deleteInput = {
    operationId: "sqlite-delete",
    operationMode: "initial" as const,
    offering: sqliteOffering,
    nativeId,
    identity,
    spec: {},
  };
  expect(await provider.delete(deleteInput)).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(
    await provider.recoverDelete?.({
      ...deleteInput,
      operationMode: "recovery",
    }),
  ).toMatchObject({ phase: "succeeded", result: { disposition: "deleted" } });
  expect(sqlite.destroyed).toBe(true);
});

test("managed SQLite never initializes after an indeterminate authority read", async () => {
  const sqlite = new ManagedSqliteFake();
  sqlite.inspectFailure = "backend_unavailable";
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [sqliteOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: {
      ...managedBackend(createEphemeralSql()),
      sqliteNamespace: { getByName: () => sqlite },
    },
    fetch: async () => {
      throw new Error("managed SQLite must not call D1 or a public HTTP admin path");
    },
  });
  const identity = {
    tenantRef: "organization_yurucommu",
    space: "production",
    name: "indeterminate",
    uid: "sqlite_indeterminate",
  };
  expect(
    await provider.apply({
      operationId: "sqlite-never-initialize",
      operationMode: "initial",
      offering: sqliteOffering,
      identity,
      spec: {},
    }),
  ).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(sqlite.initializeCalls).toBe(0);
});

test("deployment promotion changes only the logical release route and keeps the hostname", async () => {
  const calls: string[] = [];
  const sql = createEphemeralSql();
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [offering, versionOffering, deploymentOffering, endpointOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(sql),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      throw new Error(`unexpected Cloudflare call: ${request.method} ${path}`);
    },
  });
  const worker = related("/worker", stored("ModuleWorker", "worker_yurucommu", {}), {
    nativeId: "worker:tsw-logical-yurucommu",
    offeringId: offering.id,
    outputs: { scriptName: "tsw-logical-yurucommu" },
  });
  const version = (name: string, release: string) =>
    related(`/versions/0/workerVersion`, stored("WorkerVersion", name, {}), {
      nativeId: `version:tsw-logical-yurucommu:${release}`,
      offeringId: versionOffering.id,
      outputs: { scriptName: "tsw-logical-yurucommu", versionId: release },
    });
  const state = new ManagedWorkerState("cloudflare.wfp.integration", sql);
  await seedManagedVersion(state, "version:tsw-logical-yurucommu:tsr-release-v1", "seed-v1");
  await seedManagedVersion(state, "version:tsw-logical-yurucommu:tsr-release-v2", "seed-v2");

  const first = await provider.apply({
    operationId: "deploy-yurucommu-v1",
    operationMode: "initial",
    offering: deploymentOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: "live-v1",
      uid: "deployment_yurucommu_v1",
    },
    spec: { versions: [{ weight: 10_000 }] },
    relations: [worker, version("version_v1", "tsr-release-v1")],
  });
  expect(first.phase).toBe("succeeded");

  const reservedHostname = "yurucommu-reserved.app-staging.takos.jp";
  const endpoint = await provider.apply({
    operationId: "endpoint-yurucommu",
    operationMode: "initial",
    offering: endpointOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: "official",
      uid: "endpoint_yurucommu",
    },
    spec: {},
    relations: [worker],
    workerEndpointOriginAssignment: {
      canonicalPublicOrigin: `https://${reservedHostname}`,
      assignmentDigest: `sha256:${"e".repeat(64)}`,
    },
  });
  expect(endpoint).toMatchObject({
    phase: "succeeded",
    result: {
      outputs: {
        hostname: reservedHostname,
        url: `https://${reservedHostname}/`,
      },
    },
  });
  expect(await state.activeRoutes("host")).toHaveLength(1);

  // The hostname comes only from the Host's exact private assignment. A later
  // deployment promotion may update the logical Worker route, never this host route.
  const [hostAuthority] = await sql.query(
    `SELECT generation, state, value_json FROM cloudflare_managed_worker_routes
     WHERE provider_id = ? AND route_kind = 'host' AND route_key = ?`,
    ["cloudflare.wfp.integration", managedWorkerHostRouteKey(reservedHostname)],
  );

  const promoted = await provider.apply({
    operationId: "deploy-yurucommu-v2",
    operationMode: "initial",
    offering: deploymentOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: "live-v1",
      uid: "deployment_yurucommu_v1",
    },
    spec: { versions: [{ weight: 10_000 }] },
    previous: {
      nativeId: first.phase === "succeeded" ? first.result.nativeId : "invalid",
      spec: { versions: [{ weight: 10_000 }] },
    },
    relations: [worker, version("version_v2", "tsr-release-v2")],
  });
  expect(promoted.phase).toBe("succeeded");
  expect(
    await sql.query(
      `SELECT generation, state, value_json FROM cloudflare_managed_worker_routes
       WHERE provider_id = ? AND route_kind = 'host' AND route_key = ?`,
      ["cloudflare.wfp.integration", managedWorkerHostRouteKey(reservedHostname)],
    ),
  ).toEqual(hostAuthority ? [hostAuthority] : []);
  const [releaseAuthority] = await sql.query(
    `SELECT generation, state, value_json FROM cloudflare_managed_worker_routes
     WHERE provider_id = ? AND route_kind = 'worker' AND route_key = ?`,
    ["cloudflare.wfp.integration", "worker/v1/tsw-logical-yurucommu"],
  );
  expect(releaseAuthority).toMatchObject({ generation: 2, state: "active" });
  expect(JSON.parse(String(releaseAuthority?.value_json ?? "{}"))).toEqual({
    deploymentId: expect.stringMatching(/^deployment:tsw-logical-yurucommu:tsd-[0-9a-f]{64}$/u),
    generation: 2,
    releases: [{ percentage: 100, scriptName: "tsr-release-v2" }],
    schema: "takoserver.managed-worker-release-route@v1",
  });

  const endpointDelete = {
    operationId: "delete-endpoint-yurucommu",
    operationMode: "initial" as const,
    offering: endpointOffering,
    nativeId: "endpoint:endpoint_yurucommu",
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: "official",
      uid: "endpoint_yurucommu",
    },
    spec: {},
    relations: [worker],
  };
  expect(await provider.delete(endpointDelete)).toMatchObject({
    phase: "succeeded",
    result: {
      nativeId: "endpoint:endpoint_yurucommu",
      disposition: "deleted",
    },
  });
  expect(await state.activeRoutes("host")).toEqual([]);
  expect(await state.receiptByResourceUid("endpoint_yurucommu")).toMatchObject({
    state: "deleted",
    nativeId: "endpoint:endpoint_yurucommu",
  });
  expect(
    await sql.query(
      `SELECT state FROM cloudflare_managed_worker_routes
       WHERE provider_id = ? AND route_kind = 'host' AND route_key = ?`,
      ["cloudflare.wfp.integration", managedWorkerHostRouteKey(reservedHostname)],
    ),
  ).toEqual([{ state: "tombstone" }]);
  expect(
    await provider.recoverDelete({ ...endpointDelete, operationMode: "recovery" }),
  ).toMatchObject({
    phase: "succeeded",
    result: {
      nativeId: "endpoint:endpoint_yurucommu",
      disposition: "deleted",
    },
  });
  expect(calls).toEqual([]);
});

test("Queue and Schedule triggers attach only the Takoserver gateway and route through D1", async () => {
  const sql = createEphemeralSql();
  const calls: Array<{ method: string; path: string; body: string }> = [];
  let schedules: string[] = [];
  let queueConsumer: Readonly<Record<string, unknown>> | undefined;
  let nextQueueConsumerId = "consumer-gateway";
  let queueCreateLosesProcess = false;
  let failNextQueueList = false;
  let queueDeleteLosesAck = false;
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [offering, cronOffering, queueConsumerOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(sql),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.clone().text();
      calls.push({ method: request.method, path, body });
      if (path.endsWith("/workers/scripts/takoserver-dispatch/schedules")) {
        if (request.method === "GET") {
          return Response.json({
            success: true,
            result: schedules.map((cron) => ({ cron })),
          });
        }
        schedules = (JSON.parse(body) as Array<{ cron: string }>).map(({ cron }) => cron);
        return Response.json({ success: true, result: schedules });
      }
      if (path.endsWith("/queues/queue-id/consumers")) {
        if (request.method === "GET") {
          if (failNextQueueList) {
            failNextQueueList = false;
            throw new Error("consumer list transport closed after create");
          }
          return Response.json({
            success: true,
            result: queueConsumer ? [queueConsumer] : [],
          });
        }
        queueConsumer = {
          ...(JSON.parse(body) as Readonly<Record<string, unknown>>),
          consumer_id: nextQueueConsumerId,
        };
        if (queueCreateLosesProcess) {
          queueCreateLosesProcess = false;
          failNextQueueList = true;
          throw new Error("consumer create transport closed after commit");
        }
        return Response.json({
          success: true,
          result: { consumer_id: nextQueueConsumerId },
        });
      }
      const queueConsumerId = path.match(/\/queues\/queue-id\/consumers\/([^/]+)$/u)?.[1];
      if (queueConsumerId) {
        if (request.method === "GET") {
          return queueConsumer?.consumer_id === queueConsumerId
            ? Response.json({ success: true, result: queueConsumer })
            : Response.json({ success: false }, { status: 404 });
        }
        if (request.method === "DELETE") {
          queueConsumer = undefined;
          if (queueDeleteLosesAck) {
            queueDeleteLosesAck = false;
            throw new Error("consumer delete transport closed after commit");
          }
          return new Response(null, { status: 204 });
        }
      }
      throw new Error(`unexpected Cloudflare call: ${request.method} ${path}`);
    },
  });
  const worker = related("/worker", stored("ModuleWorker", "worker_yurucommu", {}), {
    nativeId: "worker:tsw-logical-yurucommu",
    offeringId: offering.id,
    outputs: { scriptName: "tsw-logical-yurucommu" },
  });

  const cronApply = {
    operationId: "cron-yurucommu-minute",
    operationMode: "initial" as const,
    offering: cronOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: "minute",
      uid: "cron_yurucommu_minute",
    },
    spec: { cron: "* * * * *" },
    relations: [worker],
  };
  const cron = await provider.apply(cronApply);
  expect(cron.phase).toBe("succeeded");
  const cronNativeId = succeededNativeId(cron);
  schedules = [];
  const scheduleWritesBeforeReadback = calls.filter(
    ({ method, path }) =>
      method === "PUT" && path.endsWith("/workers/scripts/takoserver-dispatch/schedules"),
  ).length;
  expect(await provider.apply(cronApply)).toMatchObject({
    phase: "failed",
    failure: { code: "not_found" },
  });
  expect(schedules).toEqual([]);
  expect(
    calls.filter(
      ({ method, path }) =>
        method === "PUT" && path.endsWith("/workers/scripts/takoserver-dispatch/schedules"),
    ),
  ).toHaveLength(scheduleWritesBeforeReadback);
  schedules = ["* * * * *"];
  expect(await provider.apply(cronApply)).toMatchObject({ phase: "succeeded" });

  const queue = related("/queue", stored("AtLeastOnceQueue", "queue_yurucommu_jobs", {}), {
    nativeId: "queue:queue-id",
    offeringId: technical("AtLeastOnceQueue").id,
    outputs: { queueId: "queue-id", queueName: "tsq-yurucommu-jobs" },
  });
  const consumerApply = {
    operationId: "consumer-yurucommu-jobs",
    operationMode: "initial" as const,
    offering: queueConsumerOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: "jobs",
      uid: "consumer_yurucommu_jobs",
    },
    spec: {
      maxBatchSize: 10,
      maxBatchTimeoutSeconds: 5,
      maxRetries: 3,
      retryDelaySeconds: 1,
      maxConcurrency: 5,
    },
    relations: [worker, queue],
  };
  queueConsumer = {
    type: "worker",
    script_name: "takoserver-dispatch",
    settings: {
      batch_size: 10,
      max_wait_time_ms: 5_000,
      max_retries: 3,
      retry_delay: 1,
      max_concurrency: 5,
    },
    consumer_id: "preexisting-equal-closure",
  };
  expect(
    await provider.apply({ ...consumerApply, operationId: "consumer-must-not-adopt" }),
  ).toMatchObject({ phase: "failed", failure: { code: "conflict" } });
  expect(
    calls.filter(
      ({ method, path }) => method === "POST" && path.endsWith("/queues/queue-id/consumers"),
    ),
  ).toHaveLength(0);
  queueConsumer = undefined;

  queueCreateLosesProcess = true;
  expect(await provider.apply(consumerApply)).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  const consumer = await provider.convergeApply?.({
    ...consumerApply,
    operationMode: "recovery",
  });
  if (!consumer) throw new Error("managed provider missing convergence seam");
  expect(consumer).toMatchObject({
    phase: "succeeded",
    result: { nativeId: "consumer:queue-id:consumer-gateway" },
  });
  const consumerNativeId = succeededNativeId(consumer);

  const committedConsumer = {
    type: "worker",
    script_name: "takoserver-dispatch",
    settings: {
      batch_size: 10,
      max_wait_time_ms: 5_000,
      max_retries: 3,
      retry_delay: 1,
      max_concurrency: 5,
    },
    consumer_id: "consumer-gateway",
  } as const;
  expect(queueConsumer as Readonly<Record<string, unknown>> | undefined).toEqual(committedConsumer);
  queueConsumer = { ...committedConsumer, consumer_id: "consumer-recreated-same-closure" };
  expect(await provider.apply(consumerApply)).toMatchObject({
    phase: "failed",
    failure: { code: "not_found" },
  });
  queueConsumer = committedConsumer;

  expect(
    await provider.observe({
      offering: cronOffering,
      nativeId: cronNativeId,
      identity: {
        tenantRef: "organization_yurucommu",
        space: "production",
        name: "minute",
        uid: "cron_yurucommu_minute",
      },
      spec: { cron: "* * * * *" },
    }),
  ).toMatchObject({ phase: "succeeded" });
  expect(
    await provider.observe({
      offering: queueConsumerOffering,
      nativeId: consumerNativeId,
      identity: {
        tenantRef: "organization_yurucommu",
        space: "production",
        name: "jobs",
        uid: "consumer_yurucommu_jobs",
      },
      spec: {},
    }),
  ).toMatchObject({ phase: "succeeded" });

  const routes = await sql.query(
    `SELECT route_kind, route_key, state, value_json
     FROM cloudflare_managed_worker_routes
     WHERE provider_id = ? ORDER BY route_kind, route_key`,
    ["cloudflare.wfp.integration"],
  );
  expect(routes).toHaveLength(2);
  expect(
    routes.map(({ route_kind, route_key, state }) => ({ route_kind, route_key, state })),
  ).toEqual([
    { route_kind: "queue", route_key: "queue/v1/tsq-yurucommu-jobs", state: "active" },
    { route_kind: "schedule", route_key: "schedule/v1/*%20*%20*%20*%20*", state: "active" },
  ]);
  expect(queueConsumer).toMatchObject({ script_name: "takoserver-dispatch" });
  expect(calls.some(({ path }) => path.includes("tsw-logical-yurucommu"))).toBe(false);
  expect(calls.some(({ path }) => path.includes("/subdomain"))).toBe(false);

  const state = new ManagedWorkerState("cloudflare.wfp.integration", sql);
  expect(
    await state.beginReceiptDelete({
      resourceUid: "cron_yurucommu_minute",
      nativeId: cronNativeId,
      operationId: "cron-delete-after-process-loss",
    }),
  ).not.toBeNull();
  expect(
    await provider.recoverDelete?.({
      operationId: "cron-delete-after-process-loss",
      operationMode: "recovery",
      offering: cronOffering,
      nativeId: cronNativeId,
      identity: {
        tenantRef: "organization_yurucommu",
        space: "production",
        name: "minute",
        uid: "cron_yurucommu_minute",
      },
      spec: { cron: "* * * * *" },
    }),
  ).toMatchObject({ phase: "succeeded", result: { disposition: "deleted" } });
  expect(schedules).toEqual([]);

  const processLossDelete = {
    operationId: "consumer-delete-after-process-loss",
    operationMode: "recovery" as const,
    offering: queueConsumerOffering,
    nativeId: consumerNativeId,
    identity: consumerApply.identity,
    spec: {},
  };
  expect(
    await state.beginReceiptDelete({
      resourceUid: consumerApply.identity.uid,
      nativeId: consumerNativeId,
      operationId: processLossDelete.operationId,
    }),
  ).not.toBeNull();
  expect(await provider.recoverDelete?.(processLossDelete)).toMatchObject({
    phase: "succeeded",
    result: { disposition: "deleted" },
  });
  expect(queueConsumer).toBeUndefined();

  nextQueueConsumerId = "consumer-replacement";
  const replacementApply = {
    ...consumerApply,
    operationId: "consumer-yurucommu-jobs-replacement",
    identity: { ...consumerApply.identity, uid: "consumer_yurucommu_jobs_replacement" },
  };
  const replacement = await provider.apply(replacementApply);
  expect(replacement).toMatchObject({
    phase: "succeeded",
    result: { nativeId: "consumer:queue-id:consumer-replacement" },
  });
  expect(await provider.recoverDelete?.(processLossDelete)).toMatchObject({
    phase: "succeeded",
    result: { disposition: "deleted" },
  });
  expect(queueConsumer).toMatchObject({ consumer_id: "consumer-replacement" });

  queueDeleteLosesAck = true;
  const consumerDelete = {
    operationId: "consumer-delete-lost-ack",
    operationMode: "initial" as const,
    offering: queueConsumerOffering,
    nativeId: succeededNativeId(replacement),
    identity: replacementApply.identity,
    spec: {},
  };
  expect(await provider.delete(consumerDelete)).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(
    await provider.recoverDelete?.({ ...consumerDelete, operationMode: "recovery" }),
  ).toMatchObject({ phase: "succeeded", result: { disposition: "deleted" } });
  expect(queueConsumer).toBeUndefined();
  expect(
    await sql.query(
      `SELECT route_kind, state FROM cloudflare_managed_worker_routes
       WHERE provider_id = ? AND route_kind IN ('queue', 'schedule') ORDER BY route_kind`,
      ["cloudflare.wfp.integration"],
    ),
  ).toEqual([
    { route_kind: "queue", state: "tombstone" },
    { route_kind: "schedule", state: "tombstone" },
  ]);
  expect(
    calls
      .filter(({ path }) => path.includes("/workers/scripts/"))
      .every(({ path }) => path.includes("/workers/scripts/takoserver-dispatch/schedules")),
  ).toBe(true);
});

test("schedule reconciliation prevents an older whole-set PUT from overwriting a newer generation", async () => {
  const sql = createEphemeralSql();
  let schedules: string[] = [];
  let putCalls = 0;
  let firstPut = true;
  let loseNextPutAck = false;
  let releaseFirstPut = (): void => {
    throw new Error("first schedule PUT was not initialized");
  };
  const firstPutEntered = new Promise<void>((resolve) => {
    releaseFirstPut = resolve;
  });
  let unblockFirstPut = (): void => {
    throw new Error("first schedule PUT release was not initialized");
  };
  const firstPutRelease = new Promise<void>((resolve) => {
    unblockFirstPut = resolve;
  });
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [offering, cronOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(sql),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!path.endsWith("/workers/scripts/takoserver-dispatch/schedules")) {
        throw new Error(`unexpected Cloudflare call: ${request.method} ${path}`);
      }
      if (request.method === "GET") {
        return Response.json({
          success: true,
          result: schedules.map((cron) => ({ cron })),
        });
      }
      const desired = (await request.json()) as Array<{ cron: string }>;
      putCalls += 1;
      if (firstPut) {
        firstPut = false;
        releaseFirstPut();
        await firstPutRelease;
      }
      schedules = desired.map(({ cron }) => cron).sort();
      if (loseNextPutAck) {
        loseNextPutAck = false;
        throw new Error("schedule PUT acknowledgement was lost after commit");
      }
      return Response.json({ success: true, result: schedules });
    },
  });
  const worker = related("/worker", stored("ModuleWorker", "worker_schedule_fence", {}), {
    nativeId: "worker:tsw-schedule-fence",
    offeringId: offering.id,
    outputs: { scriptName: "tsw-schedule-fence" },
  });
  const cronInput = (suffix: string, cron: string) => ({
    operationId: `cron-generation-${suffix}`,
    operationMode: "initial" as const,
    offering: cronOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: `cron-${suffix}`,
      uid: `cron_generation_${suffix}`,
    },
    spec: { cron },
    relations: [worker],
  });
  const olderInput = cronInput("older", "1 * * * *");
  const newerInput = cronInput("newer", "2 * * * *");
  const older = provider.apply(olderInput);
  const started = await Promise.race([
    older.then((ticket) => ({ kind: "settled" as const, ticket })),
    firstPutEntered.then(() => ({ kind: "entered" as const })),
  ]);
  if (started.kind !== "entered") {
    throw new Error(`older schedule mutation settled early: ${JSON.stringify(started.ticket)}`);
  }
  const newerFirstAttempt = await provider.apply(newerInput);
  expect(newerFirstAttempt).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  unblockFirstPut();
  expect(await older).toMatchObject({ phase: "succeeded" });
  expect(schedules).toEqual(["1 * * * *", "2 * * * *"]);
  expect(
    await provider.convergeApply?.({ ...newerInput, operationMode: "recovery" }),
  ).toMatchObject({ phase: "succeeded" });
  expect(schedules).toEqual(["1 * * * *", "2 * * * *"]);
  loseNextPutAck = true;
  const ackLossInput = cronInput("ack-loss", "3 * * * *");
  expect(await provider.apply(ackLossInput)).toMatchObject({
    phase: "failed",
    failure: {
      code: "unavailable",
      retryable: false,
      message: "the gateway schedule mutation requires explicit operator reconciliation",
    },
  });
  expect(schedules).toEqual(["1 * * * *", "2 * * * *", "3 * * * *"]);
  const putsAfterAckLoss = putCalls;
  const status = await provider.managedScheduleReconciliationStatus();
  expect(status).toMatchObject({
    ok: true,
    value: {
      state: "operator_reconciliation_required",
      desiredGeneration: 3,
      appliedGeneration: 2,
      actualSchedules: ["1 * * * *", "2 * * * *", "3 * * * *"],
      ambiguousGeneration: 3,
      ambiguityReason: "mutation_indeterminate",
    },
  });
  if (!status.ok || status.value.state !== "operator_reconciliation_required") {
    throw new Error("schedule ambiguity status is unavailable");
  }
  expect(
    await provider.convergeApply?.({ ...ackLossInput, operationMode: "recovery" }),
  ).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: false },
  });
  expect(putCalls).toBe(putsAfterAckLoss);
  expect(
    await sql.query(
      `SELECT state FROM cloudflare_managed_worker_receipts
       WHERE provider_id = ? AND resource_uid = ?`,
      ["cloudflare.wfp.integration", ackLossInput.identity.uid],
    ),
  ).toEqual([{ state: "pending" }]);
  const proof = {
    operatorAcknowledgement: "operator-reviewed-provider-state",
    leaseToken: status.value.leaseToken as string,
    ambiguousGeneration: status.value.ambiguousGeneration as number,
    desiredGeneration: status.value.desiredGeneration as number,
    actualDigest: status.value.actualDigest,
    action: "accept-provider-state" as const,
  };
  expect(await provider.reconcileManagedSchedules(proof)).toMatchObject({
    ok: true,
    value: { state: "idle", appliedGeneration: 3 },
  });
  expect(
    await provider.convergeApply?.({ ...ackLossInput, operationMode: "recovery" }),
  ).toMatchObject({ phase: "succeeded" });
  expect(putCalls).toBe(putsAfterAckLoss);
  expect(await provider.reconcileManagedSchedules(proof)).toMatchObject({
    ok: false,
    failure: { code: "conflict" },
  });
  expect(
    await sql.query(
      `SELECT desired_generation, applied_generation, reconciliation_state,
              lease_token, lease_started_at, lease_until,
              ambiguous_generation, ambiguity_reason
       FROM cloudflare_managed_worker_schedule_reconciliation
       WHERE provider_id = ?`,
      ["cloudflare.wfp.integration"],
    ),
  ).toEqual([
    {
      desired_generation: 3,
      applied_generation: 3,
      reconciliation_state: "idle",
      lease_token: null,
      lease_started_at: null,
      lease_until: null,
      ambiguous_generation: null,
      ambiguity_reason: null,
    },
  ]);
});

test("an expired in-flight schedule PUT becomes operator-only and is never automatically stolen", async () => {
  const sql = createEphemeralSql();
  let schedules: string[] = [];
  let putCalls = 0;
  let entered = (): void => {
    throw new Error("schedule PUT did not enter");
  };
  const putEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = (): void => {
    throw new Error("schedule PUT release was not initialized");
  };
  const putRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [offering, cronOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(sql),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!path.endsWith("/workers/scripts/takoserver-dispatch/schedules")) {
        throw new Error(`unexpected Cloudflare call: ${request.method} ${path}`);
      }
      if (request.method === "GET") {
        return Response.json({
          success: true,
          result: schedules.map((cron) => ({ cron })),
        });
      }
      putCalls += 1;
      const desired = (await request.json()) as Array<{ cron: string }>;
      if (putCalls === 1) {
        entered();
        await putRelease;
      }
      schedules = desired.map(({ cron }) => cron).sort();
      return Response.json({ success: true, result: schedules });
    },
  });
  const worker = related("/worker", stored("ModuleWorker", "worker_schedule_expiry", {}), {
    nativeId: "worker:tsw-schedule-expiry",
    offeringId: offering.id,
    outputs: { scriptName: "tsw-schedule-expiry" },
  });
  const input = (suffix: string, cron: string) => ({
    operationId: `cron-expiry-${suffix}`,
    operationMode: "initial" as const,
    offering: cronOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: `cron-expiry-${suffix}`,
      uid: `cron_expiry_${suffix}`,
    },
    spec: { cron },
    relations: [worker],
  });
  const olderInput = input("older", "11 * * * *");
  const newerInput = input("newer", "22 * * * *");
  const older = provider.apply(olderInput);
  await putEntered;
  await sql.run(
    `UPDATE cloudflare_managed_worker_schedule_reconciliation
     SET lease_started_at = 0, lease_until = 1
     WHERE provider_id = ? AND reconciliation_state = 'leased'`,
    ["cloudflare.wfp.integration"],
  );

  expect(await provider.apply(newerInput)).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: false },
  });
  expect(putCalls).toBe(1);
  expect(await provider.managedScheduleReconciliationStatus()).toMatchObject({
    ok: true,
    value: {
      state: "operator_reconciliation_required",
      desiredGeneration: 2,
      desiredSchedules: ["11 * * * *", "22 * * * *"],
      actualSchedules: [],
      ambiguityReason: "lease_expired",
    },
  });

  release();
  expect(await older).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: false },
  });
  expect(schedules).toEqual(["11 * * * *"]);
  const lateStatus = await provider.managedScheduleReconciliationStatus();
  expect(lateStatus).toMatchObject({
    ok: true,
    value: {
      state: "operator_reconciliation_required",
      desiredGeneration: 2,
      appliedGeneration: 0,
      desiredSchedules: ["11 * * * *", "22 * * * *"],
      actualSchedules: ["11 * * * *"],
      ambiguousGeneration: 2,
    },
  });
  expect(
    await provider.convergeApply?.({ ...newerInput, operationMode: "recovery" }),
  ).toMatchObject({ phase: "failed", failure: { retryable: false } });
  expect(putCalls).toBe(1);
  if (!lateStatus.ok || lateStatus.value.state !== "operator_reconciliation_required") {
    throw new Error("late schedule status is unavailable");
  }
  expect(
    await provider.reconcileManagedSchedules({
      operatorAcknowledgement: "operator-approved-desired-replacement",
      leaseToken: lateStatus.value.leaseToken as string,
      ambiguousGeneration: lateStatus.value.ambiguousGeneration as number,
      desiredGeneration: lateStatus.value.desiredGeneration as number,
      actualDigest: lateStatus.value.actualDigest,
      action: "replace-with-desired",
    }),
  ).toMatchObject({ ok: true, value: { state: "idle", appliedGeneration: 2 } });
  expect(putCalls).toBe(2);
  expect(schedules).toEqual(["11 * * * *", "22 * * * *"]);
});

test("Queue Consumer creation cleans its exact native result when the route CAS loses", async () => {
  const sql = createEphemeralSql();
  const state = new ManagedWorkerState("cloudflare.wfp.integration", sql);
  const calls: string[] = [];
  let queueConsumer: Readonly<Record<string, unknown>> | undefined;
  const provider = new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [queueConsumerOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(sql),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path.endsWith("/queues/queue-race/consumers")) {
        if (request.method === "GET") {
          return Response.json({
            success: true,
            result: queueConsumer ? [queueConsumer] : [],
          });
        }
        queueConsumer = {
          ...(JSON.parse(await request.text()) as Readonly<Record<string, unknown>>),
          consumer_id: "consumer-created-by-loser",
        };
        expect(
          await state.putRoute({
            kind: "queue",
            key: "queue/v1/tsq-yurucommu-race",
            ownerNativeId: "consumer:replacement_resource",
            operationId: "replacement-route-operation",
            predecessor: { kind: "absent" },
            value: {
              schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.queue,
              logicalWorkerId: "tsw-replacement",
            },
          }),
        ).not.toBeNull();
        return Response.json({
          success: true,
          result: { consumer_id: "consumer-created-by-loser" },
        });
      }
      if (path.endsWith("/queues/queue-race/consumers/consumer-created-by-loser")) {
        if (request.method === "GET") {
          return queueConsumer
            ? Response.json({ success: true, result: queueConsumer })
            : Response.json({ success: false }, { status: 404 });
        }
        if (request.method === "DELETE") {
          queueConsumer = undefined;
          return new Response(null, { status: 204 });
        }
      }
      throw new Error(`unexpected Cloudflare call: ${request.method} ${path}`);
    },
  });
  const worker = related("/worker", stored("ModuleWorker", "worker_yurucommu_race", {}), {
    nativeId: "worker:tsw-logical-yurucommu",
    offeringId: offering.id,
    outputs: { scriptName: "tsw-logical-yurucommu" },
  });
  const queue = related("/queue", stored("AtLeastOnceQueue", "queue_yurucommu_race", {}), {
    nativeId: "queue:queue-race",
    offeringId: technical("AtLeastOnceQueue").id,
    outputs: { queueId: "queue-race", queueName: "tsq-yurucommu-race" },
  });

  expect(
    await provider.apply({
      operationId: "consumer-route-race",
      operationMode: "initial",
      offering: queueConsumerOffering,
      identity: {
        tenantRef: "organization_yurucommu",
        space: "production",
        name: "race",
        uid: "consumer_yurucommu_race",
      },
      spec: {
        maxBatchSize: 10,
        maxBatchTimeoutSeconds: 5,
        maxRetries: 3,
        retryDelaySeconds: 1,
        maxConcurrency: 5,
      },
      relations: [worker, queue],
    }),
  ).toMatchObject({ phase: "failed", failure: { code: "conflict" } });
  expect(queueConsumer).toBeUndefined();
  expect(await state.receiptByResourceUid("consumer_yurucommu_race")).toBeNull();
  expect(await state.route("queue", "queue/v1/tsq-yurucommu-race")).toMatchObject({
    state: "active",
    ownerNativeId: "consumer:replacement_resource",
    value: { logicalWorkerId: "tsw-replacement" },
  });
  expect(calls).toContain(
    "DELETE /client/v4/accounts/acct_1/queues/queue-race/consumers/consumer-created-by-loser",
  );
});

function stored(kind: string, uid: string, spec: JsonObject) {
  const forms = kind === "ObjectBucket" ? currentTakoformCandidates().forms : released.forms;
  const form = forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!form) throw new Error(`released ${kind} Form is missing`);
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind,
    form: form.identity,
    metadata: {
      name: kind.toLowerCase(),
      space: "production",
      uid,
      generation: "1",
      revision: "1",
    },
    spec,
    status: { observedGeneration: "1", conditions: [] },
  };
}

function related(
  pointer: string,
  resource: ReturnType<typeof stored>,
  deployment?: {
    readonly nativeId: string;
    readonly offeringId: string;
    readonly outputs: JsonObject;
  },
): ProviderRelation {
  return {
    pointer,
    relation: pointer.replace(/\/\d+/gu, "/*"),
    targetUid: resource.metadata.uid,
    resource,
    ...(deployment
      ? {
          deployment: {
            tenantId: "organization_yurucommu",
            id: `deployment_${resource.metadata.uid}`,
            resourceUid: resource.metadata.uid,
            offeringId: deployment.offeringId,
            providerPackRef: "cloudflare",
            providerInstallationRef: "cloudflare.wfp.integration",
            nativeId: deployment.nativeId,
            state: "active" as const,
            observed: {},
            outputs: deployment.outputs,
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
          },
        }
      : {}),
  };
}

interface HeldRelease {
  readonly etag: string;
  readonly content: ArrayBuffer;
  readonly contentType: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

class ManagedReleaseApi {
  readonly calls: string[] = [];
  readonly scripts = new Map<string, HeldRelease>();
  inspectionFailure = false;
  uploadFailure: "none" | "transport" | "lost-ack" | "rejected" = "none";
  deleteLosesAck = false;
  nextEtag = 1;

  readonly inspectRelease: CloudflareWorkersForPlatformsBackendOptions["inspectRelease"] = async (
    input,
  ) =>
    this.inspectionFailure
      ? { ok: false, retryable: false }
      : {
          ok: true,
          scriptName: input.scriptName,
          descriptorDigest: input.descriptorDigest,
          operationId: input.operationId,
          handlers: input.declaredHandlers,
        };

  readonly fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    this.calls.push(`${request.method} ${path}`);
    const match = path.match(
      /\/workers\/dispatch\/namespaces\/takoserver-customers\/scripts\/([^/]+)(\/content|\/settings|\/secrets)?$/u,
    );
    if (!match) throw new Error(`unexpected managed release call: ${request.method} ${path}`);
    const scriptName = decodeURIComponent(match[1] ?? "");
    const suffix = match[2];
    if (request.method === "PUT" && !suffix) {
      if (this.uploadFailure === "transport") throw new Error("upload transport closed");
      if (this.uploadFailure === "rejected") return new Response(null, { status: 422 });
      const content = await request.clone().arrayBuffer();
      const contentType = request.headers.get("content-type") ?? "";
      const form = await request.formData();
      const metadataPart = form.get("metadata");
      const metadataText =
        typeof metadataPart === "string"
          ? metadataPart
          : metadataPart instanceof Blob
            ? await metadataPart.text()
            : "";
      const metadata = recordValue(JSON.parse(metadataText));
      if (!metadata || !Array.isArray(metadata.bindings)) {
        return new Response(null, { status: 400 });
      }
      const bindings = metadata.bindings.map((value) => {
        const binding = { ...(recordValue(value) ?? {}) };
        if (binding.type === "secret_text") delete binding.text;
        return binding;
      });
      const etag = `etag-${this.nextEtag++}`;
      this.scripts.set(scriptName, {
        etag,
        content,
        contentType,
        settings: {
          main_module: metadata.main_module,
          compatibility_date: metadata.compatibility_date,
          compatibility_flags: metadata.compatibility_flags,
          bindings,
        },
      });
      if (this.uploadFailure === "lost-ack") {
        this.uploadFailure = "none";
        throw new Error("upload acknowledgement lost after commit");
      }
      return Response.json({
        success: true,
        result: { script: { id: scriptName, etag } },
      });
    }
    if (request.method === "DELETE" && !suffix) {
      this.scripts.delete(scriptName);
      if (this.deleteLosesAck) {
        this.deleteLosesAck = false;
        throw new Error("delete acknowledgement lost");
      }
      return new Response(null, { status: 204 });
    }
    const held = this.scripts.get(scriptName);
    if (!held) return new Response(null, { status: 404 });
    if (request.method === "GET" && suffix === "/content") {
      return new Response(held.content.slice(0), {
        headers: { "content-type": held.contentType },
      });
    }
    if (request.method === "GET" && suffix === "/settings") {
      return Response.json({ success: true, result: held.settings });
    }
    if (request.method === "GET" && suffix === "/secrets") {
      return Response.json({ success: true, result: [] });
    }
    if (request.method === "GET" && !suffix) {
      return Response.json({
        success: true,
        result: { script: { id: scriptName, etag: held.etag, handlers: [] } },
      });
    }
    throw new Error(`unexpected managed release call: ${request.method} ${path}`);
  };
}

function releaseProvider(
  api: ManagedReleaseApi,
  sql: Sql,
  readbackQualified = true,
  providerId = "cloudflare.wfp.integration",
): CloudflareProvider {
  return new CloudflareProvider({
    id: providerId,
    accountId: "acct_1",
    offerings: [offering, versionOffering, objectBucketOffering],
    artifacts,
    authorize: () => "Bearer test-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerBackend: managedBackend(sql, api.inspectRelease, readbackQualified),
    fetch: api.fetch,
  });
}

function managedVersionInput(
  uid: string,
  operationId: string,
  logicalWorkerId: string,
): ApplyInput {
  return {
    operationId,
    operationMode: "initial",
    offering: versionOffering,
    identity: {
      tenantRef: "organization_yurucommu",
      space: "production",
      name: uid,
      uid,
    },
    spec: { handlers: ["fetch", "queue", "scheduled"] },
    relations: [
      related("/worker", stored("ModuleWorker", `worker_${uid}`, {}), {
        nativeId: `worker:${logicalWorkerId}`,
        offeringId: offering.id,
        outputs: { scriptName: logicalWorkerId },
      }),
      related("/bundle", stored("WorkerBundle", `bundle_${uid}`, { manifestDigest: bundleDigest })),
    ],
  };
}

function succeededNativeId(ticket: ProviderTicket): string {
  if (ticket.phase !== "succeeded")
    throw new Error(`expected provider success: ${JSON.stringify(ticket)}`);
  return ticket.result.nativeId;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

class ManagedObjectReceiptFake implements CloudflareManagedObjectReceiptStub {
  prepareStates: Array<"draining" | "prepared"> = ["prepared"];
  readonly events: string[] = [];
  readonly instanceNames: string[] = [];
  commitLosesAck = false;
  destroyed = false;
  lifecycle: "active" | "destroying" = "active";
  receiptCount = 0;
  operatorReconciliationRequired = 0;
  nextActionAt: number | null = null;

  constructor(
    readonly authority: ManagedObjectReceiptAuthority,
    readonly bucketName: string,
  ) {}

  async #authorization(
    operation: ManagedObjectReceiptAdminOperation,
    input: CloudflareManagedObjectReceiptAdminRequest,
  ): Promise<"ok" | "conflict" | "invalid_argument"> {
    if (
      input.proof !==
      (await managedObjectReceiptAdminProof({
        secret: TEST_OBJECT_RECEIPT_SECRET,
        operation,
        authority: input.authority,
        bucketName: input.bucketName,
      }))
    ) {
      return "invalid_argument";
    }
    return JSON.stringify(input.authority) === JSON.stringify(this.authority) &&
      input.bucketName === this.bucketName
      ? "ok"
      : "conflict";
  }

  async takoserverObjectReceiptInspect(input: CloudflareManagedObjectReceiptAdminRequest) {
    const authorization = await this.#authorization("inspect", input);
    if (authorization !== "ok") {
      return { ok: false as const, error: { code: authorization } };
    }
    this.events.push("receipt.inspect");
    return {
      ok: true as const,
      value: {
        schemaVersion: 2 as const,
        lifecycle: this.lifecycle,
        authority: this.authority,
        bucketName: this.bucketName,
        receiptCount: this.receiptCount,
        operatorReconciliationRequired: this.operatorReconciliationRequired,
        nextActionAt: this.nextActionAt,
      },
    };
  }

  async takoserverObjectReceiptPrepareDestroy(input: CloudflareManagedObjectReceiptAdminRequest) {
    const authorization = await this.#authorization("prepare-destroy", input);
    if (authorization !== "ok") {
      return { ok: false as const, error: { code: authorization } };
    }
    this.events.push("receipt.prepare");
    this.lifecycle = "destroying";
    const state = this.prepareStates.shift() ?? "prepared";
    return { ok: true as const, value: { state } };
  }

  async takoserverObjectReceiptCommitDestroy(input: CloudflareManagedObjectReceiptAdminRequest) {
    const authorization = await this.#authorization("commit-destroy", input);
    if (authorization !== "ok") {
      return { ok: false as const, error: { code: authorization } };
    }
    this.events.push("receipt.commit");
    if (this.destroyed) return { ok: true as const, value: { destroyed: true as const } };
    this.destroyed = true;
    if (this.commitLosesAck) {
      this.commitLosesAck = false;
      throw new Error("receipt transport closed after destroy commit");
    }
    return { ok: true as const, value: { destroyed: true as const } };
  }
}

function managedObjectBackend(
  sql: Sql,
  receipt: ManagedObjectReceiptFake,
): CloudflareWorkersForPlatformsBackendOptions {
  return {
    ...managedBackend(sql),
    objectReceiptAuthority: receiptAuthority(receipt),
  };
}

function receiptAuthority(
  receipt: ManagedObjectReceiptFake,
): CloudflareManagedObjectReceiptAuthority {
  const prepareProof = "a".repeat(43);
  const admin = async (
    operation: ManagedObjectReceiptAdminOperation,
    input: { readonly authority: ManagedObjectReceiptAuthority; readonly bucketName: string },
  ): Promise<CloudflareManagedObjectReceiptAdminRequest> => {
    receipt.instanceNames.push(await managedObjectReceiptInstanceName(input.authority));
    return {
      ...input,
      proof: await managedObjectReceiptAdminProof({
        secret: TEST_OBJECT_RECEIPT_SECRET,
        operation,
        authority: input.authority,
        bucketName: input.bucketName,
      }),
    };
  };
  return {
    async takoserverObjectReceiptRuntimeBinding(input) {
      const instanceName = await managedObjectReceiptInstanceName(input.authority);
      receipt.instanceNames.push(instanceName);
      return {
        ok: true,
        value: {
          instanceName,
          proof: await managedObjectReceiptRuntimeProof({
            secret: TEST_OBJECT_RECEIPT_SECRET,
            authority: input.authority,
            bucketName: input.bucketName,
          }),
        },
      };
    },
    async takoserverObjectReceiptInspect(input) {
      return receipt.takoserverObjectReceiptInspect(await admin("inspect", input));
    },
    async takoserverObjectReceiptPrepareDestroy(input) {
      if (input.authorityProof !== undefined && input.authorityProof !== prepareProof) {
        return { ok: false, error: { code: "invalid_argument" } };
      }
      const result = await receipt.takoserverObjectReceiptPrepareDestroy(
        await admin("prepare-destroy", input),
      );
      return result.ok
        ? { ok: true, value: { state: result.value.state, authorityProof: prepareProof } }
        : result;
    },
    async takoserverObjectReceiptCommitDestroy(input) {
      if (input.authorityProof !== prepareProof) {
        return { ok: false, error: { code: "invalid_argument" } };
      }
      return receipt.takoserverObjectReceiptCommitDestroy(await admin("commit-destroy", input));
    },
  };
}

function mutateManagedObjectDestroyHandle(
  handle: string,
  mutate: (value: Record<string, unknown>) => void,
): string {
  const prefix = "tsobjd1.";
  if (!handle.startsWith(prefix)) throw new Error("unexpected managed ObjectBucket handle");
  const encoded = handle.slice(prefix.length).replaceAll("-", "+").replaceAll("_", "/");
  const value = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), (character) =>
        character.charCodeAt(0),
      ),
    ),
  ) as Record<string, unknown>;
  mutate(value);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

/**
 * A faithful stand-in for the Durable Object's admin plane: it refuses an
 * operation whose proof was not sealed for that exact operation and authority,
 * exactly as `ManagedWorkerSqliteCore` does.
 */
class ManagedSqliteFake implements CloudflareManagedSqliteStub {
  authority: ManagedWorkerSqliteAuthority | null = null;
  ledger: ManagedWorkerSqliteMigrationIdentity[] = [];
  lastMigrationBytes: Uint8Array | null = null;
  unsealedCalls = 0;
  initializeCalls = 0;
  inspectFailure: "backend_unavailable" | null = null;
  destroyLosesAck = false;
  destroyed = false;

  async #sealed(
    operation: ManagedWorkerSqliteAdminOperation,
    input: CloudflareManagedSqliteAdminRequest,
  ): Promise<boolean> {
    if (
      Object.keys(input).sort().join(",") !== "authority,proof" ||
      input.proof !==
        (await managedWorkerSqliteAdminProof({
          secret: TEST_SQLITE_ADMIN_SECRET,
          operation,
          authority: input.authority,
        }))
    ) {
      this.unsealedCalls += 1;
      return false;
    }
    return true;
  }

  async takoserverSqliteInitialize(input: CloudflareManagedSqliteAdminRequest) {
    this.initializeCalls += 1;
    if (!(await this.#sealed("initialize", input))) {
      return { ok: false as const, error: { code: "invalid_argument" as const } };
    }
    if (this.authority && !sameSqliteAuthority(this.authority, input.authority)) {
      return { ok: false as const, error: { code: "conflict" as const } };
    }
    this.authority = { ...input.authority };
    return { ok: true as const, value: { state: "active" as const } };
  }

  async takoserverSqliteInspect(input: CloudflareManagedSqliteAdminRequest) {
    if (!(await this.#sealed("inspect", input))) {
      return { ok: false as const, error: { code: "invalid_argument" as const } };
    }
    if (this.inspectFailure) {
      return { ok: false as const, error: { code: this.inspectFailure } };
    }
    if (!this.authority || !sameSqliteAuthority(this.authority, input.authority)) {
      return { ok: false as const, error: { code: "not_found" as const } };
    }
    return {
      ok: true as const,
      value: {
        state: this.destroyed ? ("destroyed" as const) : ("active" as const),
        authority: this.authority,
        migrations: this.ledger,
      },
    };
  }

  async takoserverSqliteReadMigrationLedger(input: CloudflareManagedSqliteAdminRequest) {
    if (!(await this.#sealed("read-migration-ledger", input))) {
      return { ok: false as const, error: { code: "invalid_argument" as const } };
    }
    if (
      !this.authority ||
      this.destroyed ||
      !sameSqliteAuthority(this.authority, input.authority)
    ) {
      return { ok: false as const, error: { code: "not_found" as const } };
    }
    return { ok: true as const, value: this.ledger };
  }

  async takoserverSqliteApplyMigrationSuffix(
    input: CloudflareManagedSqliteAdminRequest & {
      readonly expectedPrefix: readonly ManagedWorkerSqliteMigrationIdentity[];
      readonly migrations: readonly {
        readonly path: string;
        readonly digest: `sha256:${string}`;
        readonly sql: Uint8Array;
      }[];
    },
  ) {
    const { expectedPrefix, migrations, ...request } = input;
    if (!(await this.#sealed("apply-migration-suffix", request))) {
      return { ok: false as const, error: { code: "invalid_argument" as const } };
    }
    if (
      !this.authority ||
      this.destroyed ||
      !sameSqliteAuthority(this.authority, input.authority) ||
      JSON.stringify(expectedPrefix) !== JSON.stringify(this.ledger)
    ) {
      return { ok: false as const, error: { code: "conflict" as const } };
    }
    this.lastMigrationBytes = migrations[0]?.sql ?? null;
    this.ledger = [...this.ledger, ...migrations.map(({ path, digest }) => ({ path, digest }))];
    return { ok: true as const, value: undefined };
  }

  async takoserverSqliteDestroy(input: CloudflareManagedSqliteAdminRequest) {
    if (!(await this.#sealed("destroy", input))) {
      return { ok: false as const, error: { code: "invalid_argument" as const } };
    }
    if (!this.authority || !sameSqliteAuthority(this.authority, input.authority)) {
      return { ok: false as const, error: { code: "not_found" as const } };
    }
    this.destroyed = true;
    if (this.destroyLosesAck) {
      this.destroyLosesAck = false;
      throw new Error("destroy transport closed after commit");
    }
    return { ok: true as const, value: { destroyed: true as const } };
  }
}

function sameSqliteAuthority(
  left: ManagedWorkerSqliteAuthority,
  right: ManagedWorkerSqliteAuthority,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function managedBackend(
  sql: Sql,
  inspectRelease: CloudflareWorkersForPlatformsBackendOptions["inspectRelease"] = async (
    input,
  ) => ({
    ok: true,
    scriptName: input.scriptName,
    descriptorDigest: input.descriptorDigest,
    operationId: input.operationId,
    handlers: input.declaredHandlers,
  }),
  readbackQualified = true,
): CloudflareWorkersForPlatformsBackendOptions {
  return {
    kind: "workers-for-platforms",
    dispatchNamespace: "takoserver-customers",
    gatewayWorkerName: "takoserver-dispatch",
    providerInstallationId: "cloudflare.wfp.integration",
    managedBaseDomain: "app-staging.takos.jp",
    sql,
    inspectRelease,
    ...(readbackQualified
      ? {
          releaseReadbackQualification: {
            schema: "takoserver.cloudflare-wfp-release-readback-qualification@v1" as const,
            dispatchNamespace: "takoserver-customers",
            rehearsalDigest: `sha256:${"9".repeat(64)}` as const,
          },
        }
      : {}),
    async deriveSqliteInstanceName({ resourceUid }) {
      return `sqlite-${resourceUid}`;
    },
    sealSqliteAdminProof({ operation, authority }) {
      return managedWorkerSqliteAdminProof({
        secret: TEST_SQLITE_ADMIN_SECRET,
        operation,
        authority,
      });
    },
    sqliteNamespace: missingSqliteNamespace,
    objectReceiptWorkerName: "takoserver-managed-object-receipt-authority",
    objectReceiptAuthority: missingObjectReceiptAuthority,
  };
}

function providerWithSql(sql: Sql): CloudflareProvider {
  return new CloudflareProvider({
    id: "cloudflare.wfp.integration",
    accountId: "acct_1",
    offerings: [offering],
    artifacts,
    authorize: () => "Bearer test-token",
    workerBackend: managedBackend(sql),
    fetch: async () => {
      throw new Error("durable authority failure must not call Cloudflare");
    },
  });
}

function readSql(query: (statement: string) => readonly Row[]): Sql {
  return {
    async query(statement) {
      return query(statement);
    },
    async run() {
      throw new Error("malformed authority must fail before mutation");
    },
    async batch() {
      throw new Error("malformed authority must fail before mutation");
    },
  };
}

const missingSqliteStub: CloudflareManagedSqliteStub = {
  async takoserverSqliteInitialize() {
    return { ok: false, error: { code: "not_found" } };
  },
  async takoserverSqliteInspect() {
    return { ok: false, error: { code: "not_found" } };
  },
  async takoserverSqliteReadMigrationLedger() {
    return { ok: false, error: { code: "not_found" } };
  },
  async takoserverSqliteApplyMigrationSuffix() {
    return { ok: false, error: { code: "not_found" } };
  },
  async takoserverSqliteDestroy() {
    return { ok: false, error: { code: "not_found" } };
  },
};

const missingSqliteNamespace: CloudflareManagedSqliteNamespace = {
  getByName() {
    return missingSqliteStub;
  },
};

const missingObjectReceiptStub: CloudflareManagedObjectReceiptStub = {
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

const missingObjectReceiptAuthority: CloudflareManagedObjectReceiptAuthority = {
  async takoserverObjectReceiptRuntimeBinding(input) {
    return {
      ok: true,
      value: {
        instanceName: await managedObjectReceiptInstanceName(input.authority),
        proof: await managedObjectReceiptRuntimeProof({
          secret: TEST_OBJECT_RECEIPT_SECRET,
          authority: input.authority,
          bucketName: input.bucketName,
        }),
      },
    };
  },
  async takoserverObjectReceiptInspect(input) {
    return missingObjectReceiptStub.takoserverObjectReceiptInspect({
      ...input,
      proof: "p".repeat(64),
    });
  },
  async takoserverObjectReceiptPrepareDestroy(input) {
    const result = await missingObjectReceiptStub.takoserverObjectReceiptPrepareDestroy({
      ...input,
      proof: "p".repeat(64),
    });
    return result.ok
      ? { ok: true, value: { ...result.value, authorityProof: "p".repeat(64) } }
      : result;
  },
  async takoserverObjectReceiptCommitDestroy(input) {
    return missingObjectReceiptStub.takoserverObjectReceiptCommitDestroy({
      ...input,
      proof: "p".repeat(64),
    });
  },
};

async function seedManagedVersion(
  state: ManagedWorkerState,
  nativeId: string,
  operationId: string,
): Promise<void> {
  const normalizedDigest = `sha256:${(operationId === "seed-v1" ? "1" : "2").repeat(64)}` as const;
  const claim = await state.claimReceipt({
    resourceUid: `resource-${operationId}`,
    nativeId,
    kind: "version",
    logicalWorkerId: "tsw-logical-yurucommu",
    operationId,
    descriptorDigest: normalizedDigest,
  });
  if (claim.outcome === "conflict") throw new Error("version seed conflicted");
  if (
    !(await state.commitReceipt({
      resourceUid: `resource-${operationId}`,
      operationId,
      descriptorDigest: normalizedDigest,
      providerEtag: `etag-${operationId}`,
      observed: { seeded: true },
    }))
  )
    throw new Error("version seed did not commit");
}
