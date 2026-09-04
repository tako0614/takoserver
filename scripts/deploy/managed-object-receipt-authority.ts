import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import { materializeManagedObjectReceiptSecrets } from "./managed-object-receipt-secrets.ts";
import {
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact, type WorkerArtifactProcess } from "./worker-artifact.ts";
import { parseWorkerDeploymentHistory } from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  deployWranglerLifecycleChange,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

const AUTHORITY_CLASS = "TakoserverManagedObjectReceipt";
const AUTHORITY_ENTRYPOINT = "TakoserverManagedObjectReceiptAuthority";
const VERSION_MESSAGE =
  /^takoserver-managed-object-receipt-authority:([0-9a-f]{40}):([0-9a-f]{64})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTHORITY_LIFECYCLE_RECEIPT_KIND =
  "takoserver.managed-object-receipt-authority-lifecycle-rehearsal@v1" as const;
const AUTHORITY_LIFECYCLE_SCHEMA = {
  from: null,
  to: "v1",
  className: AUTHORITY_CLASS,
  migrationTags: ["v1"],
  mutationTargets: [],
} as const;
const AUTHORITY_LIFECYCLE_SCHEMA_DIGEST = createHash("sha256")
  .update(JSON.stringify(AUTHORITY_LIFECYCLE_SCHEMA))
  .digest("hex");

interface ManagedObjectReceiptAuthorityLifecycleReceipt {
  readonly kind: typeof AUTHORITY_LIFECYCLE_RECEIPT_KIND;
  readonly commit: string;
  readonly bundleDigestHex: string;
  readonly lifecycleSchemaDigest: string;
  readonly predecessorMigrationTag: null;
  readonly migrationTag: "v1";
  readonly className: typeof AUTHORITY_CLASS;
  readonly versionId: string;
  readonly deploymentId: string;
  readonly previousVersionId: null;
  readonly mutationTargets: readonly [];
  readonly moduleExact: true;
  readonly bindingsExact: true;
  readonly settingsExact: true;
  readonly routeLess: true;
}

interface ManagedObjectReceiptAuthorityLifecycleEvidence {
  readonly receipt: ManagedObjectReceiptAuthorityLifecycleReceipt;
  readonly digestHex: string;
}

export interface ManagedObjectReceiptAuthorityInvocation {
  readonly surface: "takoserver-managed-object-receipt-authority";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface ManagedObjectReceiptAuthorityState {
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerVersionWithModules(workerName: string, versionId: string): Promise<unknown>;
  workerSettings(workerName: string): Promise<unknown>;
  workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }>;
  workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  >;
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
}

export interface ManagedObjectReceiptAuthorityOptions {
  readonly state?: ManagedObjectReceiptAuthorityState;
  readonly accountId?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly secretsPath?: string;
  readonly run?: WorkerArtifactProcess;
  readonly outputDirectory?: string;
  readonly review?: string;
  readonly publicationLease?: WranglerVersionPublicationLease;
  readonly rehearsalReceiptPath?: string;
}

export interface ManagedObjectReceiptAuthorityInspection {
  readonly status: "absent" | "ready" | "drift" | "unavailable";
  readonly ready: boolean;
  readonly routeLess: boolean;
  readonly versionId: string | null;
  readonly deploymentId: string | null;
  readonly previousVersionId: string | null;
  readonly commit: string | null;
  readonly bundleDigestHex: string | null;
  readonly moduleDigestHex: string | null;
  readonly bindingsExact: boolean;
  readonly settingsExact: boolean;
  readonly migrationExact: boolean;
  readonly migrationTag: "v1" | null;
}

/**
 * Publishes the route-less authority with code, DO lifecycle and all three
 * required secrets in Wrangler's single deploy operation.
 */
export async function runManagedObjectReceiptAuthority(
  invocation: ManagedObjectReceiptAuthorityInvocation,
  target: DeployTarget,
  options: ManagedObjectReceiptAuthorityOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("receipt authority invocation and target environments differ");
  }
  const executor = target.cloudflareProviderExecutor;
  if (executor === undefined) {
    throw preflightError(
      "receipt authority requires the exact Cloudflare provider executor topology",
    );
  }
  const scriptName = exactToken(
    executor.receiptAuthorityWorkerName,
    "receipt authority Worker name",
  );
  const providerInstallationId = exactToken(
    executor.providerInstallationId,
    "Cloudflare ProviderInstallation id",
  );
  const run = options.run ?? runCommand;
  const credential =
    invocation.environment !== "integration" || options.state === undefined
      ? await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
        })
      : undefined;
  const state =
    options.state ??
    new CloudflareState({
      accountId: options.accountId ?? target.accountId,
      token: exactCloudflareToken(credential?.childEnvironment ?? {}),
    });
  let inspection = await inspectManagedObjectReceiptAuthority("preflight", state, {
    scriptName,
    providerInstallationId,
    accountId: target.accountId,
    commit: invocation.commit,
  });
  if (invocation.action === "status") return status(invocation, scriptName, inspection);

  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-object-receipt-authority-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let materializedSecretsPath: string | null = null;
  let primaryFailure: unknown = null;
  let result: Record<string, unknown> | undefined;
  try {
    await runOwnerGate(run);
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      main: resolve(REPOSITORY, "src/entry-cloudflare-managed-object-receipt-authority.ts"),
      run,
      environment: credential?.childEnvironment ?? {},
      writeConfig: ({ path, main }) =>
        writeManagedObjectReceiptAuthorityConfig({
          path,
          main,
          target,
          scriptName,
          providerInstallationId,
        }),
    });
    const secrets = materializeManagedObjectReceiptSecrets({
      sourcePath:
        options.secretsPath ?? requireEnvironment("TAKOSERVER_MANAGED_OBJECT_RECEIPT_SECRETS_PATH"),
      releaseRoot: prepared.releaseDirectory,
    });
    materializedSecretsPath = secrets.path;
    const artifact = prepared.seal(["managed-object-receipt-secrets.json"]);
    artifact.assertUnchanged();
    const module = expectedModule(prepared.bundlePath, prepared.bundleDigestHex);
    const predecessor = await readHistory("preflight", state, scriptName);
    if (
      predecessor !== null &&
      (inspection.versionId !== predecessor.versionId ||
        !inspection.migrationExact ||
        !inspection.routeLess)
    ) {
      throw preflightError(
        "receipt authority predecessor is not the exact route-less v1 lifecycle",
      );
    }
    const freshLifecycle = predecessor === null;
    const lifecycleReceiptPath =
      freshLifecycle && invocation.environment !== "integration"
        ? exactAuthorityLifecycleReceiptPath(
            options.rehearsalReceiptPath ??
              requireEnvironment(
                "TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_REHEARSAL_RECEIPT_PATH",
              ),
          )
        : null;
    let productionEvidence: ManagedObjectReceiptAuthorityLifecycleEvidence | null = null;
    if (freshLifecycle && invocation.environment === "rehearsal") {
      assertAuthorityLifecycleReceiptAbsent(lifecycleReceiptPath as string);
    }
    if (freshLifecycle && invocation.environment === "production") {
      productionEvidence = readAuthorityLifecycleReceipt(lifecycleReceiptPath as string);
      assertAuthorityLifecycleReceiptMatches(productionEvidence.receipt, {
        commit: source.commit,
        bundleDigestHex: prepared.bundleDigestHex,
      });
    }
    const lease =
      options.publicationLease ??
      (await acquireWranglerVersionPublicationLease({
        accountId: options.accountId ?? target.accountId,
        workerName: scriptName,
        root: join(root, "publication-lease"),
      }));
    let publication: Awaited<ReturnType<typeof deployWranglerLifecycleChange>> | null = null;
    let mutationFailure: unknown = null;
    let releaseFailure: unknown = null;
    try {
      publication = await deployWranglerLifecycleChange({
        root,
        bundlePath: prepared.bundlePath,
        configPath: prepared.configPath,
        accountId: options.accountId ?? target.accountId,
        workerName: scriptName,
        message: `takoserver-managed-object-receipt-authority:${source.commit}:${prepared.bundleDigestHex}`,
        lease,
        secretsFilePath: secrets.path,
        environment: credential?.childEnvironment ?? {},
        run,
        assertCurrentStillExpected: async () => {
          artifact.assertUnchanged();
          const current = await readHistory("preflight", state, scriptName);
          if (!sameHistory(current, predecessor)) {
            throw preflightError("receipt authority Worker predecessor changed before publication");
          }
          if (productionEvidence !== null && lifecycleReceiptPath !== null) {
            const reread = readAuthorityLifecycleReceipt(lifecycleReceiptPath);
            if (reread.digestHex !== productionEvidence.digestHex) {
              throw preflightError(
                "receipt authority lifecycle rehearsal evidence changed before publication",
              );
            }
            assertAuthorityLifecycleReceiptMatches(reread.receipt, {
              commit: source.commit,
              bundleDigestHex: prepared.bundleDigestHex,
            });
          }
        },
      });
    } catch (error) {
      mutationFailure = error;
    } finally {
      try {
        await lease.release();
      } catch (error) {
        releaseFailure = error;
      }
    }
    artifact.assertUnchanged();
    if (!publication || mutationFailure || releaseFailure) {
      const repair = await inspectManagedObjectReceiptAuthority("preflight", state, {
        scriptName,
        providerInstallationId,
        accountId: target.accountId,
        commit: source.commit,
        bundleDigestHex: prepared.bundleDigestHex,
        expectedModule: module,
      });
      throw mutationError(
        "receipt authority publication acknowledgement is indeterminate; run --status before forward repair",
        JSON.stringify({
          versionId: repair.versionId,
          deploymentId: repair.deploymentId,
          commit: repair.commit,
          bundleDigestHex: repair.bundleDigestHex,
          ready: repair.ready,
        }),
      );
    }
    inspection = await inspectManagedObjectReceiptAuthority("verification", state, {
      scriptName,
      providerInstallationId,
      accountId: target.accountId,
      commit: source.commit,
      bundleDigestHex: prepared.bundleDigestHex,
      expectedModule: module,
    });
    if (
      !inspection.ready ||
      inspection.versionId !== publication.versionId ||
      inspection.previousVersionId !== (predecessor?.versionId ?? null) ||
      !inspection.routeLess ||
      publication.targets.length !== 0
    ) {
      throw verificationError(
        "receipt authority readback does not match the atomic sealed publication",
      );
    }
    let lifecycleRehearsalReceiptDigest: string | null = productionEvidence?.digestHex ?? null;
    if (freshLifecycle && invocation.environment === "rehearsal") {
      const receipt = authorityLifecycleReceipt({
        commit: source.commit,
        bundleDigestHex: prepared.bundleDigestHex,
        inspection,
      });
      writeAuthorityLifecycleReceipt(lifecycleReceiptPath as string, receipt);
      const evidence = readAuthorityLifecycleReceipt(lifecycleReceiptPath as string);
      if (
        authorityLifecycleReceiptBytes(receipt).compare(
          authorityLifecycleReceiptBytes(evidence.receipt),
        ) !== 0
      ) {
        throw verificationError(
          "receipt authority lifecycle rehearsal evidence readback is not exact",
        );
      }
      lifecycleRehearsalReceiptDigest = evidence.digestHex;
    }
    result = {
      kind: "takoserver.managed-object-receipt-authority-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      scriptName,
      authorityEntrypoint: AUTHORITY_ENTRYPOINT,
      workerVersionId: inspection.versionId,
      workerDeploymentId: inspection.deploymentId,
      workerPreviousVersionId: inspection.previousVersionId,
      workerBundleDigest: inspection.bundleDigestHex,
      routeLess: inspection.routeLess,
      secretNames: secrets.names,
      secretPublication: "atomic-wrangler-secrets-file",
      lifecycle: freshLifecycle ? "v1-created" : "v1-preserved",
      lifecycleRehearsalReceiptDigest,
      reviewer,
      ready: true,
    };
  } catch (error) {
    primaryFailure = error;
  }
  let cleanupFailure: unknown = null;
  try {
    unsealDirectory(root);
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (materializedSecretsPath !== null) {
    try {
      rmSync(materializedSecretsPath, { force: true });
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (temporary) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (primaryFailure !== null) throw primaryFailure;
  if (cleanupFailure !== null) {
    throw verificationError("receipt authority release material cleanup failed");
  }
  if (result === undefined) {
    throw verificationError("receipt authority publication returned no result");
  }
  return result;
}

export async function inspectManagedObjectReceiptAuthority(
  phase: "preflight" | "verification",
  state: ManagedObjectReceiptAuthorityState,
  input: {
    readonly scriptName: string;
    readonly providerInstallationId: string;
    readonly accountId: string;
    readonly commit?: string;
    readonly bundleDigestHex?: string;
    readonly expectedModule?: ExpectedModule;
  },
): Promise<ManagedObjectReceiptAuthorityInspection> {
  const history = await readHistory(phase, state, input.scriptName);
  if (!history) return unavailable("absent");
  try {
    const [version, settings, subdomain, routes, domains] = await Promise.all([
      state.workerVersionWithModules(input.scriptName, history.versionId),
      state.workerSettings(input.scriptName),
      state.workerSubdomain(input.scriptName),
      state.workerRoutes(),
      state.workerDomains(),
    ]);
    const identity = versionIdentity(version, history.versionId);
    const module = moduleClosure(version, input.expectedModule);
    const bindingsExact = bindingClosure(version, input);
    const migrationTag = authorityMigrationTag(version);
    const migrationExact = migrationClosure(version);
    const settingsExact = settingsClosure(version, settings, subdomain);
    const routeLess =
      routes.every((route) => route.script !== input.scriptName) &&
      domains.every((domain) => domain.service !== input.scriptName);
    const ready =
      routeLess &&
      bindingsExact &&
      migrationExact &&
      settingsExact &&
      module.canonical &&
      (input.commit === undefined || identity.commit === input.commit) &&
      (input.bundleDigestHex === undefined || identity.bundleDigestHex === input.bundleDigestHex) &&
      (input.expectedModule === undefined || module.exact);
    return {
      status: ready ? "ready" : "drift",
      ready,
      routeLess,
      versionId: history.versionId,
      deploymentId: history.deploymentId,
      previousVersionId: history.previousVersionId,
      commit: identity.commit,
      bundleDigestHex: identity.bundleDigestHex,
      moduleDigestHex: module.digestHex,
      bindingsExact,
      settingsExact,
      migrationExact,
      migrationTag,
    };
  } catch (error) {
    if (phase === "verification") throw verificationError("receipt authority readback failed");
    void error;
    return {
      ...unavailable("unavailable"),
      versionId: history.versionId,
      deploymentId: history.deploymentId,
      previousVersionId: history.previousVersionId,
    };
  }
}

function writeManagedObjectReceiptAuthorityConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly target: DeployTarget;
  readonly scriptName: string;
  readonly providerInstallationId: string;
}): string {
  const config = {
    name: input.scriptName,
    main: input.main,
    account_id: input.target.accountId,
    compatibility_date: "2026-08-31",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    durable_objects: {
      bindings: [{ name: "OBJECT_RECEIPTS", class_name: AUTHORITY_CLASS }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: [AUTHORITY_CLASS] }],
    vars: {
      MANAGED_PROVIDER_ID: input.providerInstallationId,
      TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID: input.target.accountId,
    },
    secrets: {
      required: [
        "TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID",
        "TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY",
        "TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET",
      ],
    },
  };
  writeFileSync(input.path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return input.path;
}

function exactAuthorityLifecycleReceiptPath(value: string): string {
  if (!isAbsolute(value) || value.trim() !== value || value.length > 4_096) {
    throw preflightError(
      "receipt authority lifecycle rehearsal receipt path must be an exact absolute path",
    );
  }
  const requested = resolve(value);
  let parent: string;
  try {
    parent = realpathSync(dirname(requested));
  } catch {
    throw preflightError("receipt authority lifecycle rehearsal receipt parent is unavailable");
  }
  const path = join(parent, basename(requested));
  const fromRepository = relative(realpathSync(REPOSITORY), path);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw preflightError(
      "receipt authority lifecycle rehearsal receipt must stay outside the repository",
    );
  }
  const held = statSync(parent, { throwIfNoEntry: false });
  if (
    !held?.isDirectory() ||
    (held.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && held.uid !== process.getuid())
  ) {
    throw preflightError(
      "receipt authority lifecycle rehearsal receipt parent must be an owned mode-0700 directory",
    );
  }
  for (let cursor = parent; ; ) {
    if (existsSync(join(cursor, ".git"))) {
      throw preflightError(
        "receipt authority lifecycle rehearsal receipt must stay outside every Git repository",
      );
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return path;
}

function assertAuthorityLifecycleReceiptAbsent(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw preflightError(
      "receipt authority lifecycle rehearsal receipt already exists and cannot be overwritten",
    );
  }
}

function authorityLifecycleReceipt(input: {
  readonly commit: string;
  readonly bundleDigestHex: string;
  readonly inspection: ManagedObjectReceiptAuthorityInspection;
}): ManagedObjectReceiptAuthorityLifecycleReceipt {
  if (
    !input.inspection.ready ||
    input.inspection.versionId === null ||
    input.inspection.deploymentId === null ||
    input.inspection.previousVersionId !== null ||
    input.inspection.migrationTag !== "v1" ||
    !input.inspection.bindingsExact ||
    !input.inspection.settingsExact ||
    !input.inspection.routeLess
  ) {
    throw verificationError(
      "receipt authority lifecycle rehearsal cannot attest an inexact readback",
    );
  }
  return {
    kind: AUTHORITY_LIFECYCLE_RECEIPT_KIND,
    commit: input.commit,
    bundleDigestHex: input.bundleDigestHex,
    lifecycleSchemaDigest: AUTHORITY_LIFECYCLE_SCHEMA_DIGEST,
    predecessorMigrationTag: null,
    migrationTag: "v1",
    className: AUTHORITY_CLASS,
    versionId: input.inspection.versionId,
    deploymentId: input.inspection.deploymentId,
    previousVersionId: null,
    mutationTargets: [],
    moduleExact: true,
    bindingsExact: true,
    settingsExact: true,
    routeLess: true,
  };
}

function writeAuthorityLifecycleReceipt(
  path: string,
  receipt: ManagedObjectReceiptAuthorityLifecycleReceipt,
): void {
  try {
    writeFileSync(path, authorityLifecycleReceiptBytes(receipt), { flag: "wx", mode: 0o600 });
  } catch {
    throw verificationError(
      "receipt authority v1 lifecycle changed but rehearsal evidence could not be written; forward repair is required",
    );
  }
}

function readAuthorityLifecycleReceipt(
  path: string,
): ManagedObjectReceiptAuthorityLifecycleEvidence {
  const bytes = readSecureAuthorityLifecycleReceipt(path);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw preflightError("receipt authority lifecycle rehearsal receipt is not valid UTF-8 JSON");
  }
  const receipt = parseAuthorityLifecycleReceipt(value);
  if (!bytes.equals(authorityLifecycleReceiptBytes(receipt))) {
    throw preflightError(
      "receipt authority lifecycle rehearsal receipt is not in canonical exact-byte encoding",
    );
  }
  return {
    receipt,
    digestHex: createHash("sha256").update(bytes).digest("hex"),
  };
}

function readSecureAuthorityLifecycleReceipt(path: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw preflightError(
      "receipt authority lifecycle rehearsal receipt must be an owned link-free file",
    );
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      Number(before.mode & 0o777n) !== 0o600 ||
      before.size < 3n ||
      before.size > 16_384n ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      throw preflightError(
        "receipt authority lifecycle rehearsal receipt must be an owned single-link mode-0600 bounded file",
      );
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes.byteLength !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.nlink !== after.nlink ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw preflightError(
        "receipt authority lifecycle rehearsal receipt changed while it was read",
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseAuthorityLifecycleReceipt(
  value: unknown,
): ManagedObjectReceiptAuthorityLifecycleReceipt {
  const keys = [
    "kind",
    "commit",
    "bundleDigestHex",
    "lifecycleSchemaDigest",
    "predecessorMigrationTag",
    "migrationTag",
    "className",
    "versionId",
    "deploymentId",
    "previousVersionId",
    "mutationTargets",
    "moduleExact",
    "bindingsExact",
    "settingsExact",
    "routeLess",
  ];
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    value.kind !== AUTHORITY_LIFECYCLE_RECEIPT_KIND ||
    typeof value.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.commit) ||
    typeof value.bundleDigestHex !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.bundleDigestHex) ||
    value.lifecycleSchemaDigest !== AUTHORITY_LIFECYCLE_SCHEMA_DIGEST ||
    value.predecessorMigrationTag !== null ||
    value.migrationTag !== "v1" ||
    value.className !== AUTHORITY_CLASS ||
    typeof value.versionId !== "string" ||
    !UUID.test(value.versionId) ||
    typeof value.deploymentId !== "string" ||
    !UUID.test(value.deploymentId) ||
    value.previousVersionId !== null ||
    !Array.isArray(value.mutationTargets) ||
    value.mutationTargets.length !== 0 ||
    value.moduleExact !== true ||
    value.bindingsExact !== true ||
    value.settingsExact !== true ||
    value.routeLess !== true
  ) {
    throw preflightError(
      "receipt authority lifecycle rehearsal receipt has an invalid exact shape",
    );
  }
  return {
    kind: AUTHORITY_LIFECYCLE_RECEIPT_KIND,
    commit: value.commit,
    bundleDigestHex: value.bundleDigestHex,
    lifecycleSchemaDigest: AUTHORITY_LIFECYCLE_SCHEMA_DIGEST,
    predecessorMigrationTag: null,
    migrationTag: "v1",
    className: AUTHORITY_CLASS,
    versionId: value.versionId,
    deploymentId: value.deploymentId,
    previousVersionId: null,
    mutationTargets: [],
    moduleExact: true,
    bindingsExact: true,
    settingsExact: true,
    routeLess: true,
  };
}

function assertAuthorityLifecycleReceiptMatches(
  receipt: ManagedObjectReceiptAuthorityLifecycleReceipt,
  expected: { readonly commit: string; readonly bundleDigestHex: string },
): void {
  if (receipt.commit !== expected.commit || receipt.bundleDigestHex !== expected.bundleDigestHex) {
    throw preflightError(
      "receipt authority lifecycle rehearsal receipt does not match this exact production transition",
    );
  }
}

function authorityLifecycleReceiptBytes(
  receipt: ManagedObjectReceiptAuthorityLifecycleReceipt,
): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

interface ExpectedModule {
  readonly bytes: Uint8Array;
  readonly digestHex: string;
}

function expectedModule(path: string, digestHex: string): ExpectedModule {
  const bytes = Uint8Array.from(readFileSync(path));
  if (createHash("sha256").update(bytes).digest("hex") !== digestHex) {
    throw preflightError("sealed receipt authority bundle changed before publication");
  }
  return { bytes, digestHex };
}

function versionIdentity(value: unknown, versionId: string) {
  if (!isRecord(value) || value.id !== versionId || !isRecord(value.annotations)) {
    throw new TypeError("receipt authority Version identity is malformed");
  }
  const message = value.annotations["workers/message"];
  const match = typeof message === "string" ? VERSION_MESSAGE.exec(message) : null;
  if (!match?.[1] || !match[2]) throw new TypeError("receipt authority Version message is invalid");
  return { commit: match[1], bundleDigestHex: match[2] };
}

function moduleClosure(value: unknown, expected?: ExpectedModule) {
  if (!isRecord(value) || value.main_module !== "worker.js" || !Array.isArray(value.modules)) {
    throw new TypeError("receipt authority module closure is malformed");
  }
  if (value.modules.length !== 1 || !isRecord(value.modules[0])) {
    throw new TypeError("receipt authority module closure is not exact");
  }
  const module = value.modules[0];
  if (
    Object.keys(module).sort().join(",") !== "content_base64,content_type,name" ||
    module.name !== "worker.js" ||
    module.content_type !== "application/javascript+module" ||
    typeof module.content_base64 !== "string"
  ) {
    throw new TypeError("receipt authority module closure is malformed");
  }
  const bytes = strictBase64(module.content_base64);
  const digestHex = createHash("sha256").update(bytes).digest("hex");
  return {
    canonical: true,
    digestHex,
    exact:
      expected !== undefined &&
      expected.digestHex === digestHex &&
      sameBytes(expected.bytes, bytes),
  };
}

function bindingClosure(
  value: unknown,
  input: { readonly providerInstallationId: string; readonly accountId: string },
): boolean {
  if (!isRecord(value) || !Array.isArray(value.bindings)) return false;
  const expected: Record<
    string,
    { readonly type: string; readonly fields: Record<string, string> }
  > = {
    OBJECT_RECEIPTS: {
      type: "durable_object_namespace",
      fields: { class_name: AUTHORITY_CLASS },
    },
    MANAGED_PROVIDER_ID: {
      type: "plain_text",
      fields: { text: input.providerInstallationId },
    },
    TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID: {
      type: "plain_text",
      fields: { text: input.accountId },
    },
    TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID: { type: "secret_text", fields: {} },
    TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY: { type: "secret_text", fields: {} },
    TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET: { type: "secret_text", fields: {} },
  };
  const seen = new Set<string>();
  for (const raw of value.bindings) {
    if (!isRecord(raw) || typeof raw.name !== "string" || seen.has(raw.name)) return false;
    seen.add(raw.name);
    const requirement = expected[raw.name];
    if (!requirement || raw.type !== requirement.type) return false;
    const keys = ["name", "type", ...Object.keys(requirement.fields)].sort().join(",");
    if (Object.keys(raw).sort().join(",") !== keys) return false;
    for (const [field, expectedValue] of Object.entries(requirement.fields)) {
      if (raw[field] !== expectedValue) return false;
    }
  }
  return seen.size === Object.keys(expected).length;
}

function authorityMigrationTag(value: unknown): "v1" | null {
  return isRecord(value) && value.migration_tag === "v1" ? "v1" : null;
}

function migrationClosure(value: unknown): boolean {
  if (!isRecord(value) || value.migration_tag !== "v1") return false;
  if (value.migrations === undefined) return true;
  if (!isRecord(value.migrations)) return false;
  if (Object.keys(value.migrations).length === 0) return true;
  return (
    Object.keys(value.migrations).sort().join(",") === "new_tag,steps" &&
    value.migrations.new_tag === "v1" &&
    Array.isArray(value.migrations.steps) &&
    value.migrations.steps.length === 1 &&
    isRecord(value.migrations.steps[0]) &&
    Object.keys(value.migrations.steps[0]).join(",") === "new_sqlite_classes" &&
    Array.isArray(value.migrations.steps[0].new_sqlite_classes) &&
    value.migrations.steps[0].new_sqlite_classes.length === 1 &&
    value.migrations.steps[0].new_sqlite_classes[0] === AUTHORITY_CLASS
  );
}

function settingsClosure(
  version: unknown,
  settings: unknown,
  subdomain: { readonly enabled: boolean; readonly previewsEnabled: boolean },
): boolean {
  if (!isRecord(version) || !isRecord(settings)) return false;
  return (
    version.compatibility_date === "2026-08-31" &&
    Array.isArray(version.compatibility_flags) &&
    version.compatibility_flags.length === 1 &&
    version.compatibility_flags[0] === "nodejs_compat" &&
    version.assets === undefined &&
    version.placement === undefined &&
    (settings.workers_dev === false || settings.workers_dev === undefined) &&
    (settings.preview_urls === false || settings.preview_urls === undefined) &&
    subdomain.enabled === false &&
    subdomain.previewsEnabled === false
  );
}

async function readHistory(
  phase: "preflight" | "verification",
  state: ManagedObjectReceiptAuthorityState,
  workerName: string,
) {
  try {
    return parseWorkerDeploymentHistory(await state.workerDeployments(workerName), phase);
  } catch (error) {
    if (phase === "verification") {
      throw verificationError("receipt authority deployment history readback failed");
    }
    throw preflightError(
      "receipt authority deployment history readback failed",
      error instanceof Error ? error.name : typeof error,
    );
  }
}

function sameHistory(
  left: ReturnType<typeof parseWorkerDeploymentHistory>,
  right: ReturnType<typeof parseWorkerDeploymentHistory>,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.versionId === right.versionId &&
    left.deploymentId === right.deploymentId &&
    left.previousVersionId === right.previousVersionId
  );
}

function unavailable(
  statusValue: "absent" | "unavailable",
): ManagedObjectReceiptAuthorityInspection {
  return {
    status: statusValue,
    ready: false,
    routeLess: false,
    versionId: null,
    deploymentId: null,
    previousVersionId: null,
    commit: null,
    bundleDigestHex: null,
    moduleDigestHex: null,
    bindingsExact: false,
    settingsExact: false,
    migrationExact: false,
    migrationTag: null,
  };
}

function status(
  invocation: ManagedObjectReceiptAuthorityInvocation,
  scriptName: string,
  inspection: ManagedObjectReceiptAuthorityInspection,
): Record<string, unknown> {
  return {
    kind: "takoserver.managed-object-receipt-authority-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    scriptName,
    authorityEntrypoint: AUTHORITY_ENTRYPOINT,
    workerStatus: inspection.status,
    workerVersionId: inspection.versionId,
    workerDeploymentId: inspection.deploymentId,
    workerPreviousVersionId: inspection.previousVersionId,
    workerCommit: inspection.commit,
    workerBundleDigest: inspection.bundleDigestHex,
    bindingsExact: inspection.bindingsExact,
    settingsExact: inspection.settingsExact,
    migrationExact: inspection.migrationExact,
    migrationTag: inspection.migrationTag,
    routeLess: inspection.routeLess,
    ready: inspection.ready,
  };
}

async function runOwnerGate(run: WorkerArtifactProcess): Promise<void> {
  const result = await run(["bun", "run", "check"]);
  if (result.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
}

function strictBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError("receipt authority module bytes are malformed");
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) {
    throw new TypeError("receipt authority module bytes are not canonical");
  }
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function exactToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/u.test(value)) {
    throw preflightError(`${label} is invalid`);
  }
  return value;
}

function exactReviewer(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/u.test(value)) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW is invalid");
  }
  return value;
}

function exactCloudflareToken(environment: Readonly<Record<string, string>>): string {
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!token || token.length < 20 || token.length > 4_096 || token.trim() !== token) {
    throw preflightError("CLOUDFLARE_API_TOKEN is required for receipt authority deployment");
  }
  return token;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
