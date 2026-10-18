import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { readClosureSecretInputs } from "../scripts/deploy/worker-closure-transition.ts";
import {
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
} from "../scripts/deploy/worker-state.ts";
import { assertSurfaceTransitionPredecessor } from "../scripts/deploy/worker-surface-transition.ts";

const CLIENT_SECRET = "TAKOSERVER_SHARED_AUTH_CLIENT_SECRET";
const SESSION_KEY = "TAKOSERVER_SHARED_AUTH_SESSION_ENCRYPTION_KEY";
const AUTH_SECRETS = [CLIENT_SECRET, SESSION_KEY] as const;
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: { databaseName: "runtime-db", databaseId: "00000000-0000-4000-8000-000000000001" },
  r2: { bucketName: "takoserver-test-objects" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;
const selected = {
  ...target,
  auth103NativeProfile: "root-shared-auth-staging-v1",
} satisfies DeployTarget;

function versionFor(closure: ReturnType<typeof expectedExactBindingClosure>) {
  return {
    resources: {
      bindings: Object.entries(closure).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function withSecretDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "takoserver-auth103-secrets-"));
  chmodSync(directory, 0o700);
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("selected Root Auth103 secret closure", () => {
  test("adds exactly the two dedicated names only to the selected profile", () => {
    expect(expectedWorkerSecrets(target)).toEqual(["TAKOSERVER_SIGNING_KEY"]);
    expect(expectedWorkerSecrets(selected)).toEqual([...AUTH_SECRETS, "TAKOSERVER_SIGNING_KEY"]);
    expect(
      expectedWorkerSecrets({
        ...selected,
        stripeCheckout: true,
        stripeWebhook: true,
        takoformV2: { config: "{}" },
      }),
    ).toEqual([
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      ...AUTH_SECRETS,
      "TAKOSERVER_SIGNING_KEY",
      "TAKOSERVER_TAKOFORM_V2_CURSOR_KEY",
    ]);
  });

  test("requires both exact secret_text bindings and rejects any extra binding", () => {
    const closure = expectedExactBindingClosure(selected);
    for (const name of AUTH_SECRETS) {
      expect(closure[name]).toEqual({ type: "secret_text", fields: {} });
      expect(expectedExactBindingClosure(target)[name]).toBeUndefined();
    }
    const exact = versionFor(closure);
    expect(() =>
      assertExactVersionBindingClosure("preflight", "version-1", exact, closure),
    ).not.toThrow();
    for (const name of AUTH_SECRETS) {
      const absent = {
        resources: {
          bindings: exact.resources.bindings.filter((binding) => binding.name !== name),
        },
      };
      expect(() =>
        assertExactVersionBindingClosure("preflight", "version-1", absent, closure),
      ).toThrow(`does not declare the ${name} binding`);
      const wrongType = {
        resources: {
          bindings: exact.resources.bindings.map((binding) =>
            binding.name === name ? { ...binding, type: "plain_text", text: "synthetic" } : binding,
          ),
        },
      };
      expect(() =>
        assertExactVersionBindingClosure("preflight", "version-1", wrongType, closure),
      ).toThrow(`binds ${name} with unexpected type`);
    }
    const extra = {
      resources: {
        bindings: [
          ...exact.resources.bindings,
          { name: "UNKNOWN_AUTH_SECRET", type: "secret_text" },
        ],
      },
    };
    expect(() =>
      assertExactVersionBindingClosure("preflight", "version-1", extra, closure),
    ).toThrow("exact selected target closure");
  });

  test("keeps basic Host closure and secret transition admission closed", () => {
    const basic = expectedExactBindingClosure(target);
    const withAuthSecrets = versionFor(expectedExactBindingClosure(selected));
    expect(() =>
      assertExactVersionBindingClosure("preflight", "basic", withAuthSecrets, basic),
    ).toThrow("exact selected target closure");
    expect(() =>
      assertSurfaceTransitionPredecessor("preflight", "basic", versionFor(basic), {
        delta: {
          retiredVars: [],
          addedVars: [],
          refreshedVars: [],
          addedBindings: [],
          addedSecrets: [...AUTH_SECRETS],
          rotatedSecrets: [],
        },
        targetClosure: basic,
        targetSecrets: expectedWorkerSecrets(target),
      }),
    ).toThrow("does not describe the closure this surface publishes");
  });

  test("reads the dedicated transport values only through existing private file custody", () => {
    withSecretDirectory((directory) => {
      const client = "synthetic-root-rp-client-secret";
      const key = "A".repeat(43);
      writeFileSync(join(directory, CLIENT_SECRET), client, { mode: 0o600 });
      writeFileSync(join(directory, SESSION_KEY), key, { mode: 0o600 });
      expect(readClosureSecretInputs(directory, AUTH_SECRETS)).toEqual({
        [CLIENT_SECRET]: client,
        [SESSION_KEY]: key,
      });
      chmodSync(join(directory, SESSION_KEY), 0o644);
      expect(() => readClosureSecretInputs(directory, AUTH_SECRETS)).toThrow(
        "must be an owned 0600 exact non-whitespace regular file",
      );
    });
  });

  test("refuses noncanonical session keys without exposing the supplied bytes", () => {
    withSecretDirectory((directory) => {
      for (const key of ["A".repeat(42), "A".repeat(44), "B".repeat(43), `${"A".repeat(42)}=`]) {
        writeFileSync(join(directory, SESSION_KEY), key, { mode: 0o600 });
        let failure: unknown;
        try {
          readClosureSecretInputs(directory, [SESSION_KEY]);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(DeployError);
        expect(String(failure)).toContain("must be canonical base64url32");
        expect(String(failure)).not.toContain(key);
      }
    });
  });

  test("preserves generic secret limits while applying the dedicated client transport bound", () => {
    withSecretDirectory((directory) => {
      const boundary = "c".repeat(8192);
      writeFileSync(join(directory, CLIENT_SECRET), boundary, { mode: 0o600 });
      expect(readClosureSecretInputs(directory, [CLIENT_SECRET])[CLIENT_SECRET]).toBe(boundary);
      writeFileSync(join(directory, CLIENT_SECRET), `${boundary}c`, { mode: 0o600 });
      expect(() => readClosureSecretInputs(directory, [CLIENT_SECRET])).toThrow(
        "exceeds its exact transport bound",
      );
      writeFileSync(join(directory, CLIENT_SECRET), "synthetic\u0000invalid", { mode: 0o600 });
      expect(() => readClosureSecretInputs(directory, [CLIENT_SECRET])).toThrow(
        "must be an owned 0600 exact non-whitespace regular file",
      );
      const ordinary = "TAKOSERVER_SIGNING_KEY";
      const existingLimit = "g".repeat(8193);
      writeFileSync(join(directory, ordinary), existingLimit, { mode: 0o600 });
      expect(readClosureSecretInputs(directory, [ordinary])[ordinary]).toBe(existingLimit);
    });
  });
});
