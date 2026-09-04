import { expect, test } from "bun:test";
import {
  CloudflareManagedObjectS3,
  ManagedObjectS3Error,
} from "../src/providers/cloudflare-managed-object-s3.ts";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function adapter(
  responses: readonly Response[],
  calls: Request[] = [],
  bounds?: { readonly maximumPages?: number; readonly maximumCandidates?: number },
) {
  let index = 0;
  return {
    calls,
    client: new CloudflareManagedObjectS3({
      accountId: "account-123",
      accessKeyId: "synthetic-access-key",
      secretAccessKey: "synthetic-secret-key",
      now: () => new Date("2026-09-04T00:00:00.000Z"),
      fetch: async (request) => {
        calls.push(request.clone());
        const response = responses[index++];
        if (!response) throw new Error("unexpected S3 request");
        return response;
      },
      ...bounds,
    }),
  };
}

function listXml(input: {
  readonly uploads: readonly { readonly key: string; readonly uploadId: string }[];
  readonly truncated?: boolean;
  readonly nextKeyMarker?: string;
  readonly nextUploadIdMarker?: string;
}): string {
  const uploads = input.uploads
    .map(
      ({ key, uploadId }) =>
        `<Upload><Key>${key}</Key><UploadId>${uploadId}</UploadId><Initiated>2026-09-04T00:00:00Z</Initiated></Upload>`,
    )
    .join("");
  return `${XML_HEADER}<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${uploads}<IsTruncated>${input.truncated === true ? "true" : "false"}</IsTruncated>${input.nextKeyMarker ? `<NextKeyMarker>${input.nextKeyMarker}</NextKeyMarker>` : ""}${input.nextUploadIdMarker ? `<NextUploadIdMarker>${input.nextUploadIdMarker}</NextUploadIdMarker>` : ""}</ListMultipartUploadsResult>`;
}

test("private R2 S3 adapter signs create, lists the exact key across pages, and aborts", async () => {
  const calls: Request[] = [];
  const { client } = adapter(
    [
      new Response(
        listXml({
          uploads: [
            { key: "folder/object.bin", uploadId: "old-one" },
            { key: "folder/object.bin.extra", uploadId: "not-exact" },
          ],
          truncated: true,
          nextKeyMarker: "folder/object.bin",
          nextUploadIdMarker: "old-one",
        }),
        { status: 200 },
      ),
      new Response(listXml({ uploads: [{ key: "folder/object.bin", uploadId: "new-one" }] }), {
        status: 200,
      }),
      new Response(
        `${XML_HEADER}<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>bucket-one</Bucket><Key>folder/object.bin</Key><UploadId>created-id</UploadId></InitiateMultipartUploadResult>`,
        { status: 200 },
      ),
      new Response(null, { status: 204 }),
    ],
    calls,
  );

  expect(
    await client.listMultipartUploads({ bucketName: "bucket-one", key: "folder/object.bin" }),
  ).toEqual([
    { key: "folder/object.bin", uploadId: "old-one" },
    { key: "folder/object.bin", uploadId: "new-one" },
  ]);
  expect(
    await client.createMultipartUpload({
      bucketName: "bucket-one",
      key: "folder/object.bin",
      contentType: "application/octet-stream",
      marker: "A".repeat(43),
    }),
  ).toEqual({ uploadId: "created-id" });
  await client.abortMultipartUpload({
    bucketName: "bucket-one",
    key: "folder/object.bin",
    uploadId: "created-id",
  });

  expect(calls).toHaveLength(4);
  for (const call of calls) {
    expect(call.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /u);
    expect(call.url).not.toContain("synthetic-secret-key");
  }
  expect(new URL(calls[0]?.url ?? "").searchParams.get("prefix")).toBe("folder/object.bin");
  expect(new URL(calls[1]?.url ?? "").searchParams.get("key-marker")).toBe("folder/object.bin");
  expect(calls[2]?.headers.get("x-amz-meta-takoserver-multipart-receipt-v1")).toBe("A".repeat(43));
  expect(new URL(calls[3]?.url ?? "").searchParams.get("uploadId")).toBe("created-id");
});

test("private R2 S3 adapter fails closed on XML, pagination, response, and candidate bounds", async () => {
  const malformed = adapter([new Response("<not-list/>", { status: 200 })]).client;
  await expect(
    malformed.listMultipartUploads({ bucketName: "bucket-one", key: "object.bin" }),
  ).rejects.toBeInstanceOf(ManagedObjectS3Error);

  const unknownEntity = adapter([
    new Response(listXml({ uploads: [{ key: "object&unsupported;", uploadId: "one" }] }), {
      status: 200,
    }),
  ]).client;
  await expect(
    unknownEntity.listMultipartUploads({ bucketName: "bucket-one" }),
  ).rejects.toMatchObject({ code: "malformed_response" });

  const missingCursor = adapter([
    new Response(listXml({ uploads: [], truncated: true }), { status: 200 }),
  ]).client;
  await expect(
    missingCursor.listMultipartUploads({ bucketName: "bucket-one", key: "object.bin" }),
  ).rejects.toMatchObject({ code: "malformed_response" });

  const pageBound = adapter(
    [
      new Response(
        listXml({
          uploads: [{ key: "object.bin", uploadId: "one" }],
          truncated: true,
          nextKeyMarker: "object.bin",
          nextUploadIdMarker: "one",
        }),
        { status: 200 },
      ),
    ],
    [],
    { maximumPages: 1 },
  ).client;
  await expect(
    pageBound.listMultipartUploads({ bucketName: "bucket-one", key: "object.bin" }),
  ).rejects.toMatchObject({ code: "bound_exceeded" });

  const candidateBound = adapter(
    [
      new Response(
        listXml({
          uploads: [
            { key: "object.bin", uploadId: "one" },
            { key: "object.bin", uploadId: "two" },
          ],
        }),
        { status: 200 },
      ),
    ],
    [],
    { maximumCandidates: 1 },
  ).client;
  await expect(
    candidateBound.listMultipartUploads({ bucketName: "bucket-one", key: "object.bin" }),
  ).rejects.toMatchObject({ code: "bound_exceeded" });

  const oversized = adapter([
    new Response("x".repeat(262_145), {
      status: 200,
      headers: { "content-length": "262145" },
    }),
  ]).client;
  await expect(
    oversized.listMultipartUploads({ bucketName: "bucket-one", key: "object.bin" }),
  ).rejects.toMatchObject({ code: "bound_exceeded" });
});

test("private R2 S3 adapter sanitizes transport and credential failures", async () => {
  expect(
    () =>
      new CloudflareManagedObjectS3({
        accountId: "account-123",
        accessKeyId: "",
        secretAccessKey: "must-not-appear",
      }),
  ).toThrow("managed ObjectBucket S3 credentials are unavailable");

  const client = new CloudflareManagedObjectS3({
    accountId: "account-123",
    accessKeyId: "synthetic-access-key",
    secretAccessKey: "must-not-appear",
    fetch: async () => {
      throw new Error("must-not-appear");
    },
  });
  let caught: unknown;
  try {
    await client.listMultipartUploads({ bucketName: "bucket-one", key: "object.bin" });
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "transport" });
  expect(String(caught)).not.toContain("must-not-appear");
});
