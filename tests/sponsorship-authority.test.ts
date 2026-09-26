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
const managedPolicyDigest = `sha256:${"d".repeat(64)}` as const;
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

  test("managed issuance claims before narrow admission and starts a full TTL after delayed readiness", async () => {
    const fixture = await managedFixture({
      onEnsure: async ({ sql, state }) => {
        expect(
          await sql.query(
            "SELECT tenant_ref, org_id FROM sponsorship_tenants WHERE tenant_ref = ?",
            ["tenant:managed"],
          ),
        ).toEqual([{ tenant_ref: "tenant:managed", org_id: "org_hosted" }]);
        expect(
          await sql.query(
            "SELECT issuance_operation_id FROM sponsorship_credential_issuance_operations",
          ),
        ).toEqual([]);
        state.current = new Date("2026-09-04T00:02:00.000Z");
      },
    });

    const issued = await fixture.authority.issueTenantRunCredential(managedInput());

    expect(issued.expiresAt).toBe("2026-09-04T00:07:00.000Z");
    expect(fixture.issued[0]?.issuedAtEpochSeconds).toBe(
      Math.floor(Date.parse("2026-09-04T00:02:00.000Z") / 1_000),
    );
    expect(fixture.events).toEqual(["ensure", "sign", "receipt"]);
    expect(
      await fixture.sql.query(
        "SELECT tenant_ref, org_id, created_at FROM sponsorship_tenants WHERE tenant_ref = ?",
        ["tenant:managed"],
      ),
    ).toEqual([
      {
        tenant_ref: "tenant:managed",
        org_id: "org_hosted",
        created_at: now.toISOString(),
      },
    ]);
  });

  test("managed admission failure leaves the guarded claim but no issuance or signer effect", async () => {
    const fixture = await managedFixture({ ensureError: new Error("admission unavailable") });

    await expect(fixture.authority.issueTenantRunCredential(managedInput())).rejects.toEqual(
      new SponsorshipAuthorityError("authority_denied"),
    );
    expect(fixture.events).toEqual(["ensure"]);
    expect(fixture.issued).toEqual([]);
    expect(
      await fixture.sql.query(
        "SELECT tenant_ref, org_id FROM sponsorship_tenants WHERE tenant_ref = ?",
        ["tenant:managed"],
      ),
    ).toEqual([{ tenant_ref: "tenant:managed", org_id: "org_hosted" }]);
    expect(
      await fixture.sql.query(
        "SELECT issuance_operation_id FROM sponsorship_credential_issuance_operations",
      ),
    ).toEqual([]);
  });

  test("managed scope grammar is checked before any claim or admission", async () => {
    const fixture = await managedFixture();
    for (const { tenantRef, spaceRef } of [
      { tenantRef: "tenant:managed", spaceRef: "other:space" },
      { tenantRef: "tenant:bad/space", spaceRef: "tenant:bad/space" },
      { tenantRef: "a".repeat(256), spaceRef: "a".repeat(256) },
    ]) {
      await expect(
        fixture.authority.issueTenantRunCredential(managedInput({ tenantRef, spaceRef })),
      ).rejects.toEqual(new SponsorshipAuthorityError("invalid_input"));
    }
    expect(fixture.events).toEqual([]);
    expect(await fixture.sql.query("SELECT tenant_ref FROM sponsorship_tenants")).toEqual([]);
  });

  test("foreign ownership and an unavailable wallet never reach narrow admission", async () => {
    const foreign = await managedFixture();
    await foreign.sql.run(
      "INSERT INTO sponsorship_tenants (tenant_ref, org_id, created_at) VALUES (?, ?, ?)",
      ["tenant:managed", "org_other", now.toISOString()],
    );
    await expect(foreign.authority.issueTenantRunCredential(managedInput())).rejects.toEqual(
      new SponsorshipAuthorityError("authority_denied"),
    );
    expect(foreign.events).toEqual([]);
    expect(foreign.issued).toEqual([]);

    const unfunded = await managedFixture({ fundAmount: 0 });
    await expect(unfunded.authority.issueTenantRunCredential(managedInput())).rejects.toEqual(
      new SponsorshipAuthorityError("authority_denied"),
    );
    expect(unfunded.events).toEqual([]);
    expect(unfunded.issued).toEqual([]);
    expect(await unfunded.sql.query("SELECT tenant_ref FROM sponsorship_tenants")).toEqual([]);
  });

  test("managed readiness requires the exact organization, Space, policy digest, and closed shape", async () => {
    const invalidReady: unknown[] = [
      managedReady("tenant:managed", { policyDigest: `sha256:${"0".repeat(64)}` }),
      { ...managedReady("tenant:managed"), extra: true },
      managedReady("tenant:managed", { organizationId: "org_other" }),
      managedReady("tenant:managed", { spaceRef: "other:space" }),
      {
        organizationId: "org_hosted",
        tenantRef: "tenant:managed",
        spaceRef: "tenant:managed",
        ready: true,
      },
    ];
    for (const ready of invalidReady) {
      const fixture = await managedFixture({ ready });
      await expect(fixture.authority.issueTenantRunCredential(managedInput())).rejects.toEqual(
        new SponsorshipAuthorityError("authority_denied"),
      );
      expect(fixture.issued).toEqual([]);
      expect(
        await fixture.sql.query(
          "SELECT issuance_operation_id FROM sponsorship_credential_issuance_operations",
        ),
      ).toEqual([]);
    }
  });

  test("a wallet change after readiness blocks the issuance CAS", async () => {
    const fixture = await managedFixture({
      onEnsure: async ({ ledger }) => {
        expect(
          await ledger.hold({
            organizationId: "org_hosted",
            reference: "hold:after-admission",
            amountMinor: 1_000,
          }),
        ).toBe(true);
      },
    });

    await expect(fixture.authority.issueTenantRunCredential(managedInput())).rejects.toEqual(
      new SponsorshipAuthorityError("authority_denied"),
    );
    expect(fixture.events).toEqual(["ensure"]);
    expect(fixture.issued).toEqual([]);
    expect(
      await fixture.sql.query(
        "SELECT tenant_ref, org_id FROM sponsorship_tenants WHERE tenant_ref = ?",
        ["tenant:managed"],
      ),
    ).toEqual([{ tenant_ref: "tenant:managed", org_id: "org_hosted" }]);
    expect(
      await fixture.sql.query(
        "SELECT issuance_operation_id FROM sponsorship_credential_issuance_operations",
      ),
    ).toEqual([]);
  });

  test("exact managed replay skips re-admission and retains token and issued time after wallet change", async () => {
    const fixture = await managedFixture();
    const input = managedInput();
    const first = await fixture.authority.issueTenantRunCredential(input);
    expect(
      await fixture.ledger.hold({
        organizationId: "org_hosted",
        reference: "hold:after-first-issuance",
        amountMinor: 1_000,
      }),
    ).toBe(true);
    fixture.state.current = new Date("2026-09-04T00:04:00.000Z");

    const replay = await fixture.authority.issueTenantRunCredential(input);

    expect(replay).toEqual(first);
    expect(fixture.ensureCalls).toBe(1);
    expect(fixture.issued).toHaveLength(2);
    expect(fixture.issued[1]?.issuedAtEpochSeconds).toBe(fixture.issued[0]?.issuedAtEpochSeconds);
    expect(fixture.events).toEqual(["ensure", "sign", "receipt", "sign", "receipt"]);
  });

  test("an input conflict is rejected before managed admission", async () => {
    const fixture = await managedFixture();
    const input = managedInput();
    await fixture.authority.issueTenantRunCredential(input);
    const events = [...fixture.events];

    await expect(
      fixture.authority.issueTenantRunCredential({ ...input, runRef: "run:changed" }),
    ).rejects.toEqual(new SponsorshipAuthorityError("operation_conflict"));
    expect(fixture.events).toEqual(events);
    expect(fixture.ensureCalls).toBe(1);
    expect(
      await fixture.sql.query(
        "SELECT COUNT(*) AS total FROM sponsorship_credential_issuance_operations",
      ),
    ).toEqual([{ total: 1 }]);
  });
});

interface ManagedFixtureOptions {
  readonly fundAmount?: number;
  readonly ready?: unknown;
  readonly ensureError?: unknown;
  readonly onEnsure?: (context: {
    readonly sql: ReturnType<typeof createEphemeralSql>;
    readonly ledger: ReturnType<typeof createLedger>;
    readonly state: { current: Date };
  }) => Promise<void>;
}

async function managedFixture(options: ManagedFixtureOptions = {}) {
  const sql = await authoritySql();
  await organization(sql, "org_hosted");
  const state = { current: now };
  const ledger = createLedger(sql, () => state.current);
  if ((options.fundAmount ?? 1_000) > 0) {
    await ledger.fund({
      organizationId: "org_hosted",
      fundingRef: "funding:managed",
      amountMinor: options.fundAmount ?? 1_000,
    });
  }
  const events: string[] = [];
  const issued: Parameters<SponsorshipCredentialIssuer["issue"]>[0][] = [];
  let ensureCalls = 0;
  const authority = createSponsorshipAuthority({
    sql,
    organizationId: "org_hosted",
    clock: () => state.current,
    ...receiptOptions,
    credentialIssuer: fakeCredentialIssuer({
      async issue(input) {
        events.push("sign");
        issued.push(input);
        return {
          token: `token.${input.tokenId}`,
          expiresAt: new Date((input.issuedAtEpochSeconds + 300) * 1_000).toISOString(),
        };
      },
    }),
    receipts: {
      async issue(input) {
        events.push("receipt");
        return `receipt.${input.token}`;
      },
    },
    managedSpaceAdmission: {
      policyDigest: managedPolicyDigest,
      async ensureTenantSpaceAdmission(input) {
        events.push("ensure");
        ensureCalls++;
        if (options.onEnsure) await options.onEnsure({ sql, ledger, state });
        if (options.ensureError !== undefined) throw options.ensureError;
        return options.ready ?? managedReady(input.tenantRef);
      },
    },
  });
  return {
    authority,
    sql,
    ledger,
    state,
    events,
    issued,
    get ensureCalls() {
      return ensureCalls;
    },
  };
}

function managedInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantRef: "tenant:managed",
    spaceRef: "tenant:managed",
    runRef: "run:managed",
    requiredAvailableMinor: 1_000,
    channel,
    ...overrides,
  };
}

function managedReady(
  tenantRef: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    organizationId: "org_hosted",
    tenantRef,
    spaceRef: tenantRef,
    policyDigest: managedPolicyDigest,
    ready: true,
    ...overrides,
  };
}

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
