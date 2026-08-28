import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveSigningKeyId,
  expectedWorkerSecrets,
  writeWorkerConfig,
} from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "production",
  accountId: "a".repeat(32),
  workerName: "takoserver-api",
  d1: { databaseName: "takoserver-runtime", databaseId: "00000000-0000-4000-8000-000000000000" },
  r2: { bucketName: "takoserver-objects" },
  publicOrigin: "https://api.takoserver.example",
  signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
  hostedTopology: {
    service: "takosumi-hosted",
    entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
  },
} satisfies DeployTarget;

describe("realized Worker configuration", () => {
  test("keeps the current signing id while Hosted topology is the desired routine state", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-v2-"));
    try {
      const path = writeWorkerConfig(target, {
        path: join(root, "wrangler.jsonc"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
        hostedTopology: "desired",
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(effectiveSigningKeyId(target)).toBe("key-current");
      expect(config.vars).toMatchObject({ TAKOSERVER_SIGNING_KEY_ID: "key-current" });
      expect(config.services).toEqual([
        {
          binding: "HOST_RUNTIME_MATERIALIZER",
          service: "takosumi-hosted",
          entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
        },
      ]);
      expect(config.secrets).toEqual({
        required: ["TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN", "TAKOSERVER_SIGNING_KEY"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("can seal the pre-topology token state without silently changing signing", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-token-"));
    try {
      const path = writeWorkerConfig(target, {
        path: join(root, "wrangler.jsonc"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
        hostedTopology: "absent",
        signingKeyId: "key-current",
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config).not.toHaveProperty("services");
      expect(config.vars).toMatchObject({ TAKOSERVER_SIGNING_KEY_ID: "key-current" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives an exact secret inventory from enabled product capabilities", () => {
    expect(expectedWorkerSecrets(target)).toEqual([
      "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
      "TAKOSERVER_SIGNING_KEY",
    ]);
    const { hostedTopology: _hostedTopology, ...withoutHostedTopology } = target;
    expect(
      expectedWorkerSecrets({
        ...withoutHostedTopology,
        stripeCheckout: true,
        r2ParentAccessKeyId: "parent-key",
      }),
    ).toEqual(["STRIPE_SECRET_KEY", "TAKOSERVER_R2_PARENT_TOKEN", "TAKOSERVER_SIGNING_KEY"]);
  });
});
