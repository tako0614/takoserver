import { describe, expect, test } from "bun:test";
import { createWasabiS3CredentialIssuer } from "../src/providers/wasabi-s3.ts";

const NOW = new Date("2026-08-19T10:00:00.000Z");
const ISSUE = {
  organizationId: "org_example",
  resourceUid: "uid_bucket",
  deploymentId: "dep_bucket",
  offeringId: "storage.object.wasabi.eu-central-2",
  providerPackRef: "wasabi",
  providerInstallationRef: "wasabi.primary",
  nativeId: `wasabi:eu-central-2:ts-${"a".repeat(40)}`,
  access: "read-write" as const,
  ttlSeconds: 900,
};

describe("Wasabi temporary S3 credentials", () => {
  test("assumes the configured role with one exact bucket policy", async () => {
    let request: Request | undefined;
    const issuer = createWasabiS3CredentialIssuer({
      providerInstallationRef: "wasabi.primary",
      roleArn: "arn:aws:iam::1234567890:role/takoserver-bucket-access",
      accessKeyId: "parent-access-key",
      secretAccessKey: "parent-secret-key",
      clock: () => NOW,
      async fetch(input) {
        request = input;
        return new Response(
          `<AssumeRoleResponse><AssumeRoleResult><Credentials>` +
            `<AccessKeyId>temporary-key</AccessKeyId>` +
            `<SecretAccessKey>temporary-secret</SecretAccessKey>` +
            `<SessionToken>temporary-token</SessionToken>` +
            `<Expiration>2026-08-19T10:15:00.000Z</Expiration>` +
            `</Credentials></AssumeRoleResult></AssumeRoleResponse>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      },
    });

    expect(issuer.limits(ISSUE)).toEqual({
      minimumSeconds: 900,
      maximumSeconds: 3_600,
      defaultSeconds: 900,
    });
    const result = await issuer.issue(ISSUE);
    expect(result).toEqual({
      endpoint: "https://s3.eu-central-2.wasabisys.com",
      region: "eu-central-2",
      bucket: `ts-${"a".repeat(40)}`,
      accessKeyId: "temporary-key",
      secretAccessKey: "temporary-secret",
      sessionToken: "temporary-token",
      expiresAt: "2026-08-19T10:15:00.000Z",
    });
    expect(request?.url).toBe("https://sts.wasabisys.com/");
    expect(request?.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 ");
    const body = new URLSearchParams(await request?.text());
    expect(body.get("Action")).toBe("AssumeRole");
    expect(body.get("DurationSeconds")).toBe("900");
    expect(JSON.parse(body.get("Policy") ?? "null")).toEqual({
      Statement: [
        {
          Action: ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
          Effect: "Allow",
          Resource: `arn:aws:s3:::ts-${"a".repeat(40)}`,
        },
        {
          Action: [
            "s3:AbortMultipartUpload",
            "s3:DeleteObject",
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:ListMultipartUploadParts",
            "s3:PutObject",
          ],
          Effect: "Allow",
          Resource: `arn:aws:s3:::ts-${"a".repeat(40)}/*`,
        },
      ],
      Version: "2012-10-17",
    });
    expect(JSON.stringify(request)).not.toContain("parent-secret-key");
  });

  test("refuses another installation and malformed or oversized upstream XML", async () => {
    const issuer = createWasabiS3CredentialIssuer({
      providerInstallationRef: "wasabi.primary",
      roleArn: "arn:aws:iam::1234567890:role/takoserver-bucket-access",
      accessKeyId: "parent-access-key",
      secretAccessKey: "parent-secret-key",
      fetch: async () =>
        new Response(`<!DOCTYPE x><AccessKeyId>${"x".repeat(70_000)}</AccessKeyId>`, {
          status: 200,
        }),
    });
    expect(issuer.limits({ ...ISSUE, providerInstallationRef: "wasabi.other" })).toBeNull();
    await expect(issuer.issue(ISSUE)).rejects.toMatchObject({ code: "upstream_invalid" });
  });
});
