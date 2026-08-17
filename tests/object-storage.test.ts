import { describe, expect, test } from "bun:test";
import {
  CloudflareR2ObjectStorageAdapter,
  createObjectStorageModule,
  InMemoryObjectStorageAdapter,
  ObjectStorageError,
  objectStorageBodyDigest,
  objectStorageIntent,
} from "../src/object-storage.ts";
import {
  createExecutionGrantSigner,
  createRuntimeGrantVerifier,
  executionIntentDigest,
  GrantVerificationError,
  InMemoryGrantReplayStore,
} from "../src/runtime-grants.ts";

const issuedAt = Date.parse("2026-08-17T12:00:00.000Z");

async function grantFor(
  operation: "put" | "get" | "head" | "delete" | "list",
  intent: unknown,
  options: { readonly tenantRef?: string; readonly grantId?: string } = {},
): Promise<{
  readonly token: string;
  readonly verifier: ReturnType<typeof createRuntimeGrantVerifier>;
}> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const tenantRef = options.tenantRef ?? "tenant_storage_test";
  const signer = createExecutionGrantSigner({
    issuer: "https://api.takoserver.com",
    keyId: "storage-key",
    privateKey: keys.privateKey,
  });
  const token = await signer.issue({
    audience: "takoserver.runtime.v1",
    securityDomainId: "domain_storage_test",
    tenantRef,
    reservationId: "reservation_storage_test",
    offeringId: "storage.object.standard",
    offeringDigest: `sha256:${"c".repeat(64)}`,
    operation: "s3.access",
    intentDigest: await executionIntentDigest(intent),
    issuedAt: new Date(issuedAt),
    expiresAt: new Date(issuedAt + 60_000),
    grantId: options.grantId ?? `grant_storage_${operation}`,
  });
  return {
    token,
    verifier: createRuntimeGrantVerifier({
      issuer: "https://api.takoserver.com",
      audience: "takoserver.runtime.v1",
      publicKeys: new Map([["storage-key", keys.publicKey]]),
      replayStore: new InMemoryGrantReplayStore(),
      clock: () => new Date(issuedAt + 1_000),
    }),
  };
}

describe("ObjectStorageModule", () => {
  test("scopes in-memory objects by tenant and resource and supports bounded CRUD/list", async () => {
    const adapter = new InMemoryObjectStorageAdapter();
    const putBody = new TextEncoder().encode("hello");
    const putIntent = objectStorageIntent({
      operation: "put",
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
      bodyDigest: await objectStorageBodyDigest(putBody),
      contentType: "text/plain",
      metadata: { source: "test" },
    });
    const putGrant = await grantFor("put", putIntent);
    const module = createObjectStorageModule({
      adapter,
      verifier: putGrant.verifier,
      maxObjectBytes: 32,
      maxListEntries: 10,
    });

    await expect(
      module.execute({
        kind: "put",
        grantToken: putGrant.token,
        tenantRef: "tenant_storage_test",
        resourceRef: "bucket-one",
        key: "nested/hello.txt",
        body: putBody,
        contentType: "text/plain",
        metadata: { source: "test" },
      }),
    ).resolves.toMatchObject({ kind: "put", key: "nested/hello.txt", size: 5 });

    const getBody = new TextEncoder().encode("hello");
    const getIntent = objectStorageIntent({
      operation: "get",
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
    });
    const getGrant = await grantFor("get", getIntent, { grantId: "grant_storage_get" });
    const getModule = createObjectStorageModule({ adapter, verifier: getGrant.verifier });
    const got = await getModule.execute({
      kind: "get",
      grantToken: getGrant.token,
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
    });
    expect(got.kind).toBe("get");
    if (got.kind !== "get" || !got.object) throw new Error("expected object");
    expect(got.object.key).toBe("nested/hello.txt");
    expect(new Uint8Array(await new Response(got.object.body).arrayBuffer())).toEqual(getBody);

    const headIntent = objectStorageIntent({
      operation: "head",
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
    });
    const headGrant = await grantFor("head", headIntent, { grantId: "grant_storage_head" });
    const headed = await createObjectStorageModule({
      adapter,
      verifier: headGrant.verifier,
    }).execute({
      kind: "head",
      grantToken: headGrant.token,
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
    });
    expect(headed).toMatchObject({ kind: "head", object: { key: "nested/hello.txt", size: 5 } });

    const listIntent = objectStorageIntent({
      operation: "list",
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      prefix: "nested/",
      limit: 10,
    });
    const listGrant = await grantFor("list", listIntent, { grantId: "grant_storage_list" });
    const listed = await createObjectStorageModule({
      adapter,
      verifier: listGrant.verifier,
    }).execute({
      kind: "list",
      grantToken: listGrant.token,
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      prefix: "nested/",
      limit: 10,
    });
    expect(listed).toMatchObject({ kind: "list", keys: ["nested/hello.txt"], truncated: false });

    const deleteIntent = objectStorageIntent({
      operation: "delete",
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
    });
    const deleteGrant = await grantFor("delete", deleteIntent, { grantId: "grant_storage_delete" });
    const deleted = await createObjectStorageModule({
      adapter,
      verifier: deleteGrant.verifier,
    }).execute({
      kind: "delete",
      grantToken: deleteGrant.token,
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
    });
    expect(deleted).toEqual({ kind: "delete", key: "nested/hello.txt", deleted: true });

    const otherBody = new TextEncoder().encode("other");
    const otherIntent = objectStorageIntent({
      operation: "put",
      tenantRef: "other_tenant_storage",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
      bodyDigest: await objectStorageBodyDigest(otherBody),
    });
    const otherGrant = await grantFor("put", otherIntent, {
      tenantRef: "other_tenant_storage",
      grantId: "grant_storage_other",
    });
    await createObjectStorageModule({ adapter, verifier: otherGrant.verifier }).execute({
      kind: "put",
      grantToken: otherGrant.token,
      tenantRef: "other_tenant_storage",
      resourceRef: "bucket-one",
      key: "nested/hello.txt",
      body: otherBody,
    });
    expect(adapter.size()).toBe(1);
  });

  test("rejects intent substitution before adapter I/O and never exposes provider errors", async () => {
    const adapter = new InMemoryObjectStorageAdapter();
    let calls = 0;
    const instrumented = {
      put: async (...args: Parameters<InMemoryObjectStorageAdapter["put"]>) => {
        calls += 1;
        return adapter.put(...args);
      },
      get: adapter.get.bind(adapter),
      head: adapter.head.bind(adapter),
      delete: adapter.delete.bind(adapter),
      list: adapter.list.bind(adapter),
    };
    const intent = objectStorageIntent({
      operation: "put",
      tenantRef: "tenant_storage_test",
      resourceRef: "bucket-one",
      key: "safe.txt",
      bodyDigest: await objectStorageBodyDigest(new TextEncoder().encode("safe")),
    });
    const grant = await grantFor("put", intent, { grantId: "grant_storage_substitution" });
    const module = createObjectStorageModule({ adapter: instrumented, verifier: grant.verifier });
    await expect(
      module.execute({
        kind: "put",
        grantToken: grant.token,
        tenantRef: "tenant_storage_test",
        resourceRef: "bucket-one",
        key: "attacker.txt",
        body: new TextEncoder().encode("safe"),
      }),
    ).rejects.toEqual(new GrantVerificationError("wrong_intent"));
    expect(calls).toBe(0);

    const freshGrant = await grantFor("put", intent, { grantId: "grant_storage_provider_error" });
    const failing = createObjectStorageModule({
      verifier: freshGrant.verifier,
      adapter: {
        ...instrumented,
        put: async () => {
          throw new Error("provider secret credential should stay private");
        },
      },
    });
    const result = await failing
      .execute({
        kind: "put",
        grantToken: freshGrant.token,
        tenantRef: "tenant_storage_test",
        resourceRef: "bucket-one",
        key: "safe.txt",
        body: new TextEncoder().encode("safe"),
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ObjectStorageError);
    expect(String(result)).not.toContain("credential");
  });

  test("uses Cloudflare R2 binding methods directly without REST", async () => {
    const calls: string[] = [];
    const objects = new Map<string, Uint8Array>();
    const binding = {
      async put(key: string, value: ArrayBuffer, _options?: Record<string, unknown>) {
        calls.push(`put:${key}`);
        objects.set(key, new Uint8Array(value.slice(0)));
        return { key, size: value.byteLength, etag: "etag-r2" };
      },
      async get(key: string) {
        calls.push(`get:${key}`);
        const value = objects.get(key);
        if (!value) return null;
        return {
          key,
          size: value.byteLength,
          etag: "etag-r2",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(value.slice());
              controller.close();
            },
          }),
        };
      },
      async head(key: string) {
        calls.push(`head:${key}`);
        const value = objects.get(key);
        return value ? { key, size: value.byteLength, etag: "etag-r2" } : null;
      },
      async delete(key: string) {
        calls.push(`delete:${key}`);
        objects.delete(key);
      },
      async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
        calls.push(`list:${options?.prefix ?? ""}`);
        return {
          objects: [...objects.keys()]
            .filter((key) => !options?.prefix || key.startsWith(options.prefix))
            .map((key) => ({ key, size: objects.get(key)?.byteLength ?? 0, etag: "etag-r2" })),
          truncated: false,
        };
      },
    };
    const adapter = new CloudflareR2ObjectStorageAdapter(binding);
    await adapter.put({ key: "tenant/resource/key", body: new TextEncoder().encode("r2").buffer });
    expect(await adapter.head("tenant/resource/key")).toMatchObject({ etag: "etag-r2" });
    expect(calls).toContain("put:tenant/resource/key");
    expect(calls).toContain("head:tenant/resource/key");
    expect(calls.every((call) => !call.startsWith("fetch:"))).toBe(true);
  });
});
