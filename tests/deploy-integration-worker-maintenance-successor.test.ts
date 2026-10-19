import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationStorageOriginalCreateOptions } from "../scripts/deploy/integration-storage-generation.ts";
import {
  INTEGRATION_WORKER_MAINTENANCE_SUCCESSOR_GATE_TESTS,
  parseOriginalMoneyMaintenanceSuccessorSelection,
  prepareIntegrationMoneyMaintenanceSuccessorSelection,
  readIntegrationMoneyMaintenancePublicationOriginal,
  readIntegrationMoneyMaintenanceSuccessorOriginal,
  runIntegrationWorkerBootstrap,
} from "../scripts/deploy/integration-worker-bootstrap.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

// Independent literal oracle for the existing private original gate; no new API export.
const ORIGINAL_BOOTSTRAP_GATE_FILES = [
  "tests/deploy-integration-worker-bootstrap.test.ts",
  "tests/deploy-integration-storage-generation.test.ts",
  "tests/deploy-signing.test.ts",
  "tests/deploy-realized-config-v2.test.ts",
  "tests/deploy-worker-artifact.test.ts",
  "tests/deploy-worker-composition.test.ts",
  "tests/deploy-worker-state.test.ts",
  "tests/deploy-wrangler-state.test.ts",
  "tests/deploy-cloudflare-state.test.ts",
  "tests/deploy-worker.test.ts",
  "tests/entry-worker-origin.test.ts",
  "tests/entry-worker-operator-authority.test.ts",
  "tests/entry-worker-startup.test.ts",
  "tests/runtime-input-seal-keyring.test.ts",
  "tests/worker-production-composition.test.ts",
] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const OLD = "c".repeat(40);
const NEXT = "e".repeat(40);
const FIRST = "00000000-0000-4000-8000-000000000001";
const FIRST_DEPLOYMENT = "00000000-0000-4000-8000-000000000002";
const SUCCESSOR = "00000000-0000-4000-8000-000000000003";
const SUCCESSOR_DEPLOYMENT = "00000000-0000-4000-8000-000000000004";
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "integration-money-maintenance",
  publicOrigin: "https://integration-money-maintenance.example-subdomain.workers.dev",
  d1: {
    databaseName: `integration-ts-${"d".repeat(32)}`,
    databaseId: "00000000-0000-4000-8000-000000000092",
  },
  r2: { bucketName: `integration-ts-${"d".repeat(32)}` },
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
// Independently computed static normalized-mode fixture vector; not a native proof.
const TARGET_DIGEST = "sha256:dd4791b9ef702eb3b8efaeaa4875d6d3496e0e90bea65819a81e277aecf7d6ca";
const selected = () => ({
  kind: "takoserver.integration-money-maintenance-original-successor-selection@v1" as const,
  originalSourceCommit: OLD,
  originalDispatchDigest: sha("first dispatch"),
  predecessor: { versionId: FIRST, deploymentId: FIRST_DEPLOYMENT },
  historicalBindingProfile: "original-money-maintenance-without-environment-v1" as const,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "original-maintenance-successor-data-"));
  roots.push(root);
  const originalRoot = join(root, "original");
  mkdirSync(originalRoot, { mode: 0o700 });
  const pin = lstatSync(originalRoot);
  const originalCreate: IntegrationStorageOriginalCreateOptions = {
    kind: "positive-fresh-0092",
    custodyDirectory: originalRoot,
    custodyIdentity: { device: String(pin.dev), inode: String(pin.ino) },
  };
  const firstRoot = `${originalRoot}.money-maintenance-publication`;
  const successorRoot = `${firstRoot}.successor`;
  const put = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const firstBinding = {
    originalCreateTerminalCustodyDigest: sha("origin"),
    targetDigest: TARGET_DIGEST,
    sourceCommit: OLD,
    writerEpoch: target.moneyCutoverWriterEpoch,
    moduleDigest: sha("old module"),
    artifactDigest: sha("old artifact"),
    artifactBytes: 10,
    artifactFiles: 2,
  };
  const first = {
    kind: "takoserver.original-money-maintenance-publication-dispatch@v1",
    binding: firstBinding,
    bindingDigest: sha(JSON.stringify(firstBinding)),
  };
  const command = {
    kind: "takoserver.original-money-maintenance-successor-dispatch@v1",
    originalDispatchDigest: sha(JSON.stringify(first)),
    originalSourceCommit: OLD,
    originalCreateTerminalCustodyDigest: sha("origin"),
    targetDigest: TARGET_DIGEST,
    writerEpoch: target.moneyCutoverWriterEpoch,
    predecessor: selected().predecessor,
    historicalBindingProfile: selected().historicalBindingProfile,
    sourceCommit: NEXT,
    moduleDigest: sha("new module"),
    artifactDigest: sha("new artifact"),
    artifactBytes: 20,
    artifactFiles: 2,
  };
  const result = {
    kind: "takoserver.integration-worker-original-money-maintenance-successor-apply@v1",
    surface: "takoserver-integration-worker-bootstrap",
    environment: "integration",
    commit: NEXT,
    originalSourceCommit: OLD,
    originalDispatchDigest: command.originalDispatchDigest,
    originalCreateTerminalCustodyDigest: sha("origin"),
    targetDigest: TARGET_DIGEST,
    writerEpoch: target.moneyCutoverWriterEpoch,
    originalDispatchPreserved: true,
    originalTerminalRecovery: "not-manufactured-by-successor",
    maintenanceOnly: true,
    normalHostReady: false,
    runtimeSigningAndSecrets: "not-qualified-maintenance-unused",
    previousVersionId: FIRST,
    preMutationObservedVersionId: FIRST,
    versionId: SUCCESSOR,
    deploymentId: SUCCESSOR_DEPLOYMENT,
    bundleDigest: command.moduleDigest,
    artifactDigest: command.artifactDigest,
    artifactBytes: command.artifactBytes,
    artifactFiles: command.artifactFiles,
    probe: {
      url: `${target.publicOrigin}/healthz`,
      status: 503,
      traffic: "maintenance",
    },
  };
  const terminal = {
    kind: "takoserver.original-money-maintenance-successor-terminal@v1",
    dispatchDigest: sha(JSON.stringify(command)),
    result,
    resultDigest: sha(JSON.stringify(result)),
  };
  mkdirSync(firstRoot, { mode: 0o700 });
  put(join(firstRoot, "dispatch.json"), first);
  const writeCommand = () => {
    mkdirSync(successorRoot, { mode: 0o700 });
    put(join(successorRoot, "dispatch.json"), command);
  };
  const read = (sourceCommit = NEXT, selectedTarget: DeployTarget = target) =>
    readIntegrationMoneyMaintenanceSuccessorOriginal(
      originalCreate,
      selectedTarget,
      sourceCommit,
      sha("origin"),
    );
  return {
    root,
    originalCreate,
    firstRoot,
    successorRoot,
    first,
    command,
    result,
    terminal,
    put,
    writeCommand,
    read,
  };
}

// These are custody and command-DATA mechanics. No native preparation/apply permission is minted.
describe("original92 maintenance successor command and historical custody", () => {
  test("closed selection captures an independent original source and detached actual-ID DATA", () => {
    const input = selected();
    const parsed = parseOriginalMoneyMaintenanceSuccessorSelection(input);
    input.predecessor.versionId = SUCCESSOR;
    expect(parsed.originalSourceCommit).toBe(OLD);
    expect(parsed.predecessor.versionId).toBe(FIRST);
    expect(parsed.historicalBindingProfile).toBe(
      "original-money-maintenance-without-environment-v1",
    );
  });
  test("unknown fields, malformed original command and other predecessor profiles fail closed", () => {
    for (const input of [
      { ...selected(), ready: true },
      { ...selected(), originalSourceCommit: NEXT.toUpperCase() },
      { ...selected(), originalDispatchDigest: "unknown" },
      { ...selected(), historicalBindingProfile: "normal" },
      { ...selected(), predecessor: { versionId: FIRST } },
      {
        ...selected(),
        predecessor: { ...selected().predecessor, versionId: "invented" },
      },
    ])
      expect(() => parseOriginalMoneyMaintenanceSuccessorSelection(input)).toThrow(
        "exact closed original command",
      );
  });
  test("selection accessors never run", () => {
    let getter = 0;
    const input = { ...selected() };
    Object.defineProperty(input, "originalSourceCommit", {
      enumerable: true,
      get() {
        getter++;
        return OLD;
      },
    });
    expect(() => parseOriginalMoneyMaintenanceSuccessorSelection(input)).toThrow("accessor");
    expect(getter).toBe(0);
  });
  test("successor gate retains the original15 and appends each changed owner regression once", () => {
    expect(INTEGRATION_WORKER_MAINTENANCE_SUCCESSOR_GATE_TESTS.slice(0, 15)).toEqual([
      ...ORIGINAL_BOOTSTRAP_GATE_FILES,
    ]);
    expect(ORIGINAL_BOOTSTRAP_GATE_FILES).toHaveLength(15);
    expect(INTEGRATION_WORKER_MAINTENANCE_SUCCESSOR_GATE_TESTS).toHaveLength(20);
    expect(new Set(INTEGRATION_WORKER_MAINTENANCE_SUCCESSOR_GATE_TESTS).size).toBe(20);
  });
  test("caller-native ports cannot accompany repair selection and are never invoked", async () => {
    let effects = 0;
    await expect(
      runIntegrationWorkerBootstrap(
        { action: "apply", environment: "integration", commit: NEXT },
        target,
        {
          originalMoneyMaintenanceRepair: {
            originalCreateInputPath: "/unavailable/input",
            selectionPath: "/unavailable/selection",
            repairSelectionPath: "/unavailable/repair",
          },
          run: async () => {
            effects++;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).rejects.toThrow("no injected ports");
    expect(effects).toBe(0);
  });
  test("repair option getters are refused without evaluation", async () => {
    let getter = 0;
    const options = Object.defineProperty({}, "originalMoneyMaintenanceRepair", {
      enumerable: true,
      get() {
        getter++;
        return {};
      },
    });
    await expect(
      runIntegrationWorkerBootstrap(
        { action: "apply", environment: "integration", commit: NEXT },
        target,
        options,
      ),
    ).rejects.toThrow("no injected ports");
    expect(getter).toBe(0);
  });
  test("native readonly preparation rejects apply before credential or provider access", async () => {
    await expect(
      prepareIntegrationMoneyMaintenanceSuccessorSelection(
        { action: "apply", environment: "integration", commit: OLD },
        target,
        {
          originalCreateInputPath: "/unavailable/input",
          selectionPath: "/unavailable/selection",
        },
      ),
    ).rejects.toThrow("status and original locators only");
  });
  test("absence is historical absence without root creation or write permission", () => {
    const f = fixture();
    const before = readdirSync(f.root).sort();
    expect(f.read()).toBeNull();
    expect(readdirSync(f.root).sort()).toEqual(before);
    expect(
      readIntegrationMoneyMaintenancePublicationOriginal(
        f.originalCreate,
        target,
        OLD,
        sha("origin"),
      )?.result,
    ).toBeNull();
  });
  test("retained successor dispatch without terminal remains unknown and preserves first bytes", () => {
    const f = fixture();
    f.writeCommand();
    const first = readFileSync(join(f.firstRoot, "dispatch.json"));
    const read = f.read();
    expect(read?.result).toBeNull();
    expect(read?.terminalDigest).toBeNull();
    expect(read?.originalFirst.result).toBeNull();
    expect(read?.originalFirst.dispatchDigest).toBe(f.command.originalDispatchDigest);
    expect(readFileSync(join(f.firstRoot, "dispatch.json"))).toEqual(first);
    expect(readdirSync(f.firstRoot)).toEqual(["dispatch.json"]);
    expect(readdirSync(f.successorRoot)).toEqual(["dispatch.json"]);
  });
  test("complete successor DATA binds its mandatory unknown first dispatch and exact new result", () => {
    const f = fixture();
    f.writeCommand();
    f.put(join(f.successorRoot, "terminal.json"), f.terminal);
    const first = readFileSync(join(f.firstRoot, "dispatch.json"));
    const read = f.read();
    expect(read?.result).toEqual(f.result);
    expect(read?.binding.sourceCommit).toBe(NEXT);
    expect(read?.originalFirst.binding.sourceCommit).toBe(OLD);
    expect(read?.originalFirst.result).toBeNull();
    expect(read?.terminalDigest).toBe(sha(JSON.stringify(f.terminal)));
    expect(read?.resultDigest).toBe(sha(JSON.stringify(f.result)));
    expect(readFileSync(join(f.firstRoot, "dispatch.json"))).toEqual(first);
    expect(readdirSync(f.firstRoot)).toEqual(["dispatch.json"]);
  });
  test("Money mode-free original target reads the same normalized maintenance custody", () => {
    const f = fixture();
    f.writeCommand();
    f.put(join(f.successorRoot, "terminal.json"), f.terminal);
    const { schemaMaintenanceMode: _mode, ...normalTarget } = target;
    expect(f.read(NEXT, normalTarget)?.result).toEqual(f.result);
  });
  test("a new source cannot rebind the first dispatch to its successor commit", () => {
    const f = fixture();
    f.writeCommand();
    f.put(join(f.successorRoot, "terminal.json"), f.terminal);
    expect(() => f.read(OLD)).toThrow("exact full command");
    f.put(join(f.firstRoot, "dispatch.json"), {
      ...f.first,
      binding: { ...f.first.binding, sourceCommit: NEXT },
    });
    expect(() => f.read()).toThrow("dispatch custody differs");
  });
  test("target epoch or original dispatch digest changes cannot borrow a terminal", () => {
    const f = fixture();
    f.writeCommand();
    f.put(join(f.successorRoot, "terminal.json"), f.terminal);
    expect(() =>
      f.read(NEXT, {
        ...target,
        moneyCutoverWriterEpoch: sha("another epoch"),
      }),
    ).toThrow("exact full command");
    f.put(join(f.successorRoot, "dispatch.json"), {
      ...f.command,
      originalDispatchDigest: sha("another first"),
    });
    expect(() => f.read()).toThrow("unknown first dispatch");
  });
  test("orphan terminal and extra journal entries cannot become positive absence", () => {
    const f = fixture();
    mkdirSync(f.successorRoot, { mode: 0o700 });
    f.put(join(f.successorRoot, "terminal.json"), f.terminal);
    expect(() => f.read()).toThrow("partial or contains unknown");
    f.put(join(f.successorRoot, "dispatch.json"), f.command);
    f.put(join(f.successorRoot, "extra.json"), {});
    expect(() => f.read()).toThrow("partial or contains unknown");
  });
  test("corrupt same-command receipt and crossed predecessor remain refused", () => {
    const f = fixture();
    f.writeCommand();
    f.put(join(f.successorRoot, "terminal.json"), {
      ...f.terminal,
      resultDigest: sha("corrupt"),
    });
    expect(() => f.read()).toThrow("mandatory original chain");
    f.put(join(f.successorRoot, "terminal.json"), {
      ...f.terminal,
      result: { ...f.result, previousVersionId: SUCCESSOR },
    });
    expect(() => f.read()).toThrow("mandatory original chain");
  });
});
