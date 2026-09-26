import { WorkerEntrypoint } from "cloudflare:workers";
import { createSponsorshipAuthority } from "./sponsorship-authority.ts";
import {
  createSponsorshipCredentialIssuer,
  loadSponsorshipCredentialSigningKey,
} from "./sponsorship-credential.ts";
import {
  createSponsorshipIssuanceReceiptIssuer,
  loadSponsorshipReceiptSigningKey,
} from "./sponsorship-issuance-receipt.ts";
import { createD1Sql } from "./sql-d1.ts";

export interface SponsorshipAuthorityWorkerBindings {
  readonly STATE_DB: D1Database;
  readonly TAKOSERVER_SPONSORSHIP_ORGANIZATION_ID: string;
  readonly TAKOSERVER_SPONSORSHIP_TOKEN_ISSUER: string;
  readonly TAKOSERVER_SPONSORSHIP_CREDENTIAL_KEY_ID: string;
  readonly TAKOSERVER_SPONSORSHIP_CREDENTIAL_PUBLIC_JWK: string;
  readonly TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY: string;
  readonly TAKOSERVER_SPONSORSHIP_RECEIPT_KEY_ID: string;
  readonly TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY: string;
  readonly TAKOSERVER_SPONSORSHIP_AUTHORITY_WORKER_NAME: string;
  readonly TAKOSERVER_SPONSORSHIP_AUTHORITY_SOURCE_COMMIT: string;
  readonly TAKOSERVER_SPONSORSHIP_AUTHORITY_ARTIFACT_SHA256: `sha256:${string}`;
  readonly TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY_DIGEST?: string;
  readonly TENANT_SPACE_ADMISSION?: {
    ensureTenantSpaceAdmission(input: { readonly tenantRef: string }): Promise<unknown>;
  };
  readonly WORKER_VERSION: WorkerVersionMetadata;
}

/**
 * Route-less authority bound only by the Hosted Worker.
 *
 * The registration-only HTTP handler always refuses the request. The default
 * service-binding entrypoint exposes one authority RPC and receives the owning organization,
 * issuer, D1, and signing key only from its deploy-pinned binding closure.
 */
export default class SponsorshipAuthorityEntrypoint extends WorkerEntrypoint<SponsorshipAuthorityWorkerBindings> {
  override fetch(_request: Request): Response {
    return new Response(null, { status: 404 });
  }

  async issueTenantRunCredential(input: unknown) {
    const sql = createD1Sql(this.env.STATE_DB);
    const signingKey = await loadSponsorshipCredentialSigningKey(
      this.env.TAKOSERVER_SPONSORSHIP_CREDENTIAL_KEY_ID,
      this.env.TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY,
    );
    if (!signingKey) {
      throw new TypeError("sponsorship signing authority is unavailable");
    }
    const receiptKey = await loadSponsorshipReceiptSigningKey(
      this.env.TAKOSERVER_SPONSORSHIP_RECEIPT_KEY_ID,
      this.env.TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY,
    );
    if (!receiptKey) {
      throw new TypeError("sponsorship receipt authority is unavailable");
    }
    const credentialJwk = credentialPublicJwk(
      this.env.TAKOSERVER_SPONSORSHIP_CREDENTIAL_PUBLIC_JWK,
    );
    if (
      signingKey.publicJwk.x !== credentialJwk.x ||
      signingKey.keyId === receiptKey.keyId ||
      credentialJwk.x === receiptKey.publicJwk.x
    ) {
      throw new TypeError("sponsorship credential and receipt authorities must differ");
    }
    // Admission can take time. The authority samples the issuance instant only
    // after admission; the signer and expiry validation use the retained
    // operation's explicit instant, including when an RPC result is replayed.
    const clock = () => new Date();
    const admission = managedSpaceAdmission(this.env);
    const credentialIssuer = createSponsorshipCredentialIssuer({
      issuer: exactHttpsOrigin(this.env.TAKOSERVER_SPONSORSHIP_TOKEN_ISSUER),
      signingKey,
      clock,
    });
    return await createSponsorshipAuthority({
      sql,
      organizationId: this.env.TAKOSERVER_SPONSORSHIP_ORGANIZATION_ID,
      credentialIssuer,
      receipts: createSponsorshipIssuanceReceiptIssuer({
        key: receiptKey,
        authority: {
          workerName: this.env.TAKOSERVER_SPONSORSHIP_AUTHORITY_WORKER_NAME,
          versionId: this.env.WORKER_VERSION.id,
          sourceCommit: this.env.TAKOSERVER_SPONSORSHIP_AUTHORITY_SOURCE_COMMIT,
          artifactSha256: this.env.TAKOSERVER_SPONSORSHIP_AUTHORITY_ARTIFACT_SHA256,
        },
      }),
      credentialPublicJwk: credentialJwk,
      issuanceAuthority: {
        workerName: this.env.TAKOSERVER_SPONSORSHIP_AUTHORITY_WORKER_NAME,
        versionId: this.env.WORKER_VERSION.id,
        sourceCommit: this.env.TAKOSERVER_SPONSORSHIP_AUTHORITY_SOURCE_COMMIT,
        artifactSha256: this.env.TAKOSERVER_SPONSORSHIP_AUTHORITY_ARTIFACT_SHA256,
        credentialKeyId: this.env.TAKOSERVER_SPONSORSHIP_CREDENTIAL_KEY_ID,
        receiptKeyId: this.env.TAKOSERVER_SPONSORSHIP_RECEIPT_KEY_ID,
      },
      clock,
      ...(admission ? { managedSpaceAdmission: admission } : {}),
    }).issueTenantRunCredential(input);
  }
}

function managedSpaceAdmission(env: SponsorshipAuthorityWorkerBindings) {
  const policyDigest = env.TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY_DIGEST;
  const authority = env.TENANT_SPACE_ADMISSION;
  if (policyDigest === undefined && authority === undefined) return undefined;
  if (
    typeof policyDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(policyDigest) ||
    !authority ||
    typeof authority.ensureTenantSpaceAdmission !== "function"
  ) {
    throw new TypeError("managed Space admission binding is incomplete");
  }
  return {
    policyDigest: policyDigest as `sha256:${string}`,
    ensureTenantSpaceAdmission: (input: { readonly tenantRef: string }) =>
      authority.ensureTenantSpaceAdmission(input),
  };
}

function credentialPublicJwk(raw: string): {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("sponsorship credential signing key is invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["crv", "kty", "x"]) ||
    (value as Record<string, unknown>).kty !== "OKP" ||
    (value as Record<string, unknown>).crv !== "Ed25519" ||
    typeof (value as Record<string, unknown>).x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test((value as Record<string, unknown>).x as string)
  ) {
    throw new TypeError("sponsorship credential signing key is invalid");
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: (value as Record<string, unknown>).x as string,
  };
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new TypeError("sponsorship token issuer is invalid");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("sponsorship token issuer is invalid");
  }
  return url.origin;
}
