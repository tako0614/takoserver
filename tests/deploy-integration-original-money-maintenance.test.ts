import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { IntegrationStorageOriginalCreateOptions } from "../scripts/deploy/integration-storage-generation.ts";
import {
  readIntegrationMoneyMaintenancePublicationOriginal,
  runIntegrationWorkerBootstrap,
} from "../scripts/deploy/integration-worker-bootstrap.ts";
import { REPOSITORY } from "../scripts/deploy/process.ts";
import { expectedWorkerSecrets, writeWorkerConfig } from "../scripts/deploy/realized-config.ts";
import { type DeployTarget, parseDeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const COMMIT = "c".repeat(40);
const GENERATION = "d".repeat(32);
const selectedTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "integration-money-maintenance",
  publicOrigin: "https://integration-money-maintenance.example-subdomain.workers.dev",
  d1: {
    databaseName: `integration-ts-${GENERATION}`,
    databaseId: "00000000-0000-4000-8000-000000000092",
  },
  r2: { bucketName: `integration-ts-${GENERATION}` },
  signing: { currentKeyId: "actual-owner-key" },
  schemaMaintenanceMode: "pre-wallet-usd-micros-quiesced",
  moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
  moneyCutoverWriterEpoch: sha("old epoch"),
  takoformV2: {
    storageLineage: "v2-0092",
    config: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/auth",
    }),
  },
} satisfies DeployTarget;
const invocation = { action: "apply", environment: "integration", commit: COMMIT } as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "money-maintenance-source-"));
  roots.push(root);
  const originalRoot = join(root, "original");
  mkdirSync(originalRoot, { mode: 0o700 });
  const pin = lstatSync(originalRoot);
  const originalCreate: IntegrationStorageOriginalCreateOptions = {
    kind: "positive-fresh-0092",
    custodyDirectory: originalRoot,
    custodyIdentity: { device: String(pin.dev), inode: String(pin.ino) },
  };
  const originalCreateInputPath = join(root, "original-input.json");
  writeFileSync(originalCreateInputPath, JSON.stringify(originalCreate), { mode: 0o600 });
  const selectionPath = join(root, "selection.json");
  const locators = { originalCreateInputPath, selectionPath };
  const publicationRoot = join(
    dirname(originalRoot),
    `${basename(originalRoot)}.money-maintenance-publication`,
  );
  return {
    root,
    originalRoot,
    originalCreate,
    originalCreateInputPath,
    selectionPath,
    locators,
    publicationRoot,
  };
}

// These tests are bounded mechanics. A synthetic journal/read result is DATA, never native permission.
describe("original92 maintenance-only first-publication source boundary", () => {
  test("only the explicit operation selects a prefixed maintenance target; default publication stays closed", () => {
    expect(() => parseDeployTarget(selectedTarget, "test", "integration")).toThrow();
    const parsed = parseDeployTarget(
      selectedTarget,
      "test",
      "integration",
      "money-original-maintenance-bootstrap",
    );
    expect(parsed.d1).toEqual(selectedTarget.d1);
    expect(parsed.moneyCutoverWriterEpoch).toBe(selectedTarget.moneyCutoverWriterEpoch);
    expect(parsed.schemaMaintenanceMode).toBe("pre-wallet-usd-micros-quiesced");
  });

  test("normal code, an alias, another lineage or an unpinned epoch cannot use the maintenance operation", () => {
    for (const changed of [
      { ...selectedTarget, schemaMaintenanceMode: undefined },
      { ...selectedTarget, aliases: ["alias.example.test"] },
      {
        ...selectedTarget,
        takoformV2: { ...selectedTarget.takoformV2, storageLineage: "v2-0089" },
      },
      { ...selectedTarget, moneyCutoverWriterEpoch: undefined },
      { ...selectedTarget, publicOrigin: "https://other.example-subdomain.workers.dev" },
    ])
      expect(() =>
        parseDeployTarget(changed, "test", "integration", "money-original-maintenance-bootstrap"),
      ).toThrow();
  });

  test("an inherited or supplied proof/runner cannot accompany original locator selection", async () => {
    const f = fixture();
    let calls = 0;
    const run = async () => {
      calls++;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(
      runIntegrationWorkerBootstrap(invocation, selectedTarget, {
        originalMoneyMaintenance: f.locators,
        run,
      }),
    ).rejects.toThrow("no injected ports");
    expect(calls).toBe(0);
    expect(() => readFileSync(join(f.publicationRoot, "dispatch.json"))).toThrow();
  });

  test("the original selection option is captured without evaluating an accessor", async () => {
    const f = fixture();
    let reads = 0;
    const options = Object.defineProperty({}, "originalMoneyMaintenance", {
      enumerable: true,
      get() {
        reads++;
        return f.locators;
      },
    });
    await expect(
      runIntegrationWorkerBootstrap(invocation, selectedTarget, options),
    ).rejects.toThrow("no injected ports");
    expect(reads).toBe(0);
  });

  test("a JSON ready flag, supplied identity or extra result cannot stand in for original selectors", async () => {
    for (const value of [
      { ready: true },
      {
        kind: "takoserver.integration-money-maintenance-original-selection@v1",
        originalOrigin: { ready: true },
      },
      {
        kind: "takoserver.integration-money-maintenance-original-selection@v1",
        originalOrigin: {
          invocation: {
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            generation: GENERATION,
            namespace: "integration-ts",
            freshLineage: "v2-0092",
          },
          originalTargetPath: "/unavailable/original.json",
        },
        result: { databaseId: selectedTarget.d1.databaseId },
      },
    ]) {
      const f = fixture();
      writeFileSync(f.selectionPath, JSON.stringify(value), { mode: 0o600 });
      await expect(
        runIntegrationWorkerBootstrap(invocation, selectedTarget, {
          originalMoneyMaintenance: f.locators,
        }),
      ).rejects.toThrow("six-field invocation");
    }
  });

  test("a changed original invocation is rejected before a collision target or native port is opened", async () => {
    const f = fixture();
    writeFileSync(
      f.selectionPath,
      JSON.stringify({
        kind: "takoserver.integration-money-maintenance-original-selection@v1",
        originalOrigin: {
          invocation: {
            action: "status",
            environment: "integration",
            commit: COMMIT,
            generation: GENERATION,
            namespace: "integration-ts",
            freshLineage: "v2-0092",
          },
          originalTargetPath: "/unavailable/original.json",
        },
      }),
      { mode: 0o600 },
    );
    await expect(
      runIntegrationWorkerBootstrap(invocation, selectedTarget, {
        originalMoneyMaintenance: f.locators,
      }),
    ).rejects.toThrow("differs from fresh92");
  });

  test("positive absence from the historical DATA reader creates no publication directory or new dispatch", () => {
    const f = fixture();
    expect(
      readIntegrationMoneyMaintenancePublicationOriginal(
        f.originalCreate,
        selectedTarget,
        COMMIT,
        sha("origin"),
      ),
    ).toBeNull();
    expect(() => lstatSync(f.publicationRoot)).toThrow();
    expect(readFileSync(f.originalCreateInputPath, "utf8")).toBe(JSON.stringify(f.originalCreate));
  });

  test("a retained original dispatch remains unknown and is not manufactured into a terminal record", () => {
    const f = fixture();
    mkdirSync(f.publicationRoot, { mode: 0o700 });
    const binding = {
      originalCreateTerminalCustodyDigest: sha("origin"),
      targetDigest: "sha256:dd4791b9ef702eb3b8efaeaa4875d6d3496e0e90bea65819a81e277aecf7d6ca",
      sourceCommit: COMMIT,
      writerEpoch: selectedTarget.moneyCutoverWriterEpoch,
      moduleDigest: sha("module"),
      artifactDigest: sha("artifact"),
      artifactBytes: 10,
      artifactFiles: 2,
    };
    const dispatch = {
      kind: "takoserver.original-money-maintenance-publication-dispatch@v1",
      binding,
      bindingDigest: sha(JSON.stringify(binding)),
    };
    const dispatchPath = join(f.publicationRoot, "dispatch.json");
    writeFileSync(dispatchPath, JSON.stringify(dispatch), { mode: 0o600 });
    const before = readFileSync(dispatchPath);
    const read = readIntegrationMoneyMaintenancePublicationOriginal(
      f.originalCreate,
      selectedTarget,
      COMMIT,
      sha("origin"),
    );
    expect(read?.result).toBeNull();
    expect(read?.dispatchDigest).toBe(sha(JSON.stringify(dispatch)));
    expect(readFileSync(dispatchPath)).toEqual(before);
    expect(() => lstatSync(join(f.publicationRoot, "terminal.json"))).toThrow();
  });

  test("full-command historical terminal DATA is returned only against its original capture binding", () => {
    const f = fixture();
    mkdirSync(f.publicationRoot, { mode: 0o700 });
    const binding = {
      originalCreateTerminalCustodyDigest: sha("origin"),
      targetDigest: "sha256:dd4791b9ef702eb3b8efaeaa4875d6d3496e0e90bea65819a81e277aecf7d6ca",
      sourceCommit: COMMIT,
      writerEpoch: selectedTarget.moneyCutoverWriterEpoch,
      moduleDigest: sha("module"),
      artifactDigest: sha("artifact"),
      artifactBytes: 10,
      artifactFiles: 2,
    };
    const dispatch = {
      kind: "takoserver.original-money-maintenance-publication-dispatch@v1",
      binding,
      bindingDigest: sha(JSON.stringify(binding)),
    };
    writeFileSync(join(f.publicationRoot, "dispatch.json"), JSON.stringify(dispatch), {
      mode: 0o600,
    });
    const result = {
      kind: "takoserver.integration-worker-bootstrap-original-money-maintenance-apply@v1",
      originalCreateTerminalCustodyDigest: sha("origin"),
      commit: COMMIT,
      bundleDigest: binding.moduleDigest,
      maintenanceOnly: true,
      normalHostReady: false,
      runtimeSigningAndSecrets: "not-qualified-maintenance-unused",
      artifactDigest: binding.artifactDigest,
      artifactBytes: 10,
      artifactFiles: 2,
    };
    const terminal = {
      kind: "takoserver.original-money-maintenance-publication-terminal@v1",
      dispatchDigest: sha(JSON.stringify(dispatch)),
      result,
      resultDigest: sha(JSON.stringify(result)),
    };
    writeFileSync(join(f.publicationRoot, "terminal.json"), JSON.stringify(terminal), {
      mode: 0o600,
    });
    const read = readIntegrationMoneyMaintenancePublicationOriginal(
      f.originalCreate,
      selectedTarget,
      COMMIT,
      sha("origin"),
    );
    expect(read?.result).toEqual(result);
    expect(read?.terminalDigest).toBe(sha(JSON.stringify(terminal)));
    const { schemaMaintenanceMode: _mode, ...normalSelectionData } = selectedTarget;
    expect(
      readIntegrationMoneyMaintenancePublicationOriginal(
        f.originalCreate,
        normalSelectionData,
        COMMIT,
        sha("origin"),
      )?.result,
    ).toEqual(result);
    expect(() =>
      readIntegrationMoneyMaintenancePublicationOriginal(
        f.originalCreate,
        {
          ...selectedTarget,
          d1: { ...selectedTarget.d1, databaseId: "00000000-0000-4000-8000-000000000093" },
        },
        COMMIT,
        sha("origin"),
      ),
    ).toThrow("full command");
    expect(() =>
      readIntegrationMoneyMaintenancePublicationOriginal(
        f.originalCreate,
        selectedTarget,
        "e".repeat(40),
        sha("origin"),
      ),
    ).toThrow("full command");
    expect(() =>
      readIntegrationMoneyMaintenancePublicationOriginal(
        f.originalCreate,
        selectedTarget,
        COMMIT,
        sha("other origin"),
      ),
    ).toThrow("full command");
  });
});

describe("original maintenance-only v2 corrections", () => {
  test("an existing empty, unknown or terminal-only custody root is never positive absence", () => {
    for (const name of [null, "unexpected.json", "terminal.json"] as const) {
      const f = fixture();
      mkdirSync(f.publicationRoot, { mode: 0o700 });
      if (name !== null) writeFileSync(join(f.publicationRoot, name), "{}", { mode: 0o600 });
      expect(() =>
        readIntegrationMoneyMaintenancePublicationOriginal(
          f.originalCreate,
          selectedTarget,
          COMMIT,
          sha("origin"),
        ),
      ).toThrow("partial or contains unknown");
      expect(() => lstatSync(join(f.publicationRoot, "dispatch.json"))).toThrow();
    }
  });

  test("publication invocation getters are not evaluated before native original capture", async () => {
    const f = fixture();
    let reads = 0;
    const request = {
      environment: "integration" as const,
      commit: COMMIT,
      get action(): "apply" {
        reads++;
        return "apply";
      },
    };
    await expect(
      runIntegrationWorkerBootstrap(request, selectedTarget, {
        originalMoneyMaintenance: f.locators,
      }),
    ).rejects.toThrow("accessor");
    expect(reads).toBe(0);
  });

  test("the source-owned empty-secret profile retains epoch/mode bindings and normal secret requirements", () => {
    const f = fixture();
    const configPath = join(f.root, "maintenance-wrangler.jsonc");
    writeWorkerConfig(selectedTarget, {
      path: configPath,
      main: join(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: COMMIT,
      sourceRepositoryRoot: REPOSITORY,
      transitionExpectedSecrets: [],
    });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.secrets.required).toEqual([]);
    expect(config.vars.TAKOSERVER_SCHEMA_MAINTENANCE_MODE).toBe("pre-wallet-usd-micros-quiesced");
    expect(config.vars.TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH).toBe(
      selectedTarget.moneyCutoverWriterEpoch,
    );
    expect(config.vars.TAKOSERVER_SIGNING_KEY_ID).toBe(selectedTarget.signing.currentKeyId);
    const maintenance = expectedExactBindingClosure(selectedTarget, { expectedSecrets: [] });
    expect(maintenance.TAKOSERVER_SIGNING_KEY).toBeUndefined();
    expect(maintenance.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY).toBeUndefined();
    expect(maintenance.STATE_DB?.fields.id).toBe(selectedTarget.d1.databaseId);
    expect(expectedWorkerSecrets(selectedTarget)).toEqual([
      "TAKOSERVER_SIGNING_KEY",
      "TAKOSERVER_TAKOFORM_V2_CURSOR_KEY",
    ]);
    expect(expectedExactBindingClosure(selectedTarget).TAKOSERVER_SIGNING_KEY?.type).toBe(
      "secret_text",
    );
  });
});
