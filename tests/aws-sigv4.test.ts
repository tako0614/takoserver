import { describe, expect, test } from "bun:test";
import { signAwsV4Request } from "../src/providers/aws-sigv4.ts";

describe("AWS Signature Version 4", () => {
  test("matches the official S3 header-signing example", async () => {
    const request = await signAwsV4Request({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      service: "s3",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      headers: { range: "bytes=0-9" },
      now: new Date("2013-05-24T00:00:00.000Z"),
    });

    expect(request.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(request.headers.get("x-amz-content-sha256")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("never places a secret in the target URL", async () => {
    const request = await signAwsV4Request({
      method: "PUT",
      url: "https://s3.eu-central-1.wasabisys.com/tenant-bucket",
      region: "eu-central-1",
      service: "s3",
      credentials: { accessKeyId: "public-access", secretAccessKey: "private-secret" },
      now: new Date("2026-08-19T00:00:00.000Z"),
    });

    expect(request.url).not.toContain("public-access");
    expect(request.url).not.toContain("private-secret");
    expect(request.headers.get("authorization")).not.toContain("private-secret");
  });
});
