import { describe, expect, test } from "bun:test";
import { tenantRunPrincipalId } from "../src/tenant-run-principal.ts";

describe("tenant-run principal derivation", () => {
  const claims = {
    organizationId: "org_alpha",
    tenantRef: "tenant_workspace_x",
    spaceRef: "tsp_capsule_yurucommu",
    tokenId: "tok_sponsor_first_run",
    logicalPrincipalRef: "tshlp_same_capsule",
  } as const;

  test("keeps legacy credentials bound to their token ID", async () => {
    expect(
      await tenantRunPrincipalId({
        organizationId: claims.organizationId,
        tenantRef: claims.tenantRef,
        spaceRef: claims.spaceRef,
        tokenId: claims.tokenId,
      }),
    ).toBe("run:tok_sponsor_first_run");
  });

  test("hashes org, tenant, Space, and opaque logical principal into the established owner form", async () => {
    expect(await tenantRunPrincipalId(claims)).toBe(
      "run:owner_e1bdacb1e67f96ddc8bbbeae71682caedac5e6052cacb09cbf5e2cef8b7ccae2",
    );
    expect(await tenantRunPrincipalId({ ...claims, spaceRef: "space_other" })).not.toBe(
      await tenantRunPrincipalId(claims),
    );
    expect(await tenantRunPrincipalId({ ...claims, tenantRef: "tenant_workspace_other" })).not.toBe(
      await tenantRunPrincipalId(claims),
    );
    expect(await tenantRunPrincipalId({ ...claims, organizationId: "org_other" })).not.toBe(
      await tenantRunPrincipalId(claims),
    );
    expect(await tenantRunPrincipalId({ ...claims, logicalPrincipalRef: "other_owner" })).not.toBe(
      await tenantRunPrincipalId(claims),
    );
  });
});
