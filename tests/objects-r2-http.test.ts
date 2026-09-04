import { describe, expect, test } from "bun:test";
import { bytesDigest, canonicalDigest, canonicalJson } from "../src/json.ts";
import { createR2HttpObjectStore } from "../src/objects-r2-http.ts";
import type { ObjectStoreError } from "../src/ports.ts";
import { FORM_PACKAGE_LIMITS } from "../src/takoform/form-package-limits.ts";
import {
  createFormPackageReader,
  readOnlyFormPackageKey,
  readOnlyFormPackagePrefix,
} from "../src/takoform/form-package-reader.ts";
import { packageManifest } from "../src/takoform/form-packages.ts";

describe("R2 HTTP object adapter", () => {
  test("refuses an exact write identity it cannot round-trip", async () => {
    let called = false;
    const store = createR2HttpObjectStore({
      accountId: "account",
      bucketName: "bucket",
      authorize: () => "Bearer test",
      apiOrigin: "https://r2.test",
      fetch: async () => {
        called = true;
        return new Response(null, { status: 500 });
      },
    });

    await expect(
      store.put("art/exact", new Uint8Array([1]), {
        writeOperationId: "abw_http_must_not_drop",
      }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "R2 HTTP cannot persist an exact write operation identity",
    } satisfies Partial<ObjectStoreError>);
    expect(called).toBe(false);
  });

  test("fails closed and returns promptly when a probe has no exact size metadata", async () => {
    let cancelled = false;
    const store = createR2HttpObjectStore({
      accountId: "account",
      bucketName: "bucket",
      authorize: () => "Bearer test",
      apiOrigin: "https://r2.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
              return new Promise<void>(() => {});
            },
          }),
          { status: 200, headers: { etag: "etag-1" } },
        ),
    });

    const result = await Promise.race([
      store.head("payload").then(
        () => "accepted",
        (error: unknown) => (error instanceof Error ? error.message : "rejected"),
      ),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    expect(result).toBe("R2 returned an invalid probe size");
    expect(cancelled).toBe(true);
  });

  test("lists bounded R2 metadata pages and carries the opaque cursor", async () => {
    const requests: Request[] = [];
    const store = createR2HttpObjectStore({
      accountId: "account",
      bucketName: "bucket",
      authorize: () => "Bearer test",
      apiOrigin: "https://r2.test",
      fetch: async (request) => {
        requests.push(request);
        return Response.json({
          success: true,
          result: [{ key: "formpkg/a", size: 1, etag: "etag-a" }],
          result_info: { is_truncated: true, cursor: "next-page" },
        });
      },
    });

    const page = await store.list({ prefix: "formpkg/", limit: 100 });
    expect(page).toEqual({
      objects: [{ key: "formpkg/a", size: 1, etag: "etag-a" }],
      truncated: true,
      cursor: "next-page",
    });
    const url = new URL(requests[0]?.url ?? "https://invalid");
    expect(url.pathname).toBe("/accounts/account/r2/buckets/bucket/objects");
    expect(url.searchParams.get("prefix")).toBe("formpkg/");
    expect(url.searchParams.get("per_page")).toBe("100");
  });

  test("rejects an oversized R2 listing body before parsing it", async () => {
    let cancelled = false;
    const store = createR2HttpObjectStore({
      accountId: "account",
      bucketName: "bucket",
      authorize: () => "Bearer test",
      apiOrigin: "https://r2.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(FORM_PACKAGE_LIMITS.indexBytes + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    });

    await expect(store.list({ prefix: "formpkg/", limit: 100 })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(cancelled).toBe(true);
  });

  test("reads and verifies a package through the R2 HTTP object seam", async () => {
    const held = new Map<string, Uint8Array>();
    const store = createR2HttpObjectStore({
      accountId: "account",
      bucketName: "bucket",
      authorize: () => "Bearer test",
      apiOrigin: "https://r2.test",
      fetch: async (request) => {
        const url = new URL(request.url);
        const marker = "/objects/";
        const listRequest = url.pathname.endsWith("/objects");
        const encoded = listRequest
          ? ""
          : url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
        if (request.method === "GET" && listRequest) {
          const prefix = url.searchParams.get("prefix") ?? "";
          const keys = [...held.keys()].filter((key) => key.startsWith(prefix)).sort();
          return Response.json({
            success: true,
            result: keys.map((key) => ({
              key,
              size: held.get(key)?.byteLength ?? 0,
              etag: "etag",
            })),
            result_info: { is_truncated: false },
          });
        }
        const key = encoded
          .split("/")
          .map((segment) => decodeURIComponent(segment))
          .join("/");
        if (request.method === "PUT") {
          held.set(key, new Uint8Array(await request.arrayBuffer()));
          return Response.json({ key, size: held.get(key)?.byteLength ?? 0, etag: "etag" });
        }
        if (request.method === "GET") {
          const bytes = held.get(key);
          if (!bytes) return new Response(null, { status: 404 });
          return new Response(bytes as unknown as BodyInit, {
            headers: { etag: "etag" },
          });
        }
        if (request.method === "DELETE") {
          if (!held.delete(key)) return new Response(null, { status: 404 });
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 405 });
      },
    });

    const formRef = {
      apiVersion: "example.forms.test/v1alpha1",
      kind: "Widget",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    } as const;
    const bytes = new TextEncoder().encode("payload");
    const files = [
      {
        path: "payload.txt",
        digest: await bytesDigest(bytes),
        size: bytes.byteLength,
        mediaType: "text/plain" as const,
      },
    ];
    const manifest = packageManifest({ formRef, files });
    const packageDigest = await canonicalDigest(manifest);
    expect("create" in store).toBe(false);
    await store.put(readOnlyFormPackageKey(packageDigest, "payload.txt"), bytes, {
      contentType: "text/plain",
    });
    await store.put(
      `${readOnlyFormPackagePrefix(packageDigest)}/package-index.json`,
      new TextEncoder().encode(canonicalJson(manifest)),
      { contentType: "application/json" },
    );
    const reader = createFormPackageReader(store);
    const read = await reader.read({ packageDigest, formRef });
    expect(read?.files[0]?.bytes).toEqual(bytes);
    expect(read).toMatchObject({
      packageDigest,
    });
  });
});
