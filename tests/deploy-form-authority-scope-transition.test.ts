import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFormAuthorityScopeTransition } from "../scripts/deploy/form-authority-scope-transition.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { canonicalDigest } from "../src/json.ts";

const HOST_ID = "https://api.integration.example.test";
const PREDECESSOR_SCOPE = {
  tenantId: "tenant-yurucommu-predecessor",
  space: "space-yurucommu-predecessor",
} as const;
const TARGET_SCOPE = {
  tenantId: "tenant-yurucommu-integration",
  space: "space-yurucommu-integration",
} as const;

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: HOST_ID,
  formAuthority: {
    workerName: "takoserver-form-authority-integration",
    integrationWorkerName: "takoserver-form-fixture-integration",
    integrationOperatorWorkerName: "takoserver-form-operator-integration",
    integrationOperatorOrigin: "https://form-authority.integration.example.test",
    integrationOperatorScope: TARGET_SCOPE,
    operatorPublicJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: "A".repeat(43),
    },
    hostId: HOST_ID,
  },
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    kind: "takoserver.integration-form-authority-scope-transition@v1",
    environment: "integration",
    hostId: HOST_ID,
    predecessorScope: PREDECESSOR_SCOPE,
    targetScope: TARGET_SCOPE,
    ...overrides,
  } as const;
}

function privateFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-scope-transition-"));
  roots.push(root);
  const path = join(root, "transition.json");
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe("operator-private Form authority scope transition descriptor", () => {
  test("loads one exact integration transition and binds its canonical digest to the target", async () => {
    const value = descriptor();
    const path = privateFile(`${JSON.stringify(value, null, 2)}\n`);

    const loaded = loadFormAuthorityScopeTransition(path, target);

    expect(loaded).toEqual({
      value,
      digest: await canonicalDigest(value),
    });
    expect(JSON.stringify(loaded)).not.toContain(path);
  });

  test("requires an absolute owned 0600 link-free regular file of at most 16 KiB", () => {
    const unsafeMode = privateFile(JSON.stringify(descriptor()));
    chmodSync(unsafeMode, 0o640);

    const hardlinkSource = privateFile(JSON.stringify(descriptor()));
    const hardlink = join(hardlinkSource, "..", "hardlink.json");
    linkSync(hardlinkSource, hardlink);

    const symlinkSource = privateFile(JSON.stringify(descriptor()));
    const symlink = join(symlinkSource, "..", "symlink.json");
    symlinkSync(symlinkSource, symlink);

    const oversized = privateFile(" ".repeat(16_385));

    for (const path of [
      "relative.json",
      unsafeMode,
      hardlinkSource,
      hardlink,
      symlink,
      oversized,
    ]) {
      const failure = (() => {
        try {
          loadFormAuthorityScopeTransition(path, target);
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(path);
    }
  });

  test("refuses duplicate members, secret fields, wrong identity, same scopes, and malformed scopes", () => {
    const duplicate = privateFile(
      '{"kind":"takoserver.integration-form-authority-scope-transition@v1","kind":"duplicate","environment":"integration","hostId":"https://api.integration.example.test","predecessorScope":{"tenantId":"tenant-old","space":"space-old"},"targetScope":{"tenantId":"tenant-yurucommu-integration","space":"space-yurucommu-integration"}}',
    );
    const cases = [
      duplicate,
      privateFile(JSON.stringify(descriptor({ secret: "must-not-be-accepted" }))),
      privateFile(JSON.stringify(descriptor({ kind: "wrong" }))),
      privateFile(JSON.stringify(descriptor({ environment: "production" }))),
      privateFile(JSON.stringify(descriptor({ hostId: "https://foreign.example.test" }))),
      privateFile(JSON.stringify(descriptor({ targetScope: PREDECESSOR_SCOPE }))),
      privateFile(JSON.stringify(descriptor({ predecessorScope: TARGET_SCOPE }))),
      privateFile(
        JSON.stringify(
          descriptor({
            predecessorScope: { ...PREDECESSOR_SCOPE, token: "must-not-be-accepted" },
          }),
        ),
      ),
      privateFile(JSON.stringify(descriptor({ predecessorScope: { tenantId: "", space: "x" } }))),
    ];

    for (const path of cases) {
      expect(() => loadFormAuthorityScopeTransition(path, target)).toThrow();
    }
  });
});
