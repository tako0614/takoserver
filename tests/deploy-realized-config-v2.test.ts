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
  sponsorship: true,
} satisfies DeployTarget;

describe("realized Worker configuration", () => {
  test("realizes the independent public Worker with no service binding", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-v2-"));
    try {
      const path = writeWorkerConfig(target, {
        path: join(root, "wrangler.jsonc"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(effectiveSigningKeyId(target)).toBe("key-current");
      expect(config.vars).toMatchObject({ TAKOSERVER_SIGNING_KEY_ID: "key-current" });
      expect(config).not.toHaveProperty("services");
      expect(config.secrets).toEqual({
        required: ["TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN", "TAKOSERVER_SIGNING_KEY"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not infer sponsorship or a service route for a standalone target", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-token-"));
    try {
      const { sponsorship: _sponsorship, ...standalone } = target;
      const path = writeWorkerConfig(standalone, {
        path: join(root, "wrangler.jsonc"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
        signingKeyId: "key-current",
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config).not.toHaveProperty("services");
      expect(config.vars).toMatchObject({ TAKOSERVER_SIGNING_KEY_ID: "key-current" });
      expect(config.secrets).toEqual({ required: ["TAKOSERVER_SIGNING_KEY"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives an exact secret inventory from enabled product capabilities", () => {
    expect(expectedWorkerSecrets(target)).toEqual([
      "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
      "TAKOSERVER_SIGNING_KEY",
    ]);
    const { sponsorship: _sponsorship, ...withoutSponsorship } = target;
    expect(
      expectedWorkerSecrets({
        ...withoutSponsorship,
        stripeCheckout: true,
        r2ParentAccessKeyId: "parent-key",
      }),
    ).toEqual(["STRIPE_SECRET_KEY", "TAKOSERVER_R2_PARENT_TOKEN", "TAKOSERVER_SIGNING_KEY"]);
  });

  test("adds the canonical operator public JWK only in desired identity state", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-identity-"));
    try {
      const identityTarget = {
        ...target,
        environment: "integration",
        operatorIdentity: {
          publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "A".repeat(43) },
        },
      } satisfies DeployTarget;
      const desiredPath = writeWorkerConfig(identityTarget, {
        path: join(root, "desired.json"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
      });
      const { operatorIdentity: _operatorIdentity, ...withoutOperatorIdentity } = identityTarget;
      const absentPath = writeWorkerConfig(withoutOperatorIdentity, {
        path: join(root, "absent.json"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
      });
      const desired = JSON.parse(readFileSync(desiredPath, "utf8")) as {
        vars: Record<string, string>;
      };
      const absent = JSON.parse(readFileSync(absentPath, "utf8")) as {
        vars: Record<string, string>;
      };
      expect(desired.vars.OPERATOR_IDENTITY_PUBLIC_JWK).toBe(
        JSON.stringify(identityTarget.operatorIdentity.publicJwk),
      );
      expect(desired.vars).not.toHaveProperty("OPERATOR_PUBLIC_JWK");
      expect(absent.vars).not.toHaveProperty("OPERATOR_IDENTITY_PUBLIC_JWK");
      const {
        OPERATOR_IDENTITY_PUBLIC_JWK: _operatorIdentityPublicJwk,
        ...desiredWithoutIdentity
      } = desired.vars;
      expect(desiredWithoutIdentity).toEqual(absent.vars);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
