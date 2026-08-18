import { describe, expect, test } from "bun:test";
import { createCloudflareS3CredentialIssuer } from "../src/providers/cloudflare-s3.ts";

const NOW = new Date("2026-08-18T17:30:00.000Z");
const ACCOUNT_ID = "a10162d23653f1ad1193dabf520a5dd0";
const PARENT_ACCESS_KEY_ID = "0123456789abcdef0123456789abcdef";
const PARENT_SECRET_ACCESS_KEY = "a".repeat(64);

describe("Cloudflare R2 temporary S3 credentials", () => {
  test("signs a bucket-scoped session locally with the parent S3 secret", async () => {
    const issuer = createCloudflareS3CredentialIssuer({
      accountId: ACCOUNT_ID,
      providerInstallationRef: "cloudflare.primary",
      parentAccessKeyId: PARENT_ACCESS_KEY_ID,
      parentSecretAccessKey: PARENT_SECRET_ACCESS_KEY,
      clock: () => NOW,
    });

    const credentials = await issuer.issue({
      organizationId: "org_example",
      resourceUid: "uid_bucket",
      deploymentId: "dep_bucket",
      offeringId: "storage.object.standard",
      providerPackRef: "cloudflare",
      providerInstallationRef: "cloudflare.primary",
      nativeId: "r2:takoserver-objects",
      access: "read-write",
      ttlSeconds: 120,
    });

    expect(credentials.endpoint).toBe(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(credentials.region).toBe("auto");
    expect(credentials.bucket).toBe("takoserver-objects");
    expect(credentials.accessKeyId).toBe(PARENT_ACCESS_KEY_ID);
    expect(credentials.expiresAt).toBe("2026-08-18T17:31:55.000Z");

    const session = atob(credentials.sessionToken);
    expect(session.startsWith("jwt/")).toBe(true);
    const jwt = session.slice("jwt/".length);
    const [encodedHeader, encodedClaims, encodedSignature, extra] = jwt.split(".");
    expect(extra).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(base64UrlBytes(encodedHeader)))).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(new TextDecoder().decode(base64UrlBytes(encodedClaims)))).toEqual({
      aud: `${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: "takoserver-objects",
      exp: 1_787_074_320,
      iat: 1_787_074_200,
      iss: PARENT_ACCESS_KEY_ID,
      scope: "object-read-write",
      sub: ACCOUNT_ID,
    });

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(PARENT_SECRET_ACCESS_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "HMAC",
        key,
        base64UrlBytes(encodedSignature),
        new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
      ),
    ).toBe(true);
    expect(credentials.secretAccessKey).toBe(await sha256Hex(jwt));
  });
});

function base64UrlBytes(value: string | undefined): Uint8Array<ArrayBuffer> {
  if (!value) throw new Error("missing JWT component");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
