import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  AUTH103_NATIVE_DEPLOYMENT_QUERY,
  AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE,
  AUTH103_NATIVE_PROFILE,
  AUTH103_NATIVE_RP_REGISTRATION_QUERY,
  type Auth103NativeSourceManifest,
} from "../../src/auth103-native-source-contract.ts";
import { canonicalJson } from "../../src/json.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../../src/shared-auth-oidc-client.ts";
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";
import { applicationSchemaMatches } from "./application-schema-shape.ts";
import {
  auth103NativeDeploymentRecord,
  auth103NativeTargetRef,
  compileAuth103NativeSourceInstallContribution,
} from "./auth103-native-source.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import { readFinancial0104CanonicalMigrationSource } from "./financial0104-canonical-source.ts";
import {
  compileRoot0105ImportShapes,
  financial0104LedgerApplied,
} from "./financial0104-schema-shape.ts";
import { readD1SchemaState } from "./migrations.ts";
import {
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import { qualifySource } from "./qualification.ts";
import {
  boundCurrentPredicate,
  boundedOriginalShapePredicates,
  boundPredicate,
  ledgerPredicate,
  readAuth103OriginalCustodyDirectory,
} from "./schema-auth103-native-source.ts";
import { type DeployTarget, loadTarget, targetPath } from "./target.ts";
import {
  inspectCanonicalWorkerVersionWithScriptIdentity,
  workerVersionIdentity,
  workerVersionScriptContentIdentity,
} from "./worker-live.ts";

const SHA = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ASSIGNMENT = "define_TAKOSERVER_AUTH103_NATIVE_SOURCE_default";
const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const pathExistsNoFollow = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

/** The tool tree must carry these Auth paths byte-identically to the deployed commit. */
export const AUTH103_CURRENT_RUNTIME_DEPLOYED_SOURCE_PATHS = Object.freeze([
  "src/auth103-native-origin-source.ts",
  "src/auth103-native-source-contract.ts",
  "src/shared-auth-oidc-client.ts",
  "src/shared-auth-session.ts",
  "src/worker-request-shared-principal-issuance.ts",
] as const);

/** Read a single esbuild define assignment as data. No bundle code is run. */
function embeddedManifest(worker: Uint8Array): Auth103NativeSourceManifest {
  const source = ts.createSourceFile(
    "worker.js",
    Buffer.from(worker).toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
      .length !== 0
  )
    throw preflightError("Auth103 current module syntax is invalid");
  const matches: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === ASSIGNMENT
    )
      matches.push(node.right);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (matches.length !== 1)
    throw preflightError("Auth103 current manifest assignment is not unique");
  const decode = (node: ts.Node, depth: number): unknown => {
    if (depth > 6) throw preflightError("Auth103 current manifest is too deeply nested");
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.length > 1024)
        throw preflightError("Auth103 current manifest array is oversized");
      return node.elements.map((entry) => decode(entry, depth + 1));
    }
    if (ts.isObjectLiteralExpression(node)) {
      if (node.properties.length > 1024)
        throw preflightError("Auth103 current manifest object is oversized");
      const result: Record<string, unknown> = Object.create(null);
      for (const entry of node.properties) {
        if (!ts.isPropertyAssignment(entry))
          throw preflightError("Auth103 current manifest has executable syntax");
        const name = entry.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteral(name))
          throw preflightError("Auth103 current manifest has a computed key");
        const key = name.text;
        if (key === "__proto__" || key in result)
          throw preflightError("Auth103 current manifest has a duplicate key");
        result[key] = decode(entry.initializer, depth + 1);
      }
      return result;
    }
    throw preflightError("Auth103 current manifest has a non-data value");
  };
  const value = decode(matches[0]!, 0);
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "version",
      "sourceCommit",
      "sourceRef",
      "targetRef",
      "authSchemaRef",
      "catalogDigest",
      "catalogProjection",
      "registrationRef",
      "recipeDigest",
      "clockSourceDigest",
      "clockPolicyRef",
      "rpRegistration",
    ]) ||
    value.version !== 1 ||
    typeof value.sourceCommit !== "string" ||
    !COMMIT.test(value.sourceCommit) ||
    [
      "sourceRef",
      "targetRef",
      "authSchemaRef",
      "catalogDigest",
      "registrationRef",
      "recipeDigest",
      "clockSourceDigest",
      "clockPolicyRef",
    ].some((key) => typeof value[key] !== "string" || !SHA.test(value[key] as string)) ||
    !Array.isArray(value.catalogProjection) ||
    value.catalogProjection.length < 7 ||
    value.catalogProjection.length > 1024 ||
    value.catalogProjection.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 3 ||
        entry.some((cell) => typeof cell !== "string" || cell.length === 0),
    ) ||
    !isRecord(value.rpRegistration) ||
    !exactKeys(value.rpRegistration, [
      "registrationRef",
      "registrationDigest",
      "receiptRef",
      "issuerSourceRef",
      "configDigest",
      "profile",
    ]) ||
    ["registrationRef", "registrationDigest", "receiptRef", "issuerSourceRef", "configDigest"].some(
      (key) =>
        typeof (value.rpRegistration as Record<string, unknown>)[key] !== "string" ||
        !SHA.test((value.rpRegistration as Record<string, string>)[key]!),
    ) ||
    canonicalJson(value.rpRegistration.profile) !== canonicalJson(SHARED_AUTH_STAGING_PROFILE)
  )
    throw preflightError("Auth103 current manifest shape is invalid");
  return value as unknown as Auth103NativeSourceManifest;
}

/** Pure pair verifier used by the owning readback and focused regressions. */
export function exactCurrentAuth103NativePair(
  response: unknown,
  sourceCommit: string,
  bundleDigestHex: string,
) {
  if (
    !isRecord(response) ||
    response.main_module !== "worker.js" ||
    !Array.isArray(response.modules) ||
    response.modules.length !== 2 ||
    response.resources !== undefined
  )
    throw preflightError("Auth103 current module pair is not exact");
  const modules = new Map<string, Uint8Array>();
  for (const raw of response.modules) {
    if (
      !isRecord(raw) ||
      !exactKeys(raw, ["name", "content_type", "content_base64"]) ||
      typeof raw.name !== "string" ||
      typeof raw.content_base64 !== "string" ||
      modules.has(raw.name)
    )
      throw preflightError("Auth103 current module pair is not exact");
    const media =
      raw.name === "worker.js"
        ? "application/javascript+module"
        : raw.name === "auth103-source-install.sql"
          ? "text/plain"
          : null;
    if (media === null || raw.content_type !== media)
      throw preflightError("Auth103 current module pair has an unknown member");
    const bytes = Buffer.from(raw.content_base64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== raw.content_base64)
      throw preflightError("Auth103 current module pair has noncanonical bytes");
    modules.set(raw.name, bytes);
  }
  const worker = modules.get("worker.js");
  const install = modules.get("auth103-source-install.sql");
  if (
    worker === undefined ||
    install === undefined ||
    digest(worker) !== `sha256:${bundleDigestHex}`
  )
    throw preflightError("Auth103 current module digest differs from Version identity");
  const manifest = embeddedManifest(worker);
  if (manifest.sourceCommit !== sourceCommit)
    throw preflightError("Auth103 current source commit differs");
  const record = auth103NativeDeploymentRecord(manifest, digest(worker));
  const compiled = compileAuth103NativeSourceInstallContribution(manifest, digest(worker));
  if (!Buffer.from(install).equals(Buffer.from(compiled)))
    throw preflightError("Auth103 current install module differs from its owner compiler");
  return Object.freeze({
    manifest,
    record,
    bundleDigest: digest(worker),
    installDigest: digest(install),
  });
}

type NativePair = ReturnType<typeof exactCurrentAuth103NativePair>;

function currentRpSuccessor(current: NativePair, historical: NativePair): boolean {
  const rp = current.record.rp;
  const old = historical.record;
  const sameRp =
    rp.registrationRef === old.rp.registrationRef &&
    rp.registrationDigest === old.rp.registrationDigest &&
    rp.receiptRef === old.rp.receiptRef &&
    current.record.rpJson === old.rpJson;
  if (
    !sameRp &&
    (rp.registrationRef === old.rp.registrationRef ||
      rp.registrationDigest === old.rp.registrationDigest ||
      rp.receiptRef === old.rp.receiptRef ||
      current.record.rpJson === old.rpJson)
  )
    throw preflightError(
      "Auth103 current runtime RP successor identity collides with the historical original",
    );
  return !sameRp;
}

/** The first two owner statements represent immutable originals already proven
 * byte-for-byte in this database. Only the owner's final pair is new. */
export function compileAuth103CurrentRuntimePairSql(input: {
  readonly current: NativePair;
  readonly historical: NativePair;
  readonly predecessor?: NativePair;
  readonly earlierPredecessor?: NativePair;
  readonly oldestPredecessor?: NativePair;
  readonly earliestPredecessor?: NativePair;
  readonly initialPredecessor?: NativePair;
  readonly originPredecessor?: NativePair;
  readonly genesisPredecessor?: NativePair;
  readonly migrationNames: readonly string[];
  readonly postShape: string;
  readonly currentSourcePredicate: string;
}): {
  readonly sql: string;
  readonly guardCount: number;
  readonly postGuardCount: number;
  readonly rpAdded: boolean;
} {
  const { current, historical } = input;
  const frames = frameHostMigrationSql(
    compileAuth103NativeSourceInstallContribution(current.manifest, current.bundleDigest),
  );
  if (
    frames.length !== 4 ||
    !frames[0]?.trimStart().startsWith("INSERT INTO auth103_native_rp_registrations(") ||
    !frames[1]?.trimStart().startsWith("INSERT INTO auth103_native_rp_registration_receipts(") ||
    !frames[2]?.trimStart().startsWith("INSERT INTO auth103_native_deployments(") ||
    !frames[3]?.trimStart().startsWith("INSERT INTO auth103_native_deployment_receipts(")
  )
    throw preflightError("Auth103 owner contribution has an unexpected statement shape");
  const rp = current.record.rp;
  const old = historical.record;
  if (
    (input.earlierPredecessor && !input.predecessor) ||
    (input.oldestPredecessor && !input.earlierPredecessor) ||
    (input.earliestPredecessor && !input.oldestPredecessor) ||
    (input.initialPredecessor && !input.earliestPredecessor) ||
    (input.originPredecessor && !input.initialPredecessor) ||
    (input.genesisPredecessor && !input.originPredecessor)
  ) {
    throw preflightError("Auth103 fourth runtime requires its sealed latest predecessor");
  }
  const rpAdded = currentRpSuccessor(current, input.predecessor ?? historical);
  if (
    input.predecessor &&
    !input.earlierPredecessor &&
    (currentRpSuccessor(input.predecessor, historical) ||
      input.predecessor.record.deploymentRef === historical.record.deploymentRef ||
      input.predecessor.record.deploymentRef === current.record.deploymentRef ||
      input.predecessor.manifest.sourceRef === current.manifest.sourceRef ||
      !currentRpSuccessor(current, input.predecessor))
  )
    throw preflightError("Auth103 current runtime predecessor is foreign or duplicated");
  if (
    input.genesisPredecessor &&
    input.originPredecessor &&
    input.initialPredecessor &&
    input.earliestPredecessor &&
    input.oldestPredecessor &&
    input.earlierPredecessor &&
    input.predecessor
  ) {
    const first = input.genesisPredecessor;
    const second = input.originPredecessor;
    const third = input.initialPredecessor;
    const fourth = input.earliestPredecessor;
    const fifth = input.oldestPredecessor;
    const sixth = input.earlierPredecessor;
    const seventh = input.predecessor;
    const lineage = [historical, first, second, third, fourth, fifth, sixth, seventh, current];
    // The sealed seventh runtime kept the sixth runtime's RP; the eighth must be a new RP
    // distinct from every sealed RP (a partial match throws).
    if (
      currentRpSuccessor(first, historical) ||
      !currentRpSuccessor(second, first) ||
      !currentRpSuccessor(third, second) ||
      !currentRpSuccessor(fourth, third) ||
      !currentRpSuccessor(fifth, fourth) ||
      !currentRpSuccessor(sixth, fifth) ||
      currentRpSuccessor(seventh, sixth) ||
      [historical, first, second, third, fourth, fifth, sixth, seventh].some(
        (part) => !currentRpSuccessor(current, part),
      ) ||
      new Set(lineage.map((part) => part.record.deploymentRef)).size !== 9 ||
      new Set(lineage.map((part) => part.manifest.sourceRef)).size !== 9 ||
      lineage.some((part) => part.manifest.targetRef !== current.manifest.targetRef)
    ) {
      throw preflightError("auth103 eighth runtime RP successor lineage is not exact");
    }
  } else if (
    input.originPredecessor &&
    input.initialPredecessor &&
    input.earliestPredecessor &&
    input.oldestPredecessor &&
    input.earlierPredecessor &&
    input.predecessor
  ) {
    const first = input.originPredecessor;
    const second = input.initialPredecessor;
    const third = input.earliestPredecessor;
    const fourth = input.oldestPredecessor;
    const fifth = input.earlierPredecessor;
    const sixth = input.predecessor;
    const lineage = [historical, first, second, third, fourth, fifth, sixth, current];
    // The seventh runtime keeps the sixth runtime's RP exactly (a partial match throws).
    if (
      currentRpSuccessor(first, historical) ||
      !currentRpSuccessor(second, first) ||
      !currentRpSuccessor(third, second) ||
      !currentRpSuccessor(fourth, third) ||
      !currentRpSuccessor(fifth, fourth) ||
      !currentRpSuccessor(sixth, fifth) ||
      currentRpSuccessor(current, sixth) ||
      [historical, first, second, third, fourth, fifth].some(
        (part) => !currentRpSuccessor(current, part),
      ) ||
      new Set(lineage.map((part) => part.record.deploymentRef)).size !== 8 ||
      new Set(lineage.map((part) => part.manifest.sourceRef)).size !== 8 ||
      lineage.some((part) => part.manifest.targetRef !== current.manifest.targetRef)
    ) {
      throw preflightError("auth103 seventh runtime same-RP lineage is not exact");
    }
  } else if (
    input.initialPredecessor &&
    input.earliestPredecessor &&
    input.oldestPredecessor &&
    input.earlierPredecessor &&
    input.predecessor
  ) {
    const first = input.initialPredecessor;
    const second = input.earliestPredecessor;
    const third = input.oldestPredecessor;
    const fourth = input.earlierPredecessor;
    const fifth = input.predecessor;
    const lineage = [historical, first, second, third, fourth, fifth, current];
    if (
      currentRpSuccessor(first, historical) ||
      !currentRpSuccessor(second, first) ||
      !currentRpSuccessor(third, second) ||
      !currentRpSuccessor(fourth, third) ||
      !currentRpSuccessor(fifth, fourth) ||
      [historical, first, second, third, fourth].some(
        (part) => !currentRpSuccessor(current, part),
      ) ||
      new Set(lineage.map((part) => part.record.deploymentRef)).size !== 7 ||
      new Set(lineage.map((part) => part.manifest.sourceRef)).size !== 7 ||
      lineage.some((part) => part.manifest.targetRef !== current.manifest.targetRef)
    ) {
      throw preflightError("auth103 sixth runtime lineage is not exact");
    }
  } else if (
    input.earliestPredecessor &&
    input.oldestPredecessor &&
    input.earlierPredecessor &&
    input.predecessor
  ) {
    const first = input.earliestPredecessor;
    const second = input.oldestPredecessor;
    const third = input.earlierPredecessor;
    const fourth = input.predecessor;
    const lineage = [historical, first, second, third, fourth, current];
    if (
      currentRpSuccessor(first, historical) ||
      !currentRpSuccessor(second, first) ||
      !currentRpSuccessor(third, second) ||
      !currentRpSuccessor(fourth, third) ||
      [historical, first, second, third].some((part) => !currentRpSuccessor(current, part)) ||
      new Set(lineage.map((part) => part.record.deploymentRef)).size !== 6 ||
      new Set(lineage.map((part) => part.manifest.sourceRef)).size !== 6 ||
      lineage.some((part) => part.manifest.targetRef !== current.manifest.targetRef)
    ) {
      throw preflightError("auth103 current runtime lineage is not exact");
    }
  } else if (input.oldestPredecessor && input.earlierPredecessor && input.predecessor) {
    const first = input.oldestPredecessor;
    const second = input.earlierPredecessor;
    const third = input.predecessor;
    const lineage = [historical, first, second, third, current];
    if (
      currentRpSuccessor(first, historical) ||
      !currentRpSuccessor(second, first) ||
      !currentRpSuccessor(third, second) ||
      [historical, first, second].some((part) => !currentRpSuccessor(current, part)) ||
      new Set(lineage.map((part) => part.record.deploymentRef)).size !== 5 ||
      new Set(lineage.map((part) => part.manifest.sourceRef)).size !== 5 ||
      lineage.some((part) => part.manifest.targetRef !== current.manifest.targetRef)
    ) {
      throw preflightError("Auth103 current-runtime fourth predecessor lineage differs");
    }
  } else if (input.earlierPredecessor && input.predecessor) {
    const earlier = input.earlierPredecessor;
    const latest = input.predecessor;
    const lineage = [historical, earlier, latest, current];
    if (
      currentRpSuccessor(earlier, historical) ||
      !currentRpSuccessor(latest, earlier) ||
      !currentRpSuccessor(current, historical) ||
      !currentRpSuccessor(current, earlier) ||
      new Set(lineage.map((part) => part.record.deploymentRef)).size !== 4 ||
      new Set(lineage.map((part) => part.manifest.sourceRef)).size !== 4 ||
      lineage.some((part) => part.manifest.targetRef !== current.manifest.targetRef)
    ) {
      throw preflightError("Auth103 fourth runtime predecessor lineage is not exact");
    }
  }
  const historicalPredicate = boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
    old.deploymentRef,
    old.deploymentJson,
    old.rp.registrationRef,
    old.rp.registrationDigest,
    old.rpJson,
  ]);
  const predecessorPredicate = input.predecessor
    ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
        input.predecessor.record.deploymentRef,
        input.predecessor.record.deploymentJson,
        input.predecessor.record.rp.registrationRef,
        input.predecessor.record.rp.registrationDigest,
        input.predecessor.record.rpJson,
      ])
    : undefined;
  const earlierPredecessorPredicate = input.earlierPredecessor
    ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
        input.earlierPredecessor.record.deploymentRef,
        input.earlierPredecessor.record.deploymentJson,
        input.earlierPredecessor.record.rp.registrationRef,
        input.earlierPredecessor.record.rp.registrationDigest,
        input.earlierPredecessor.record.rpJson,
      ])
    : undefined;
  const oldestPredecessorPredicate = input.oldestPredecessor
    ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
        input.oldestPredecessor.record.deploymentRef,
        input.oldestPredecessor.record.deploymentJson,
        input.oldestPredecessor.record.rp.registrationRef,
        input.oldestPredecessor.record.rp.registrationDigest,
        input.oldestPredecessor.record.rpJson,
      ])
    : undefined;
  const earliestPredecessorPredicate = input.earliestPredecessor
    ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
        input.earliestPredecessor.record.deploymentRef,
        input.earliestPredecessor.record.deploymentJson,
        input.earliestPredecessor.record.rp.registrationRef,
        input.earliestPredecessor.record.rp.registrationDigest,
        input.earliestPredecessor.record.rpJson,
      ])
    : undefined;
  const initialPredecessorPredicate = input.initialPredecessor
    ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
        input.initialPredecessor.record.deploymentRef,
        input.initialPredecessor.record.deploymentJson,
        input.initialPredecessor.record.rp.registrationRef,
        input.initialPredecessor.record.rp.registrationDigest,
        input.initialPredecessor.record.rpJson,
      ])
    : undefined;
  const originPredecessorPredicate = input.originPredecessor
    ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
        input.originPredecessor.record.deploymentRef,
        input.originPredecessor.record.deploymentJson,
        input.originPredecessor.record.rp.registrationRef,
        input.originPredecessor.record.rp.registrationDigest,
        input.originPredecessor.record.rpJson,
      ])
    : undefined;
  const genesisPredecessorPredicate = input.genesisPredecessor
    ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
        input.genesisPredecessor.record.deploymentRef,
        input.genesisPredecessor.record.deploymentJson,
        input.genesisPredecessor.record.rp.registrationRef,
        input.genesisPredecessor.record.rp.registrationDigest,
        input.genesisPredecessor.record.rpJson,
      ])
    : undefined;
  const baseRpCount = input.genesisPredecessor
    ? 6
    : input.originPredecessor
      ? 6
      : input.initialPredecessor
        ? 5
        : input.earliestPredecessor
          ? 4
          : input.oldestPredecessor
            ? 3
            : input.earlierPredecessor
              ? 2
              : 1;
  const baseDeploymentCount = input.genesisPredecessor
    ? 8
    : input.originPredecessor
      ? 7
      : input.initialPredecessor
        ? 6
        : input.earliestPredecessor
          ? 5
          : input.oldestPredecessor
            ? 4
            : input.earlierPredecessor
              ? 3
              : input.predecessor
                ? 2
                : 1;
  const preconditions = [
    ledgerPredicate(input.migrationNames),
    ...boundedOriginalShapePredicates(input.postShape),
    input.currentSourcePredicate,
    historicalPredicate,
    ...(genesisPredecessorPredicate ? [genesisPredecessorPredicate] : []),
    ...(originPredecessorPredicate ? [originPredecessorPredicate] : []),
    ...(initialPredecessorPredicate ? [initialPredecessorPredicate] : []),
    ...(earliestPredecessorPredicate ? [earliestPredecessorPredicate] : []),
    ...(oldestPredecessorPredicate ? [oldestPredecessorPredicate] : []),
    ...(earlierPredecessorPredicate ? [earlierPredecessorPredicate] : []),
    ...(predecessorPredicate ? [predecessorPredicate] : []),
    `(SELECT count(*) FROM auth103_native_rp_registrations)=${baseRpCount}
      AND (SELECT count(*) FROM auth103_native_rp_registration_receipts)=${baseRpCount}
      AND (SELECT count(*) FROM auth103_native_deployments)=${baseDeploymentCount}
      AND (SELECT count(*) FROM auth103_native_deployment_receipts)=${baseDeploymentCount}`,
    `NOT EXISTS(SELECT 1 FROM auth103_native_deployments WHERE deployment_ref=${sqlLiteral(current.record.deploymentRef)}
      OR (target_ref=${sqlLiteral(current.manifest.targetRef)} AND source_ref=${sqlLiteral(current.manifest.sourceRef)}
        AND artifact_digest=${sqlLiteral(current.bundleDigest)}))`,
    `NOT EXISTS(SELECT 1 FROM auth103_native_deployment_receipts WHERE receipt_ref=${sqlLiteral(current.record.deploymentReceiptRef)}
      OR deployment_ref=${sqlLiteral(current.record.deploymentRef)})`,
    ...(rpAdded
      ? [
          `NOT EXISTS(SELECT 1 FROM auth103_native_rp_registrations WHERE registration_ref=${sqlLiteral(rp.registrationRef)} OR registration_digest=${sqlLiteral(rp.registrationDigest)})`,
          `NOT EXISTS(SELECT 1 FROM auth103_native_rp_registration_receipts WHERE receipt_ref=${sqlLiteral(rp.receiptRef)} OR registration_ref=${sqlLiteral(rp.registrationRef)})`,
        ]
      : []),
  ];
  const postcondition = boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
    current.record.deploymentRef,
    current.record.deploymentJson,
    rp.registrationRef,
    rp.registrationDigest,
    current.record.rpJson,
  ]);
  const guard = (predicate: string) =>
    `SELECT CASE WHEN (${predicate}) THEN 1 ELSE abs(-9223372036854775808) END AS current;`;
  const changedOne =
    "SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END AS changed_rows;";
  const statements = [
    ...preconditions.map(guard),
    ...(rpAdded ? [frames[0]!, changedOne, frames[1]!, changedOne] : []),
    frames[2]!,
    changedOne,
    frames[3]!,
    changedOne,
    guard(postcondition),
    guard(historicalPredicate),
    ...(genesisPredecessorPredicate ? [guard(genesisPredecessorPredicate)] : []),
    ...(originPredecessorPredicate ? [guard(originPredecessorPredicate)] : []),
    ...(initialPredecessorPredicate ? [guard(initialPredecessorPredicate)] : []),
    ...(earliestPredecessorPredicate ? [guard(earliestPredecessorPredicate)] : []),
    ...(oldestPredecessorPredicate ? [guard(oldestPredecessorPredicate)] : []),
    ...(earlierPredecessorPredicate ? [guard(earlierPredecessorPredicate)] : []),
    ...(predecessorPredicate ? [guard(predecessorPredicate)] : []),
    guard(`(SELECT count(*) FROM auth103_native_rp_registrations)=${baseRpCount + (rpAdded ? 1 : 0)}
      AND (SELECT count(*) FROM auth103_native_rp_registration_receipts)=${baseRpCount + (rpAdded ? 1 : 0)}
      AND (SELECT count(*) FROM auth103_native_deployments)=${baseDeploymentCount + 1}
      AND (SELECT count(*) FROM auth103_native_deployment_receipts)=${baseDeploymentCount + 1}`),
    guard(ledgerPredicate(input.migrationNames)),
    ...boundedOriginalShapePredicates(input.postShape).map(guard),
  ];
  if (statements.some((statement) => Buffer.byteLength(statement) >= 100_000))
    throw preflightError("Auth103 current registration statement exceeds D1 SQL limit");
  const sql = `${statements.join("\n")}\n`;
  const framed = frameHostMigrationSql(sql);
  if (
    framed.length !== statements.length ||
    framed.some((statement) => Buffer.byteLength(statement) >= 100_000)
  )
    throw preflightError("Auth103 current registration statement framing differs");
  return Object.freeze({
    sql,
    guardCount: preconditions.length,
    postGuardCount: statements.length - preconditions.length - (rpAdded ? 8 : 4),
    rpAdded,
  });
}

/** A partial third attempt consumes its fixed custody; neither shape permits replay. */
export function assertAuth103CurrentRuntimeThirdCustodyEntries(
  path: string,
): "dispatched" | "installed" {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw preflightError("third runtime custody directory differs");
  const entries = readdirSync(path).sort();
  if (entries.length === 1 && entries[0] === "dispatch.json") return "dispatched";
  if (entries.length === 2 && entries[0] === "dispatch.json" && entries[1] === "installed.json")
    return "installed";
  throw preflightError("third runtime custody inventory differs");
}

function writeSealedJson(path: string, value: Record<string, unknown>): void {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const directory = openSync(
    join(path, ".."),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let file = -1;
  try {
    file = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(file, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(file, bytes, offset, bytes.length - offset);
      if (count < 1) throw mutationError("Auth103 current registration custody write was short");
      offset += count;
    }
    fsyncSync(file);
    fsyncSync(directory);
  } finally {
    if (file >= 0) closeSync(file);
    closeSync(directory);
  }
}

/** Every result of the one /query transaction is checked; a missing response
 * is UNKNOWN even if the provider may have committed. */
export function assertAuth103CurrentRuntimePairAck(
  raw: string,
  guardCount: number,
  current: NativePair,
  postGuardCount: number,
  historical: NativePair,
): void {
  const rpAdded = currentRpSuccessor(current, historical);
  const deploymentOffset = guardCount + (rpAdded ? 4 : 0);
  let response: unknown;
  try {
    response = JSON.parse(raw);
  } catch {
    throw verificationError(
      "Auth103 current registration returned no complete query acknowledgement",
    );
  }
  if (
    !Array.isArray(response) ||
    response.length !== guardCount + (rpAdded ? 8 : 4) + postGuardCount
  )
    throw verificationError("Auth103 current registration query acknowledgement count differs");
  for (let index = 0; index < response.length; index++) {
    const entry = response[index];
    if (
      !isRecord(entry) ||
      entry.success !== true ||
      !Array.isArray(entry.results) ||
      entry.results.length !== 1 ||
      !isRecord(entry.results[0])
    )
      throw verificationError("Auth103 current registration query acknowledgement shape differs");
    const row = entry.results[0];
    if (rpAdded && index === guardCount) {
      if (
        !exactKeys(row, ["registration_ref", "registration_digest", "record_json"]) ||
        row.registration_ref !== current.record.rp.registrationRef ||
        row.registration_digest !== current.record.rp.registrationDigest ||
        row.record_json !== current.record.rpJson
      )
        throw verificationError("Auth103 current runtime RP registration acknowledgement mismatch");
    } else if (rpAdded && index === guardCount + 2) {
      if (
        !exactKeys(row, ["receipt_ref", "registration_ref", "record_json"]) ||
        row.receipt_ref !== current.record.rp.receiptRef ||
        row.registration_ref !== current.record.rp.registrationRef ||
        row.record_json !== current.record.rpJson
      )
        throw verificationError("Auth103 current runtime RP receipt acknowledgement mismatch");
    } else if (index === deploymentOffset) {
      if (
        !exactKeys(row, [
          "deployment_ref",
          "target_ref",
          "source_ref",
          "artifact_digest",
          "record_json",
        ]) ||
        row.deployment_ref !== current.record.deploymentRef ||
        row.target_ref !== current.manifest.targetRef ||
        row.source_ref !== current.manifest.sourceRef ||
        row.artifact_digest !== current.bundleDigest ||
        row.record_json !== current.record.deploymentJson
      )
        throw verificationError("Auth103 current deployment acknowledgement differs");
    } else if (index === deploymentOffset + 2) {
      if (
        !exactKeys(row, ["receipt_ref", "deployment_ref", "record_json"]) ||
        row.receipt_ref !== current.record.deploymentReceiptRef ||
        row.deployment_ref !== current.record.deploymentRef ||
        row.record_json !== current.record.deploymentJson
      )
        throw verificationError("Auth103 current receipt acknowledgement differs");
    } else if (
      index === deploymentOffset + 1 ||
      index === deploymentOffset + 3 ||
      (rpAdded && (index === guardCount + 1 || index === guardCount + 3))
    ) {
      if (!exactKeys(row, ["changed_rows"]) || row.changed_rows !== 1)
        throw verificationError("Auth103 current registration write-count acknowledgement differs");
    } else if (!exactKeys(row, ["current"]) || row.current !== 1) {
      throw verificationError("Auth103 current registration guard acknowledgement differs");
    }
  }
}

/** Internal status-only comparison; saved custody still requires the caller's sealed read. */
export function exactAuth103CurrentRuntimeInstalledCustody(
  marker: Readonly<Record<string, unknown>>,
  savedMarker: Readonly<{ value: Record<string, unknown>; digest: string }>,
  savedInstalled: Readonly<{ digest: string }>,
): boolean {
  const installedToolCommit = savedMarker.value.toolCommit;
  if (typeof installedToolCommit !== "string" || !COMMIT.test(installedToolCommit)) return false;
  const installedMarker = { ...marker, toolCommit: installedToolCommit };
  const markerDigest = digest(`${JSON.stringify(installedMarker, null, 2)}\n`);
  const installedRecord = {
    ...installedMarker,
    kind: "takoserver.auth103-current-runtime-registration-installed@v1",
    markerDigest,
  };
  return (
    savedMarker.digest === markerDigest &&
    savedInstalled.digest === digest(`${JSON.stringify(installedRecord, null, 2)}\n`)
  );
}

/** Sealed private custody read: one 0600 file, one link, canonical JSON, re-checkable bytes. */
export function readSealedAuth103CustodyJson(path: string, pretty: boolean) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
    throw preflightError("Auth103 historical custody is not sealed");
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > 8192)
    throw preflightError("Auth103 historical custody size differs");
  const after = lstatSync(path);
  if (
    stat.dev !== after.dev ||
    stat.ino !== after.ino ||
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs ||
    stat.ctimeMs !== after.ctimeMs ||
    bytes.length !== stat.size
  )
    throw preflightError("Auth103 historical custody changed during read");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw preflightError("Auth103 historical custody JSON is invalid");
  }
  if (
    !isRecord(parsed) ||
    bytes.toString("utf8") !== `${JSON.stringify(parsed, null, pretty ? 2 : undefined)}\n`
  )
    throw preflightError("Auth103 historical custody encoding differs");
  return {
    value: parsed,
    digest: digest(bytes),
    assertUnchanged: () => {
      const now = lstatSync(path);
      if (
        !now.isFile() ||
        now.isSymbolicLink() ||
        now.nlink !== 1 ||
        now.dev !== stat.dev ||
        now.ino !== stat.ino ||
        now.mode !== stat.mode ||
        now.size !== stat.size ||
        now.mtimeMs !== stat.mtimeMs ||
        now.ctimeMs !== stat.ctimeMs ||
        !readFileSync(path).equals(bytes)
      )
        throw preflightError("Auth103 historical custody changed");
    },
  };
}

/** One bound sealed-pair predicate: deployment original+receipt and RP original+receipt. */
export function auth103NativePairPredicate(pair: NativePair): string {
  return boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
    pair.record.deploymentRef,
    pair.record.deploymentJson,
    pair.record.rp.registrationRef,
    pair.record.rp.registrationDigest,
    pair.record.rpJson,
  ]);
}

const D1_MAX_STATEMENT_BYTES = 100_000;

/** The postimage reads every sealed pair and the inventory separately: seven bound
 * pairs in one SELECT exceed D1's per-statement limit. Every read must return 1. */
export function compileAuth103CurrentRuntimePostimageStatements(
  pairPredicates: readonly string[],
  counts: { readonly rp: number; readonly deployments: number },
): readonly string[] {
  if (
    pairPredicates.length < 2 ||
    pairPredicates.some((predicate) => predicate.length === 0) ||
    !Number.isSafeInteger(counts.rp) ||
    counts.rp < 1 ||
    !Number.isSafeInteger(counts.deployments) ||
    counts.deployments < 2
  )
    throw preflightError("Auth103 current runtime postimage input differs");
  const statements = [
    ...pairPredicates.map(
      (predicate) => `SELECT CASE WHEN (${predicate}) THEN 1 ELSE 0 END AS current`,
    ),
    `SELECT CASE WHEN ((SELECT count(*) FROM auth103_native_rp_registrations)=${counts.rp}
      AND (SELECT count(*) FROM auth103_native_rp_registration_receipts)=${counts.rp}
      AND (SELECT count(*) FROM auth103_native_deployments)=${counts.deployments}
      AND (SELECT count(*) FROM auth103_native_deployment_receipts)=${counts.deployments}) THEN 1 ELSE 0 END AS current`,
  ];
  if (
    statements.some((statement) => Buffer.byteLength(statement, "utf8") >= D1_MAX_STATEMENT_BYTES)
  )
    throw preflightError("Auth103 current runtime postimage read exceeds the D1 statement limit");
  return Object.freeze(statements);
}

/** Each split postimage read returns exactly one `current` row equal to 1. */
export function assertAuth103CurrentRuntimePostimageRows(
  results: readonly (readonly Record<string, unknown>[])[],
  expected: number,
  phase: "preflight" | "verification" = "verification",
): void {
  const fail = phase === "preflight" ? preflightError : verificationError;
  if (expected < 3 || results.length !== expected)
    throw fail("Auth103 current runtime postimage read count differs");
  for (const rows of results) {
    const row = rows[0];
    if (rows.length !== 1 || !isRecord(row) || !exactKeys(row, ["current"]) || row.current !== 1)
      throw fail("Auth103 current runtime old and new pair postimage mismatch");
  }
}

export function auth103CurrentRuntimeRegistrationState(input: {
  readonly pairPresent: boolean;
  readonly pairAbsent: boolean;
  readonly bridgeExists: boolean;
  readonly custodyPairExact: boolean;
}): "installed" | "ready" | "unresolved-no-retry" {
  return input.pairPresent && input.custodyPairExact
    ? "installed"
    : input.pairAbsent && !input.bridgeExists
      ? "ready"
      : "unresolved-no-retry";
}

/** Apply dispatches only into an absent pair and an unreserved custody slot. */
export function assertAuth103CurrentRuntimeApplyAllowed(input: {
  readonly pairAbsent: boolean;
  readonly bridgeExists: boolean;
}): void {
  if (!input.pairAbsent || input.bridgeExists)
    throw preflightError("Auth103 current registration is already present or reserved; no retry");
}

const CURRENT_RUNTIME_DISPATCH_KIND = "takoserver.auth103-current-runtime-registration-dispatch@v1";
const CURRENT_RUNTIME_INSTALLED_KIND =
  "takoserver.auth103-current-runtime-registration-installed@v1";

/** Forward repair for one ACKed append whose post-verification could not complete:
 * a dispatch-only slot whose sealed marker equals the recomputed marker (apart from
 * the tool that dispatched it) gains its installed record once. It never touches D1;
 * the caller proves the present pair, inventory, live Version and schema by reads. */
export async function finalizeAuth103CurrentRuntimeDispatchedCustody(input: {
  readonly bridge: string;
  readonly marker: Readonly<Record<string, unknown>>;
  readonly state: {
    readonly pairPresent: boolean;
    readonly pairAbsent: boolean;
    readonly currentRpPresent: boolean;
    readonly inventoryExact: boolean;
  };
  readonly verifyRemote: () => Promise<void>;
  readonly assertUnchanged: () => Promise<void>;
}): Promise<{
  readonly markerDigest: string;
  readonly installedDigest: string;
  readonly dispatchToolCommit: string;
}> {
  const { bridge, marker, state } = input;
  if (!state.pairPresent || state.pairAbsent || !state.currentRpPresent || !state.inventoryExact)
    throw preflightError(
      "Auth103 current runtime finalize requires the exact present pair and inventory",
    );
  if (marker.kind !== CURRENT_RUNTIME_DISPATCH_KIND)
    throw preflightError("Auth103 current runtime finalize marker kind differs");
  if (!pathExistsNoFollow(bridge))
    throw preflightError("Auth103 current runtime finalize requires a dispatched custody slot");
  if (assertAuth103CurrentRuntimeThirdCustodyEntries(bridge) !== "dispatched")
    throw preflightError("Auth103 current runtime finalize requires a dispatch-only custody slot");
  const markerPath = join(bridge, "dispatch.json");
  const installedPath = join(bridge, "installed.json");
  const saved = readSealedAuth103CustodyJson(markerPath, true);
  const dispatchToolCommit = saved.value.toolCommit;
  if (typeof dispatchToolCommit !== "string" || !COMMIT.test(dispatchToolCommit))
    throw preflightError("Auth103 current runtime dispatched tool origin is invalid");
  const installedMarker = { ...marker, toolCommit: dispatchToolCommit };
  if (digest(`${JSON.stringify(installedMarker, null, 2)}\n`) !== saved.digest)
    throw preflightError("Auth103 current runtime dispatched marker differs from this runtime");
  const installedRecord = {
    ...installedMarker,
    kind: CURRENT_RUNTIME_INSTALLED_KIND,
    markerDigest: saved.digest,
  };
  const assertDispatchOnly = () => {
    saved.assertUnchanged();
    if (assertAuth103CurrentRuntimeThirdCustodyEntries(bridge) !== "dispatched")
      throw preflightError("Auth103 current runtime finalize custody changed");
  };
  await input.verifyRemote();
  assertDispatchOnly();
  await input.assertUnchanged();
  assertDispatchOnly();
  writeSealedJson(installedPath, installedRecord);
  if (assertAuth103CurrentRuntimeThirdCustodyEntries(bridge) !== "installed")
    throw verificationError("Auth103 current runtime finalize custody is incomplete");
  const savedAgain = readSealedAuth103CustodyJson(markerPath, true);
  const installed = readSealedAuth103CustodyJson(installedPath, true);
  if (
    savedAgain.digest !== saved.digest ||
    !exactAuth103CurrentRuntimeInstalledCustody(marker, savedAgain, installed)
  )
    throw verificationError("Auth103 current runtime finalized custody differs");
  return Object.freeze({
    markerDigest: saved.digest,
    installedDigest: installed.digest,
    dispatchToolCommit,
  });
}

/** The sealed runtime every "is the RP new?" decision, the latest RP read and the
 * ACK compare against: the newest sealed predecessor, else the historical original. */
export function auth103CurrentRuntimeRpReference(
  predecessors: readonly NativePair[],
  historical: NativePair,
): NativePair {
  return predecessors.at(-1) ?? historical;
}

/** Chooses the custody slot for the live Version once v5 or later sealed runtimes exist.
 * A live Version equal to the newest sealed runtime stays on that slot; any other live
 * Version must not collide with sealed history and takes the next slot. Slots are 1-based. */
export function selectAuth103CurrentRuntimeSuccessorSlot(input: {
  readonly live: {
    readonly versionId: string;
    readonly deploymentId: string;
    readonly commit: string;
  };
  readonly pair: NativePair;
  readonly sealed: readonly {
    readonly versionId: string;
    readonly deploymentId: string;
    readonly deployedCommit: string;
    readonly pair: NativePair;
  }[];
}): { readonly slot: number; readonly predecessors: readonly NativePair[] } {
  const { live, pair, sealed } = input;
  const newest = sealed.at(-1);
  if (newest === undefined || sealed.length > 7)
    throw preflightError("Auth103 current runtime sealed history length is unsupported");
  const collides = (entry: (typeof sealed)[number]) =>
    entry.versionId === live.versionId ||
    entry.deployedCommit === live.commit ||
    entry.pair.record.deploymentRef === pair.record.deploymentRef;
  if (
    newest.versionId === live.versionId &&
    newest.deploymentId === live.deploymentId &&
    newest.deployedCommit === live.commit &&
    newest.pair.record.deploymentRef === pair.record.deploymentRef
  ) {
    const earlier = sealed.slice(0, -1);
    if (earlier.some(collides))
      throw preflightError("auth103 current runtime identity collides with sealed history");
    const latest = earlier.at(-1);
    if (latest) currentRpSuccessor(pair, latest.pair);
    return Object.freeze({
      slot: sealed.length,
      predecessors: Object.freeze(earlier.map((entry) => entry.pair)),
    });
  }
  if (sealed.some(collides))
    throw preflightError("auth103 current runtime successor identity collides with sealed history");
  currentRpSuccessor(pair, newest.pair);
  return Object.freeze({
    slot: sealed.length + 1,
    predecessors: Object.freeze(sealed.map((entry) => entry.pair)),
  });
}

/** Wrangler's /query transport accepts one SQL string, but its --command argv
 * cannot carry the exact 0105 schema guards (over Linux's per-argument limit).
 * This private call uses the same D1 /query endpoint once with that full SQL.
 * Any transport, HTTP, envelope, or ACK ambiguity is UNKNOWN and never retried. */
async function sendAuth103CurrentAtomicQuery(input: {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
  readonly sql: string;
}): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}` +
        `/d1/database/${encodeURIComponent(input.databaseId)}/query`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql: input.sql }),
        signal: AbortSignal.timeout(120_000),
      },
    );
  } catch {
    throw mutationError("Auth103 current registration query transport is unknown; no retry");
  }
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw mutationError("Auth103 current registration query response is missing; no retry");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1024 * 1024)
        throw mutationError("Auth103 current registration query response is oversized; no retry");
      chunks.push(next.value);
    }
  } catch {
    throw mutationError("Auth103 current registration query response is incomplete; no retry");
  } finally {
    reader.releaseLock();
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw mutationError("Auth103 current registration query response is malformed; no retry");
  }
  if (
    !response.ok ||
    !isRecord(envelope) ||
    envelope.success !== true ||
    !Array.isArray(envelope.result)
  )
    throw mutationError("Auth103 current registration query acknowledgement is unknown; no retry");
  return JSON.stringify(envelope.result);
}

/** The current-runtime bridge is a distinct, single-use D1 operation. */
export async function runD1SchemaAuth103CurrentRuntimeRegistration(
  invocation: {
    readonly action: "status" | "apply" | "finalize";
    readonly environment: "integration";
    readonly commit: string;
  },
  target: DeployTarget,
  productionD1: { readonly databaseId: string; readonly databaseName: string },
): Promise<Record<string, unknown>> {
  if (
    target.environment !== "integration" ||
    target.auth103NativeProfile !== AUTH103_NATIVE_PROFILE ||
    target.schemaMaintenanceMode !== undefined ||
    target.moneyCutoverWriterPolicy !== undefined ||
    target.d1.databaseId === productionD1.databaseId ||
    target.d1.databaseName === productionD1.databaseName
  )
    throw preflightError(
      "Auth103 current registration requires the exact ordinary Root integration target",
    );
  const source = await qualifySource({ environment: "integration", commit: invocation.commit });
  if (source.dirty)
    throw preflightError("Auth103 current registration requires a clean tool source");
  const custody = readAuth103OriginalCustodyDirectory();
  const firstBridge = join(custody.path, "auth103-current-runtime-registration-v1");
  const successorBridge = join(custody.path, "auth103-current-runtime-registration-v2");
  const nextBridge = join(custody.path, "auth103-current-runtime-registration-v3");
  const fourthBridge = join(custody.path, "auth103-current-runtime-registration-v4");
  const fifthBridge = join(custody.path, "auth103-current-runtime-registration-v5");
  const sixthBridge = join(custody.path, "auth103-current-runtime-registration-v6");
  const seventhBridge = join(custody.path, "auth103-current-runtime-registration-v7");
  const eighthBridge = join(custody.path, "auth103-current-runtime-registration-v8");
  let bridge = firstBridge;
  if (invocation.action === "apply" || invocation.action === "finalize") {
    const reviewer = requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW");
    if (reviewer.trim() !== reviewer || reviewer.length > 256 || reviewer.includes("\n"))
      throw preflightError("Auth103 current runtime registration requires independent review");
  }
  const priorPath = join(custody.path, "auth103-forward-v2", "auth103-installed.json");
  const dispatchPath = join(custody.path, "auth103-forward-v2", "auth103-dispatched.json");
  if (pathExistsNoFollow(join(custody.path, "auth103-installed.json")))
    throw preflightError(
      "Auth103 current registration cannot replace original installation history",
    );
  const readPrivate = readSealedAuth103CustodyJson;
  const prior = readPrivate(priorPath, true);
  const dispatched = readPrivate(dispatchPath, false);
  const originalMarker = readPrivate(join(custody.path, "auth103-dispatched.json"), false);
  const firstForwardMarker = readPrivate(
    join(custody.path, "auth103-forward-v1", "auth103-dispatched.json"),
    false,
  );
  const firstForwardDisposition = readPrivate(
    join(custody.path, "auth103-forward-v1", "auth103-state-equivalent-disposition.json"),
    true,
  );
  if (
    prior.value.kind !== "takoserver.auth103-forward-v2-source-apply@v1" ||
    prior.value.appliedCount !== 103 ||
    prior.value.nativeRequestQualified !== false ||
    dispatched.value.kind !== "takoserver.auth103-forward-v2-dispatched@v1" ||
    prior.value.commit !== dispatched.value.commit ||
    prior.value.sourceRef !== dispatched.value.sourceRef ||
    prior.value.targetRef !== dispatched.value.targetRef ||
    prior.value.importDigest !== dispatched.value.importDigest ||
    prior.value.importBytes !== dispatched.value.importBytes ||
    prior.value.secondForwardMarkerDigest !== dispatched.digest ||
    prior.value.originalMarkerDigest !== originalMarker.digest ||
    prior.value.firstForwardMarkerDigest !== firstForwardMarker.digest ||
    prior.value.firstForwardDispositionDigest !== firstForwardDisposition.digest ||
    typeof dispatched.value.versionId !== "string" ||
    typeof dispatched.value.bundleDigest !== "string" ||
    !SHA.test(dispatched.value.bundleDigest) ||
    typeof dispatched.value.deploymentId !== "string"
  )
    throw preflightError("Auth103 historical physical receipt is inconsistent");
  const expectedTargetRef = auth103NativeTargetRef(target);
  if (prior.value.targetRef !== expectedTargetRef)
    throw preflightError("Auth103 historical receipt belongs to a different State DB");
  const targetJson = canonicalJson(target);
  const assertTarget = () => {
    if (canonicalJson(loadTarget(targetPath("integration"), "integration")) !== targetJson)
      throw preflightError("Auth103 current registration target changed");
  };
  assertTarget();
  const firstBridgeExists = pathExistsNoFollow(firstBridge);
  const successorBridgeExists = pathExistsNoFollow(successorBridge);
  const nextBridgeExists = pathExistsNoFollow(nextBridge);
  const fourthBridgeExists = pathExistsNoFollow(fourthBridge);
  const fifthBridgeExists = pathExistsNoFollow(fifthBridge);
  const sixthBridgeExists = pathExistsNoFollow(sixthBridge);
  const seventhBridgeExists = pathExistsNoFollow(seventhBridge);
  const eighthBridgeExists = pathExistsNoFollow(eighthBridge);
  if (successorBridgeExists && !firstBridgeExists)
    throw preflightError("Auth103 current runtime successor custody has no installed predecessor");
  if (nextBridgeExists && !successorBridgeExists)
    throw preflightError("Auth103 next runtime custody has no sealed second predecessor");
  if (nextBridgeExists) assertAuth103CurrentRuntimeThirdCustodyEntries(nextBridge);
  if (fourthBridgeExists) {
    if (!nextBridgeExists)
      throw preflightError("Auth103 fourth runtime predecessor custody is absent");
    assertAuth103CurrentRuntimeThirdCustodyEntries(fourthBridge);
  }
  if (fifthBridgeExists) {
    if (!fourthBridgeExists)
      throw preflightError("auth103 current runtime predecessor custody is missing");
    assertAuth103CurrentRuntimeThirdCustodyEntries(fifthBridge);
  }
  if (sixthBridgeExists) {
    if (!fifthBridgeExists)
      throw preflightError("auth103 sixth runtime predecessor custody is missing");
    assertAuth103CurrentRuntimeThirdCustodyEntries(sixthBridge);
  }
  if (seventhBridgeExists) {
    if (!sixthBridgeExists)
      throw preflightError("auth103 seventh runtime predecessor custody is missing");
    assertAuth103CurrentRuntimeThirdCustodyEntries(seventhBridge);
  }
  if (eighthBridgeExists) {
    if (!seventhBridgeExists)
      throw preflightError("auth103 eighth runtime predecessor custody is missing");
    assertAuth103CurrentRuntimeThirdCustodyEntries(eighthBridge);
  }
  if (firstBridgeExists) {
    const stat = lstatSync(firstBridge);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
      throw preflightError("Auth103 current runtime predecessor custody is foreign");
    if (
      !pathExistsNoFollow(join(firstBridge, "dispatch.json")) ||
      !pathExistsNoFollow(join(firstBridge, "installed.json"))
    )
      throw preflightError("Auth103 current runtime predecessor custody is incomplete");
  }
  const assertFirstBridgeEntries = () => {
    const stat = lstatSync(firstBridge);
    const entries = readdirSync(firstBridge).sort();
    if (
      !stat.isDirectory() ||
      entries.length !== 2 ||
      entries[0] !== "dispatch.json" ||
      entries[1] !== "installed.json"
    ) {
      throw new Error("auth103 current runtime registration predecessor custody mismatch");
    }
  };
  if (firstBridgeExists) assertFirstBridgeEntries();
  const firstDispatch = firstBridgeExists
    ? readPrivate(join(firstBridge, "dispatch.json"), true)
    : undefined;
  const firstInstalled = firstBridgeExists
    ? readPrivate(join(firstBridge, "installed.json"), true)
    : undefined;
  const assertSuccessorBridgeEntries = () => {
    const stat = lstatSync(successorBridge);
    const entries = readdirSync(successorBridge).sort();
    if (
      !stat.isDirectory() ||
      entries.length !== 2 ||
      entries[0] !== "dispatch.json" ||
      entries[1] !== "installed.json"
    ) {
      throw new Error("auth103 current runtime registration predecessor custody mismatch");
    }
  };
  if (successorBridgeExists) assertSuccessorBridgeEntries();
  const secondDispatch = successorBridgeExists
    ? readPrivate(join(successorBridge, "dispatch.json"), true)
    : undefined;
  const secondInstalled = successorBridgeExists
    ? readPrivate(join(successorBridge, "installed.json"), true)
    : undefined;
  const thirdDispatch =
    nextBridgeExists && pathExistsNoFollow(join(nextBridge, "dispatch.json"))
      ? readPrivate(join(nextBridge, "dispatch.json"), true)
      : undefined;
  const thirdInstalled =
    nextBridgeExists && pathExistsNoFollow(join(nextBridge, "installed.json"))
      ? readPrivate(join(nextBridge, "installed.json"), true)
      : undefined;
  if (fourthBridgeExists && (!thirdDispatch || !thirdInstalled))
    throw preflightError("Auth103 fourth runtime predecessor is not installed");
  const fourthDispatch =
    fourthBridgeExists && pathExistsNoFollow(join(fourthBridge, "dispatch.json"))
      ? readPrivate(join(fourthBridge, "dispatch.json"), true)
      : undefined;
  const fourthInstalled =
    fourthBridgeExists && pathExistsNoFollow(join(fourthBridge, "installed.json"))
      ? readPrivate(join(fourthBridge, "installed.json"), true)
      : undefined;
  if ((fourthDispatch && !fourthInstalled) || (!fourthDispatch && fourthInstalled))
    throw preflightError("auth103 current runtime predecessor custody is incomplete");
  if (fifthBridgeExists && (!fourthDispatch || !fourthInstalled))
    throw preflightError("auth103 current runtime predecessor custody is incomplete");
  const fifthDispatch =
    fifthBridgeExists && pathExistsNoFollow(join(fifthBridge, "dispatch.json"))
      ? readPrivate(join(fifthBridge, "dispatch.json"), true)
      : undefined;
  const fifthInstalled =
    fifthBridgeExists && pathExistsNoFollow(join(fifthBridge, "installed.json"))
      ? readPrivate(join(fifthBridge, "installed.json"), true)
      : undefined;
  if ((fifthDispatch && !fifthInstalled) || (!fifthDispatch && fifthInstalled))
    throw preflightError("auth103 sixth runtime predecessor custody is incomplete");
  if (sixthBridgeExists && (!fifthDispatch || !fifthInstalled))
    throw preflightError("auth103 sixth runtime predecessor custody is incomplete");
  const sixthDispatch =
    sixthBridgeExists && pathExistsNoFollow(join(sixthBridge, "dispatch.json"))
      ? readPrivate(join(sixthBridge, "dispatch.json"), true)
      : undefined;
  const sixthInstalled =
    sixthBridgeExists && pathExistsNoFollow(join(sixthBridge, "installed.json"))
      ? readPrivate(join(sixthBridge, "installed.json"), true)
      : undefined;
  // A dispatch-only v6 stays resolvable (status/finalize on the v6 slot) but is never a
  // sealed predecessor: a v7 slot requires the complete v6 pair.
  if (sixthInstalled && !sixthDispatch)
    throw preflightError("auth103 sixth runtime custody has installed without dispatch");
  if (seventhBridgeExists && (!sixthDispatch || !sixthInstalled))
    throw preflightError("auth103 seventh runtime predecessor custody is incomplete");
  const seventhDispatch =
    seventhBridgeExists && pathExistsNoFollow(join(seventhBridge, "dispatch.json"))
      ? readPrivate(join(seventhBridge, "dispatch.json"), true)
      : undefined;
  const seventhInstalled =
    seventhBridgeExists && pathExistsNoFollow(join(seventhBridge, "installed.json"))
      ? readPrivate(join(seventhBridge, "installed.json"), true)
      : undefined;
  // A dispatch-only v7 stays resolvable on its own slot but is never a sealed
  // predecessor: a v8 slot requires the complete v7 pair.
  if (seventhInstalled && !seventhDispatch)
    throw preflightError("auth103 seventh runtime custody has installed without dispatch");
  if (eighthBridgeExists && (!seventhDispatch || !seventhInstalled))
    throw preflightError("auth103 eighth runtime predecessor custody is incomplete");
  if (firstDispatch && firstInstalled) {
    const expectedKeys = [
      "artifactDigest",
      "deployedCommit",
      "deploymentId",
      "deploymentRef",
      "environment",
      "historicalReceiptDigest",
      "kind",
      "publicationStatusDigest",
      "receiptRef",
      "sourceRef",
      "sqlDigest",
      "targetDigest",
      "targetRef",
      "toolCommit",
      "versionId",
    ];
    if (
      JSON.stringify(Object.keys(firstDispatch.value).sort()) !==
        JSON.stringify(expectedKeys.sort()) ||
      firstDispatch.value.kind !== "takoserver.auth103-current-runtime-registration-dispatch@v1" ||
      firstDispatch.value.environment !== "integration" ||
      firstDispatch.value.historicalReceiptDigest !== prior.digest ||
      firstDispatch.value.targetRef !== expectedTargetRef ||
      firstDispatch.value.targetDigest !== digest(targetJson) ||
      firstInstalled.value.kind !==
        "takoserver.auth103-current-runtime-registration-installed@v1" ||
      firstInstalled.value.markerDigest !== firstDispatch.digest ||
      Object.keys(firstInstalled.value).length !== expectedKeys.length + 1 ||
      expectedKeys.some(
        (key) => key !== "kind" && firstInstalled.value[key] !== firstDispatch.value[key],
      )
    )
      throw preflightError("Auth103 current runtime predecessor custody is not sealed");
  }
  if (secondDispatch && secondInstalled) {
    if (!firstDispatch || !firstInstalled) {
      throw preflightError("Auth103 second runtime custody lacks its first sealed predecessor");
    }
    const expectedKeys = [
      ...Object.keys(firstDispatch.value),
      "predecessorDeploymentRef",
      "predecessorInstalledDigest",
      "predecessorMarkerDigest",
    ].sort();
    if (
      JSON.stringify(Object.keys(secondDispatch.value).sort()) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(Object.keys(secondInstalled.value).sort()) !==
        JSON.stringify([...expectedKeys, "markerDigest"].sort()) ||
      secondDispatch.value.kind !== firstDispatch.value.kind ||
      secondInstalled.value.kind !== firstInstalled.value.kind ||
      secondDispatch.value.environment !== "integration" ||
      secondDispatch.value.historicalReceiptDigest !== prior.digest ||
      secondDispatch.value.targetRef !== expectedTargetRef ||
      secondDispatch.value.targetDigest !== digest(targetJson) ||
      secondDispatch.value.predecessorMarkerDigest !== firstDispatch.digest ||
      secondDispatch.value.predecessorInstalledDigest !== firstInstalled.digest ||
      secondDispatch.value.predecessorDeploymentRef !== firstDispatch.value.deploymentRef ||
      secondInstalled.value.markerDigest !== secondDispatch.digest ||
      expectedKeys.some(
        (key) => key !== "kind" && secondInstalled.value[key] !== secondDispatch.value[key],
      )
    ) {
      throw preflightError("Auth103 second runtime custody is not the sealed first successor");
    }
  }

  if (thirdDispatch || thirdInstalled) {
    if (!thirdDispatch || !thirdInstalled || !secondDispatch || !secondInstalled)
      throw preflightError("Auth103 third runtime custody pair is incomplete");
    const expectedKeys = Object.keys(secondDispatch.value).sort();
    if (
      JSON.stringify(Object.keys(thirdDispatch.value).sort()) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(Object.keys(thirdInstalled.value).sort()) !==
        JSON.stringify([...expectedKeys, "markerDigest"].sort()) ||
      thirdDispatch.value.kind !== secondDispatch.value.kind ||
      thirdInstalled.value.kind !== secondInstalled.value.kind ||
      thirdDispatch.value.environment !== "integration" ||
      thirdDispatch.value.historicalReceiptDigest !== prior.digest ||
      thirdDispatch.value.targetRef !== expectedTargetRef ||
      thirdDispatch.value.targetDigest !== digest(targetJson) ||
      thirdDispatch.value.predecessorMarkerDigest !== secondDispatch.digest ||
      thirdDispatch.value.predecessorInstalledDigest !== secondInstalled.digest ||
      thirdDispatch.value.predecessorDeploymentRef !== secondDispatch.value.deploymentRef ||
      thirdInstalled.value.markerDigest !== thirdDispatch.digest ||
      expectedKeys.some(
        (key) => key !== "kind" && thirdInstalled.value[key] !== thirdDispatch.value[key],
      )
    )
      throw preflightError("Auth103 third runtime custody differs");
  }
  if (fourthDispatch || fourthInstalled) {
    if (!fourthDispatch || !fourthInstalled || !thirdDispatch || !thirdInstalled)
      throw preflightError("Auth103 third runtime custody pair is incomplete");
    const expectedKeys = Object.keys(thirdDispatch.value).sort();
    if (
      JSON.stringify(Object.keys(fourthDispatch.value).sort()) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(Object.keys(fourthInstalled.value).sort()) !==
        JSON.stringify([...expectedKeys, "markerDigest"].sort()) ||
      fourthDispatch.value.kind !== thirdDispatch.value.kind ||
      fourthInstalled.value.kind !== thirdInstalled.value.kind ||
      fourthDispatch.value.environment !== "integration" ||
      fourthDispatch.value.historicalReceiptDigest !== prior.digest ||
      fourthDispatch.value.targetRef !== expectedTargetRef ||
      fourthDispatch.value.targetDigest !== digest(targetJson) ||
      fourthDispatch.value.predecessorMarkerDigest !== thirdDispatch.digest ||
      fourthDispatch.value.predecessorInstalledDigest !== thirdInstalled.digest ||
      fourthDispatch.value.predecessorDeploymentRef !== thirdDispatch.value.deploymentRef ||
      fourthInstalled.value.markerDigest !== fourthDispatch.digest ||
      expectedKeys.some(
        (key) => key !== "kind" && fourthInstalled.value[key] !== fourthDispatch.value[key],
      )
    )
      throw preflightError("Auth103 third runtime custody differs");
  }
  if (fifthDispatch || fifthInstalled) {
    if (!fifthDispatch || !fifthInstalled || !fourthDispatch || !fourthInstalled)
      throw preflightError("Auth103 fifth runtime custody pair is incomplete");
    const expectedKeys = Object.keys(fourthDispatch.value).sort();
    if (
      JSON.stringify(Object.keys(fifthDispatch.value).sort()) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(Object.keys(fifthInstalled.value).sort()) !==
        JSON.stringify([...expectedKeys, "markerDigest"].sort()) ||
      fifthDispatch.value.kind !== fourthDispatch.value.kind ||
      fifthInstalled.value.kind !== fourthInstalled.value.kind ||
      fifthDispatch.value.environment !== "integration" ||
      fifthDispatch.value.historicalReceiptDigest !== prior.digest ||
      fifthDispatch.value.targetRef !== expectedTargetRef ||
      fifthDispatch.value.targetDigest !== digest(targetJson) ||
      fifthDispatch.value.predecessorMarkerDigest !== fourthDispatch.digest ||
      fifthDispatch.value.predecessorInstalledDigest !== fourthInstalled.digest ||
      fifthDispatch.value.predecessorDeploymentRef !== fourthDispatch.value.deploymentRef ||
      fifthInstalled.value.markerDigest !== fifthDispatch.digest ||
      expectedKeys.some(
        (key) => key !== "kind" && fifthInstalled.value[key] !== fifthDispatch.value[key],
      )
    )
      throw preflightError("Auth103 fifth runtime custody differs");
  }
  if (sixthDispatch && sixthInstalled) {
    if (!fifthDispatch || !fifthInstalled)
      throw preflightError("Auth103 sixth runtime custody pair is incomplete");
    const expectedKeys = Object.keys(fifthDispatch.value).sort();
    if (
      JSON.stringify(Object.keys(sixthDispatch.value).sort()) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(Object.keys(sixthInstalled.value).sort()) !==
        JSON.stringify([...expectedKeys, "markerDigest"].sort()) ||
      sixthDispatch.value.kind !== fifthDispatch.value.kind ||
      sixthInstalled.value.kind !== fifthInstalled.value.kind ||
      sixthDispatch.value.environment !== "integration" ||
      sixthDispatch.value.historicalReceiptDigest !== prior.digest ||
      sixthDispatch.value.targetRef !== expectedTargetRef ||
      sixthDispatch.value.targetDigest !== digest(targetJson) ||
      sixthDispatch.value.predecessorMarkerDigest !== fifthDispatch.digest ||
      sixthDispatch.value.predecessorInstalledDigest !== fifthInstalled.digest ||
      sixthDispatch.value.predecessorDeploymentRef !== fifthDispatch.value.deploymentRef ||
      sixthInstalled.value.markerDigest !== sixthDispatch.digest ||
      expectedKeys.some(
        (key) => key !== "kind" && sixthInstalled.value[key] !== sixthDispatch.value[key],
      )
    )
      throw preflightError("Auth103 sixth runtime custody differs");
  }
  if (seventhDispatch && seventhInstalled) {
    if (!sixthDispatch || !sixthInstalled)
      throw preflightError("Auth103 seventh runtime custody pair is incomplete");
    const expectedKeys = Object.keys(sixthDispatch.value).sort();
    if (
      JSON.stringify(Object.keys(seventhDispatch.value).sort()) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(Object.keys(seventhInstalled.value).sort()) !==
        JSON.stringify([...expectedKeys, "markerDigest"].sort()) ||
      seventhDispatch.value.kind !== sixthDispatch.value.kind ||
      seventhInstalled.value.kind !== sixthInstalled.value.kind ||
      seventhDispatch.value.environment !== "integration" ||
      seventhDispatch.value.historicalReceiptDigest !== prior.digest ||
      seventhDispatch.value.targetRef !== expectedTargetRef ||
      seventhDispatch.value.targetDigest !== digest(targetJson) ||
      seventhDispatch.value.predecessorMarkerDigest !== sixthDispatch.digest ||
      seventhDispatch.value.predecessorInstalledDigest !== sixthInstalled.digest ||
      seventhDispatch.value.predecessorDeploymentRef !== sixthDispatch.value.deploymentRef ||
      seventhInstalled.value.markerDigest !== seventhDispatch.digest ||
      expectedKeys.some(
        (key) => key !== "kind" && seventhInstalled.value[key] !== seventhDispatch.value[key],
      )
    )
      throw preflightError("Auth103 seventh runtime custody differs");
  }
  const credential = await resolveCloudflareCredential("integration");
  const state = new CloudflareState({ accountId: target.accountId, token: credential.token });
  const live = await inspectCanonicalWorkerVersionWithScriptIdentity(
    "preflight",
    target,
    state,
    {},
  );
  const modules = await state.workerVersionWithModules(target.workerName, live.history.versionId);
  const pair = exactCurrentAuth103NativePair(modules, live.commit, live.bundleDigestHex);
  if (
    pair.manifest.targetRef !== prior.value.targetRef ||
    pair.manifest.sourceCommit === prior.value.commit
  )
    throw preflightError("Auth103 current runtime is not a distinct same-target successor");
  const version = await state.workerVersion(target.workerName, live.history.versionId);
  if (
    workerVersionScriptContentIdentity("preflight", live.history.versionId, version) !==
    live.scriptEtag
  )
    throw preflightError("Auth103 current Version script changed during inspection");
  const historicalVersion = await state.workerVersion(
    target.workerName,
    dispatched.value.versionId,
  );
  const historicalIdentity = workerVersionIdentity("preflight", historicalVersion);
  if (
    historicalIdentity.commit !== prior.value.commit ||
    `sha256:${historicalIdentity.bundleDigestHex}` !== dispatched.value.bundleDigest
  )
    throw preflightError("Auth103 historical Version differs from installed receipt");
  const historicalModules = await state.workerVersionWithModules(
    target.workerName,
    dispatched.value.versionId,
  );
  const historicalPair = exactCurrentAuth103NativePair(
    historicalModules,
    historicalIdentity.commit,
    historicalIdentity.bundleDigestHex,
  );
  if (
    historicalPair.manifest.targetRef !== expectedTargetRef ||
    historicalPair.manifest.sourceRef !== prior.value.sourceRef ||
    historicalPair.manifest.authSchemaRef !== prior.value.authSchemaRef
  )
    throw preflightError("Auth103 historical code and receipt disagree");
  let predecessorPair: NativePair | undefined;
  let firstPairProof: NativePair | undefined;
  let earlierPredecessorPair: NativePair | undefined;
  let secondPairProof: NativePair | undefined;
  let thirdPairProof: NativePair | undefined;
  let fourthPairProof: NativePair | undefined;
  let fifthPairProof: NativePair | undefined;
  let sixthPairProof: NativePair | undefined;
  let originPredecessorPair: NativePair | undefined;
  let seventhPairProof: NativePair | undefined;
  let genesisPredecessorPair: NativePair | undefined;
  let initialPredecessorPair: NativePair | undefined;
  let earliestPredecessorPair: NativePair | undefined;
  let oldestPredecessorPair: NativePair | undefined;
  if (firstDispatch && firstInstalled) {
    if (
      typeof firstDispatch.value.versionId !== "string" ||
      typeof firstDispatch.value.deployedCommit !== "string" ||
      typeof firstDispatch.value.artifactDigest !== "string" ||
      typeof firstDispatch.value.deploymentId !== "string"
    )
      throw preflightError("Auth103 current runtime predecessor identity is incomplete");
    const firstVersion = await state.workerVersion(
      target.workerName,
      firstDispatch.value.versionId,
    );
    const firstIdentity = workerVersionIdentity("preflight", firstVersion);
    if (
      firstIdentity.commit !== firstDispatch.value.deployedCommit ||
      `sha256:${firstIdentity.bundleDigestHex}` !== firstDispatch.value.artifactDigest
    )
      throw preflightError("Auth103 current runtime predecessor Version differs");
    const firstModules = await state.workerVersionWithModules(
      target.workerName,
      firstDispatch.value.versionId,
    );
    const firstPair = exactCurrentAuth103NativePair(
      firstModules,
      firstIdentity.commit,
      firstIdentity.bundleDigestHex,
    );
    firstPairProof = firstPair;
    if (
      firstPair.manifest.targetRef !== expectedTargetRef ||
      firstPair.manifest.sourceCommit !== firstDispatch.value.deployedCommit ||
      firstPair.manifest.sourceRef !== firstDispatch.value.sourceRef ||
      firstPair.bundleDigest !== firstDispatch.value.artifactDigest ||
      firstPair.record.deploymentRef !== firstDispatch.value.deploymentRef ||
      firstPair.record.deploymentReceiptRef !== firstDispatch.value.receiptRef ||
      firstPair.record.deploymentRef === historicalPair.record.deploymentRef ||
      currentRpSuccessor(firstPair, historicalPair)
    )
      throw preflightError("Auth103 current runtime predecessor is not the installed pair");
    if (secondDispatch && secondInstalled) {
      if (
        typeof secondDispatch.value.versionId !== "string" ||
        typeof secondDispatch.value.deployedCommit !== "string" ||
        typeof secondDispatch.value.artifactDigest !== "string" ||
        typeof secondDispatch.value.deploymentId !== "string"
      )
        throw preflightError("sealed second dispatch identity invalid");
      const secondVersion = await state.workerVersion(
        target.workerName,
        secondDispatch.value.versionId,
      );
      const secondIdentity = workerVersionIdentity("preflight", secondVersion);
      if (
        secondIdentity.commit !== secondDispatch.value.deployedCommit ||
        `sha256:${secondIdentity.bundleDigestHex}` !== secondDispatch.value.artifactDigest
      )
        throw preflightError("sealed second Version identity differs");
      const secondModules = await state.workerVersionWithModules(
        target.workerName,
        secondDispatch.value.versionId,
      );
      const secondPair = exactCurrentAuth103NativePair(
        secondModules,
        secondIdentity.commit,
        secondIdentity.bundleDigestHex,
      );
      secondPairProof = secondPair;
      if (
        secondPair.manifest.targetRef !== expectedTargetRef ||
        secondPair.manifest.sourceCommit !== secondDispatch.value.deployedCommit ||
        secondPair.manifest.sourceRef !== secondDispatch.value.sourceRef ||
        secondPair.bundleDigest !== secondDispatch.value.artifactDigest ||
        secondPair.record.deploymentRef !== secondDispatch.value.deploymentRef ||
        secondPair.record.deploymentReceiptRef !== secondDispatch.value.receiptRef ||
        secondPair.record.deploymentRef === firstPair.record.deploymentRef ||
        !currentRpSuccessor(secondPair, firstPair)
      )
        throw preflightError("sealed second native pair identity differs");
      if (thirdDispatch && thirdInstalled) {
        if (
          typeof thirdDispatch.value.versionId !== "string" ||
          typeof thirdDispatch.value.deployedCommit !== "string" ||
          typeof thirdDispatch.value.artifactDigest !== "string" ||
          typeof thirdDispatch.value.deploymentId !== "string"
        )
          throw preflightError("Auth103 third runtime Version identity is absent");
        const thirdVersion = await state.workerVersion(
          target.workerName,
          thirdDispatch.value.versionId,
        );
        const thirdIdentity = workerVersionIdentity("verification", thirdVersion);
        if (
          thirdIdentity.commit !== thirdDispatch.value.deployedCommit ||
          `sha256:${thirdIdentity.bundleDigestHex}` !== thirdDispatch.value.artifactDigest
        )
          throw preflightError("Auth103 third runtime Version identity differs");
        const thirdModules = await state.workerVersionWithModules(
          target.workerName,
          thirdDispatch.value.versionId,
        );
        const thirdPair = exactCurrentAuth103NativePair(
          thirdModules,
          thirdIdentity.commit,
          thirdIdentity.bundleDigestHex,
        );
        thirdPairProof = thirdPair;
        if (
          thirdPair.manifest.targetRef !== expectedTargetRef ||
          thirdPair.manifest.sourceCommit !== thirdDispatch.value.deployedCommit ||
          thirdPair.manifest.sourceRef !== thirdDispatch.value.sourceRef ||
          thirdPair.bundleDigest !== thirdDispatch.value.artifactDigest ||
          thirdPair.record.deploymentRef !== thirdDispatch.value.deploymentRef ||
          thirdPair.record.deploymentReceiptRef !== thirdDispatch.value.receiptRef ||
          thirdPair.record.deploymentRef === secondPair.record.deploymentRef ||
          thirdPair.record.deploymentRef === firstPair.record.deploymentRef ||
          !currentRpSuccessor(thirdPair, secondPair)
        )
          throw preflightError("Auth103 third runtime pair differs");
        if (fourthDispatch && fourthInstalled) {
          if (
            typeof fourthDispatch.value.versionId !== "string" ||
            typeof fourthDispatch.value.deployedCommit !== "string" ||
            typeof fourthDispatch.value.artifactDigest !== "string" ||
            typeof fourthDispatch.value.deploymentId !== "string"
          )
            throw preflightError("Auth103 third runtime Version identity is absent");
          const fourthVersion = await state.workerVersion(
            target.workerName,
            fourthDispatch.value.versionId,
          );
          const fourthIdentity = workerVersionIdentity("verification", fourthVersion);
          if (
            fourthIdentity.commit !== fourthDispatch.value.deployedCommit ||
            `sha256:${fourthIdentity.bundleDigestHex}` !== fourthDispatch.value.artifactDigest
          )
            throw preflightError("Auth103 third runtime Version identity differs");
          const fourthModules = await state.workerVersionWithModules(
            target.workerName,
            fourthDispatch.value.versionId,
          );
          const fourthPair = exactCurrentAuth103NativePair(
            fourthModules,
            fourthIdentity.commit,
            fourthIdentity.bundleDigestHex,
          );
          fourthPairProof = fourthPair;
          if (
            fourthPair.manifest.targetRef !== expectedTargetRef ||
            fourthPair.manifest.sourceCommit !== fourthDispatch.value.deployedCommit ||
            fourthPair.manifest.sourceRef !== fourthDispatch.value.sourceRef ||
            fourthPair.bundleDigest !== fourthDispatch.value.artifactDigest ||
            fourthPair.record.deploymentRef !== fourthDispatch.value.deploymentRef ||
            fourthPair.record.deploymentReceiptRef !== fourthDispatch.value.receiptRef ||
            fourthPair.record.deploymentRef === thirdPair.record.deploymentRef ||
            fourthPair.record.deploymentRef === firstPair.record.deploymentRef ||
            fourthPair.record.deploymentRef === secondPair.record.deploymentRef ||
            !currentRpSuccessor(fourthPair, thirdPair)
          )
            throw preflightError("Auth103 third runtime pair differs");
          if (
            fourthDispatch.value.versionId === live.history.versionId &&
            fourthDispatch.value.deploymentId === live.history.deploymentId &&
            fourthDispatch.value.deployedCommit === live.commit &&
            fourthPair.record.deploymentRef === pair.record.deploymentRef
          ) {
            oldestPredecessorPair = firstPair;
            earlierPredecessorPair = secondPair;
            predecessorPair = thirdPair;
            bridge = fourthBridge;
          } else {
            if (
              firstDispatch.value.versionId === live.history.versionId ||
              firstDispatch.value.deployedCommit === live.commit ||
              firstPair.record.deploymentRef === pair.record.deploymentRef ||
              secondDispatch.value.versionId === live.history.versionId ||
              secondDispatch.value.deployedCommit === live.commit ||
              secondPair.record.deploymentRef === pair.record.deploymentRef ||
              thirdDispatch.value.versionId === live.history.versionId ||
              thirdDispatch.value.deployedCommit === live.commit ||
              thirdPair.record.deploymentRef === pair.record.deploymentRef ||
              fourthDispatch.value.versionId === live.history.versionId ||
              fourthDispatch.value.deployedCommit === live.commit ||
              fourthPair.record.deploymentRef === pair.record.deploymentRef
            )
              throw preflightError(
                "auth103 current runtime successor identity collides with sealed history",
              );
            currentRpSuccessor(pair, fourthPair);
            if (fifthDispatch && fifthInstalled) {
              if (
                typeof fifthDispatch.value.versionId !== "string" ||
                typeof fifthDispatch.value.deployedCommit !== "string" ||
                typeof fifthDispatch.value.artifactDigest !== "string" ||
                typeof fifthDispatch.value.deploymentId !== "string"
              )
                throw preflightError("Auth103 fifth runtime Version identity is absent");
              const fifthVersion = await state.workerVersion(
                target.workerName,
                fifthDispatch.value.versionId,
              );
              const fifthIdentity = workerVersionIdentity("verification", fifthVersion);
              if (
                fifthIdentity.commit !== fifthDispatch.value.deployedCommit ||
                `sha256:${fifthIdentity.bundleDigestHex}` !== fifthDispatch.value.artifactDigest
              )
                throw preflightError("Auth103 fifth runtime Version identity differs");
              const fifthModules = await state.workerVersionWithModules(
                target.workerName,
                fifthDispatch.value.versionId,
              );
              const fifthPair = exactCurrentAuth103NativePair(
                fifthModules,
                fifthIdentity.commit,
                fifthIdentity.bundleDigestHex,
              );
              fifthPairProof = fifthPair;
              if (
                fifthPair.manifest.targetRef !== expectedTargetRef ||
                fifthPair.manifest.sourceCommit !== fifthDispatch.value.deployedCommit ||
                fifthPair.manifest.sourceRef !== fifthDispatch.value.sourceRef ||
                fifthPair.bundleDigest !== fifthDispatch.value.artifactDigest ||
                fifthPair.record.deploymentRef !== fifthDispatch.value.deploymentRef ||
                fifthPair.record.deploymentReceiptRef !== fifthDispatch.value.receiptRef ||
                fifthPair.record.deploymentRef === fourthPair.record.deploymentRef ||
                fifthPair.record.deploymentRef === thirdPair.record.deploymentRef ||
                fifthPair.record.deploymentRef === secondPair.record.deploymentRef ||
                fifthPair.record.deploymentRef === firstPair.record.deploymentRef ||
                !currentRpSuccessor(fifthPair, fourthPair)
              )
                throw preflightError("Auth103 fifth runtime pair differs");
              const sealedEntry = (value: Record<string, unknown>, sealedPair: NativePair) => ({
                versionId: String(value.versionId),
                deploymentId: String(value.deploymentId),
                deployedCommit: String(value.deployedCommit),
                pair: sealedPair,
              });
              const sealedRuntimes = [
                sealedEntry(firstDispatch.value, firstPair),
                sealedEntry(secondDispatch.value, secondPair),
                sealedEntry(thirdDispatch.value, thirdPair),
                sealedEntry(fourthDispatch.value, fourthPair),
                sealedEntry(fifthDispatch.value, fifthPair),
              ];
              if (sixthDispatch && sixthInstalled) {
                if (
                  typeof sixthDispatch.value.versionId !== "string" ||
                  typeof sixthDispatch.value.deployedCommit !== "string" ||
                  typeof sixthDispatch.value.artifactDigest !== "string" ||
                  typeof sixthDispatch.value.deploymentId !== "string"
                )
                  throw preflightError("Auth103 sixth runtime Version identity is absent");
                const sixthVersion = await state.workerVersion(
                  target.workerName,
                  sixthDispatch.value.versionId,
                );
                const sixthIdentity = workerVersionIdentity("verification", sixthVersion);
                if (
                  sixthIdentity.commit !== sixthDispatch.value.deployedCommit ||
                  `sha256:${sixthIdentity.bundleDigestHex}` !== sixthDispatch.value.artifactDigest
                )
                  throw preflightError("Auth103 sixth runtime Version identity differs");
                const sixthModules = await state.workerVersionWithModules(
                  target.workerName,
                  sixthDispatch.value.versionId,
                );
                const sixthPair = exactCurrentAuth103NativePair(
                  sixthModules,
                  sixthIdentity.commit,
                  sixthIdentity.bundleDigestHex,
                );
                sixthPairProof = sixthPair;
                if (
                  sixthPair.manifest.targetRef !== expectedTargetRef ||
                  sixthPair.manifest.sourceCommit !== sixthDispatch.value.deployedCommit ||
                  sixthPair.manifest.sourceRef !== sixthDispatch.value.sourceRef ||
                  sixthPair.bundleDigest !== sixthDispatch.value.artifactDigest ||
                  sixthPair.record.deploymentRef !== sixthDispatch.value.deploymentRef ||
                  sixthPair.record.deploymentReceiptRef !== sixthDispatch.value.receiptRef ||
                  sixthPair.record.deploymentRef === fifthPair.record.deploymentRef ||
                  sixthPair.record.deploymentRef === fourthPair.record.deploymentRef ||
                  sixthPair.record.deploymentRef === thirdPair.record.deploymentRef ||
                  sixthPair.record.deploymentRef === secondPair.record.deploymentRef ||
                  sixthPair.record.deploymentRef === firstPair.record.deploymentRef ||
                  !currentRpSuccessor(sixthPair, fifthPair)
                )
                  throw preflightError("Auth103 sixth runtime pair differs");
                sealedRuntimes.push(sealedEntry(sixthDispatch.value, sixthPair));
                if (seventhDispatch && seventhInstalled) {
                  if (
                    typeof seventhDispatch.value.versionId !== "string" ||
                    typeof seventhDispatch.value.deployedCommit !== "string" ||
                    typeof seventhDispatch.value.artifactDigest !== "string" ||
                    typeof seventhDispatch.value.deploymentId !== "string"
                  )
                    throw preflightError("Auth103 seventh runtime Version identity is absent");
                  const seventhVersion = await state.workerVersion(
                    target.workerName,
                    seventhDispatch.value.versionId,
                  );
                  const seventhIdentity = workerVersionIdentity("verification", seventhVersion);
                  if (
                    seventhIdentity.commit !== seventhDispatch.value.deployedCommit ||
                    `sha256:${seventhIdentity.bundleDigestHex}` !==
                      seventhDispatch.value.artifactDigest
                  )
                    throw preflightError("Auth103 seventh runtime Version identity differs");
                  const seventhModules = await state.workerVersionWithModules(
                    target.workerName,
                    seventhDispatch.value.versionId,
                  );
                  const seventhPair = exactCurrentAuth103NativePair(
                    seventhModules,
                    seventhIdentity.commit,
                    seventhIdentity.bundleDigestHex,
                  );
                  seventhPairProof = seventhPair;
                  // The sealed seventh runtime kept the sixth runtime's RP exactly.
                  if (
                    seventhPair.manifest.targetRef !== expectedTargetRef ||
                    seventhPair.manifest.sourceCommit !== seventhDispatch.value.deployedCommit ||
                    seventhPair.manifest.sourceRef !== seventhDispatch.value.sourceRef ||
                    seventhPair.bundleDigest !== seventhDispatch.value.artifactDigest ||
                    seventhPair.record.deploymentRef !== seventhDispatch.value.deploymentRef ||
                    seventhPair.record.deploymentReceiptRef !== seventhDispatch.value.receiptRef ||
                    [sixthPair, fifthPair, fourthPair, thirdPair, secondPair, firstPair].some(
                      (part) => part.record.deploymentRef === seventhPair.record.deploymentRef,
                    ) ||
                    currentRpSuccessor(seventhPair, sixthPair)
                  )
                    throw preflightError("Auth103 seventh runtime pair differs");
                  sealedRuntimes.push(sealedEntry(seventhDispatch.value, seventhPair));
                }
              }
              const selected = selectAuth103CurrentRuntimeSuccessorSlot({
                live: {
                  versionId: live.history.versionId,
                  deploymentId: live.history.deploymentId,
                  commit: live.commit,
                },
                pair,
                sealed: sealedRuntimes,
              });
              const roles = [...selected.predecessors].reverse();
              predecessorPair = roles[0];
              earlierPredecessorPair = roles[1];
              oldestPredecessorPair = roles[2];
              earliestPredecessorPair = roles[3];
              initialPredecessorPair = roles[4];
              originPredecessorPair = roles[5];
              genesisPredecessorPair = roles[6];
              const selectedBridge = [fifthBridge, sixthBridge, seventhBridge, eighthBridge][
                selected.slot - 5
              ];
              if (selectedBridge === undefined || roles.length !== selected.slot - 1)
                throw preflightError("Auth103 current runtime slot selection differs");
              bridge = selectedBridge;
            } else {
              earliestPredecessorPair = firstPair;
              oldestPredecessorPair = secondPair;
              earlierPredecessorPair = thirdPair;
              predecessorPair = fourthPair;
              bridge = fifthBridge;
            }
          }
        } else if (
          thirdDispatch.value.versionId === live.history.versionId &&
          thirdDispatch.value.deploymentId === live.history.deploymentId &&
          thirdDispatch.value.deployedCommit === live.commit &&
          thirdPair.record.deploymentRef === pair.record.deploymentRef
        ) {
          earlierPredecessorPair = firstPair;
          predecessorPair = secondPair;
          bridge = nextBridge;
        } else {
          if (
            firstDispatch.value.versionId === live.history.versionId ||
            firstDispatch.value.deployedCommit === live.commit ||
            firstPair.record.deploymentRef === pair.record.deploymentRef ||
            secondDispatch.value.versionId === live.history.versionId ||
            secondDispatch.value.deployedCommit === live.commit ||
            secondPair.record.deploymentRef === pair.record.deploymentRef ||
            thirdDispatch.value.versionId === live.history.versionId ||
            thirdDispatch.value.deployedCommit === live.commit ||
            thirdPair.record.deploymentRef === pair.record.deploymentRef
          )
            throw preflightError("Auth103 fourth runtime identity crosses predecessor");
          currentRpSuccessor(pair, thirdPair);
          oldestPredecessorPair = firstPair;
          earlierPredecessorPair = secondPair;
          predecessorPair = thirdPair;
          bridge = fourthBridge;
        }
      } else {
        if (
          secondDispatch.value.versionId === live.history.versionId &&
          secondDispatch.value.deploymentId === live.history.deploymentId &&
          secondDispatch.value.deployedCommit === live.commit &&
          secondPair.record.deploymentRef === pair.record.deploymentRef
        ) {
          predecessorPair = firstPair;
          bridge = successorBridge;
        } else {
          if (
            firstDispatch.value.versionId === live.history.versionId ||
            firstDispatch.value.deployedCommit === live.commit ||
            firstPair.record.deploymentRef === pair.record.deploymentRef ||
            secondDispatch.value.versionId === live.history.versionId ||
            secondDispatch.value.deployedCommit === live.commit ||
            secondPair.record.deploymentRef === pair.record.deploymentRef
          )
            throw preflightError("current Version crosses a sealed predecessor");
          currentRpSuccessor(pair, secondPair);
          earlierPredecessorPair = firstPair;
          predecessorPair = secondPair;
          bridge = nextBridge;
        }
      }
    } else if (
      firstDispatch.value.versionId === live.history.versionId &&
      firstDispatch.value.deploymentId === live.history.deploymentId &&
      firstDispatch.value.deployedCommit === live.commit &&
      firstPair.record.deploymentRef === pair.record.deploymentRef
    ) {
      bridge = firstBridge;
    } else {
      if (
        firstDispatch.value.versionId === live.history.versionId ||
        firstDispatch.value.deployedCommit === live.commit ||
        firstPair.record.deploymentRef === pair.record.deploymentRef ||
        !currentRpSuccessor(pair, firstPair)
      )
        throw preflightError("Auth103 current runtime successor crosses predecessor identity");
      predecessorPair = firstPair;
      bridge = successorBridge;
    }
  }
  const historicalRelease = dispatched.value.releaseDirectory;
  const assertHistoricalRelease = () => {
    if (
      typeof historicalRelease !== "string" ||
      !historicalRelease.startsWith(join(custody.path, "auth103-forward-v2", "auth103-source-")) ||
      !historicalRelease.endsWith("/release") ||
      realpathSync(historicalRelease) !== historicalRelease ||
      !lstatSync(historicalRelease).isDirectory()
    )
      throw preflightError("Auth103 historical release custody differs");
    for (const [name, expected] of [
      ["worker.js", historicalPair.bundleDigest],
      ["auth103-source-install.sql", historicalPair.installDigest],
    ] as const) {
      const path = join(historicalRelease, name);
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o400 ||
        realpathSync(path) !== path ||
        digest(readFileSync(path)) !== expected
      )
        throw preflightError("Auth103 retained historical module differs from Version");
    }
  };
  assertHistoricalRelease();
  const publicationPath = requireEnvironment(
    "TAKOSERVER_AUTH103_CURRENT_RUNTIME_PUBLICATION_STATUS_PATH",
  );
  const publication = readPrivate(publicationPath, true);
  if (
    publication.value.kind !== "takoserver.worker-status@v2" ||
    publication.value.environment !== "integration" ||
    publication.value.deployedCommit !== live.commit ||
    publication.value.versionId !== live.history.versionId ||
    publication.value.deploymentId !== live.history.deploymentId ||
    publication.value.artifactDigest !== pair.bundleDigest ||
    !Array.isArray(publication.value.appliedMigrations) ||
    publication.value.appliedMigrations.length !== 105 ||
    !Array.isArray(publication.value.pendingMigrations) ||
    publication.value.pendingMigrations.length !== 0
  )
    throw preflightError("Auth103 saved publication readback differs from current Version");
  const historicalSources = await runCommand([
    "git",
    "-C",
    REPOSITORY,
    "diff",
    "--quiet",
    live.commit,
    "--",
    ...AUTH103_CURRENT_RUNTIME_DEPLOYED_SOURCE_PATHS,
  ]);
  if (historicalSources.exitCode !== 0)
    throw preflightError("Auth103 current runtime source differs from the deployed Git original");
  const scratch = mkdtempSync(join(custody.path, "auth103-current-runtime-inspection-"));
  let registered: ReturnType<typeof readFinancial0104CanonicalMigrationSource> | undefined;
  try {
    registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratch);
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    if (firstDispatch && firstPairProof) {
      const firstPredicate = boundCurrentPredicate(
        [
          firstPairProof.manifest.registrationRef,
          firstPairProof.manifest.recipeDigest,
          firstPairProof.manifest.clockSourceDigest,
          firstPairProof.manifest.clockPolicyRef,
        ],
        JSON.stringify(shapes.auth103Catalog),
      );
      const firstCompiled = compileAuth103CurrentRuntimePairSql({
        current: firstPairProof,
        historical: historicalPair,
        migrationNames: registered.artifact105.names,
        postShape: shapes.postShape,
        currentSourcePredicate: firstPredicate,
      });
      if (firstDispatch.value.sqlDigest !== digest(firstCompiled.sql))
        throw preflightError("Auth103 current runtime predecessor SQL seal differs");
    }
    if (secondDispatch && secondPairProof && firstPairProof) {
      const secondPredicate = boundCurrentPredicate(
        [
          secondPairProof.manifest.registrationRef,
          secondPairProof.manifest.recipeDigest,
          secondPairProof.manifest.clockSourceDigest,
          secondPairProof.manifest.clockPolicyRef,
        ],
        JSON.stringify(shapes.auth103Catalog),
      );
      const secondCompiled = compileAuth103CurrentRuntimePairSql({
        current: secondPairProof,
        historical: historicalPair,
        predecessor: firstPairProof,
        migrationNames: registered.artifact105.names,
        postShape: shapes.postShape,
        currentSourcePredicate: secondPredicate,
      });
      if (secondDispatch.value.sqlDigest !== digest(secondCompiled.sql))
        throw preflightError("sealed second dispatch SQL differs");
    }
    if (thirdDispatch && thirdPairProof && secondPairProof && firstPairProof) {
      const thirdPredicate = boundCurrentPredicate(
        [
          thirdPairProof.manifest.registrationRef,
          thirdPairProof.manifest.recipeDigest,
          thirdPairProof.manifest.clockSourceDigest,
          thirdPairProof.manifest.clockPolicyRef,
        ],
        JSON.stringify(shapes.auth103Catalog),
      );
      const thirdCompiled = compileAuth103CurrentRuntimePairSql({
        current: thirdPairProof,
        historical: historicalPair,
        predecessor: secondPairProof,
        earlierPredecessor: firstPairProof,
        migrationNames: registered.artifact105.names,
        postShape: shapes.postShape,
        currentSourcePredicate: thirdPredicate,
      });
      if (thirdDispatch.value.sqlDigest !== digest(thirdCompiled.sql))
        throw preflightError("Auth103 third runtime SQL seal differs");
    }
    if (fourthDispatch && fourthPairProof && thirdPairProof && secondPairProof && firstPairProof) {
      const fourthPredicate = boundCurrentPredicate(
        [
          fourthPairProof.manifest.registrationRef,
          fourthPairProof.manifest.recipeDigest,
          fourthPairProof.manifest.clockSourceDigest,
          fourthPairProof.manifest.clockPolicyRef,
        ],
        JSON.stringify(shapes.auth103Catalog),
      );
      const fourthCompiled = compileAuth103CurrentRuntimePairSql({
        current: fourthPairProof,
        historical: historicalPair,
        predecessor: thirdPairProof,
        earlierPredecessor: secondPairProof,
        oldestPredecessor: firstPairProof,
        migrationNames: registered.artifact105.names,
        postShape: shapes.postShape,
        currentSourcePredicate: fourthPredicate,
      });
      if (fourthDispatch.value.sqlDigest !== digest(fourthCompiled.sql))
        throw preflightError("Auth103 third runtime SQL seal differs");
    }
    if (
      fifthDispatch &&
      fifthPairProof &&
      fourthPairProof &&
      thirdPairProof &&
      secondPairProof &&
      firstPairProof
    ) {
      const fifthPredicate = boundCurrentPredicate(
        [
          fifthPairProof.manifest.registrationRef,
          fifthPairProof.manifest.recipeDigest,
          fifthPairProof.manifest.clockSourceDigest,
          fifthPairProof.manifest.clockPolicyRef,
        ],
        JSON.stringify(shapes.auth103Catalog),
      );
      const fifthCompiled = compileAuth103CurrentRuntimePairSql({
        current: fifthPairProof,
        historical: historicalPair,
        predecessor: fourthPairProof,
        earlierPredecessor: thirdPairProof,
        oldestPredecessor: secondPairProof,
        earliestPredecessor: firstPairProof,
        migrationNames: registered.artifact105.names,
        postShape: shapes.postShape,
        currentSourcePredicate: fifthPredicate,
      });
      if (fifthDispatch.value.sqlDigest !== digest(fifthCompiled.sql))
        throw preflightError("Auth103 fifth runtime SQL seal differs");
    }
    if (
      sixthDispatch &&
      sixthPairProof &&
      fifthPairProof &&
      fourthPairProof &&
      thirdPairProof &&
      secondPairProof &&
      firstPairProof
    ) {
      const sixthPredicate = boundCurrentPredicate(
        [
          sixthPairProof.manifest.registrationRef,
          sixthPairProof.manifest.recipeDigest,
          sixthPairProof.manifest.clockSourceDigest,
          sixthPairProof.manifest.clockPolicyRef,
        ],
        JSON.stringify(shapes.auth103Catalog),
      );
      const sixthCompiled = compileAuth103CurrentRuntimePairSql({
        current: sixthPairProof,
        historical: historicalPair,
        predecessor: fifthPairProof,
        earlierPredecessor: fourthPairProof,
        oldestPredecessor: thirdPairProof,
        earliestPredecessor: secondPairProof,
        initialPredecessor: firstPairProof,
        migrationNames: registered.artifact105.names,
        postShape: shapes.postShape,
        currentSourcePredicate: sixthPredicate,
      });
      if (sixthDispatch.value.sqlDigest !== digest(sixthCompiled.sql))
        throw preflightError("Auth103 sixth runtime SQL seal differs");
    }
    if (
      seventhDispatch &&
      seventhPairProof &&
      sixthPairProof &&
      fifthPairProof &&
      fourthPairProof &&
      thirdPairProof &&
      secondPairProof &&
      firstPairProof
    ) {
      const seventhPredicate = boundCurrentPredicate(
        [
          seventhPairProof.manifest.registrationRef,
          seventhPairProof.manifest.recipeDigest,
          seventhPairProof.manifest.clockSourceDigest,
          seventhPairProof.manifest.clockPolicyRef,
        ],
        JSON.stringify(shapes.auth103Catalog),
      );
      const seventhCompiled = compileAuth103CurrentRuntimePairSql({
        current: seventhPairProof,
        historical: historicalPair,
        predecessor: sixthPairProof,
        earlierPredecessor: fifthPairProof,
        oldestPredecessor: fourthPairProof,
        earliestPredecessor: thirdPairProof,
        initialPredecessor: secondPairProof,
        originPredecessor: firstPairProof,
        migrationNames: registered.artifact105.names,
        postShape: shapes.postShape,
        currentSourcePredicate: seventhPredicate,
      });
      if (seventhDispatch.value.sqlDigest !== digest(seventhCompiled.sql))
        throw preflightError("Auth103 seventh runtime SQL seal differs");
    }
    const configPath = join(scratch, "wrangler.jsonc");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          name: target.workerName,
          account_id: target.accountId,
          compatibility_date: "2026-08-17",
          d1_databases: [
            {
              binding: "STATE_DB",
              database_name: target.d1.databaseName,
              database_id: target.d1.databaseId,
              migrations_dir: join(scratch, "migrations"),
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const database = new RemoteD1(configPath, { environment: credential.childEnvironment });
    const snapshot = await readD1SchemaState(database);
    if (
      JSON.stringify(publication.value.appliedMigrations) !==
        JSON.stringify(registered.artifact105.names) ||
      JSON.stringify(snapshot.applied) !== JSON.stringify(registered.artifact105.names) ||
      !applicationSchemaMatches(snapshot, shapes.postShape) ||
      !financial0104LedgerApplied(registered.physicalNames, snapshot.applied, REPOSITORY)
    )
      throw preflightError(
        "Auth103 current registration requires exact physical 0105 and no pending source",
      );
    const currentPredicate = boundCurrentPredicate(
      [
        pair.manifest.registrationRef,
        pair.manifest.recipeDigest,
        pair.manifest.clockSourceDigest,
        pair.manifest.clockPolicyRef,
      ],
      JSON.stringify(shapes.auth103Catalog),
    );
    const currentRows = await database.query(
      "preflight",
      "Auth103 unchanged source original",
      `SELECT CASE WHEN (${currentPredicate}) THEN 1 ELSE 0 END AS current`,
    );
    if (currentRows.length !== 1 || currentRows[0]?.current !== 1)
      throw preflightError("Auth103 original source registration is not current");
    const rpReferencePair = auth103CurrentRuntimeRpReference(
      [
        genesisPredecessorPair,
        originPredecessorPair,
        initialPredecessorPair,
        earliestPredecessorPair,
        oldestPredecessorPair,
        earlierPredecessorPair,
        predecessorPair,
      ].filter((part): part is NativePair => part !== undefined),
      historicalPair,
    );
    const rpAdded = currentRpSuccessor(pair, rpReferencePair);
    const genesisPredecessorPredicate = genesisPredecessorPair
      ? auth103NativePairPredicate(genesisPredecessorPair)
      : undefined;
    if (genesisPredecessorPredicate) {
      const genesisRows = await database.query(
        "preflight",
        "read",
        `SELECT (${genesisPredecessorPredicate}) AS current`,
      );
      if (genesisRows.length !== 1 || genesisRows[0]?.current !== 1)
        throw preflightError("sealed genesis predecessor pair differs");
    }
    const originPredecessorPredicate = originPredecessorPair
      ? auth103NativePairPredicate(originPredecessorPair)
      : undefined;
    if (originPredecessorPredicate) {
      const originRows = await database.query(
        "preflight",
        "read",
        `SELECT (${originPredecessorPredicate}) AS current`,
      );
      if (originRows.length !== 1 || originRows[0]?.current !== 1)
        throw preflightError("sealed origin predecessor pair differs");
    }
    const initialPredecessorPredicate = initialPredecessorPair
      ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
          initialPredecessorPair.record.deploymentRef,
          initialPredecessorPair.record.deploymentJson,
          initialPredecessorPair.record.rp.registrationRef,
          initialPredecessorPair.record.rp.registrationDigest,
          initialPredecessorPair.record.rpJson,
        ])
      : undefined;
    if (initialPredecessorPredicate) {
      const initialRows = await database.query(
        "preflight",
        "read",
        `SELECT (${initialPredecessorPredicate}) AS current`,
      );
      if (initialRows.length !== 1 || initialRows[0]?.current !== 1)
        throw preflightError("sealed initial predecessor pair differs");
    }
    const earliestPredecessorPredicate = earliestPredecessorPair
      ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
          earliestPredecessorPair.record.deploymentRef,
          earliestPredecessorPair.record.deploymentJson,
          earliestPredecessorPair.record.rp.registrationRef,
          earliestPredecessorPair.record.rp.registrationDigest,
          earliestPredecessorPair.record.rpJson,
        ])
      : undefined;
    if (earliestPredecessorPredicate) {
      const earliestRows = await database.query(
        "preflight",
        "read",
        `SELECT (${earliestPredecessorPredicate}) AS current`,
      );
      if (earliestRows.length !== 1 || earliestRows[0]?.current !== 1)
        throw preflightError("sealed oldest predecessor pair differs");
    }
    const oldestPredecessorPredicate = oldestPredecessorPair
      ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
          oldestPredecessorPair.record.deploymentRef,
          oldestPredecessorPair.record.deploymentJson,
          oldestPredecessorPair.record.rp.registrationRef,
          oldestPredecessorPair.record.rp.registrationDigest,
          oldestPredecessorPair.record.rpJson,
        ])
      : undefined;
    if (oldestPredecessorPredicate) {
      const oldestRows = await database.query(
        "preflight",
        "read",
        `SELECT (${oldestPredecessorPredicate}) AS current`,
      );
      if (oldestRows.length !== 1 || oldestRows[0]?.current !== 1)
        throw preflightError("sealed oldest predecessor pair differs");
    }
    const earlierPredecessorPredicate = earlierPredecessorPair
      ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
          earlierPredecessorPair.record.deploymentRef,
          earlierPredecessorPair.record.deploymentJson,
          earlierPredecessorPair.record.rp.registrationRef,
          earlierPredecessorPair.record.rp.registrationDigest,
          earlierPredecessorPair.record.rpJson,
        ])
      : undefined;
    if (earlierPredecessorPredicate) {
      const earlierRows = await database.query(
        "preflight",
        "read",
        `SELECT (${earlierPredecessorPredicate}) AS current`,
      );
      if (earlierRows.length !== 1 || earlierRows[0]?.current !== 1)
        throw preflightError("sealed earlier predecessor pair differs");
    }
    const predecessorPredicate = predecessorPair
      ? boundPredicate(AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE, [
          predecessorPair.record.deploymentRef,
          predecessorPair.record.deploymentJson,
          predecessorPair.record.rp.registrationRef,
          predecessorPair.record.rp.registrationDigest,
          predecessorPair.record.rpJson,
        ])
      : undefined;
    if (predecessorPredicate) {
      const predecessorRows = await database.query(
        "preflight",
        "Auth103 installed current-runtime predecessor",
        `SELECT (${predecessorPredicate}) AS current`,
      );
      if (predecessorRows.length !== 1 || predecessorRows[0]?.current !== 1)
        throw preflightError("Auth103 installed current-runtime predecessor differs");
    }
    const rp = pair.record.rp;
    const oldRp = historicalPair.record.rp;
    const readRpRows = async (selectedRp: typeof rp) => {
      let rpBindIndex = 0;
      const rows = await database.query(
        "preflight",
        "Auth103 unchanged RP original",
        `${AUTH103_NATIVE_RP_REGISTRATION_QUERY.replace(/\?/gu, () =>
          sqlLiteral([selectedRp.registrationRef, selectedRp.registrationDigest][rpBindIndex++]!),
        )}`,
      );
      if (rpBindIndex !== 2)
        throw preflightError("Auth103 current runtime RP query binding mismatch");
      return rows;
    };
    const rpRows = await readRpRows(oldRp);
    if (
      rpRows.length !== 1 ||
      rpRows[0]?.record_json !== historicalPair.record.rpJson ||
      rpRows[0]?.receipt_ref !== oldRp.receiptRef
    )
      throw preflightError("Auth103 current runtime historical RP original mismatch");
    const latestRpRows =
      earlierPredecessorPair && predecessorPair
        ? await readRpRows(rpReferencePair.record.rp)
        : undefined;
    if (
      latestRpRows &&
      (latestRpRows.length !== 1 ||
        latestRpRows[0]?.record_json !== rpReferencePair.record.rpJson ||
        latestRpRows[0]?.receipt_ref !== rpReferencePair.record.rp.receiptRef)
    )
      throw preflightError("sealed second RP registration differs");
    const currentRpRows = rpAdded ? await readRpRows(rp) : (latestRpRows ?? rpRows);
    let oldIndex = 0;
    const oldQuery = AUTH103_NATIVE_DEPLOYMENT_QUERY.replace(/\?/gu, () =>
      sqlLiteral(
        [
          historicalPair.manifest.targetRef,
          historicalPair.manifest.sourceRef,
          historicalPair.bundleDigest,
        ][oldIndex++]!,
      ),
    );
    if (oldIndex !== 3) throw preflightError("Auth103 historical deployment query shape changed");
    const oldRows = await database.query(
      "preflight",
      "Auth103 historical physical deployment",
      oldQuery,
    );
    if (
      oldRows.length !== 1 ||
      oldRows[0]?.deployment_ref !== historicalPair.record.deploymentRef ||
      oldRows[0]?.record_json !== historicalPair.record.deploymentJson ||
      oldRows[0]?.receipt_ref !== historicalPair.record.deploymentReceiptRef
    )
      throw preflightError("Auth103 historical deployment pair is not current");
    const currentDeploymentRows = await database.query(
      "preflight",
      "Auth103 current deployment pair",
      `SELECT deployment_ref,target_ref,source_ref,artifact_digest,record_json FROM auth103_native_deployments
       WHERE deployment_ref=${sqlLiteral(pair.record.deploymentRef)} OR
       (target_ref=${sqlLiteral(pair.manifest.targetRef)} AND source_ref=${sqlLiteral(pair.manifest.sourceRef)}
        AND artifact_digest=${sqlLiteral(pair.bundleDigest)})`,
    );
    const receiptRows = await database.query(
      "preflight",
      "Auth103 current deployment receipt",
      `SELECT receipt_ref,deployment_ref,record_json FROM auth103_native_deployment_receipts
       WHERE receipt_ref=${sqlLiteral(pair.record.deploymentReceiptRef)} OR
       deployment_ref=${sqlLiteral(pair.record.deploymentRef)}`,
    );
    const pairAbsent = currentDeploymentRows.length === 0 && receiptRows.length === 0;
    const pairPresent =
      currentDeploymentRows.length === 1 &&
      receiptRows.length === 1 &&
      currentDeploymentRows[0]?.deployment_ref === pair.record.deploymentRef &&
      currentDeploymentRows[0]?.target_ref === pair.manifest.targetRef &&
      currentDeploymentRows[0]?.source_ref === pair.manifest.sourceRef &&
      currentDeploymentRows[0]?.artifact_digest === pair.bundleDigest &&
      currentDeploymentRows[0]?.record_json === pair.record.deploymentJson &&
      receiptRows[0]?.receipt_ref === pair.record.deploymentReceiptRef &&
      receiptRows[0]?.deployment_ref === pair.record.deploymentRef &&
      receiptRows[0]?.record_json === pair.record.deploymentJson;
    if (!pairAbsent && !pairPresent)
      throw preflightError("Auth103 current deployment pair is foreign or partial");
    const currentRpPresent =
      currentRpRows.length === 1 &&
      currentRpRows[0]?.record_json === pair.record.rpJson &&
      currentRpRows[0]?.receipt_ref === rp.receiptRef;
    if ((rpAdded && pairAbsent && currentRpRows.length !== 0) || (pairPresent && !currentRpPresent))
      throw preflightError("Auth103 current runtime RP successor is partial or foreign");
    const baseRpCount = genesisPredecessorPair
      ? 6
      : originPredecessorPair
        ? 6
        : initialPredecessorPair
          ? 5
          : earliestPredecessorPair
            ? 4
            : oldestPredecessorPair
              ? 3
              : earlierPredecessorPair
                ? 2
                : 1;
    const baseDeploymentCount = genesisPredecessorPair
      ? 8
      : originPredecessorPair
        ? 7
        : initialPredecessorPair
          ? 6
          : earliestPredecessorPair
            ? 5
            : oldestPredecessorPair
              ? 4
              : earlierPredecessorPair
                ? 3
                : predecessorPair
                  ? 2
                  : 1;
    const inventory = await database.query(
      "preflight",
      "Auth103 immutable original inventory",
      `SELECT (SELECT count(*) FROM auth103_native_rp_registrations) AS rp_originals,
        (SELECT count(*) FROM auth103_native_rp_registration_receipts) AS rp_receipts,
        (SELECT count(*) FROM auth103_native_deployments) AS deployments,
        (SELECT count(*) FROM auth103_native_deployment_receipts) AS deployment_receipts`,
    );
    if (
      inventory.length !== 1 ||
      inventory[0]?.rp_originals !== baseRpCount + (rpAdded && pairPresent ? 1 : 0) ||
      inventory[0]?.rp_receipts !== baseRpCount + (rpAdded && pairPresent ? 1 : 0) ||
      inventory[0]?.deployments !== baseDeploymentCount + (pairPresent ? 1 : 0) ||
      inventory[0]?.deployment_receipts !== baseDeploymentCount + (pairPresent ? 1 : 0)
    )
      throw preflightError("Auth103 immutable pair inventory differs");
    custody.assertUnchanged();
    firstDispatch?.assertUnchanged();
    firstInstalled?.assertUnchanged();
    secondDispatch?.assertUnchanged();
    secondInstalled?.assertUnchanged();
    thirdDispatch?.assertUnchanged();
    thirdInstalled?.assertUnchanged();
    fourthDispatch?.assertUnchanged();
    fourthInstalled?.assertUnchanged();
    fifthDispatch?.assertUnchanged();
    fifthInstalled?.assertUnchanged();
    sixthDispatch?.assertUnchanged();
    sixthInstalled?.assertUnchanged();
    seventhDispatch?.assertUnchanged();
    seventhInstalled?.assertUnchanged();
    if (firstBridgeExists) assertFirstBridgeEntries();
    if (successorBridgeExists) assertSuccessorBridgeEntries();
    if (fourthBridgeExists) assertAuth103CurrentRuntimeThirdCustodyEntries(fourthBridge);
    if (pathExistsNoFollow(nextBridge)) assertAuth103CurrentRuntimeThirdCustodyEntries(nextBridge);
    if (pathExistsNoFollow(fifthBridge))
      assertAuth103CurrentRuntimeThirdCustodyEntries(fifthBridge);
    if (pathExistsNoFollow(sixthBridge))
      assertAuth103CurrentRuntimeThirdCustodyEntries(sixthBridge);
    if (pathExistsNoFollow(seventhBridge))
      assertAuth103CurrentRuntimeThirdCustodyEntries(seventhBridge);
    if (pathExistsNoFollow(eighthBridge))
      assertAuth103CurrentRuntimeThirdCustodyEntries(eighthBridge);
    prior.assertUnchanged();
    dispatched.assertUnchanged();
    assertHistoricalRelease();
    originalMarker.assertUnchanged();
    firstForwardMarker.assertUnchanged();
    firstForwardDisposition.assertUnchanged();
    publication.assertUnchanged();
    registered.assertCurrent();
    assertTarget();
    const markerPath = join(bridge, "dispatch.json");
    const installedPath = join(bridge, "installed.json");
    const bridgeExists = pathExistsNoFollow(bridge);
    if (bridgeExists) {
      const stat = lstatSync(bridge);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
        throw preflightError("Auth103 current registration custody directory differs");
    }
    if (
      (bridge === nextBridge ||
        bridge === fourthBridge ||
        bridge === fifthBridge ||
        bridge === sixthBridge ||
        bridge === seventhBridge ||
        bridge === eighthBridge) &&
      bridgeExists
    )
      assertAuth103CurrentRuntimeThirdCustodyEntries(bridge);
    const markerExists = pathExistsNoFollow(markerPath);
    const installedExists = pathExistsNoFollow(installedPath);
    const compiled = compileAuth103CurrentRuntimePairSql({
      current: pair,
      historical: historicalPair,
      ...(predecessorPair ? { predecessor: predecessorPair } : {}),
      ...(earlierPredecessorPair ? { earlierPredecessor: earlierPredecessorPair } : {}),
      ...(oldestPredecessorPair ? { oldestPredecessor: oldestPredecessorPair } : {}),
      ...(earliestPredecessorPair ? { earliestPredecessor: earliestPredecessorPair } : {}),
      ...(initialPredecessorPair ? { initialPredecessor: initialPredecessorPair } : {}),
      ...(originPredecessorPair ? { originPredecessor: originPredecessorPair } : {}),
      ...(genesisPredecessorPair ? { genesisPredecessor: genesisPredecessorPair } : {}),
      migrationNames: registered.artifact105.names,
      postShape: shapes.postShape,
      currentSourcePredicate: currentPredicate,
    });
    const predecessorMarkerDigest = genesisPredecessorPair
      ? seventhDispatch?.digest
      : originPredecessorPair
        ? sixthDispatch?.digest
        : initialPredecessorPair
          ? fifthDispatch?.digest
          : earliestPredecessorPair
            ? fourthDispatch?.digest
            : oldestPredecessorPair
              ? thirdDispatch?.digest
              : earlierPredecessorPair
                ? secondDispatch?.digest
                : firstDispatch?.digest;
    const predecessorInstalledDigest = genesisPredecessorPair
      ? seventhInstalled?.digest
      : originPredecessorPair
        ? sixthInstalled?.digest
        : initialPredecessorPair
          ? fifthInstalled?.digest
          : earliestPredecessorPair
            ? fourthInstalled?.digest
            : oldestPredecessorPair
              ? thirdInstalled?.digest
              : earlierPredecessorPair
                ? secondInstalled?.digest
                : firstInstalled?.digest;
    if (predecessorPair && (!predecessorMarkerDigest || !predecessorInstalledDigest)) {
      throw new Error("auth103 current runtime registration predecessor custody missing");
    }
    const marker = {
      kind: "takoserver.auth103-current-runtime-registration-dispatch@v1",
      environment: "integration",
      toolCommit: source.commit,
      deployedCommit: live.commit,
      versionId: live.history.versionId,
      deploymentId: live.history.deploymentId,
      artifactDigest: pair.bundleDigest,
      targetRef: pair.manifest.targetRef,
      sourceRef: pair.manifest.sourceRef,
      deploymentRef: pair.record.deploymentRef,
      receiptRef: pair.record.deploymentReceiptRef,
      sqlDigest: digest(compiled.sql),
      targetDigest: digest(targetJson),
      historicalReceiptDigest: prior.digest,
      publicationStatusDigest: publication.digest,
      ...(predecessorPair
        ? {
            predecessorMarkerDigest: predecessorMarkerDigest,
            predecessorInstalledDigest: predecessorInstalledDigest,
            predecessorDeploymentRef: predecessorPair.record.deploymentRef,
          }
        : {}),
    };
    const markerDigest = digest(`${JSON.stringify(marker, null, 2)}\n`);
    const installedRecord = {
      ...marker,
      kind: "takoserver.auth103-current-runtime-registration-installed@v1",
      markerDigest,
    };
    const postimageStatements = compileAuth103CurrentRuntimePostimageStatements(
      [
        pair,
        historicalPair,
        ...[
          genesisPredecessorPair,
          originPredecessorPair,
          initialPredecessorPair,
          earliestPredecessorPair,
          oldestPredecessorPair,
          earlierPredecessorPair,
          predecessorPair,
        ].filter((part): part is NativePair => part !== undefined),
      ].map(auth103NativePairPredicate),
      { rp: baseRpCount + (rpAdded ? 1 : 0), deployments: baseDeploymentCount + 1 },
    );
    const readPostimage = async (phase: "preflight" | "verification") => {
      const results: (readonly Record<string, unknown>[])[] = [];
      for (const [index, statement] of postimageStatements.entries())
        results.push(
          await database.query(
            phase,
            `Auth103 historical and current pair postimage ${index + 1}/${postimageStatements.length}`,
            statement,
          ),
        );
      assertAuth103CurrentRuntimePostimageRows(results, postimageStatements.length, phase);
    };
    if (invocation.action === "finalize") {
      if (
        (bridge !== sixthBridge && bridge !== seventhBridge && bridge !== eighthBridge) ||
        !bridgeExists ||
        !markerExists ||
        installedExists
      )
        throw preflightError(
          "Auth103 current runtime finalize is scoped to a dispatch-only sixth, seventh or eighth runtime custody",
        );
      const inventoryExact =
        inventory[0]?.rp_originals === baseRpCount + (rpAdded ? 1 : 0) &&
        inventory[0]?.rp_receipts === baseRpCount + (rpAdded ? 1 : 0) &&
        inventory[0]?.deployments === baseDeploymentCount + 1 &&
        inventory[0]?.deployment_receipts === baseDeploymentCount + 1;
      const assertLiveUnchanged = async (phase: "preflight" | "verification") => {
        const now = await inspectCanonicalWorkerVersionWithScriptIdentity(phase, target, state, {});
        if (
          now.history.versionId !== live.history.versionId ||
          now.history.deploymentId !== live.history.deploymentId ||
          now.commit !== live.commit ||
          now.bundleDigestHex !== live.bundleDigestHex ||
          now.scriptEtag !== live.scriptEtag
        )
          throw (phase === "preflight" ? preflightError : verificationError)(
            "Auth103 current Worker Version changed during finalize",
          );
      };
      const assertSchemaUnchanged = async () => {
        const fresh = await readD1SchemaState(database);
        if (
          JSON.stringify(fresh.applied) !== JSON.stringify(snapshot.applied) ||
          fresh.applied.length !== 105 ||
          !applicationSchemaMatches(fresh, shapes.postShape)
        )
          throw preflightError("Auth103 current schema changed during finalize");
      };
      const assertSealedInputsUnchanged = () => {
        custody.assertUnchanged();
        firstDispatch?.assertUnchanged();
        firstInstalled?.assertUnchanged();
        secondDispatch?.assertUnchanged();
        secondInstalled?.assertUnchanged();
        thirdDispatch?.assertUnchanged();
        thirdInstalled?.assertUnchanged();
        fourthDispatch?.assertUnchanged();
        fourthInstalled?.assertUnchanged();
        fifthDispatch?.assertUnchanged();
        fifthInstalled?.assertUnchanged();
        sixthDispatch?.assertUnchanged();
        sixthInstalled?.assertUnchanged();
        seventhDispatch?.assertUnchanged();
        seventhInstalled?.assertUnchanged();
        if (firstBridgeExists) assertFirstBridgeEntries();
        if (successorBridgeExists) assertSuccessorBridgeEntries();
        if (pathExistsNoFollow(nextBridge))
          assertAuth103CurrentRuntimeThirdCustodyEntries(nextBridge);
        if (fourthBridgeExists) assertAuth103CurrentRuntimeThirdCustodyEntries(fourthBridge);
        if (pathExistsNoFollow(fifthBridge))
          assertAuth103CurrentRuntimeThirdCustodyEntries(fifthBridge);
        if (pathExistsNoFollow(sixthBridge))
          assertAuth103CurrentRuntimeThirdCustodyEntries(sixthBridge);
        if (pathExistsNoFollow(seventhBridge))
          assertAuth103CurrentRuntimeThirdCustodyEntries(seventhBridge);
        if (pathExistsNoFollow(eighthBridge))
          assertAuth103CurrentRuntimeThirdCustodyEntries(eighthBridge);
        prior.assertUnchanged();
        dispatched.assertUnchanged();
        assertHistoricalRelease();
        originalMarker.assertUnchanged();
        firstForwardMarker.assertUnchanged();
        firstForwardDisposition.assertUnchanged();
        publication.assertUnchanged();
        registered?.assertCurrent();
        assertTarget();
      };
      const finalized = await finalizeAuth103CurrentRuntimeDispatchedCustody({
        bridge,
        marker,
        state: { pairPresent, pairAbsent, currentRpPresent, inventoryExact },
        verifyRemote: async () => {
          await assertLiveUnchanged("preflight");
          await assertSchemaUnchanged();
          await readPostimage("preflight");
          assertSealedInputsUnchanged();
        },
        assertUnchanged: async () => {
          await assertLiveUnchanged("preflight");
          await assertSchemaUnchanged();
          assertSealedInputsUnchanged();
          const qualifiedAgain = await qualifySource({
            environment: "integration",
            commit: invocation.commit,
          });
          if (qualifiedAgain.dirty || qualifiedAgain.commit !== source.commit)
            throw preflightError("Auth103 current tool source changed before finalize");
        },
      });
      await assertLiveUnchanged("verification");
      return {
        kind: "takoserver.auth103-current-runtime-registration-finalize@v1",
        environment: "integration",
        toolCommit: source.commit,
        dispatchToolCommit: finalized.dispatchToolCommit,
        deployedCommit: live.commit,
        versionId: live.history.versionId,
        deploymentId: live.history.deploymentId,
        artifactDigest: pair.bundleDigest,
        targetRef: pair.manifest.targetRef,
        sourceRef: pair.manifest.sourceRef,
        currentPairPresent: true,
        rpSuccessorAdded: rpAdded,
        rpOriginalCount: inventory[0]?.rp_originals,
        rpReceiptCount: inventory[0]?.rp_receipts,
        deploymentOriginalCount: inventory[0]?.deployments,
        deploymentReceiptCount: inventory[0]?.deployment_receipts,
        appendedRows: 0,
        appliedCount: snapshot.applied.length,
        pendingCount: 0,
        historicalReceiptDigest: prior.digest,
        markerDigest: finalized.markerDigest,
        installedDigest: finalized.installedDigest,
        registrationState: "installed",
      };
    }
    if (invocation.action === "apply") {
      assertAuth103CurrentRuntimeApplyAllowed({ pairAbsent, bridgeExists });
      const before = await inspectCanonicalWorkerVersionWithScriptIdentity(
        "preflight",
        target,
        state,
        {},
      );
      if (
        before.history.versionId !== live.history.versionId ||
        before.history.deploymentId !== live.history.deploymentId ||
        before.commit !== live.commit ||
        before.bundleDigestHex !== live.bundleDigestHex ||
        before.scriptEtag !== live.scriptEtag
      )
        throw preflightError("Auth103 current Worker Version changed before D1 dispatch");
      const fresh = await readD1SchemaState(database);
      if (
        JSON.stringify(fresh.applied) !== JSON.stringify(snapshot.applied) ||
        !applicationSchemaMatches(fresh, shapes.postShape)
      )
        throw preflightError("Auth103 current schema changed before D1 dispatch");
      custody.assertUnchanged();
      firstDispatch?.assertUnchanged();
      firstInstalled?.assertUnchanged();
      secondDispatch?.assertUnchanged();
      secondInstalled?.assertUnchanged();
      thirdDispatch?.assertUnchanged();
      thirdInstalled?.assertUnchanged();
      fourthDispatch?.assertUnchanged();
      fourthInstalled?.assertUnchanged();
      fifthDispatch?.assertUnchanged();
      fifthInstalled?.assertUnchanged();
      sixthDispatch?.assertUnchanged();
      sixthInstalled?.assertUnchanged();
      seventhDispatch?.assertUnchanged();
      seventhInstalled?.assertUnchanged();
      if (firstBridgeExists) assertFirstBridgeEntries();
      if (successorBridgeExists) assertSuccessorBridgeEntries();
      if (fourthBridgeExists) assertAuth103CurrentRuntimeThirdCustodyEntries(fourthBridge);
      if (pathExistsNoFollow(nextBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(nextBridge);
      if (pathExistsNoFollow(fifthBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(fifthBridge);
      if (pathExistsNoFollow(sixthBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(sixthBridge);
      if (pathExistsNoFollow(seventhBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(seventhBridge);
      if (pathExistsNoFollow(eighthBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(eighthBridge);
      prior.assertUnchanged();
      dispatched.assertUnchanged();
      assertHistoricalRelease();
      originalMarker.assertUnchanged();
      firstForwardMarker.assertUnchanged();
      firstForwardDisposition.assertUnchanged();
      publication.assertUnchanged();
      registered.assertCurrent();
      assertTarget();
      const qualifiedAgain = await qualifySource({
        environment: "integration",
        commit: invocation.commit,
      });
      if (qualifiedAgain.dirty || qualifiedAgain.commit !== source.commit)
        throw preflightError("Auth103 current tool source changed before D1 dispatch");
      mkdirSync(bridge, { mode: 0o700 });
      writeSealedJson(markerPath, marker);
      if (
        (bridge === nextBridge ||
          bridge === fourthBridge ||
          bridge === fifthBridge ||
          bridge === sixthBridge ||
          bridge === seventhBridge ||
          bridge === eighthBridge) &&
        assertAuth103CurrentRuntimeThirdCustodyEntries(bridge) !== "dispatched"
      )
        throw mutationError("third runtime dispatch custody incomplete");
      // One POST /query transaction; never issue its statements individually.
      const acknowledged = await sendAuth103CurrentAtomicQuery({
        accountId: target.accountId,
        databaseId: target.d1.databaseId,
        token: credential.token,
        sql: compiled.sql,
      });
      assertAuth103CurrentRuntimePairAck(
        acknowledged,
        compiled.guardCount,
        pair,
        compiled.postGuardCount,
        rpReferencePair,
      );
      const after = await readD1SchemaState(database);
      if (
        JSON.stringify(after.applied) !== JSON.stringify(snapshot.applied) ||
        !applicationSchemaMatches(after, shapes.postShape)
      )
        throw verificationError("Auth103 current schema changed after D1 registration");
      await readPostimage("verification");
      const served = await inspectCanonicalWorkerVersionWithScriptIdentity(
        "verification",
        target,
        state,
        {},
      );
      if (
        served.history.versionId !== live.history.versionId ||
        served.history.deploymentId !== live.history.deploymentId ||
        served.commit !== live.commit ||
        served.bundleDigestHex !== live.bundleDigestHex ||
        served.scriptEtag !== live.scriptEtag
      )
        throw verificationError("Auth103 current Worker Version changed after D1 registration");
      custody.assertUnchanged();
      firstDispatch?.assertUnchanged();
      firstInstalled?.assertUnchanged();
      secondDispatch?.assertUnchanged();
      secondInstalled?.assertUnchanged();
      thirdDispatch?.assertUnchanged();
      thirdInstalled?.assertUnchanged();
      fourthDispatch?.assertUnchanged();
      fourthInstalled?.assertUnchanged();
      fifthDispatch?.assertUnchanged();
      fifthInstalled?.assertUnchanged();
      sixthDispatch?.assertUnchanged();
      sixthInstalled?.assertUnchanged();
      seventhDispatch?.assertUnchanged();
      seventhInstalled?.assertUnchanged();
      if (firstBridgeExists) assertFirstBridgeEntries();
      if (successorBridgeExists) assertSuccessorBridgeEntries();
      if (fourthBridgeExists) assertAuth103CurrentRuntimeThirdCustodyEntries(fourthBridge);
      if (pathExistsNoFollow(nextBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(nextBridge);
      if (pathExistsNoFollow(fifthBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(fifthBridge);
      if (pathExistsNoFollow(sixthBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(sixthBridge);
      if (pathExistsNoFollow(seventhBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(seventhBridge);
      if (pathExistsNoFollow(eighthBridge))
        assertAuth103CurrentRuntimeThirdCustodyEntries(eighthBridge);
      prior.assertUnchanged();
      dispatched.assertUnchanged();
      assertHistoricalRelease();
      originalMarker.assertUnchanged();
      firstForwardMarker.assertUnchanged();
      firstForwardDisposition.assertUnchanged();
      publication.assertUnchanged();
      registered.assertCurrent();
      assertTarget();
      writeSealedJson(installedPath, installedRecord);
      if (
        bridge === nextBridge ||
        bridge === fourthBridge ||
        bridge === fifthBridge ||
        bridge === sixthBridge ||
        bridge === seventhBridge ||
        bridge === eighthBridge
      ) {
        if (assertAuth103CurrentRuntimeThirdCustodyEntries(bridge) !== "installed")
          throw verificationError("third runtime installed custody incomplete");
      }
      return {
        kind: "takoserver.auth103-current-runtime-registration-apply@v1",
        environment: "integration",
        toolCommit: source.commit,
        deployedCommit: live.commit,
        versionId: live.history.versionId,
        deploymentId: live.history.deploymentId,
        artifactDigest: pair.bundleDigest,
        targetRef: pair.manifest.targetRef,
        sourceRef: pair.manifest.sourceRef,
        currentPairPresent: true,
        rpSuccessorAdded: rpAdded,
        rpOriginalCount: baseRpCount + (rpAdded ? 1 : 0),
        rpReceiptCount: baseRpCount + (rpAdded ? 1 : 0),
        deploymentOriginalCount: baseDeploymentCount + 1,
        deploymentReceiptCount: baseDeploymentCount + 1,
        appendedRows: rpAdded ? 4 : 2,
        appliedCount: after.applied.length,
        pendingCount: 0,
        historicalReceiptDigest: prior.digest,
        markerDigest,
      };
    }
    let custodyPairExact = false;
    if (
      (bridge === nextBridge ||
        bridge === fourthBridge ||
        bridge === fifthBridge ||
        bridge === sixthBridge ||
        bridge === seventhBridge ||
        bridge === eighthBridge) &&
      bridgeExists
    )
      assertAuth103CurrentRuntimeThirdCustodyEntries(bridge);
    if (bridgeExists && markerExists && installedExists) {
      try {
        const savedMarker = readPrivate(markerPath, true);
        const savedInstalled = readPrivate(installedPath, true);
        custodyPairExact =
          bridge === fifthBridge ||
          bridge === sixthBridge ||
          bridge === seventhBridge ||
          bridge === eighthBridge
            ? exactAuth103CurrentRuntimeInstalledCustody(marker, savedMarker, savedInstalled)
            : savedMarker.digest === markerDigest &&
              savedInstalled.digest === digest(`${JSON.stringify(installedRecord, null, 2)}\n`);
      } catch {
        custodyPairExact = false;
      }
    }
    return {
      kind: "takoserver.auth103-current-runtime-registration-status@v1",
      environment: "integration",
      toolCommit: source.commit,
      deployedCommit: live.commit,
      versionId: live.history.versionId,
      deploymentId: live.history.deploymentId,
      artifactDigest: pair.bundleDigest,
      targetRef: pair.manifest.targetRef,
      sourceRef: pair.manifest.sourceRef,
      currentPairPresent: pairPresent,
      predecessorPairPresent: Boolean(predecessorPair),
      rpSuccessorRequired: rpAdded,
      rpOriginalCount: inventory[0]?.rp_originals,
      rpReceiptCount: inventory[0]?.rp_receipts,
      deploymentOriginalCount: inventory[0]?.deployments,
      deploymentReceiptCount: inventory[0]?.deployment_receipts,
      expectedAppendRows: rpAdded ? 4 : 2,
      appliedCount: snapshot.applied.length,
      pendingCount: 0,
      historicalReceiptDigest: prior.digest,
      registrationState: auth103CurrentRuntimeRegistrationState({
        pairPresent,
        pairAbsent,
        bridgeExists,
        custodyPairExact,
      }),
      atomicDispatchQualified: pairAbsent && !bridgeExists,
    };
  } finally {
    registered?.dispose();
    rmSync(scratch, { recursive: true, force: false });
  }
}
