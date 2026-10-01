import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentVariables } from "../scripts/deploy/realized-config.ts";
import { resolveProtected0058Custody } from "../scripts/deploy/schema-0058-custody.ts";
import { parseDeployTarget } from "../scripts/deploy/target.ts";
import { acquireWranglerVersionPublicationLease } from "../scripts/deploy/wrangler-state.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "takoserver-0058-custody-"));
  roots.push(parent);
  const root = join(parent, "custody");
  mkdirSync(root, { mode: 0o700 });
  const state = lstatSync(root, { bigint: true });
  const raw = {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "a".repeat(32),
    workerName: "takoserver-api-integration",
    d1: { databaseName: "fixture-0058", databaseId: "00000000-0000-4000-8000-000000000058" },
    r2: { bucketName: "fixture-objects" },
    publicOrigin: "https://integration.example.test",
    signing: { currentKeyId: "key-current" },
    protected0058Custody: {
      root,
      rootIdentity: { device: String(state.dev), inode: String(state.ino) },
    },
  };
  return { parent, root, raw };
}

test("operator-pinned 0058 custody is stable across target reloads and isolates database ids", () => {
  const { raw } = fixture();
  const first = resolveProtected0058Custody(
    parseDeployTarget(raw, "private target", "integration"),
  );
  const same = resolveProtected0058Custody(
    parseDeployTarget({ ...raw, workerName: "another-worker" }, "private target", "integration"),
  );
  const other = resolveProtected0058Custody(
    parseDeployTarget(
      { ...raw, d1: { ...raw.d1, databaseId: "00000000-0000-4000-8000-000000000059" } },
      "private target",
      "integration",
    ),
  );
  expect(first.attemptPrefix).toBe(same.attemptPrefix);
  expect(first.leaseRoot).toBe(same.leaseRoot);
  expect(other.attemptPrefix).not.toBe(first.attemptPrefix);
  expect(
    parseDeployTarget({ ...raw, protected0058Custody: undefined }, "ordinary", "integration")
      .protected0058Custody,
  ).toBeUndefined();
  expect(
    JSON.stringify(deploymentVariables(parseDeployTarget(raw, "private target", "integration"))),
  ).not.toContain(raw.protected0058Custody.root);
});

test("missing, replaced, symlinked, and non-private pinned roots hold unknown 0058 history", () => {
  const { parent, root, raw } = fixture();
  const target = parseDeployTarget(raw, "private target", "integration");
  const custody = resolveProtected0058Custody(target);
  renameSync(root, join(parent, "retained-old-root"));
  expect(() => resolveProtected0058Custody(target)).toThrow("prior dispatch cannot be ruled out");
  expect(() => custody.assertContinuity()).toThrow("prior dispatch cannot be ruled out");
  mkdirSync(root, { mode: 0o700 });
  expect(() => resolveProtected0058Custody(target)).toThrow("prior dispatch cannot be ruled out");
  rmSync(root, { recursive: true });
  const substitute = join(parent, "substitute");
  mkdirSync(substitute, { mode: 0o700 });
  symlinkSync(substitute, root);
  expect(() => resolveProtected0058Custody(target)).toThrow("prior dispatch cannot be ruled out");
  rmSync(root);
  mkdirSync(root, { mode: 0o700 });
  const currentState = lstatSync(root, { bigint: true });
  const rebound = parseDeployTarget(
    {
      ...raw,
      protected0058Custody: {
        root,
        rootIdentity: { device: String(currentState.dev), inode: String(currentState.ino) },
      },
    },
    "operator-rebound target",
    "integration",
  );
  chmodSync(root, 0o750);
  expect(() => resolveProtected0058Custody(rebound)).toThrow("prior dispatch cannot be ruled out");
  chmodSync(root, 0o700);
  if (process.getuid?.() === 0) {
    chownSync(root, 1, 1);
    expect(() => resolveProtected0058Custody(rebound)).toThrow(
      "prior dispatch cannot be ruled out",
    );
  }
});

test("an ancestor alias into a checkout cannot disguise a custody root as external", () => {
  const { parent, raw } = fixture();
  const checkout = join(parent, "checkout");
  const nested = join(checkout, "nested");
  const physicalRoot = join(nested, "custody");
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  mkdirSync(join(checkout, ".git"), { mode: 0o700 });
  mkdirSync(physicalRoot, { mode: 0o700 });
  const alias = join(parent, "alias");
  symlinkSync(nested, alias);
  const root = join(alias, "custody");
  const identity = lstatSync(root, { bigint: true });
  const target = parseDeployTarget(
    {
      ...raw,
      protected0058Custody: {
        root,
        rootIdentity: { device: String(identity.dev), inode: String(identity.ino) },
      },
    },
    "private target",
    "integration",
  );
  expect(() => resolveProtected0058Custody(target)).toThrow("prior dispatch cannot be ruled out");
});

test("pinned-root lease refuses to recreate lost custody and serializes same DB only", async () => {
  const { root, raw } = fixture();
  const target = parseDeployTarget(raw, "private target", "integration");
  const custody = resolveProtected0058Custody(target);
  const sameDb = {
    accountId: target.accountId,
    workerName: `d1-${target.d1.databaseId}`,
    root: custody.leaseRoot,
    createRoot: false,
  };
  const lease = await acquireWranglerVersionPublicationLease(sameDb);
  try {
    await expect(acquireWranglerVersionPublicationLease(sameDb)).rejects.toThrow(
      "active kernel lease",
    );
    const other = await acquireWranglerVersionPublicationLease({
      ...sameDb,
      workerName: "d1-00000000-0000-4000-8000-000000000059",
    });
    await other.release();
  } finally {
    await lease.release();
  }
  rmSync(root, { recursive: true });
  await expect(acquireWranglerVersionPublicationLease(sameDb)).rejects.toThrow();
  expect(() => custody.assertContinuity()).toThrow("prior dispatch cannot be ruled out");
});
