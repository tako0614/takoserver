import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { startStableLocalCloudflareHost } from "../src/entry-stable-local-cloudflare-host.ts";

const TAKOFORM_ROOT = resolve(import.meta.dir, "fixtures/takoform-v1");

describe("the stable local Cloudflare-backed Host", () => {
  test("installs the exact 12 Form kinds used by the 13-resource Yurucommu graph without current ObjectBucket", async () => {
    const host = await startStableLocalCloudflareHost({
      takoformRepositoryRoot: TAKOFORM_ROOT,
      token: "stable-local-cloudflare-token",
      runtimeValues: {
        ENCRYPTION_KEY: "local-e2e-encryption-key-32-bytes",
        TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.local.invalid",
        TAKOSUMI_ACCOUNTS_CLIENT_ID: "local-client",
        TAKOSUMI_ACCOUNTS_OWNER_SUB: "local-owner",
        TAKOSUMI_ACCOUNTS_REDIRECT_URI: "https://worker.local.invalid/auth/callback",
      },
    });
    try {
      expect(host.report()).toMatchObject({
        classification: "test-only-local-cloudflare-adapter",
        installedFormKindCount: 12,
        resourceGraphCount: 13,
        currentObjectBucketIdentities: 0,
        currentEdgeObjectsReferences: 0,
      });
      expect(
        await fetch(`${host.endpoint}/.well-known/takoform/v1`).then((response) => response.status),
      ).toBe(200);
    } finally {
      await host.close();
    }
  });
});
