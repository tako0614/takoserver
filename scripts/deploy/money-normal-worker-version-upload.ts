/** SOURCE PROPOSAL / UNRUN. One inactive immutable Version; never a traffic or D1 writer. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { types as nodeTypes } from "node:util";
import { parseTakoformV2ApplicationConfig } from "../../src/takoform-v2/config.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError } from "./errors.ts";
import { loadIntegrationStorageOriginalCreateInput } from "./integration-storage-generation.ts";
import { captureMoneyNativeBuildClosure } from "./money-native-build-closure.ts";
import { resolveCloudflareCredential, runCommand } from "./process.ts";
import { type SealedArtifact, sealDirectory, unsealDirectory } from "./qualification.ts";
import {
  effectiveSigningKeyId,
  expectedWorkerSecrets,
  writeWorkerConfig,
} from "./realized-config.ts";
import {
  assertMoneyUnitHeldConvertCurrent,
  assertMoneyUnitHeldNormalWorkerModePreparationCurrent,
  loadMoneyUnitOriginalCutoverOptions,
  type MoneyUnitHeldConvertContext,
  type MoneyUnitHeldNormalWorkerModePreparation,
  readMoneyUnitHeldConvertContext,
  readMoneyUnitHeldNormalWorkerModePreparation,
} from "./schema-money-unit-owner.ts";
import { exactV2MaintenanceModuleDigest } from "./schema-v2-existing-transition.ts";
import { type DeployTarget, loadTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { readClosureSecretInputs } from "./worker-closure-transition.ts";
import { workerVersionIdentity } from "./worker-live.ts";
import {
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  parseWorkerDeploymentHistory,
} from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  assertWranglerVersionPublicationLeaseCurrent,
  parseWranglerVersionUploadOutput,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

const SHA = /^sha256:[0-9a-f]{64}$/u;
const requestFields = [
  "targetPath",
  "originalCreateInputPath",
  "convertDeclarationPath",
  "convertedBackupPath",
  "normalSourceRoot",
  "previousWriterEpoch",
  "nextWriterEpoch",
] as const;
export interface MoneyNormalVersionUploadRequest {
  readonly targetPath: string;
  readonly originalCreateInputPath: string;
  readonly convertDeclarationPath: string;
  readonly convertedBackupPath: string;
  readonly normalSourceRoot: string;
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
}
/** DATA parser only; no receipt, callback, config, options, client or readiness authority. */
export function parseMoneyNormalVersionUploadRequest(
  value: unknown,
): MoneyNormalVersionUploadRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw preflightError("money inactive Version requires a plain closed locator request");
  const names = Reflect.ownKeys(value);
  if (
    names.some((name) => typeof name !== "string") ||
    names.map(String).sort().join(",") !== [...requestFields].sort().join(",")
  )
    throw preflightError(
      "money inactive Version accepts only original locators and epoch/source DATA",
    );
  const fields: Record<string, string> = {};
  for (const name of requestFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    )
      throw preflightError("money inactive Version request fields must be own string DATA");
    fields[name] = descriptor.value;
  }
  for (const name of [
    "targetPath",
    "originalCreateInputPath",
    "convertDeclarationPath",
    "convertedBackupPath",
    "normalSourceRoot",
  ] as const) {
    const path = fields[name];
    if (path === undefined || !isAbsolute(path) || resolve(path) !== path)
      throw preflightError("money inactive Version needs canonical original paths");
  }
  if (
    !SHA.test(fields.previousWriterEpoch ?? "") ||
    !SHA.test(fields.nextWriterEpoch ?? "") ||
    fields.previousWriterEpoch === fields.nextWriterEpoch
  )
    throw preflightError("money inactive Version requires distinct exact old and next epoch DATA");
  return Object.freeze(
    Object.fromEntries(requestFields.map((key) => [key, fields[key]])),
  ) as unknown as MoneyNormalVersionUploadRequest;
}

const sha = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function privateDirectory(path: string): string {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777n) !== 0o700n ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    realpathSync(path) !== path
  )
    throw preflightError("money inactive Version needs its actual private owned directory");
  return [info.dev, info.ino, info.mode, info.uid].join(":");
}
function inputSeal(path: string): string {
  privateDirectory(dirname(path));
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    (before.mode & 0o777n) !== 0o600n ||
    before.uid !== BigInt(process.getuid?.() ?? -1) ||
    realpathSync(path) !== path
  )
    throw preflightError("money inactive Version original input is not private regular DATA");
  const identity = (s: typeof before) =>
    [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (
      identity(fstatSync(fd, { bigint: true })) !== identity(before) ||
      before.size > 4n * 1024n * 1024n
    )
      throw preflightError("money inactive Version original input changed or exceeds its bound");
    const body = readFileSync(fd);
    if (
      identity(fstatSync(fd, { bigint: true })) !== identity(before) ||
      identity(lstatSync(path, { bigint: true })) !== identity(before)
    )
      throw preflightError("money inactive Version original input changed during held read");
    return `${identity(before)}:${sha(body)}`;
  } finally {
    closeSync(fd);
  }
}
function writePrivate(path: string, value: unknown): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** DATA command recipe. The writer never accepts caller-generated commands/configs. */
export function moneyNormalVersionUploadArguments(input: {
  readonly bundlePath: string;
  readonly configPath: string;
  readonly workerName: string;
  readonly message: string;
  readonly secretsFilePath: string;
}): readonly string[] {
  return Object.freeze([
    "versions",
    "upload",
    input.bundlePath,
    "--name",
    input.workerName,
    "--no-bundle",
    "--config",
    input.configPath,
    "--strict",
    "--message",
    input.message,
    "--secrets-file",
    input.secretsFilePath,
  ]);
}

export interface MoneyNormalWorkerVersionUploadReceipt {
  readonly kind: "takoserver.money-inactive-normal-version-upload@v1";
  readonly qualification: "immutable-version-only";
  readonly selectorPath: string;
  readonly versionId: string;
  readonly sourceCommit: string;
  readonly modeBindingDigest: string;
}

/** Actual native references, retained only by this successful live owner operation. */
export interface MoneyNormalWorkerOwnedUpload {
  readonly receipt: Readonly<MoneyNormalWorkerVersionUploadReceipt>;
  readonly context: MoneyUnitHeldConvertContext;
  readonly normalPreparation: MoneyUnitHeldNormalWorkerModePreparation;
  readonly signingGenesisContribution: MoneyNormalWorkerSigningGenesisContribution;
}

/** Public contribution DATA only. Enrollment occurs only in the owning suffix ONE. */
export interface MoneyNormalWorkerSigningGenesisContribution {
  readonly kind: "takoserver.money-normal-signing-genesis-contribution@v1";
  readonly keyId: string;
  readonly publicJwk: string;
  readonly publicJwkDigest: string;
  readonly createdAtEpochSeconds: number;
  readonly heldConvertDigest: string;
  readonly original92BackupDigest: string;
  readonly converted94BackupDigest: string;
  readonly convertBindingDigest: string;
  readonly normalModeBindingDigest: string;
  readonly normalNativeBindingDigest: string;
  readonly sourceCommit: string;
  readonly versionId: string;
}

interface PreparedSigningGenesis {
  readonly keyId: string;
  readonly publicJwk: string;
  readonly custodyRoot: string;
  assertCurrent(): Promise<void>;
}

function assertFreshSigningCensus(context: MoneyUnitHeldConvertContext): void {
  const facts = context.facts;
  if (facts.schemaPhase !== "0094-fenced" || facts.selectedStripeMode !== "test")
    throw preflightError("money signing genesis requires the genuine fresh fenced94 TEST context");
  for (const census of [facts.original92, facts.converted94, facts.current94]) {
    if (
      census.tableInventory.filter((name) => name === "runtime_grant_keys").length !== 1 ||
      census.rowCounts.runtime_grant_keys !== 0
    )
      throw preflightError(
        "money signing genesis requires observed original92 converted94 and current94 empty signing inventories",
      );
  }
}

function assertFreshSecretProfile(target: DeployTarget): readonly string[] {
  const names = expectedWorkerSecrets(target);
  if (
    names.some(
      (name) => name !== "TAKOSERVER_SIGNING_KEY" && name !== "TAKOSERVER_TAKOFORM_V2_CURSOR_KEY",
    ) ||
    target.signing.nextKeyId !== undefined
  )
    throw preflightError(
      "money signing genesis lacks an owning original custody route for the additional normal secret or rotation profile",
    );
  return names;
}

function writeSecret(path: string, raw: string): void {
  privateDirectory(dirname(path));
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, raw);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Proves a prepared pair, not an active or enrolled D1 signing identity. */
async function provePreparedPair(custodyRoot: string, canonicalPublic: string): Promise<void> {
  const privatePath = join(custodyRoot, "TAKOSERVER_SIGNING_KEY");
  const before = inputSeal(privatePath);
  const raw = readClosureSecretInputs(custodyRoot, [
    "TAKOSERVER_SIGNING_KEY",
  ]).TAKOSERVER_SIGNING_KEY;
  let privateJwk: JsonWebKey;
  let publicJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(raw ?? "");
    publicJwk = JSON.parse(canonicalPublic);
    if (
      JSON.stringify(Object.keys(privateJwk).sort()) !==
        JSON.stringify(["crv", "d", "ext", "key_ops", "kty", "x"]) ||
      JSON.stringify(Object.keys(publicJwk)) !== JSON.stringify(["kty", "crv", "x"]) ||
      privateJwk.kty !== "OKP" ||
      privateJwk.crv !== "Ed25519" ||
      privateJwk.ext !== true ||
      JSON.stringify(privateJwk.key_ops) !== JSON.stringify(["sign"]) ||
      publicJwk.kty !== "OKP" ||
      publicJwk.crv !== "Ed25519" ||
      privateJwk.x !== publicJwk.x ||
      !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(publicJwk.x ?? "") ||
      !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(privateJwk.d ?? "")
    )
      throw new Error();
    const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, [
      "sign",
    ]);
    const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const message = new TextEncoder().encode("takoserver.money-prepared-signing-genesis-pair@v1");
    const signature = await crypto.subtle.sign("Ed25519", key, message);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) throw new Error();
  } catch {
    throw preflightError("money prepared signing genesis pair is unavailable or differs");
  }
  if (inputSeal(privatePath) !== before)
    throw preflightError("money prepared signing genesis pair changed");
}

async function createFreshSigningGenesis(
  context: MoneyUnitHeldConvertContext,
  target: DeployTarget,
  root: string,
  assertInputs: () => void,
): Promise<PreparedSigningGenesis> {
  // This is a deliberate fresh-original branch, never absence=>use an arbitrary key.
  await assertMoneyUnitHeldConvertCurrent(context);
  assertInputs();
  assertFreshSigningCensus(context);
  const names = assertFreshSecretProfile(target);
  const keyId = effectiveSigningKeyId(target);
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(keyId))
    throw preflightError("money signing genesis key selector is unavailable");
  const custodyRoot = join(root, "CUSTODY");
  mkdirSync(custodyRoot, { mode: 0o700 });
  const custodyIdentity = privateDirectory(custodyRoot);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair) || !("publicKey" in pair))
    throw preflightError("money fresh signing genesis requires an actual key pair");
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  await assertMoneyUnitHeldConvertCurrent(context);
  assertInputs();
  assertFreshSigningCensus(context);
  if (
    privateDirectory(custodyRoot) !== custodyIdentity ||
    privateJwk.x !== publicJwk.x ||
    publicJwk.x === target.integrationE2eCredentialAuthority?.publicJwk.x
  )
    throw preflightError(
      "money fresh signing genesis differs from its original custody or authority boundary",
    );
  const canonicalPublic = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x });
  const createdAtEpochSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(createdAtEpochSeconds) || createdAtEpochSeconds <= 0)
    throw preflightError("money prepared signing genesis creation DATA is unavailable");
  writeSecret(
    join(custodyRoot, "TAKOSERVER_SIGNING_KEY"),
    JSON.stringify({
      kty: "OKP",
      crv: "Ed25519",
      x: privateJwk.x,
      d: privateJwk.d,
      ext: true,
      key_ops: ["sign"],
    }),
  );
  if (names.includes("TAKOSERVER_TAKOFORM_V2_CURSOR_KEY")) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const encoded = Buffer.from(bytes).toString("base64url");
    bytes.fill(0);
    writeSecret(join(custodyRoot, "TAKOSERVER_TAKOFORM_V2_CURSOR_KEY"), encoded);
  }
  const facts = context.facts;
  const genesisPath = join(root, "SIGNING-GENESIS.json");
  writePrivate(genesisPath, {
    kind: "takoserver.money-prepared-signing-genesis@v1",
    keyId,
    publicJwk: canonicalPublic,
    createdAtEpochSeconds,
    heldConvertDigest: sha(new TextEncoder().encode(JSON.stringify(facts))),
    original92BackupDigest: facts.original92.backupDigest,
    converted94BackupDigest: facts.converted94.backupDigest,
    convertBindingDigest: facts.conversion.convertBindingDigest,
    registration: "pending-owning-suffix-transaction",
    secretNames: names,
  });
  const seals = [genesisPath, ...names.map((name) => join(custodyRoot, name))].map(
    (path) => [path, inputSeal(path)] as const,
  );
  const assertCurrent = async () => {
    assertInputs();
    if (
      privateDirectory(custodyRoot) !== custodyIdentity ||
      seals.some(([path, value]) => inputSeal(path) !== value)
    )
      throw preflightError("money prepared signing genesis custody changed");
    await assertMoneyUnitHeldConvertCurrent(context);
    assertInputs();
    assertFreshSigningCensus(context);
    await provePreparedPair(custodyRoot, canonicalPublic);
    assertInputs();
    const values = readClosureSecretInputs(custodyRoot, names);
    if (target.takoformV2 !== undefined)
      parseTakoformV2ApplicationConfig({
        TAKOSERVER_TAKOFORM_V2_CONFIG: target.takoformV2.config,
        TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: values.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY,
      });
    if (seals.some(([path, value]) => inputSeal(path) !== value))
      throw preflightError("money prepared signing genesis inputs changed");
  };
  await assertCurrent();
  return Object.freeze({ keyId, publicJwk: canonicalPublic, custodyRoot, assertCurrent });
}

interface OriginalSigningUploadWitness {
  readonly context: MoneyUnitHeldConvertContext;
  readonly preparation: MoneyUnitHeldNormalWorkerModePreparation;
  readonly genesis: PreparedSigningGenesis;
  readonly selectorPath: string;
  readonly receiptJson: string;
}
// Only the actual upload owner below inserts a successful original receipt.
// Protected files are history/recovery DATA and never insert a live witness.
const originalSigningUploads = new WeakMap<object, OriginalSigningUploadWitness>();

const originalGenesisContributions = new WeakMap<
  object,
  {
    context: MoneyUnitHeldConvertContext;
    preparation: MoneyUnitHeldNormalWorkerModePreparation;
    publicJson: string;
    assertCurrent: () => Promise<void>;
  }
>();

/**
 * Requires the original successful LIVE upload receipt and exact native graph.
 * Retained private files are rechecked history, never a way to recreate a lost
 * upload witness. A separate process/status/JSON clone must refuse, not retry.
 */
export async function readMoneyNormalWorkerSigningGenesisContribution(
  context: MoneyUnitHeldConvertContext,
  preparation: MoneyUnitHeldNormalWorkerModePreparation,
  uploadResult: unknown,
): Promise<MoneyNormalWorkerSigningGenesisContribution> {
  const original =
    typeof uploadResult === "object" && uploadResult !== null
      ? originalSigningUploads.get(uploadResult)
      : undefined;
  if (
    !original ||
    original.context !== context ||
    original.preparation !== preparation ||
    JSON.stringify(uploadResult) !== original.receiptJson
  )
    throw preflightError(
      "money signing genesis requires the original live upload witness; unavailable is not replayable",
    );
  const selectorPath = original.selectorPath;
  await original.genesis.assertCurrent();
  await assertMoneyUnitHeldConvertCurrent(context);
  await assertMoneyUnitHeldNormalWorkerModePreparationCurrent(preparation, context);
  assertFreshSigningCensus(context);
  if (
    typeof selectorPath !== "string" ||
    !isAbsolute(selectorPath) ||
    resolve(selectorPath) !== selectorPath ||
    basename(selectorPath) !== "normal-worker.selector.json" ||
    basename(dirname(selectorPath)) !== "money-inactive-normal-version"
  )
    throw preflightError("money signing genesis requires the original normal selector locator");
  const root = dirname(selectorPath);
  const rootIdentity = privateDirectory(root);
  const requestPath = join(root, "REQUEST.json");
  const genesisPath = join(root, "SIGNING-GENESIS.json");
  const resultPath = join(root, "UPLOAD-RECEIPT.json");
  const custodyRoot = join(root, "CUSTODY");
  const requestSeal = inputSeal(requestPath);
  const request = parseMoneyNormalVersionUploadRequest(
    JSON.parse(readFileSync(requestPath, "utf8")),
  );
  if (inputSeal(requestPath) !== requestSeal)
    throw preflightError("money signing genesis original request changed");
  const originalPaths = [
    request.targetPath,
    request.originalCreateInputPath,
    request.convertDeclarationPath,
  ];
  const originalSeals = originalPaths.map((path) => inputSeal(path));
  const target = loadTarget(request.targetPath, "integration", "money-original-cutover");
  if (originalPaths.some((path, index) => inputSeal(path) !== originalSeals[index]))
    throw preflightError("money signing genesis original inputs changed");
  const names = assertFreshSecretProfile(target);
  const paths = [
    selectorPath,
    requestPath,
    genesisPath,
    resultPath,
    request.targetPath,
    request.originalCreateInputPath,
    request.convertDeclarationPath,
    ...names.map((name) => join(custodyRoot, name)),
  ];
  const heldPaths = paths.map((path) => [path, inputSeal(path)] as const);
  const custodyIdentity = privateDirectory(custodyRoot);
  if (
    inputSeal(requestPath) !== requestSeal ||
    originalPaths.some((path, index) => inputSeal(path) !== originalSeals[index])
  )
    throw preflightError("money signing genesis original inputs changed before held read");
  const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
  const selector = JSON.parse(readFileSync(selectorPath, "utf8"));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const facts = context.facts;
  const mode = preparation.facts;
  const heldConvertDigest = sha(new TextEncoder().encode(JSON.stringify(facts)));
  if (
    JSON.stringify(Object.keys(genesis).sort()) !==
      JSON.stringify([
        "convertBindingDigest",
        "converted94BackupDigest",
        "createdAtEpochSeconds",
        "heldConvertDigest",
        "keyId",
        "kind",
        "original92BackupDigest",
        "publicJwk",
        "registration",
        "secretNames",
      ]) ||
    genesis.kind !== "takoserver.money-prepared-signing-genesis@v1" ||
    genesis.keyId !== original.genesis.keyId ||
    genesis.publicJwk !== original.genesis.publicJwk ||
    genesis.registration !== "pending-owning-suffix-transaction" ||
    genesis.keyId !== effectiveSigningKeyId(target) ||
    genesis.heldConvertDigest !== heldConvertDigest ||
    genesis.original92BackupDigest !== facts.original92.backupDigest ||
    genesis.converted94BackupDigest !== facts.converted94.backupDigest ||
    genesis.convertBindingDigest !== facts.conversion.convertBindingDigest ||
    JSON.stringify(genesis.secretNames) !== JSON.stringify(names) ||
    typeof genesis.publicJwk !== "string" ||
    !Number.isSafeInteger(genesis.createdAtEpochSeconds) ||
    genesis.createdAtEpochSeconds <= 0 ||
    mode.heldConvertDigest !== heldConvertDigest ||
    result.modeBindingDigest !== preparation.bindingDigest ||
    result.kind !== "takoserver.money-inactive-normal-version-upload@v1" ||
    result.qualification !== "immutable-version-only" ||
    result.selectorPath !== selectorPath ||
    result.versionId !== mode.versionId ||
    result.sourceCommit !== mode.sourceCommit ||
    selector.versionId !== mode.versionId ||
    selector.sourceCommit !== mode.sourceCommit ||
    request.normalSourceRoot !== selector.sourceRoot ||
    target.accountId !== facts.storage.accountId ||
    target.workerName !== facts.maintenance.workerName ||
    target.d1.databaseId !== facts.storage.databaseId ||
    target.d1.databaseName !== facts.storage.databaseName ||
    target.r2.bucketName !== facts.storage.bucketName ||
    request.previousWriterEpoch !== facts.previousWriterEpoch ||
    request.nextWriterEpoch !== facts.nextWriterEpoch
  )
    throw preflightError(
      "money prepared signing genesis differs from its original context or normal Version",
    );
  const keyId = genesis.keyId as string;
  const publicJwk = genesis.publicJwk as string;
  // Bind exact target key selector and ALL secret names to the same native closure digest.
  const { schemaMaintenanceMode: _maintenance, ...plainTarget } = target;
  const normalTarget: DeployTarget = {
    ...plainTarget,
    moneyCutoverWriterEpoch: facts.nextWriterEpoch,
  };
  const expected = {
    ...expectedExactBindingClosure(normalTarget, {
      signingKeyId: keyId,
      workerArtifactDigest: mode.moduleDigest as `sha256:${string}`,
      ...(normalTarget.integrationE2eCredentialAuthority === undefined
        ? {}
        : {
            authorityProfile: {
              kind: "provenance-bound-jit" as const,
              provenance: {
                sourceCommit: mode.sourceCommit,
                artifactDigest: mode.moduleDigest as `sha256:${string}`,
              },
            },
          }),
    }),
    ...(normalTarget.hostedBilling === undefined
      ? { TAKOSERVER_STRIPE_MODE: { type: "plain_text", fields: { text: "test" } } }
      : {}),
  };
  if (sha(new TextEncoder().encode(JSON.stringify(expected))) !== mode.nativeBindingDigest)
    throw preflightError(
      "money signing genesis key selector or full secret names differ from native normal bindings",
    );
  const check = async () => {
    await original.genesis.assertCurrent();
    if (
      privateDirectory(root) !== rootIdentity ||
      privateDirectory(custodyRoot) !== custodyIdentity ||
      heldPaths.some(([path, seal]) => inputSeal(path) !== seal)
    )
      throw preflightError("money prepared signing genesis retained inputs changed");
    await assertMoneyUnitHeldConvertCurrent(context);
    await assertMoneyUnitHeldNormalWorkerModePreparationCurrent(preparation, context);
    assertFreshSigningCensus(context);
    await provePreparedPair(custodyRoot, publicJwk);
    if (target.takoformV2 !== undefined) {
      const values = readClosureSecretInputs(custodyRoot, names);
      parseTakoformV2ApplicationConfig({
        TAKOSERVER_TAKOFORM_V2_CONFIG: target.takoformV2.config,
        TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: values.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY,
      });
    }
    if (
      privateDirectory(root) !== rootIdentity ||
      privateDirectory(custodyRoot) !== custodyIdentity ||
      heldPaths.some(([path, seal]) => inputSeal(path) !== seal)
    )
      throw preflightError(
        "money prepared signing genesis retained inputs changed after observation",
      );
  };
  await check();
  const contribution: MoneyNormalWorkerSigningGenesisContribution = Object.freeze({
    kind: "takoserver.money-normal-signing-genesis-contribution@v1",
    keyId,
    publicJwk,
    publicJwkDigest: sha(new TextEncoder().encode(publicJwk)),
    createdAtEpochSeconds: genesis.createdAtEpochSeconds,
    heldConvertDigest,
    original92BackupDigest: facts.original92.backupDigest,
    converted94BackupDigest: facts.converted94.backupDigest,
    convertBindingDigest: facts.conversion.convertBindingDigest,
    normalModeBindingDigest: preparation.bindingDigest,
    normalNativeBindingDigest: mode.nativeBindingDigest,
    sourceCommit: mode.sourceCommit,
    versionId: mode.versionId,
  });
  originalGenesisContributions.set(contribution, {
    context,
    preparation,
    publicJson: JSON.stringify(contribution),
    assertCurrent: check,
  });
  return contribution;
}

/** Reassert before the owning ONE; never insert, reselect, retry or activate here. */
export async function assertMoneyNormalWorkerSigningGenesisContributionCurrent(
  contribution: unknown,
  context: MoneyUnitHeldConvertContext,
  preparation: MoneyUnitHeldNormalWorkerModePreparation,
): Promise<void> {
  const held =
    typeof contribution === "object" && contribution !== null
      ? originalGenesisContributions.get(contribution)
      : undefined;
  if (
    !held ||
    held.context !== context ||
    held.preparation !== preparation ||
    JSON.stringify(contribution) !== held.publicJson
  )
    throw preflightError("money signing genesis contribution requires its original retained owner");
  await held.assertCurrent();
}

/**
 * NEW owning capability proposal, separate from runWorker. No injected run/state/config callback.
 * Loader/currentness/native readback remain the existing original owner; no D1 import occurs.
 */
export async function uploadMoneyNormalWorkerVersion(
  request: unknown,
): Promise<Readonly<MoneyNormalWorkerOwnedUpload>> {
  return uploadMoneyNormalWorkerVersionOwned(request);
}

/** Compose the actual upload with the existing Root ONE's original graph. */
export async function uploadMoneyNormalWorkerVersionForOriginalContext(
  context: MoneyUnitHeldConvertContext,
  request: unknown,
): Promise<Readonly<MoneyNormalWorkerOwnedUpload>> {
  // An object shape, clone, ready flag or DATA selection cannot reach a native factory.
  parseMoneyNormalVersionUploadRequest(request);
  await assertMoneyUnitHeldConvertCurrent(context);
  return uploadMoneyNormalWorkerVersionOwned(request, context);
}

async function uploadMoneyNormalWorkerVersionOwned(
  request: unknown,
  suppliedContext?: MoneyUnitHeldConvertContext,
): Promise<Readonly<MoneyNormalWorkerOwnedUpload>> {
  const selected = parseMoneyNormalVersionUploadRequest(request);
  const inputPaths = [
    selected.targetPath,
    selected.originalCreateInputPath,
    selected.convertDeclarationPath,
  ];
  const originalInputs = inputPaths.map(inputSeal);
  const buildClosure = captureMoneyNativeBuildClosure();
  const node = realpathSync(Bun.which("node") ?? "");
  const assertInputs = () => {
    if (inputPaths.some((path, index) => inputSeal(path) !== originalInputs[index]))
      throw preflightError("money inactive Version original locators changed");
    buildClosure.assertCurrent();
  };
  const target = loadTarget(selected.targetPath, "integration", "money-original-cutover");
  if (
    target.schemaMaintenanceMode !== "pre-wallet-usd-micros-quiesced" ||
    target.moneyCutoverWriterPolicy !== "transaction-fenced-usd-micros-v1" ||
    target.moneyCutoverWriterEpoch !== selected.previousWriterEpoch ||
    (target.hostedBilling !== undefined && target.hostedBilling.stripeMode !== "test")
  )
    throw preflightError(
      "money inactive Version requires original frozen maintenance and TEST target",
    );
  const originalCreate = loadIntegrationStorageOriginalCreateInput(
    selected.originalCreateInputPath,
  );
  const options = await loadMoneyUnitOriginalCutoverOptions({
    selectedTarget: target,
    declarationPath: selected.convertDeclarationPath,
    originalCreate,
  });
  assertInputs();
  const observedContext = await readMoneyUnitHeldConvertContext(options, {
    previousWriterEpoch: selected.previousWriterEpoch,
    nextWriterEpoch: selected.nextWriterEpoch,
    convertedBackupPath: selected.convertedBackupPath,
    selectedStripeMode: "test",
  });
  assertInputs();
  const context = suppliedContext ?? observedContext;
  if (suppliedContext !== undefined) {
    await assertMoneyUnitHeldConvertCurrent(suppliedContext);
    assertInputs();
    if (JSON.stringify(suppliedContext.facts) !== JSON.stringify(observedContext.facts))
      throw preflightError(
        "money normal upload original supplied context differs from the default native owner",
      );
  }
  if (
    context.facts.storage.accountId !== target.accountId ||
    context.facts.storage.databaseId !== target.d1.databaseId ||
    context.facts.storage.databaseName !== target.d1.databaseName ||
    context.facts.storage.bucketName !== target.r2.bucketName ||
    context.facts.maintenance.workerName !== target.workerName ||
    options.outputDirectory === undefined
  )
    throw preflightError("money inactive Version differs from the genuine original held target");
  // Derive the only output root from the actual owner declaration, not a caller output/config path.
  privateDirectory(options.outputDirectory);
  const root = join(options.outputDirectory, "money-inactive-normal-version");
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch {
    throw preflightError(
      "money inactive Version attempt already exists or is unavailable; no retry",
    );
  }
  const rootIdentity = privateDirectory(root);
  let lease: WranglerVersionPublicationLease | undefined;
  let uploadStarted = false;
  let temporarySecretsRoot: string | undefined;
  let temporarySecretSeal: SealedArtifact | undefined;
  let finalResult: Readonly<MoneyNormalWorkerVersionUploadReceipt> | undefined;
  let completedOriginal: OriginalSigningUploadWitness | undefined;
  let operationFailed = false;
  let operationFailure: unknown;
  let cleanupFailed = false;
  try {
    writePrivate(join(root, "REQUEST.json"), selected);
    const genesis = await createFreshSigningGenesis(context, target, root, assertInputs);
    const buildRoot = join(root, "build-owner");
    mkdirSync(buildRoot, { mode: 0o700 });
    const build = await buildClosure.bindSource(
      selected.normalSourceRoot,
      buildClosure.sourceCommit,
      buildRoot,
    );
    assertInputs();
    const credential = await resolveCloudflareCredential("integration", { run: runCommand });
    assertInputs();
    const state = new CloudflareState({ accountId: target.accountId, token: credential.token });
    const assertLocal = () => {
      assertInputs();
      build.assertCurrent();
      if (privateDirectory(root) !== rootIdentity)
        throw preflightError("money inactive Version output root changed");
      if (lease !== undefined) assertWranglerVersionPublicationLeaseCurrent(lease);
    };
    const assertMaintenance = async () => {
      assertLocal();
      await assertMoneyUnitHeldConvertCurrent(context);
      assertLocal();
      const writer = await options.maintenanceProof();
      assertLocal();
      const current = parseWorkerDeploymentHistory(
        await state.workerDeployments(target.workerName),
      );
      assertLocal();
      if (
        JSON.stringify(writer) !== JSON.stringify(context.facts.maintenance) ||
        current?.deploymentId !== writer.deploymentId ||
        current.versionId !== writer.versionId
      )
        throw preflightError("money inactive Version original maintenance deployment changed");
    };
    const { schemaMaintenanceMode: _maintenance, ...originalNormalFields } = target;
    const normalTarget: DeployTarget = {
      ...originalNormalFields,
      moneyCutoverWriterEpoch: context.facts.nextWriterEpoch,
    };
    const signingKeyId = genesis.keyId;
    const prepared = await prepareWorkerArtifact({
      root: buildRoot,
      target: normalTarget,
      commit: build.sourceCommit,
      sourceRepositoryRoot: selected.normalSourceRoot,
      wranglerPath: build.wranglerPath,
      dryRunCommand: "versions-upload",
      run: build.run,
      writeConfig: ({ path, main, bundleDigestHex, formImplementationIdentity }) => {
        const configPath = writeWorkerConfig(normalTarget, {
          path,
          main,
          commit: build.sourceCommit,
          signingKeyId,
          sourceRepositoryRoot: selected.normalSourceRoot,
          topology: "version-only",
          ...(formImplementationIdentity === undefined ? {} : { formImplementationIdentity }),
          ...(bundleDigestHex === undefined
            ? {}
            : { workerArtifactDigest: `sha256:${bundleDigestHex}` as const }),
          ...(normalTarget.integrationE2eCredentialAuthority === undefined
            ? {}
            : bundleDigestHex === undefined
              ? { authorityProfile: { kind: "historical-pre-jit" as const } }
              : {
                  authorityProfile: {
                    kind: "provenance-bound-jit" as const,
                    provenance: {
                      sourceCommit: build.sourceCommit,
                      artifactDigest: `sha256:${bundleDigestHex}` as const,
                    },
                  },
                }),
        });
        // Same existing TEST binding the native mode reader permits/rebuilds; no caller vars/config.
        const initialConfigSeal = inputSeal(configPath);
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        if (
          typeof config.vars !== "object" ||
          config.vars === null ||
          Object.hasOwn(config.vars, "TAKOSERVER_SCHEMA_MAINTENANCE_MODE") ||
          (Object.hasOwn(config.vars, "TAKOSERVER_STRIPE_MODE") &&
            config.vars.TAKOSERVER_STRIPE_MODE !== "test")
        )
          throw preflightError("money inactive Version generated normal configuration differs");
        if (!Object.hasOwn(config.vars, "TAKOSERVER_STRIPE_MODE")) {
          const before = lstatSync(configPath, { bigint: true });
          const fd = openSync(
            configPath,
            constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const held = fstatSync(fd, { bigint: true });
            if (
              !before.isFile() ||
              before.nlink !== 1n ||
              (before.mode & 0o777n) !== 0o600n ||
              held.dev !== before.dev ||
              held.ino !== before.ino ||
              held.nlink !== 1n ||
              inputSeal(configPath) !== initialConfigSeal
            )
              throw preflightError("money inactive Version generated config changed");
            ftruncateSync(fd, 0);
            writeFileSync(
              fd,
              `${JSON.stringify({ ...config, vars: { ...config.vars, TAKOSERVER_STRIPE_MODE: "test" } }, null, 2)}\n`,
            );
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        return configPath;
      },
    });
    assertLocal();
    const sealed = prepared.seal();
    sealed.assertUnchanged();
    // Existing same-target publication lease and provenance check; no caller-chosen namespace/lease.
    lease = await acquireWranglerVersionPublicationLease({
      accountId: target.accountId,
      workerName: target.workerName,
    });
    assertLocal();
    await assertMaintenance();
    assertLocal();
    sealed.assertUnchanged();
    const output = join(root, "wrangler-version-upload.jsonl");
    writeFileSync(output, "", { flag: "wx", mode: 0o600 });
    const message = `takoserver-worker:${build.sourceCommit}:${prepared.bundleDigestHex}`;
    await genesis.assertCurrent();
    temporarySecretsRoot = join(root, "upload-secrets");
    mkdirSync(temporarySecretsRoot, { mode: 0o700 });
    const secretsFilePath = join(temporarySecretsRoot, "secrets.json");
    const secretValues = readClosureSecretInputs(
      genesis.custodyRoot,
      expectedWorkerSecrets(normalTarget),
    );
    writePrivate(secretsFilePath, secretValues);
    temporarySecretSeal = sealDirectory(temporarySecretsRoot, ["secrets.json"]);
    temporarySecretSeal.assertUnchanged();
    const argv = moneyNormalVersionUploadArguments({
      bundlePath: prepared.bundlePath,
      configPath: prepared.configPath,
      workerName: target.workerName,
      message,
      secretsFilePath,
    });
    writePrivate(join(root, "INTENT.json"), {
      kind: "money-inactive-version-upload-intent@v1",
      sourceCommit: build.sourceCommit,
      sourceTreeDigest: build.sourceTreeDigest,
      moduleDigest: `sha256:${prepared.bundleDigestHex}`,
      artifactDigest: sealed.digest,
      maintenance: context.facts.maintenance,
      converted94BackupDigest: context.facts.converted94.backupDigest,
      convertBindingDigest: context.facts.conversion.convertBindingDigest,
      previousWriterEpoch: context.facts.previousWriterEpoch,
      nextWriterEpoch: context.facts.nextWriterEpoch,
    });
    // The only mutating command in this owner is the trusted versions-upload recipe. Never deploy.
    await genesis.assertCurrent();
    temporarySecretSeal.assertUnchanged();
    uploadStarted = true;
    const upload = await runCommand([node, build.wranglerPath, ...argv], {
      env: { ...credential.childEnvironment, WRANGLER_OUTPUT_FILE_PATH: output },
    });
    assertLocal();
    sealed.assertUnchanged();
    temporarySecretSeal.assertUnchanged();
    await genesis.assertCurrent();
    if (upload.exitCode !== 0)
      throw mutationError(
        "money inactive Version upload acknowledgement is unknown; no automatic retry",
      );
    const raw = readFileSync(output, "utf8");
    const publication = parseWranglerVersionUploadOutput(
      raw.trim() === "" ? upload.stdout : raw,
      target.workerName,
    );
    if (publication.versionId === context.facts.maintenance.versionId)
      throw mutationError("money inactive Version reused the maintenance Version identity");
    const version = await state.workerVersion(target.workerName, publication.versionId);
    assertLocal();
    const identity = workerVersionIdentity("verification", version);
    const moduleDigest = `sha256:${prepared.bundleDigestHex}` as const;
    if (
      identity.commit !== build.sourceCommit ||
      identity.bundleDigestHex !== prepared.bundleDigestHex
    )
      throw mutationError("money inactive Version native source annotation differs");
    const expected = {
      ...expectedExactBindingClosure(normalTarget, {
        signingKeyId,
        workerArtifactDigest: moduleDigest,
        ...(normalTarget.integrationE2eCredentialAuthority === undefined
          ? {}
          : {
              authorityProfile: {
                kind: "provenance-bound-jit" as const,
                provenance: { sourceCommit: build.sourceCommit, artifactDigest: moduleDigest },
              },
            }),
      }),
      ...(normalTarget.hostedBilling === undefined
        ? { TAKOSERVER_STRIPE_MODE: { type: "plain_text", fields: { text: "test" } } }
        : {}),
    };
    assertExactVersionBindingClosure("verification", publication.versionId, version, expected);
    const modules = await state.workerVersionWithModules(target.workerName, publication.versionId);
    assertLocal();
    if (`sha256:${exactV2MaintenanceModuleDigest("verification", modules)}` !== moduleDigest)
      throw mutationError("money inactive Version native module bytes differ");
    await assertMaintenance();
    assertLocal();
    sealed.assertUnchanged();
    const selectorPath = join(root, "normal-worker.selector.json");
    writePrivate(selectorPath, {
      kind: "takoserver.money-held-normal-worker-selector@v1",
      accountId: context.facts.storage.accountId,
      databaseId: context.facts.storage.databaseId,
      databaseName: context.facts.storage.databaseName,
      bucketName: context.facts.storage.bucketName,
      workerName: target.workerName,
      previousWriterEpoch: context.facts.previousWriterEpoch,
      nextWriterEpoch: context.facts.nextWriterEpoch,
      convertBindingDigest: context.facts.conversion.convertBindingDigest,
      converted94BackupDigest: context.facts.converted94.backupDigest,
      sourceRoot: selected.normalSourceRoot,
      sourceCommit: build.sourceCommit,
      versionId: publication.versionId,
      moduleDigest,
      artifactDigest: sealed.digest,
      artifactBytes: sealed.bytes,
      artifactFiles: sealed.files,
      selectedStripeMode: "test",
    });
    // Same original owner mints its real preparation only after native immutable GET and exact rebuild.
    const preparation = await readMoneyUnitHeldNormalWorkerModePreparation(context, selectorPath);
    assertLocal();
    await assertMaintenance();
    assertLocal();
    sealed.assertUnchanged();
    await genesis.assertCurrent();
    const result = Object.freeze({
      kind: "takoserver.money-inactive-normal-version-upload@v1" as const,
      qualification: "immutable-version-only" as const,
      selectorPath,
      versionId: publication.versionId,
      sourceCommit: build.sourceCommit,
      modeBindingDigest: preparation.bindingDigest,
    });
    finalResult = result;
    completedOriginal = Object.freeze({
      context,
      preparation,
      genesis,
      selectorPath,
      receiptJson: JSON.stringify(result),
    });
  } catch (error) {
    operationFailed = true;
    operationFailure = uploadStarted
      ? mutationError(
          "money inactive Version may exist; preserve output/history and original selector; no traffic change or automatic retry was requested",
        )
      : error;
  } finally {
    if (temporarySecretsRoot !== undefined) {
      try {
        unsealDirectory(temporarySecretsRoot);
      } catch {
        cleanupFailed = true;
      }
      try {
        rmSync(temporarySecretsRoot, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      if (lease !== undefined) await lease.release();
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed)
    throw mutationError(
      "money inactive Version cleanup failed; preserve original custody and output; ephemeral secret material may remain; no automatic retry",
    );
  if (operationFailed) throw operationFailure;
  if (finalResult === undefined || completedOriginal === undefined)
    throw preflightError("money inactive Version has no completed result");
  writePrivate(join(root, "UPLOAD-RECEIPT.json"), finalResult);
  // Reached only after this actual ONE upload, strict native/mode readback and cleanup.
  originalSigningUploads.set(finalResult, completedOriginal);
  const signingGenesisContribution = await readMoneyNormalWorkerSigningGenesisContribution(
    context,
    completedOriginal.preparation,
    finalResult,
  );
  writePrivate(join(root, "RESULT.json"), finalResult);
  return Object.freeze({
    receipt: finalResult,
    context,
    normalPreparation: completedOriginal.preparation,
    signingGenesisContribution,
  });
}
