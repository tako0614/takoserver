import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import {
  MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA,
  managedObjectReceiptAdminProof,
  managedObjectReceiptRuntimeProof,
} from "../src/providers/cloudflare-managed-object-receipt.ts";

const OBJECT_MODULE = resolve(
  import.meta.dir,
  "../src/providers/cloudflare-managed-object-receipt-object.ts",
);
const AUTHORITY = {
  schema: MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA,
  providerId: "cloudflare.wfp.integration",
  resourceUid: "bucket-uid",
  incarnationId: "deployment-bucket",
  generation: "3",
} as const;
const BUCKET = "managed-bucket";
const SECRET = "managed-object-receipt-object-test-secret";
const CREATE = {
  authority: AUTHORITY,
  bucketName: BUCKET,
  key: "object.bin",
  contentType: null,
  receiptId: "receipt-00000000-0000-4000-8000-000000000001",
  marker: "A".repeat(43),
};

async function bundledWorker(runtimeProof: string, inspectProof: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-managed-object-receipt-"));
  try {
    const entry = join(root, "worker.ts");
    await Bun.write(
      entry,
      `export { TakoserverManagedObjectReceipt } from ${JSON.stringify(OBJECT_MODULE)};
const authority = ${JSON.stringify(AUTHORITY)};
const create = ${JSON.stringify(CREATE)};
export default {
  async fetch(_request, env) {
    const stub = env.OBJECT_RECEIPTS.getByName("tsobj-rpc-test");
    const firstInspected = await stub.takoserverObjectReceiptInspect({
      authority,
      bucketName: create.bucketName,
      proof: ${JSON.stringify(inspectProof)},
    });
    const badProof = await stub.createMultipartUpload({ ...create, proof: "P".repeat(43) });
    const created = await stub.createMultipartUpload({ ...create, proof: ${JSON.stringify(runtimeProof)} });
    const retried = await stub.createMultipartUpload({ ...create, proof: ${JSON.stringify(runtimeProof)} });
    const part = await stub.beginPart({
      authority,
      bucketName: create.bucketName,
      proof: ${JSON.stringify(runtimeProof)},
      key: create.key,
      receiptId: create.receiptId,
      partNumber: 1,
      size: 4,
      attemptId: "attempt-00000000-0000-4000-8000-000000000001",
    });
    const inspected = await stub.takoserverObjectReceiptInspect({
      authority,
      bucketName: create.bucketName,
      proof: ${JSON.stringify(inspectProof)},
    });
    const badAdmin = await stub.takoserverObjectReceiptInspect({
      authority,
      bucketName: create.bucketName,
      proof: ${JSON.stringify(runtimeProof)},
    });
    const httpStatus = (await stub.fetch(new Request("https://do.invalid/"))).status;
    return Response.json({ firstInspected, badProof, created, retried, part, inspected, badAdmin, httpStatus });
  },
};`,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      external: ["cloudflare:workers"],
    });
    if (!built.success) {
      throw new AggregateError(built.logs, "managed object receipt bundle failed");
    }
    const output = built.outputs[0];
    if (!output) throw new Error("managed object receipt bundle produced no module");
    return await output.text();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("receipt RPC verifies exact capabilities before its durable/provider authority", async () => {
  const runtimeProof = await managedObjectReceiptRuntimeProof({
    secret: SECRET,
    authority: AUTHORITY,
    bucketName: BUCKET,
  });
  const inspectProof = await managedObjectReceiptAdminProof({
    secret: SECRET,
    operation: "inspect",
    authority: AUTHORITY,
    bucketName: BUCKET,
  });
  const contents = await bundledWorker(runtimeProof, inspectProof);
  let nativeCreateCalls = 0;
  let nativeUploadId: string | null = null;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "managed-object-receipt-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          exports: {
            TakoserverManagedObjectReceipt: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            OBJECT_RECEIPTS: {
              type: "durable-object",
              workerName: "managed-object-receipt-test",
              exportName: "TakoserverManagedObjectReceipt",
            },
            MANAGED_PROVIDER_ID: { type: "text", value: AUTHORITY.providerId },
            TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID: { type: "text", value: "test-account" },
            TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID: { type: "text", value: "test-access" },
            TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY: {
              type: "text",
              value: "test-secret",
            },
            TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET: { type: "text", value: SECRET },
            TAKOSERVER_MANAGED_OBJECT_S3_TRANSPORT: {
              type: "fetcher",
              handler: async (request: Request) => {
                const url = new URL(request.url);
                if (request.method === "GET") {
                  return new Response(
                    `<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>${
                      nativeUploadId
                        ? `<Upload><Key>object.bin</Key><UploadId>${nativeUploadId}</UploadId></Upload>`
                        : ""
                    }</ListMultipartUploadsResult>`,
                  );
                }
                if (request.method === "POST" && url.searchParams.has("uploads")) {
                  nativeCreateCalls += 1;
                  nativeUploadId = "native-created";
                  return new Response(
                    `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>object.bin</Key><UploadId>${nativeUploadId}</UploadId></InitiateMultipartUploadResult>`,
                  );
                }
                return new Response(null, { status: 405 });
              },
            },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    const response = await runtime.dispatchFetch("https://worker.example/");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      firstInspected: {
        ok: true,
        value: {
          schemaVersion: 2,
          lifecycle: "active",
          authority: AUTHORITY,
          bucketName: BUCKET,
          receiptCount: 0,
          operatorReconciliationRequired: 0,
        },
      },
      badProof: { ok: false, error: { code: "conflict" } },
      created: { ok: true, value: { state: "active" } },
      retried: { ok: true, value: { state: "active" } },
      part: {
        ok: true,
        value: {
          nativeUploadId: "native-created",
          attemptId: "attempt-00000000-0000-4000-8000-000000000001",
        },
      },
      inspected: {
        ok: true,
        value: {
          schemaVersion: 2,
          lifecycle: "active",
          receiptCount: 1,
          operatorReconciliationRequired: 0,
        },
      },
      badAdmin: { ok: false, error: { code: "conflict" } },
      httpStatus: 404,
    });
    expect(nativeCreateCalls).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 60_000);

test("missing receipt credentials fail closed before schema mutation and native I/O", async () => {
  const runtimeProof = await managedObjectReceiptRuntimeProof({
    secret: SECRET,
    authority: AUTHORITY,
    bucketName: BUCKET,
  });
  const inspectProof = await managedObjectReceiptAdminProof({
    secret: SECRET,
    operation: "inspect",
    authority: AUTHORITY,
    bucketName: BUCKET,
  });
  const contents = await bundledWorker(runtimeProof, inspectProof);
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "managed-object-receipt-unconfigured-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          exports: {
            TakoserverManagedObjectReceipt: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            OBJECT_RECEIPTS: {
              type: "durable-object",
              workerName: "managed-object-receipt-unconfigured-test",
              exportName: "TakoserverManagedObjectReceipt",
            },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    const response = await runtime.dispatchFetch("https://worker.example/");
    const body = (await response.json()) as {
      readonly created: unknown;
      readonly inspected: unknown;
    };
    expect(body.created).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(body.inspected).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  } finally {
    await runtime.dispose();
  }
}, 60_000);
