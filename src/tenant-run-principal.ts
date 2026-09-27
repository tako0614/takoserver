import { canonicalDigest } from "./json.ts";

/** Derive the stable Host operation principal represented by a tenant-run credential. */
export async function tenantRunPrincipalId(claims: {
  readonly organizationId: string;
  readonly tenantRef: string;
  readonly spaceRef: string;
  readonly tokenId: string;
  readonly logicalPrincipalRef?: string;
}): Promise<string> {
  if (claims.logicalPrincipalRef === undefined) return `run:${claims.tokenId}`;
  const digest = await canonicalDigest({
    kind: "takoserver.tenant-run-operation-principal@v1",
    organizationId: claims.organizationId,
    tenantRef: claims.tenantRef,
    spaceRef: claims.spaceRef,
    logicalPrincipalRef: claims.logicalPrincipalRef,
  });
  // Retain the established run: principal class used by artifact closure
  // policy and durable CHECK constraints; only the owner identity changes.
  return `run:owner_${digest.slice(7)}`;
}
