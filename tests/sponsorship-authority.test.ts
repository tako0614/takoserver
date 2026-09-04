import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import {
  createSponsorshipAuthority,
  SponsorshipAuthorityError,
} from "../src/sponsorship-authority.ts";
import {
  createSponsorshipCredentialIssuer,
  type SponsorshipCredentialIssuer,
} from "../src/sponsorship-credential.ts";
import { createSponsorshipIssuanceReceiptIssuer } from "../src/sponsorship-issuance-receipt.ts";

const now = new Date("2026-09-04T00:00:00.000Z");
const channel = {
  kind: "takosumi-hosted.sponsorship-authority-rpc@v1",
  hostedVersionId: "11111111-1111-4111-8111-111111111111",
  issuanceOperationId: "sha256:e0040eb636e863ccfd9f5760bdb36a05d776bb872d428712aacd546f5ac5ad5d",
  requestNonce: "a".repeat(43),
  requestSha256: `sha256:${"b".repeat(64)}`,
} as const;
const receiptOptions = {
  credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "c".repeat(43) } as const,
  receipts: {
    async issue() {
      return "receipt.payload.signature";
    },
  },
  issuanceAuthority: {
    workerName: "takoserver-sponsorship-authority-test",
    versionId: "22222222-2222-4222-8222-222222222222",
    sourceCommit: "e".repeat(40),
    artifactSha256: `sha256:${"f".repeat(64)}` as const,
    credentialKeyId: "credential-key-test",
    receiptKeyId: "receipt-key-test",
  },
};

describe("route-less Hosted sponsorship authority", () => {
  test("requires distinct sponsorship credential and receipt key identities at runtime", async () => {
    const sql = await authoritySql();
    expect(() =>
      createSponsorshipAuthority({
        sql,
        organizationId: "org_hosted",
        clock: () => now,
        ...receiptOptions,
        issuanceAuthority: {
          ...receiptOptions.issuanceAuthority,
          receiptKeyId: receiptOptions.issuanceAuthority.credentialKeyId,
        },
        credentialIssuer: fakeCredentialIssuer(),
      }),
    ).toThrow("dedicated");
  });

  test("binds the opaque tenant to the deployment organization and issues one exact 300-second run credential", async () => {
    const sql = await authoritySql();
    await organization(sql, "org_hosted");
    await createLedger(sql, () => now).fund({
      organizationId: "org_hosted",
      fundingRef: "funding:hosted",
      amountMinor: 2_000,
    });
    const issued: Parameters<SponsorshipCredentialIssuer["issue"]>[0][] = [];
    const authority = createSponsorshipAuthority({
      sql,
      organizationId: "org_hosted",
      clock: () => now,
      ...receiptOptions,
      credentialIssuer: fakeCredentialIssuer({
        async issue(input) {
          issued.push(input);
          return {
            token: "header.payload.signature",
            expiresAt: "2026-09-04T00:05:00.000Z",
          };
        },
      }),
    });

    const input = {
      tenantRef: "tenant:opaque",
      spaceRef: "space:opaque",
      runRef: "run:exact",
      requiredAvailableMinor: 1_500,
      channel,
      workerEndpointOriginReservationId: "reservation:opaque",
    } as const;
    const first = await authority.issueTenantRunCredential(input);
    expect(first).toEqual({
      token: "header.payload.signature",
      expiresAt: "2026-09-04T00:05:00.000Z",
      issuanceReceipt: "receipt.payload.signature",
    });
    await expect(authority.issueTenantRunCredential(input)).resolves.toEqual(first);
    expect(new Set(issued.map((item) => JSON.stringify(item))).size).toBe(1);

    await expect(
      authority.issueTenantRunCredential({ ...input, runRef: "run:mismatch" }),
    ).rejects.toEqual(new SponsorshipAuthorityError("operation_conflict"));
    expect(
      await sql.query(
        "SELECT tenant_ref, org_id, created_at FROM sponsorship_tenants WHERE tenant_ref = ?",
        ["tenant:opaque"],
      ),
    ).toEqual([
      {
        tenant_ref: "tenant:opaque",
        org_id: "org_hosted",
        created_at: now.toISOString(),
      },
    ]);
  });

  test("reconstructs the exact signed bearer and receipt after an RPC result is lost", async () => {
    const sql = await authoritySql();
    await organization(sql, "org_hosted");
    await createLedger(sql, () => now).fund({
      organizationId: "org_hosted",
      fundingRef: "funding:reconstruct",
      amountMinor: 2_000,
    });
    const credentialKeys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const receiptKeys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const credentialJwk = await exactPublicJwk(credentialKeys.publicKey);
    const receiptJwk = await exactPublicJwk(receiptKeys.publicKey);
    let current = now;
    const issuanceAuthority = receiptOptions.issuanceAuthority;
    const authority = createSponsorshipAuthority({
      sql,
      organizationId: "org_hosted",
      clock: () => current,
      credentialPublicJwk: credentialJwk,
      issuanceAuthority,
      credentialIssuer: createSponsorshipCredentialIssuer({
        issuer: "https://api.takoserver.test",
        signingKey: {
          keyId: issuanceAuthority.credentialKeyId,
          privateKey: credentialKeys.privateKey,
        },
        clock: () => current,
      }),
      receipts: createSponsorshipIssuanceReceiptIssuer({
        key: {
          keyId: issuanceAuthority.receiptKeyId,
          privateKey: receiptKeys.privateKey,
          publicJwk: receiptJwk,
        },
        authority: issuanceAuthority,
      }),
    });
    const input = {
      tenantRef: "tenant:reconstruct",
      spaceRef: "space:reconstruct",
      runRef: "run:reconstruct",
      requiredAvailableMinor: 1_500,
      channel,
    } as const;

    const issuedBeforeResultLoss = await authority.issueTenantRunCredential(input);
    current = new Date("2026-09-04T00:00:30.000Z");
    await expect(authority.issueTenantRunCredential(input)).resolves.toEqual(
      issuedBeforeResultLoss,
    );
    const operationRows = await sql.query(
      "SELECT * FROM sponsorship_credential_issuance_operations",
    );
    expect(operationRows).toHaveLength(1);
    expect(JSON.stringify(operationRows)).not.toContain(issuedBeforeResultLoss.token);
    expect(JSON.stringify(operationRows)).not.toContain("space:reconstruct");
    expect(JSON.stringify(operationRows)).not.toContain("run:reconstruct");
  });

  test("fails closed without binding or signing when the wallet floor is not met", async () => {
    const sql = await authoritySql();
    await organization(sql, "org_hosted");
    let signCalls = 0;
    const authority = createSponsorshipAuthority({
      sql,
      organizationId: "org_hosted",
      clock: () => now,
      ...receiptOptions,
      credentialIssuer: fakeCredentialIssuer({
        async issue() {
          signCalls += 1;
          throw new Error("must not sign");
        },
      }),
    });

    await expect(
      authority.issueTenantRunCredential({
        tenantRef: "tenant:unfunded",
        spaceRef: "space:opaque",
        runRef: "run:exact",
        requiredAvailableMinor: 1,
        channel,
      }),
    ).rejects.toEqual(new SponsorshipAuthorityError("authority_denied"));
    expect(signCalls).toBe(0);
    expect(
      await sql.query("SELECT tenant_ref FROM sponsorship_tenants WHERE tenant_ref = ?", [
        "tenant:unfunded",
      ]),
    ).toEqual([]);
  });

  test("keeps an existing tenant binding immutable on conflict", async () => {
    const sql = await authoritySql();
    await organization(sql, "org_hosted");
    await organization(sql, "org_other");
    await createLedger(sql, () => now).fund({
      organizationId: "org_hosted",
      fundingRef: "funding:hosted",
      amountMinor: 1_000,
    });
    await sql.run(
      "INSERT INTO sponsorship_tenants (tenant_ref, org_id, created_at) VALUES (?, ?, ?)",
      ["tenant:conflict", "org_other", now.toISOString()],
    );
    let signCalls = 0;
    const authority = createSponsorshipAuthority({
      sql,
      organizationId: "org_hosted",
      clock: () => now,
      ...receiptOptions,
      credentialIssuer: fakeCredentialIssuer({
        async issue() {
          signCalls += 1;
          throw new Error("must not sign");
        },
      }),
    });

    await expect(
      authority.issueTenantRunCredential({
        tenantRef: "tenant:conflict",
        spaceRef: "space:opaque",
        runRef: "run:exact",
        requiredAvailableMinor: 1,
        channel,
      }),
    ).rejects.toEqual(new SponsorshipAuthorityError("authority_denied"));
    expect(signCalls).toBe(0);
    expect(
      await sql.query("SELECT org_id FROM sponsorship_tenants WHERE tenant_ref = ?", [
        "tenant:conflict",
      ]),
    ).toEqual([{ org_id: "org_other" }]);
  });

  test("rejects caller-supplied organization, lifetime, and materialization fields", async () => {
    const sql = await authoritySql();
    await organization(sql, "org_hosted");
    const authority = createSponsorshipAuthority({
      sql,
      organizationId: "org_hosted",
      clock: () => now,
      ...receiptOptions,
      credentialIssuer: fakeCredentialIssuer(),
    });
    const base = {
      tenantRef: "tenant:opaque",
      spaceRef: "space:opaque",
      runRef: "run:exact",
      requiredAvailableMinor: 0,
      channel,
    };

    for (const extra of [
      { organizationId: "org_other" },
      { expiresInSeconds: 301 },
      { runtimeMaterialization: { phase: "apply" } },
    ]) {
      await expect(authority.issueTenantRunCredential({ ...base, ...extra })).rejects.toEqual(
        new SponsorshipAuthorityError("invalid_input"),
      );
    }
    await expect(
      authority.issueTenantRunCredential({
        ...base,
        channel: {
          ...channel,
          issuanceOperationId: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).rejects.toEqual(new SponsorshipAuthorityError("invalid_input"));
  });
});

async function organization(
  sql: ReturnType<typeof createEphemeralSql>,
  organizationId: string,
): Promise<void> {
  await sql.run("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)", [
    organizationId,
    organizationId,
    "principal:owner",
    now.toISOString(),
  ]);
}

async function exactPublicJwk(key: CryptoKey): Promise<{ kty: "OKP"; crv: "Ed25519"; x: string }> {
  const value = await crypto.subtle.exportKey("jwk", key);
  if (value.kty !== "OKP" || value.crv !== "Ed25519" || !value.x) {
    throw new Error("fixture Ed25519 public key is invalid");
  }
  return { kty: "OKP", crv: "Ed25519", x: value.x };
}

function fakeCredentialIssuer(
  overrides: Partial<SponsorshipCredentialIssuer> = {},
): SponsorshipCredentialIssuer {
  const unavailable = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    issue: unavailable,
    ...overrides,
  };
}

async function authoritySql(): Promise<ReturnType<typeof createEphemeralSql>> {
  return createEphemeralSql();
}
