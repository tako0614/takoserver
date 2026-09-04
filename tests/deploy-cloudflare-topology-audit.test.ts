import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCloudflareTopologyVisibility } from "../scripts/deploy/cloudflare-topology-audit.ts";

const ACCOUNT = "a".repeat(32);
const DEPLOYMENT = "b".repeat(32);
const AUDIT = "c".repeat(32);
const ZONE_READ = "d".repeat(32);
const ROUTES_WRITE = "e".repeat(32);
const ROUTES_READ = "f".repeat(32);

describe("Takoserver Cloudflare topology audit", () => {
  test("accepts exact active all-zone policy and rejects partial-zone policy", async () => {
    const fixture = credential();
    try {
      await expect(
        verifyCloudflareTopologyVisibility({
          accountId: ACCOUNT,
          deploymentToken: "deployment-token-value",
          auditCredentialPath: fixture.path,
          get: provider(true),
        }),
      ).resolves.toMatchObject({
        deploymentTokenIdSha256: expect.stringMatching(/^sha256:/u),
      });
      await expect(
        verifyCloudflareTopologyVisibility({
          accountId: ACCOUNT,
          deploymentToken: "deployment-token-value",
          auditCredentialPath: fixture.path,
          get: provider(false),
        }),
      ).rejects.toThrow("lacks exact all-zone visibility");
    } finally {
      fixture.cleanup();
    }
  });

  test("uses Workers Routes Read and rejects the mutation permission", async () => {
    const fixture = credential();
    try {
      await expect(
        verifyCloudflareTopologyVisibility({
          accountId: ACCOUNT,
          deploymentToken: "deployment-token-value",
          auditCredentialPath: fixture.path,
          get: provider(true, true),
        }),
      ).rejects.toThrow("unexpectedly grants Workers Routes Write");
      await expect(
        verifyCloudflareTopologyVisibility({
          accountId: ACCOUNT,
          deploymentToken: "deployment-token-value",
          auditCredentialPath: fixture.path,
          get: provider(true, false, true),
        }),
      ).rejects.toThrow("unexpectedly grants Workers Routes Write");
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects weak file custody before provider reads", async () => {
    const fixture = credential();
    chmodSync(fixture.path, 0o644);
    let calls = 0;
    try {
      await expect(
        verifyCloudflareTopologyVisibility({
          accountId: ACCOUNT,
          deploymentToken: "deployment-token-value",
          auditCredentialPath: fixture.path,
          get: async () => {
            calls += 1;
            return "";
          },
        }),
      ).rejects.toThrow("owned 0600");
      expect(calls).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});

function credential() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-topology-audit-"));
  const path = join(root, "credential.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      kind: "takoserver.cloudflare-topology-audit-credential@v1",
      deploymentTokenOwner: "user",
      token: "separate-audit-token",
    })}\n`,
    { mode: 0o600 },
  );
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function provider(allZones: boolean, grantWrite = false, writeElsewhere = false) {
  return async (url: string, token: string): Promise<string> => {
    if (url.endsWith("/verify")) {
      return envelope({
        id: token === "separate-audit-token" ? AUDIT : DEPLOYMENT,
        status: "active",
      });
    }
    if (url.endsWith("/permission_groups")) {
      return envelope([
        { id: ZONE_READ, name: "Zone Read", scopes: ["com.cloudflare.api.account.zone"] },
        {
          id: ROUTES_READ,
          name: "Workers Routes Read",
          scopes: ["com.cloudflare.api.account.zone"],
        },
        {
          id: ROUTES_WRITE,
          name: "Workers Routes Write",
          scopes: ["com.cloudflare.api.account.zone"],
        },
      ]);
    }
    return envelope({
      id: DEPLOYMENT,
      status: "active",
      policies: [
        {
          effect: "allow",
          resources: allZones
            ? {
                [`com.cloudflare.api.account.${ACCOUNT}`]: {
                  "com.cloudflare.api.account.zone.*": "*",
                },
              }
            : { [`com.cloudflare.api.account.zone.${"f".repeat(32)}`]: "*" },
          permission_groups: [{ id: ZONE_READ }, { id: grantWrite ? ROUTES_WRITE : ROUTES_READ }],
        },
        ...(writeElsewhere
          ? [
              {
                effect: "allow",
                resources: { [`com.cloudflare.api.account.zone.${"0".repeat(32)}`]: "*" },
                permission_groups: [{ id: ROUTES_WRITE }],
              },
            ]
          : []),
      ],
    });
  };
}

function envelope(result: unknown): string {
  return JSON.stringify({ success: true, result });
}
