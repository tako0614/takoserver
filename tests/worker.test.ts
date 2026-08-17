import { describe, expect, test } from "bun:test";
import {
  type CloudflareR2BucketBinding,
  type CloudflareR2ObjectBodyLike,
  type CloudflareR2ObjectLike,
  objectStorageBodyDigest,
  objectStorageIntent,
} from "../src/object-storage.ts";
import { createExecutionGrantSigner, executionIntentDigest } from "../src/runtime-grants.ts";
import type { D1DatabasePort, D1StatementPort } from "../src/state-store.ts";
import { handleTakoserverWorkerRequest } from "../src/worker.ts";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

class RuntimeStateDatabase implements D1DatabasePort {
  readonly #publicJwk: string;
  readonly #allowancesJson: string;
  readonly #replays = new Map<string, number>();
  readonly boundParameterCounts: number[] = [];

  constructor(
    publicJwk: JsonWebKey,
    allowances: readonly Record<string, string>[] = [
      { protocol: "s3", mode: "direct", authority: "resource_scoped_grant" },
    ],
  ) {
    this.#publicJwk = JSON.stringify(publicJwk);
    this.#allowancesJson = JSON.stringify(allowances);
  }

  prepare(sql: string): D1StatementPort {
    let values: unknown[] = [];
    return {
      bind: (...next: unknown[]) => {
        values = next;
        this.boundParameterCounts.push(next.length);
        return this.prepareBound(sql, values);
      },
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => ({ results: [], meta: { changes: 0 } }),
    };
  }

  private prepareBound(sql: string, values: unknown[]): D1StatementPort {
    return {
      bind: (...next: unknown[]) => this.prepareBound(sql, next),
      all: async () => {
        if (sql.includes("runtime_grant_keys")) {
          return {
            results: [{ key_id: "worker-key", public_jwk: this.#publicJwk }],
            meta: { changes: 0 },
          };
        }
        if (sql.includes("runtime_resources")) {
          if (
            JSON.stringify(values) !==
            JSON.stringify(["domain_worker_test", "tenant_worker_test", "bucket-worker"])
          ) {
            return { results: [], meta: { changes: 0 } };
          }
          return {
            results: [
              {
                organization_id: "org_worker_test",
                security_domain_id: "domain_worker_test",
                tenant_ref: "tenant_worker_test",
                resource_ref: "bucket-worker",
                reservation_id: "reservation_worker_test",
                offering_id: "storage.object.standard",
                offering_digest: `sha256:${"c".repeat(64)}`,
                backend_id: "cloudflare-r2-binding",
                native_id: "r2:bucket-worker",
                allowances_json: this.#allowancesJson,
              },
            ],
            meta: { changes: 0 },
          };
        }
        throw new Error("unexpected query");
      },
      run: async () => {
        if (sql.includes("DELETE FROM runtime_grant_replays")) {
          const now = Number(values[0]);
          for (const [grantId, expiresAt] of this.#replays) {
            if (expiresAt <= now) this.#replays.delete(grantId);
          }
          return { results: [], meta: { changes: 0 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO runtime_grant_replays")) {
          const grantId = String(values[0]);
          if (this.#replays.has(grantId)) return { results: [], meta: { changes: 0 } };
          this.#replays.set(grantId, Number(values[1]));
          return { results: [], meta: { changes: 1 } };
        }
        throw new Error("unexpected statement");
      },
    };
  }
}

class MemoryR2Binding implements CloudflareR2BucketBinding {
  readonly objects = new Map<string, Uint8Array>();
  readonly calls: string[] = [];

  async put(key: string, value: ArrayBuffer): Promise<CloudflareR2ObjectLike> {
    this.calls.push(`put:${key}`);
    const bytes = new Uint8Array(value.slice(0));
    this.objects.set(key, bytes);
    return { key, size: bytes.byteLength, etag: "worker-etag" };
  }

  async get(key: string): Promise<CloudflareR2ObjectBodyLike | null> {
    this.calls.push(`get:${key}`);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.byteLength,
      etag: "worker-etag",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice());
          controller.close();
        },
      }),
    };
  }

  async head(key: string): Promise<CloudflareR2ObjectLike | null> {
    this.calls.push(`head:${key}`);
    const bytes = this.objects.get(key);
    return bytes ? { key, size: bytes.byteLength, etag: "worker-etag" } : null;
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
    this.objects.delete(key);
  }

  async list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }) {
    this.calls.push(`list:${options?.prefix ?? ""}`);
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(options?.prefix ?? ""))
        .slice(0, options?.limit ?? 1_000)
        .map(([key, bytes]) => ({ key, size: bytes.byteLength, etag: "worker-etag" })),
      truncated: false,
    };
  }
}

async function grant(options: {
  readonly privateKey: CryptoKey;
  readonly grantId: string;
  readonly intent: unknown;
  readonly securityDomainId?: string;
}): Promise<string> {
  return createExecutionGrantSigner({
    issuer: "https://api.takoserver.test",
    keyId: "worker-key",
    privateKey: options.privateKey,
  }).issue({
    audience: "takoserver.runtime.v1",
    securityDomainId: options.securityDomainId ?? "domain_worker_test",
    tenantRef: "tenant_worker_test",
    reservationId: "reservation_worker_test",
    offeringId: "storage.object.standard",
    offeringDigest: `sha256:${"c".repeat(64)}`,
    operation: "s3.access",
    intentDigest: await executionIntentDigest(options.intent),
    issuedAt: new Date(NOW),
    expiresAt: new Date(NOW + 60_000),
    grantId: options.grantId,
  });
}

describe("Takoserver Cloudflare Worker", () => {
  test("runs a replay-safe D1 to R2 object-storage vertical slice", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const stateDb = new RuntimeStateDatabase(await crypto.subtle.exportKey("jwk", keys.publicKey));
    const objects = new MemoryR2Binding();
    const body = new TextEncoder().encode("durable-object");
    const putIntent = objectStorageIntent({
      operation: "put",
      tenantRef: "tenant_worker_test",
      resourceRef: "bucket-worker",
      key: "nested/object.txt",
      bodyDigest: await objectStorageBodyDigest(body),
      contentType: "text/plain",
    });
    const putGrant = await grant({
      privateKey: keys.privateKey,
      grantId: "grant_worker_put",
      intent: putIntent,
    });
    const url =
      "https://api.takoserver.test/v1/storage/object?tenantRef=tenant_worker_test&resourceRef=bucket-worker&key=nested%2Fobject.txt";

    const put = await handleTakoserverWorkerRequest(
      new Request(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${putGrant}`, "content-type": "text/plain" },
        body,
      }),
      { stateDb, objects },
      () => new Date(NOW + 1_000),
    );
    expect(put.status).toBe(201);
    expect(objects.objects.get("tenant_worker_test/bucket-worker/nested/object.txt")).toEqual(body);

    const getIntent = objectStorageIntent({
      operation: "get",
      tenantRef: "tenant_worker_test",
      resourceRef: "bucket-worker",
      key: "nested/object.txt",
    });
    const getGrant = await grant({
      privateKey: keys.privateKey,
      grantId: "grant_worker_get",
      intent: getIntent,
    });
    const getRequest = () =>
      new Request(url, { method: "GET", headers: { authorization: `Bearer ${getGrant}` } });
    const got = await handleTakoserverWorkerRequest(
      getRequest(),
      { stateDb, objects },
      () => new Date(NOW + 1_000),
    );
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe('"worker-etag"');
    expect(await got.text()).toBe("durable-object");

    const replay = await handleTakoserverWorkerRequest(
      getRequest(),
      { stateDb, objects },
      () => new Date(NOW + 1_000),
    );
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "grant_replayed" } });
    expect(objects.calls.filter((call) => call.startsWith("get:"))).toHaveLength(1);
    expect(stateDb.boundParameterCounts.every((count) => count <= 100)).toBe(true);
  });

  test("rejects declared oversized uploads before D1 or R2 I/O", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const stateDb = new RuntimeStateDatabase(await crypto.subtle.exportKey("jwk", keys.publicKey));
    const objects = new MemoryR2Binding();
    const response = await handleTakoserverWorkerRequest(
      new Request(
        "https://api.takoserver.test/v1/storage/object?tenantRef=tenant_worker_test&resourceRef=bucket-worker&key=large.bin",
        {
          method: "PUT",
          headers: {
            authorization: "Bearer syntactically-unimportant",
            "content-length": String(8 * 1_024 * 1_024 + 1),
          },
          body: new Uint8Array([1]),
        },
      ),
      { stateDb, objects },
    );
    expect(response.status).toBe(413);
    expect(stateDb.boundParameterCounts).toEqual([]);
    expect(objects.calls).toEqual([]);
  });

  test("rejects a resource whose durable registry lacks the s3 allowance", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const stateDb = new RuntimeStateDatabase(await crypto.subtle.exportKey("jwk", keys.publicKey), [
      { protocol: "openai", mode: "direct", authority: "resource_scoped_grant" },
    ]);
    const objects = new MemoryR2Binding();
    const body = new TextEncoder().encode("must-not-reach-r2");
    const intent = objectStorageIntent({
      operation: "put",
      tenantRef: "tenant_worker_test",
      resourceRef: "bucket-worker",
      key: "blocked.txt",
      bodyDigest: await objectStorageBodyDigest(body),
    });
    const token = await grant({
      privateKey: keys.privateKey,
      grantId: "grant_worker_wrong_allowance",
      intent,
    });
    const response = await handleTakoserverWorkerRequest(
      new Request(
        "https://api.takoserver.test/v1/storage/object?tenantRef=tenant_worker_test&resourceRef=bucket-worker&key=blocked.txt",
        {
          method: "PUT",
          headers: { authorization: `Bearer ${token}` },
          body,
        },
      ),
      { stateDb, objects },
      () => new Date(NOW + 1_000),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "wrong_operation" } });
    expect(objects.calls).toEqual([]);
  });

  test("derives the registry security domain only from the signed grant", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const stateDb = new RuntimeStateDatabase(await crypto.subtle.exportKey("jwk", keys.publicKey));
    const objects = new MemoryR2Binding();
    const intent = objectStorageIntent({
      operation: "get",
      tenantRef: "tenant_worker_test",
      resourceRef: "bucket-worker",
      key: "private.txt",
    });
    const token = await grant({
      privateKey: keys.privateKey,
      grantId: "grant_worker_wrong_domain",
      intent,
      securityDomainId: "domain_other_organization",
    });
    const response = await handleTakoserverWorkerRequest(
      new Request(
        "https://api.takoserver.test/v1/storage/object?tenantRef=tenant_worker_test&resourceRef=bucket-worker&key=private.txt",
        { method: "GET", headers: { authorization: `Bearer ${token}` } },
      ),
      { stateDb, objects },
      () => new Date(NOW + 1_000),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "wrong_intent" } });
    expect(objects.calls).toEqual([]);
  });
});
