import { describe, expect, test } from "bun:test";
import {
  BackendError,
  CloudflareBackendAdapter,
  createExecutionGrantSigner,
  createResourceRuntime,
  createRuntimeGrantVerifier,
  executionIntentDigest,
  InMemoryGrantReplayStore,
  PortableFakeBackend,
  RuntimeExecutionError,
} from "../src/index.ts";
import { TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM } from "../src/takoform-released-provider.ts";

const objectBucketOffering = {
  id: "storage.object.standard",
  kind: "object_bucket",
  displayName: "Standard object storage",
  form: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM,
  price: { currency: "USD" as const, unit: "resource_month", unitPriceMinor: 300 },
  allowances: [
    {
      protocol: "s3" as const,
      mode: "direct" as const,
      authority: "resource_scoped_grant" as const,
    },
  ],
};

describe("deep BackendAdapter seam", () => {
  test("isolates identical logical resource addresses by opaque tenant", async () => {
    const backend = new PortableFakeBackend("tenant-isolated", [objectBucketOffering]);
    const first = await backend.perform({
      kind: "provision",
      operationId: "tenant-a-operation",
      offering: objectBucketOffering,
      resource: { tenantRef: "tenant-a", name: "media", space: "shared", spec: {} },
    });
    const second = await backend.perform({
      kind: "provision",
      operationId: "tenant-b-operation",
      offering: objectBucketOffering,
      resource: { tenantRef: "tenant-b", name: "media", space: "shared", spec: {} },
    });

    expect(first.nativeId).not.toBe(second.nativeId);
    expect(backend.listResources()).toHaveLength(2);
  });

  test("selects a fake second backend from the signed offering and replays only the same request", async () => {
    const firstOffering = { ...objectBucketOffering, id: "storage.first" };
    const secondOffering = { ...objectBucketOffering, id: "storage.second" };
    const first = new PortableFakeBackend("fake-first", [firstOffering]);
    const second = new PortableFakeBackend("fake-second", [secondOffering]);
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const token = await createExecutionGrantSigner({
      issuer: "https://api.takoserver.com",
      keyId: "runtime-key",
      privateKey: keys.privateKey,
    }).issue({
      audience: "takoserver.runtime.v1",
      securityDomainId: "domain_backend_test",
      tenantRef: "tenant_backend_select",
      reservationId: "reservation_backend_select",
      offeringId: secondOffering.id,
      offeringDigest: await executionIntentDigest({
        id: secondOffering.id,
        backendId: "fake-second",
        kind: secondOffering.kind,
        form: secondOffering.form,
        price: secondOffering.price,
        allowances: secondOffering.allowances,
      }),
      operation: "resource.provision",
      intentDigest: await executionIntentDigest({
        name: "tenant-media",
        space: "tenant-space",
        spec: { location: "auto" },
      }),
      issuedAt: new Date(now),
      expiresAt: new Date(now + 60_000),
      grantId: "grant_backend_select",
    });
    const runtime = createResourceRuntime({
      backends: [first, second],
      committer: { commit: async () => undefined },
      verifier: createRuntimeGrantVerifier({
        issuer: "https://api.takoserver.com",
        audience: "takoserver.runtime.v1",
        publicKeys: new Map([["runtime-key", keys.publicKey]]),
        replayStore: new InMemoryGrantReplayStore(),
        clock: () => new Date(now + 1_000),
      }),
      clock: () => new Date(now + 1_000),
    });
    const command = {
      kind: "resource.provision" as const,
      grantToken: token,
      name: "tenant-media",
      space: "tenant-space",
      spec: { location: "auto" },
      idempotencyKey: "runtime-operation-001",
    };

    const created = await runtime.execute(command);
    const replay = await runtime.execute(command);
    expect(created).toEqual(replay);
    expect(created.resource).toMatchObject({
      tenantRef: "tenant_backend_select",
      offeringId: "storage.second",
      backendId: "fake-second",
      name: "tenant-media",
      state: "ready",
    });
    expect(first.listResources()).toEqual([]);
    expect(second.listResources()).toHaveLength(1);

    await expect(runtime.execute({ ...command, name: "other-name" })).rejects.toEqual(
      new RuntimeExecutionError("idempotency_conflict", 409),
    );
  });

  test("keeps Cloudflare R2 authorization and response handling inside the adapter", async () => {
    const requests: Request[] = [];
    const authorizations: { readonly method: string; readonly pathname: string }[] = [];
    const expectedBucketName = await tenantBucketName(
      "tenant-backend",
      "tenant-space",
      "tenant-media",
    );
    const backend = new CloudflareBackendAdapter({
      id: "cloudflare-r2",
      accountId: "account / one",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      offerings: [objectBucketOffering],
      async authorize({ method, url }) {
        authorizations.push({ method, pathname: url.pathname });
        return "Bearer provider-secret-that-must-not-escape";
      },
      async fetch(request) {
        requests.push(request);
        if (request.method === "GET") {
          return Response.json({
            success: true,
            errors: [],
            messages: [],
            result: { name: expectedBucketName, location: "auto" },
          });
        }
        if (request.method === "DELETE") {
          return Response.json({ success: true, errors: [], messages: [], result: null });
        }
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: { name: expectedBucketName },
        });
      },
    });

    const receipt = await backend.perform({
      kind: "provision",
      operationId: "cloudflare-operation-001",
      offering: objectBucketOffering,
      resource: {
        tenantRef: "tenant-backend",
        name: "tenant-media",
        space: "tenant-space",
        spec: { location: "auto" },
      },
    });
    expect(receipt).toEqual({
      nativeId: `r2:${expectedBucketName}`,
      observed: { name: expectedBucketName, location: "auto" },
      output: { protocol: "s3", bucketName: expectedBucketName },
    });
    expect(requests).toHaveLength(1);
    expect(await requests[0]?.json()).toEqual({ name: expectedBucketName, locationHint: "auto" });
    expect(JSON.stringify(receipt)).not.toContain("provider-secret");

    const observed = await backend.perform({
      kind: "observe",
      operationId: "cloudflare-operation-observe-001",
      offering: objectBucketOffering,
      nativeId: receipt.nativeId,
      resource: {
        tenantRef: "tenant-backend",
        name: "tenant-media",
        space: "tenant-space",
        spec: { location: "auto" },
      },
    });
    expect(observed).toEqual(receipt);
    const deleted = await backend.perform({
      kind: "delete",
      operationId: "cloudflare-operation-delete-001",
      offering: objectBucketOffering,
      nativeId: receipt.nativeId,
      resource: {
        tenantRef: "tenant-backend",
        name: "tenant-media",
        space: "tenant-space",
        spec: { location: "auto" },
      },
    });
    expect(deleted).toEqual({
      nativeId: `r2:${expectedBucketName}`,
      observed: { deleted: true },
      output: {},
    });
    expect(authorizations).toEqual([
      {
        method: "POST",
        pathname: "/client/v4/accounts/account%20%2F%20one/r2/buckets",
      },
      {
        method: "GET",
        pathname: `/client/v4/accounts/account%20%2F%20one/r2/buckets/${expectedBucketName}`,
      },
      {
        method: "DELETE",
        pathname: `/client/v4/accounts/account%20%2F%20one/r2/buckets/${expectedBucketName}`,
      },
    ]);
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(JSON.stringify([observed, deleted])).not.toContain("provider-secret");

    const failing = new CloudflareBackendAdapter({
      id: "cloudflare-failing",
      accountId: "account",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      offerings: [objectBucketOffering],
      authorize: () => "Bearer secret",
      fetch: async () => new Response("provider says token secret-123 is invalid", { status: 401 }),
    });
    await expect(
      failing.perform({
        kind: "provision",
        operationId: "cloudflare-operation-fail",
        offering: objectBucketOffering,
        resource: {
          tenantRef: "tenant-failing",
          name: "tenant-fail",
          space: "tenant-space",
          spec: {},
        },
      }),
    ).rejects.toEqual(new BackendError("unavailable", false));
  });

  test("never invokes settlement when provider provisioning fails", async () => {
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const token = await createExecutionGrantSigner({
      issuer: "https://api.takoserver.com",
      keyId: "failed-provider-key",
      privateKey: keys.privateKey,
    }).issue({
      audience: "takoserver.runtime.v1",
      securityDomainId: "domain_failed_provider",
      tenantRef: "tenant_failed_provider",
      reservationId: "reservation_failed_provider",
      offeringId: objectBucketOffering.id,
      offeringDigest: await executionIntentDigest({
        id: objectBucketOffering.id,
        backendId: "failed-provider",
        kind: objectBucketOffering.kind,
        form: objectBucketOffering.form,
        price: objectBucketOffering.price,
        allowances: objectBucketOffering.allowances,
      }),
      operation: "resource.provision",
      intentDigest: await executionIntentDigest({
        name: "failed-resource",
        space: "failed-space",
        spec: {},
      }),
      issuedAt: new Date(now),
      expiresAt: new Date(now + 60_000),
      grantId: "grant_failed_provider",
    });
    let commitCalls = 0;
    const runtime = createResourceRuntime({
      backends: [
        {
          id: "failed-provider",
          discover: async () => [objectBucketOffering],
          perform: async () => {
            throw new BackendError("unavailable", true);
          },
        },
      ],
      verifier: createRuntimeGrantVerifier({
        issuer: "https://api.takoserver.com",
        audience: "takoserver.runtime.v1",
        publicKeys: new Map([["failed-provider-key", keys.publicKey]]),
        replayStore: new InMemoryGrantReplayStore(),
        clock: () => new Date(now + 1_000),
      }),
      committer: {
        async commit() {
          commitCalls += 1;
        },
      },
    });

    await expect(
      runtime.execute({
        kind: "resource.provision",
        grantToken: token,
        name: "failed-resource",
        space: "failed-space",
        spec: {},
        idempotencyKey: "failed-provider-operation",
      }),
    ).rejects.toEqual(new RuntimeExecutionError("backend_unavailable", 503));
    expect(commitCalls).toBe(0);
  });

  test("rejects offering drift before provider I/O", async () => {
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const backendId = "drifted-provider";
    const token = await createExecutionGrantSigner({
      issuer: "https://api.takoserver.com",
      keyId: "offering-drift-key",
      privateKey: keys.privateKey,
    }).issue({
      audience: "takoserver.runtime.v1",
      securityDomainId: "domain_offering_drift",
      tenantRef: "tenant_offering_drift",
      reservationId: "reservation_offering_drift",
      offeringId: objectBucketOffering.id,
      offeringDigest: await executionIntentDigest({
        id: objectBucketOffering.id,
        backendId,
        kind: objectBucketOffering.kind,
        form: objectBucketOffering.form,
        price: objectBucketOffering.price,
        allowances: objectBucketOffering.allowances,
      }),
      operation: "resource.provision",
      intentDigest: await executionIntentDigest({
        name: "drifted-resource",
        space: "drifted-space",
        spec: {},
      }),
      issuedAt: new Date(now),
      expiresAt: new Date(now + 60_000),
      grantId: "grant_offering_drift",
    });
    let providerCalls = 0;
    const runtime = createResourceRuntime({
      backends: [
        {
          id: backendId,
          discover: async () => [
            {
              ...objectBucketOffering,
              price: { ...objectBucketOffering.price, unitPriceMinor: 301 },
            },
          ],
          perform: async () => {
            providerCalls += 1;
            throw new Error("must not run");
          },
        },
      ],
      verifier: createRuntimeGrantVerifier({
        issuer: "https://api.takoserver.com",
        audience: "takoserver.runtime.v1",
        publicKeys: new Map([["offering-drift-key", keys.publicKey]]),
        replayStore: new InMemoryGrantReplayStore(),
        clock: () => new Date(now + 1_000),
      }),
      committer: { commit: async () => undefined },
    });

    await expect(
      runtime.execute({
        kind: "resource.provision",
        grantToken: token,
        name: "drifted-resource",
        space: "drifted-space",
        spec: {},
        idempotencyKey: "offering-drift-operation",
      }),
    ).rejects.toEqual(new RuntimeExecutionError("offering_unavailable", 503));
    expect(providerCalls).toBe(0);
  });
});

async function tenantBucketName(tenantRef: string, space: string, name: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${tenantRef}\0${space}\0${name}`),
    ),
  );
  return `ts-${[...digest]
    .slice(0, 20)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}
