import { expect, mock, test } from "bun:test";
import type { ManagedObjectReceiptAuthority } from "../src/providers/cloudflare-managed-object-receipt.ts";
import type { CloudflareManagedObjectReceiptStub } from "../src/providers/cloudflare-worker-backend.ts";

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

const { createManagedObjectReceiptAuthority, default: routeLessHandler } = (await import(
  "../src/entry-cloudflare-managed-object-receipt-authority.ts"
)) as typeof import("../src/entry-cloudflare-managed-object-receipt-authority.ts");

const EXPECTED_PROVIDER = "cloudflare.wfp.integration";
const authority = (providerId = EXPECTED_PROVIDER): ManagedObjectReceiptAuthority => ({
  schema: "takoserver.managed-object-receipt-authority@v1",
  providerId,
  resourceUid: "bucket_media",
  incarnationId: "deployment_bucket_media",
  generation: "1",
});

test("every receipt-authority RPC rejects a different ProviderInstallation before the DO", async () => {
  let namespaceCalls = 0;
  const service = createManagedObjectReceiptAuthority({
    OBJECT_RECEIPTS: {
      getByName(): CloudflareManagedObjectReceiptStub {
        namespaceCalls += 1;
        throw new Error("mismatched provider must not reach the receipt namespace");
      },
    },
    MANAGED_PROVIDER_ID: EXPECTED_PROVIDER,
    TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID: "account",
    TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID: "access-key",
    TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY: "secret-key",
    TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET: "proof-secret",
  });
  const request = { authority: authority("cloudflare.wfp.other"), bucketName: "bucket-media" };

  expect(await service.takoserverObjectReceiptRuntimeBinding(request)).toEqual({
    ok: false,
    error: { code: "invalid_argument" },
  });
  expect(await service.takoserverObjectReceiptInspect(request)).toEqual({
    ok: false,
    error: { code: "invalid_argument" },
  });
  expect(await service.takoserverObjectReceiptPrepareDestroy(request)).toEqual({
    ok: false,
    error: { code: "invalid_argument" },
  });
  expect(
    await service.takoserverObjectReceiptCommitDestroy({
      ...request,
      authorityProof: "a".repeat(64),
    }),
  ).toEqual({ ok: false, error: { code: "invalid_argument" } });
  expect(namespaceCalls).toBe(0);
});

test("the authority has no public endpoint and mints only a bounded runtime capability", async () => {
  const service = createManagedObjectReceiptAuthority({
    OBJECT_RECEIPTS: {
      getByName(): CloudflareManagedObjectReceiptStub {
        throw new Error("runtime binding must not touch the receipt namespace");
      },
    },
    MANAGED_PROVIDER_ID: EXPECTED_PROVIDER,
    TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID: "account",
    TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID: "access-key",
    TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY: "secret-key",
    TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET: "proof-secret",
  });

  const runtime = await service.takoserverObjectReceiptRuntimeBinding({
    authority: authority(),
    bucketName: "bucket-media",
  });
  expect(runtime).toMatchObject({
    ok: true,
    value: {
      instanceName: expect.stringMatching(/^tsobj-[A-Za-z0-9_-]{43}$/u),
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    },
  });
  expect(JSON.stringify(runtime)).not.toContain("proof-secret");

  const response = routeLessHandler.fetch();
  expect(response.status).toBe(404);
});
