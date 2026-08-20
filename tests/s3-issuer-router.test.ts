import { describe, expect, test } from "bun:test";
import { createS3CredentialIssuerRouter } from "../src/s3-issuer-router.ts";
import type { S3CredentialIssuer } from "../src/s3-port.ts";

function issuer(name: string): S3CredentialIssuer {
  return {
    limits: () => ({ minimumSeconds: 900, maximumSeconds: 3_600, defaultSeconds: 900 }),
    async issue() {
      return {
        endpoint: `https://${name}.example.com`,
        region: "test",
        bucket: name,
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: "token",
        expiresAt: "2026-08-19T10:15:00.000Z",
      };
    },
  };
}

const ISSUE = {
  organizationId: "org",
  resourceUid: "uid",
  deploymentId: "dep",
  offeringId: "offering",
  providerPackRef: "wasabi",
  providerInstallationRef: "wasabi.primary",
  nativeId: `wasabi:eu-central-2:ts-${"a".repeat(40)}`,
  access: "read-only" as const,
  ttlSeconds: 900,
};

describe("S3 credential issuer router", () => {
  test("routes only the exact Deployment provider pair", async () => {
    const router = createS3CredentialIssuerRouter([
      {
        providerPackRef: "cloudflare",
        providerInstallationRef: "cloudflare.primary",
        issuer: issuer("r2"),
      },
      {
        providerPackRef: "wasabi",
        providerInstallationRef: "wasabi.primary",
        issuer: issuer("wasabi"),
      },
    ]);
    expect((await router.issue(ISSUE)).bucket).toBe("wasabi");
    expect(router.limits({ ...ISSUE, providerInstallationRef: "wasabi.other" })).toBeNull();
  });

  test("rejects an ambiguous configured route", () => {
    expect(() =>
      createS3CredentialIssuerRouter([
        { providerPackRef: "wasabi", providerInstallationRef: "primary", issuer: issuer("one") },
        { providerPackRef: "wasabi", providerInstallationRef: "primary", issuer: issuer("two") },
      ]),
    ).toThrow("duplicate S3 credential issuer route");
  });
});
