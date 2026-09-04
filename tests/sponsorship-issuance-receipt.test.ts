import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createSponsorshipIssuanceReceiptIssuer,
  SPONSORSHIP_ISSUANCE_RECEIPT_AUDIENCE,
  SPONSORSHIP_ISSUANCE_RECEIPT_TYPE,
} from "../src/sponsorship-issuance-receipt.ts";

describe("route-less sponsorship issuance receipt", () => {
  test("authenticates the exact Hosted channel and cannot be forged by the run-token key", async () => {
    const receiptPair = await pair();
    const legacyRunPair = await pair();
    const publicJwk = exactPublic(await crypto.subtle.exportKey("jwk", legacyRunPair.publicKey));
    const receipt = await createSponsorshipIssuanceReceiptIssuer({
      key: {
        keyId: "sponsorship-receipt-v1",
        privateKey: receiptPair.privateKey,
        publicJwk: exactPublic(await crypto.subtle.exportKey("jwk", receiptPair.publicKey)),
      },
      authority: {
        workerName: "takoserver-sponsorship-authority-staging",
        versionId: "11111111-1111-4111-8111-111111111111",
        sourceCommit: "a".repeat(40),
        artifactSha256: `sha256:${"b".repeat(64)}`,
      },
    }).issue({
      channel: {
        kind: "takosumi-hosted.sponsorship-authority-rpc@v1",
        hostedVersionId: "22222222-2222-4222-8222-222222222222",
        issuanceOperationId: `sha256:${"e".repeat(64)}`,
        requestNonce: "c".repeat(43),
        requestSha256: `sha256:${"d".repeat(64)}`,
      },
      token: "run.header.signature",
      issuedAt: new Date("2026-09-04T00:00:00.000Z"),
      expiresAt: "2026-09-04T00:05:00.000Z",
      credentialPublicJwk: publicJwk,
      organizationId: "org_hosted",
      tenantRef: "tenant:opaque",
      spaceRef: "tenant:opaque",
      runRef: "run:exact",
      requiredAvailableMinor: 2_300,
    });

    const [headerPart, payloadPart, signaturePart] = receipt.split(".") as [string, string, string];
    const header = decode(headerPart);
    const payload = decode(payloadPart) as Record<string, unknown>;
    expect(header).toEqual({
      alg: "EdDSA",
      kid: "sponsorship-receipt-v1",
      typ: SPONSORSHIP_ISSUANCE_RECEIPT_TYPE,
    });
    expect(payload).toMatchObject({
      aud: SPONSORSHIP_ISSUANCE_RECEIPT_AUDIENCE,
      hostedVersionId: "22222222-2222-4222-8222-222222222222",
      issuanceOperationId: `sha256:${"e".repeat(64)}`,
      requestNonceSha256: digestText("c".repeat(43)),
      requestSha256: `sha256:${"d".repeat(64)}`,
      requiredAvailableMinor: 2_300,
      credential: {
        organizationIdSha256: digestText("org_hosted"),
        tenantRefSha256: digestText("tenant:opaque"),
        tokenSha256: digestText("run.header.signature"),
        publicJwk,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("org_hosted");
    expect(JSON.stringify(payload)).not.toContain("tenant:opaque");
    expect(JSON.stringify(payload)).not.toContain("run.header.signature");
    const message = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const signature = Buffer.from(signaturePart, "base64url");
    expect(await crypto.subtle.verify("Ed25519", receiptPair.publicKey, signature, message)).toBe(
      true,
    );
    expect(await crypto.subtle.verify("Ed25519", legacyRunPair.publicKey, signature, message)).toBe(
      false,
    );
  });

  test("refuses a receipt key that the legacy run-token signer could use", async () => {
    const sharedPair = await pair();
    const sharedPublicJwk = exactPublic(await crypto.subtle.exportKey("jwk", sharedPair.publicKey));
    const receipts = createSponsorshipIssuanceReceiptIssuer({
      key: {
        keyId: "sponsorship-receipt-v1",
        privateKey: sharedPair.privateKey,
        publicJwk: sharedPublicJwk,
      },
      authority: {
        workerName: "takoserver-sponsorship-authority-staging",
        versionId: "11111111-1111-4111-8111-111111111111",
        sourceCommit: "a".repeat(40),
        artifactSha256: `sha256:${"b".repeat(64)}`,
      },
    });

    await expect(
      receipts.issue({
        channel: {
          kind: "takosumi-hosted.sponsorship-authority-rpc@v1",
          hostedVersionId: "22222222-2222-4222-8222-222222222222",
          issuanceOperationId: `sha256:${"e".repeat(64)}`,
          requestNonce: "c".repeat(43),
          requestSha256: `sha256:${"d".repeat(64)}`,
        },
        token: "run.header.signature",
        issuedAt: new Date("2026-09-04T00:00:00.000Z"),
        expiresAt: "2026-09-04T00:05:00.000Z",
        credentialPublicJwk: sharedPublicJwk,
        organizationId: "org_hosted",
        tenantRef: "tenant:opaque",
        spaceRef: "tenant:opaque",
        runRef: "run:exact",
        requiredAvailableMinor: 2_300,
      }),
    ).rejects.toThrow("dedicated");
  });
});

async function pair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

function exactPublic(jwk: JsonWebKey) {
  if (!jwk.x) throw new Error("fixture key has no public half");
  return { kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x };
}

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
