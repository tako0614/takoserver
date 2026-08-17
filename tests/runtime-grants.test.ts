import { describe, expect, test } from "bun:test";
import {
  createExecutionGrantSigner,
  createRuntimeGrantVerifier,
  GrantVerificationError,
  InMemoryGrantReplayStore,
} from "../src/index.ts";

const issuedAt = Date.parse("2026-08-17T12:00:00.000Z");

describe("independent Takoserver runtime authorization", () => {
  test("verifies a Takoserver-issued grant locally and consumes it once", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const signer = createExecutionGrantSigner({
      issuer: "https://api.takoserver.com",
      keyId: "grant-key-2026-08",
      privateKey: keys.privateKey,
    });
    const token = await signer.issue({
      audience: "takoserver.runtime.v1",
      securityDomainId: "domain_runtime_test",
      tenantRef: "tenant_opaque_runtime",
      reservationId: "reservation_runtime_001",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      operation: "resource.provision",
      intentDigest: `sha256:${"a".repeat(64)}`,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(issuedAt + 60_000),
      grantId: "grant_single_use_001",
    });
    const verifier = createRuntimeGrantVerifier({
      issuer: "https://api.takoserver.com",
      audience: "takoserver.runtime.v1",
      publicKeys: new Map([["grant-key-2026-08", keys.publicKey]]),
      replayStore: new InMemoryGrantReplayStore(),
      clock: () => new Date(issuedAt + 1_000),
      maxLifetimeSeconds: 300,
    });

    await expect(
      verifier.verifyAndConsume(token, {
        operation: "resource.provision",
        tenantRef: "tenant_opaque_runtime",
      }),
    ).resolves.toMatchObject({
      issuer: "https://api.takoserver.com",
      audience: "takoserver.runtime.v1",
      tenantRef: "tenant_opaque_runtime",
      reservationId: "reservation_runtime_001",
      operation: "resource.provision",
      grantId: "grant_single_use_001",
    });

    await expect(verifier.verifyAndConsume(token)).rejects.toEqual(
      new GrantVerificationError("grant_replayed"),
    );
  });

  test("rejects tampering, wrong audience, and expiry before replay consumption", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const signer = createExecutionGrantSigner({
      issuer: "https://api.takoserver.com",
      keyId: "key-1",
      privateKey: keys.privateKey,
    });
    const token = await signer.issue({
      audience: "takoserver.runtime.v1",
      securityDomainId: "domain_runtime_test",
      tenantRef: "tenant_fail_closed",
      reservationId: "reservation_fail_closed",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      operation: "resource.provision",
      intentDigest: `sha256:${"a".repeat(64)}`,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(issuedAt + 60_000),
      grantId: "grant_fail_closed_01",
    });
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) throw new Error("invalid test token");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        tenantRef: "tenant_attacker",
      }),
    ).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;

    const base = {
      issuer: "https://api.takoserver.com",
      publicKeys: new Map([["key-1", keys.publicKey]]),
      replayStore: new InMemoryGrantReplayStore(),
      maxLifetimeSeconds: 300,
    };
    await expect(
      createRuntimeGrantVerifier({
        ...base,
        audience: "takoserver.runtime.v1",
        clock: () => new Date(issuedAt + 1_000),
      }).verifyAndConsume(tampered),
    ).rejects.toEqual(new GrantVerificationError("invalid_signature"));
    await expect(
      createRuntimeGrantVerifier({
        ...base,
        audience: "another-runtime",
        clock: () => new Date(issuedAt + 1_000),
      }).verifyAndConsume(token),
    ).rejects.toEqual(new GrantVerificationError("wrong_audience"));
    await expect(
      createRuntimeGrantVerifier({
        ...base,
        audience: "takoserver.runtime.v1",
        clock: () => new Date(issuedAt + 60_001),
      }).verifyAndConsume(token),
    ).rejects.toEqual(new GrantVerificationError("grant_expired"));
  });
});
