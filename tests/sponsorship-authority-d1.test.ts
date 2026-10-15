import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { canonicalDigest } from "../src/json.ts";
import { createLedger } from "../src/ledger.ts";
import { minorToMicros } from "../src/money.ts";
import {
  createSponsorshipAuthority,
  SponsorshipAuthorityError,
} from "../src/sponsorship-authority.ts";
import type { SponsorshipCredentialIssuer } from "../src/sponsorship-credential.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";

const NOW = new Date("2026-09-04T00:00:00.000Z");
const MANAGED_POLICY_DIGEST = `sha256:${"d".repeat(64)}` as const;
const CHANNEL = {
  kind: "takosumi-hosted.sponsorship-authority-rpc@v1",
  hostedVersionId: "11111111-1111-4111-8111-111111111111",
  issuanceOperationId: "sha256:e0040eb636e863ccfd9f5760bdb36a05d776bb872d428712aacd546f5ac5ad5d",
  requestNonce: "a".repeat(43),
  requestSha256: `sha256:${"b".repeat(64)}`,
} as const;

test("D1 executes the guarded bind and preserves duplicate, conflict, and floor semantics", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "sponsorship-authority-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "authority-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const entry of MIGRATIONS.filter(({ name }) => name <= "0094_wallet_usd_micros.sql")) {
      await applyMigration(database, entry.sql);
    }
    const sql = createD1Sql(database as unknown as D1DatabaseLike);
    for (const organizationId of ["org_hosted", "org_other"]) {
      await sql.run(
        "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
        [organizationId, organizationId, "principal_owner", NOW.toISOString()],
      );
    }
    await createLedger(sql, () => NOW).fund({
      organizationId: "org_hosted",
      fundingRef: "funding:d1",
      amountMicros: minorToMicros(1_000),
      kind: "purchased",
      consumptionClass: "purchased",
    });
    await sql.run(
      "INSERT INTO sponsorship_tenants (tenant_ref, org_id, created_at) VALUES (?, ?, ?)",
      ["tenant:conflict", "org_other", NOW.toISOString()],
    );

    const signed: Parameters<SponsorshipCredentialIssuer["issue"]>[0][] = [];
    const authority = createSponsorshipAuthority({
      sql,
      organizationId: "org_hosted",
      clock: () => NOW,
      credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "c".repeat(43) },
      receipts: {
        async issue() {
          return "receipt.payload.signature";
        },
      },
      issuanceAuthority: {
        workerName: "takoserver-sponsorship-authority-test",
        versionId: "22222222-2222-4222-8222-222222222222",
        sourceCommit: "e".repeat(40),
        artifactSha256: `sha256:${"f".repeat(64)}`,
        credentialKeyId: "credential-key-test",
        receiptKeyId: "receipt-key-test",
      },
      credentialIssuer: {
        async issue(input) {
          signed.push(input);
          return {
            token: "header.payload.signature",
            expiresAt: "2026-09-04T00:05:00.000Z",
          };
        },
      },
    });
    const admitted = {
      tenantRef: "tenant:d1",
      spaceRef: "space:d1",
      runRef: "run:d1",
      requiredAvailableMinor: 1_000,
      channel: CHANNEL,
    } as const;

    const [first, replay] = await Promise.all([
      authority.issueTenantRunCredential(admitted),
      authority.issueTenantRunCredential(admitted),
    ]);
    expect(replay).toEqual(first);
    await expect(
      authority.issueTenantRunCredential({
        ...admitted,
        tenantRef: "tenant:unfunded",
        requiredAvailableMinor: 1_001,
        channel: {
          ...(await channelFor("c")),
        },
      }),
    ).rejects.toEqual(new SponsorshipAuthorityError("authority_denied"));
    await expect(
      authority.issueTenantRunCredential({
        ...admitted,
        tenantRef: "tenant:conflict",
        channel: {
          ...(await channelFor("d")),
        },
      }),
    ).rejects.toEqual(new SponsorshipAuthorityError("authority_denied"));

    const managedSigned: Parameters<SponsorshipCredentialIssuer["issue"]>[0][] = [];
    const managedEnsures: string[] = [];
    const managedAuthority = createSponsorshipAuthority({
      sql,
      organizationId: "org_hosted",
      clock: () => NOW,
      credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "c".repeat(43) },
      receipts: {
        async issue() {
          return "receipt.managed.payload";
        },
      },
      issuanceAuthority: {
        workerName: "takoserver-sponsorship-authority-test",
        versionId: "22222222-2222-4222-8222-222222222222",
        sourceCommit: "e".repeat(40),
        artifactSha256: `sha256:${"f".repeat(64)}`,
        credentialKeyId: "credential-key-test",
        receiptKeyId: "receipt-key-test",
      },
      credentialIssuer: {
        async issue(input) {
          managedSigned.push(input);
          return {
            token: "header.managed.signature",
            expiresAt: "2026-09-04T00:05:00.000Z",
          };
        },
      },
      managedSpaceAdmission: {
        policyDigest: MANAGED_POLICY_DIGEST,
        async ensureTenantSpaceAdmission(input) {
          managedEnsures.push(input.tenantRef);
          expect(
            await sql.query(
              "SELECT tenant_ref, org_id FROM sponsorship_tenants WHERE tenant_ref = ?",
              [input.tenantRef],
            ),
          ).toEqual([{ tenant_ref: input.tenantRef, org_id: "org_hosted" }]);
          expect(
            await sql.query(
              "SELECT COUNT(*) AS total FROM sponsorship_credential_issuance_operations",
            ),
          ).toEqual([{ total: 1 }]);
          return {
            organizationId: "org_hosted",
            tenantRef: input.tenantRef,
            spaceRef: input.tenantRef,
            policyDigest: MANAGED_POLICY_DIGEST,
            ready: true,
          };
        },
      },
    });
    const managedInput = {
      tenantRef: "tenant:managed-d1",
      spaceRef: "tenant:managed-d1",
      runRef: "run:managed-d1",
      requiredAvailableMinor: 1_000,
      channel: await channelFor("e"),
    } as const;
    await expect(managedAuthority.issueTenantRunCredential(managedInput)).resolves.toMatchObject({
      token: "header.managed.signature",
      expiresAt: "2026-09-04T00:05:00.000Z",
    });
    expect(managedEnsures).toEqual(["tenant:managed-d1"]);
    expect(managedSigned).toHaveLength(1);

    expect(new Set(signed.map((input) => JSON.stringify(input))).size).toBe(1);
    expect(
      await sql.query("SELECT COUNT(*) AS total FROM sponsorship_credential_issuance_operations"),
    ).toEqual([{ total: 2 }]);
    expect(
      await sql.query("SELECT tenant_ref, org_id FROM sponsorship_tenants ORDER BY tenant_ref"),
    ).toEqual([
      { tenant_ref: "tenant:conflict", org_id: "org_other" },
      { tenant_ref: "tenant:d1", org_id: "org_hosted" },
      { tenant_ref: "tenant:managed-d1", org_id: "org_hosted" },
    ]);
  } finally {
    await runtime.dispose();
  }
});

async function channelFor(character: string) {
  const requestSha256 = `sha256:${character.repeat(64)}` as `sha256:${string}`;
  return {
    ...CHANNEL,
    requestSha256,
    issuanceOperationId: await canonicalDigest({
      kind: "takosumi-hosted.sponsorship-issuance-operation@v1",
      requestSha256,
    }),
  };
}

function statements(source: string): string[] {
  const result: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest) {
    if (/^CREATE\s+TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end) throw new Error("migration fixture has an incomplete trigger");
      const boundary = (end.index ?? 0) + end[0].length;
      result.push(rest.slice(0, boundary));
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      result.push(rest);
      break;
    }
    result.push(rest.slice(0, boundary).trim());
    rest = rest.slice(boundary + 1).trim();
  }
  return result.filter(Boolean);
}

async function applyMigration(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  source: string,
): Promise<void> {
  for (const statement of statements(source)) {
    await database.prepare(statement).run();
  }
}
