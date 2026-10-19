import {
  AUTH103_NATIVE_CURRENT_PREDICATE,
  AUTH103_NATIVE_DEPLOYMENT_QUERY,
  AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE,
  AUTH103_NATIVE_PROFILE,
  AUTH103_NATIVE_PROJECTED_CATALOG_QUERY,
  AUTH103_NATIVE_REGISTRATION_QUERY,
  AUTH103_NATIVE_RP_REGISTRATION_QUERY,
  type Auth103NativeSourceManifest,
  auth103RpRegistrationRecord,
} from "./auth103-native-source-contract.ts";
import { readAuth103SourceClock } from "./auth103-source-clock.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { type Row, type Sql, SqlError, type SqlParam } from "./ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "./shared-auth-oidc-client.ts";
import type { SharedAuthFinancialProofReceiver } from "./shared-auth-session.ts";
import type {
  WorkerRequestFinancialInputs,
  WorkerRequestSql,
} from "./worker-request-composition.ts";

// Only the owning build replaces this identifier with its checked code literal.
// There is no environment-string, argument or JSON fallback. Ordinary builds
// retain no qualifier until canonical103 is registered in the source checkout.
declare const __TAKOSERVER_AUTH103_NATIVE_SOURCE__: Auth103NativeSourceManifest | null;
declare const __TAKOSERVER_AUTH103_NATIVE_PROFILE__: unknown;
const selectedProfile =
  typeof __TAKOSERVER_AUTH103_NATIVE_PROFILE__ === "undefined"
    ? null
    : __TAKOSERVER_AUTH103_NATIVE_PROFILE__;
const selected =
  typeof __TAKOSERVER_AUTH103_NATIVE_SOURCE__ === "undefined"
    ? null
    : __TAKOSERVER_AUTH103_NATIVE_SOURCE__;

export interface Auth103NativeRequestOrigin {
  readonly opaqueAuth103NativeRequestOrigin: unique symbol;
}
export interface Auth103NativeRequestOriginData {
  readonly authSchemaRef: string;
  readonly targetRef: string;
  readonly sourceRef: string;
  readonly clockPolicyRef: string;
}
interface Original {
  readonly connection: WorkerRequestSql;
  readonly inputs: WorkerRequestFinancialInputs;
  readonly query: Sql["query"];
  readonly run: Sql["run"];
  readonly batch: Sql["batch"];
  readonly manifest: Auth103NativeSourceManifest;
  readonly assertPlatform: (connection: WorkerRequestSql, sourceCommit: string) => void;
  readonly catalogSnapshotJson: string;
  readonly readInputs: (connection: WorkerRequestSql) => WorkerRequestFinancialInputs;
  readonly artifactDigest: string;
  readonly deploymentRef: string;
  readonly deploymentRecordJson: string;
  readonly rpRecordJson: string;
}
const originals = new WeakMap<object, Original>();
function unavailable(): never {
  throw new SqlError("unavailable", "Auth103 native source origin is unavailable");
}
function own(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return unavailable();
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property === undefined || !("value" in property)) return unavailable();
  return property.value;
}
function method<T extends (...args: never[]) => unknown>(value: unknown, key: string): T {
  const result = own(value, key);
  if (typeof result !== "function") return unavailable();
  return result as T;
}
function manifest(): Auth103NativeSourceManifest {
  if (selected === null || own(selected, "version") !== 1) return unavailable();
  const fields = [
    "sourceRef",
    "targetRef",
    "authSchemaRef",
    "catalogDigest",
    "registrationRef",
    "recipeDigest",
    "clockSourceDigest",
    "clockPolicyRef",
  ];
  if (!/^[0-9a-f]{40}$/u.test(String(own(selected, "sourceCommit")))) return unavailable();
  for (const key of fields) {
    const value = own(selected, key);
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return unavailable();
  }
  const rp = own(selected, "rpRegistration");
  for (const key of [
    "registrationRef",
    "registrationDigest",
    "receiptRef",
    "issuerSourceRef",
    "configDigest",
  ]) {
    const value = own(rp, key);
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return unavailable();
  }
  const profile = own(rp, "profile");
  if (profile === null || typeof profile !== "object" || Object.keys(profile).length !== 5)
    return unavailable();
  for (const key of Object.keys(SHARED_AUTH_STAGING_PROFILE)) {
    if (own(profile, key) !== own(SHARED_AUTH_STAGING_PROFILE, key)) return unavailable();
  }
  const projection = own(selected, "catalogProjection");
  if (
    !Array.isArray(projection) ||
    projection.length < 7 ||
    projection.length > 1024 ||
    Object.keys(projection).length !== projection.length
  )
    return unavailable();
  const seen = new Set<string>();
  for (let index = 0; index < projection.length; index++) {
    const entry = own(projection, String(index));
    if (!Array.isArray(entry) || entry.length !== 3 || Object.keys(entry).length !== 3)
      return unavailable();
    const tuple = [own(entry, "0"), own(entry, "1"), own(entry, "2")];
    if (tuple.some((cell) => typeof cell !== "string" || cell.length === 0)) return unavailable();
    const encoded = JSON.stringify(tuple);
    if (seen.has(encoded)) return unavailable();
    seen.add(encoded);
  }
  return selected;
}
/** Code-selected branch only, never a caller permission/ready flag. */
export function auth103NativeSourceCodeSelected(): boolean {
  if (selectedProfile === null) return false;
  if (selectedProfile !== AUTH103_NATIVE_PROFILE) return unavailable();
  manifest();
  return true;
}

function assertOriginal(original: Original): void {
  // The platform binding, not a caller-provided WorkerEnv, selects the target.
  original.assertPlatform(original.connection, original.manifest.sourceCommit);
  const current = original.readInputs(original.connection);
  const prior = original.inputs;
  if (
    current.sql !== prior.sql ||
    current.client !== prior.client ||
    current.realm !== prior.realm ||
    current.clock !== prior.clock ||
    current.writerEpoch !== prior.writerEpoch ||
    own(current.sql, "query") !== original.query ||
    own(current.sql, "run") !== original.run ||
    own(current.sql, "batch") !== original.batch ||
    readAuth103SourceClock(current.clock) === null
  )
    unavailable();
}
function rows(value: readonly Row[], keys: readonly string[]): readonly Row[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return unavailable();
  return Object.freeze(
    value.map((row, index) => {
      if (
        !Object.hasOwn(value, index) ||
        row === null ||
        typeof row !== "object" ||
        Object.keys(row).length !== keys.length
      )
        return unavailable();
      const detached: Record<string, string | null> = {};
      for (const key of keys) {
        const cell = own(row, key);
        if (cell !== null && typeof cell !== "string") return unavailable();
        detached[key] = cell;
      }
      return Object.freeze(detached);
    }),
  );
}
async function query(
  original: Original,
  sql: string,
  keys: readonly string[],
  params?: readonly SqlParam[],
) {
  assertOriginal(original);
  const result = await Reflect.apply(
    original.query,
    original.inputs.sql,
    params === undefined ? [sql] : [sql, params],
  );
  assertOriginal(original);
  return rows(result, keys);
}
function registration(original: Original, result: readonly Row[]): void {
  const row = result[0];
  if (
    result.length !== 1 ||
    row === undefined ||
    row.registration_ref !== original.manifest.registrationRef ||
    row.recipe_digest !== original.manifest.recipeDigest ||
    row.clock_source_digest !== original.manifest.clockSourceDigest ||
    row.clock_policy_ref !== original.manifest.clockPolicyRef
  )
    unavailable();
}
function currentness(original: Original, catalogJson: string) {
  const { registrationRef, recipeDigest, clockSourceDigest, clockPolicyRef, rpRegistration } =
    original.manifest;
  return Object.freeze({
    sql: `(${AUTH103_NATIVE_CURRENT_PREDICATE}) AND (${AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE})`,
    params: Object.freeze([
      registrationRef,
      recipeDigest,
      clockSourceDigest,
      clockPolicyRef,
      catalogJson,
      original.deploymentRef,
      original.deploymentRecordJson,
      rpRegistration.registrationRef,
      rpRegistration.registrationDigest,
      original.rpRecordJson,
    ]),
  });
}

/**
 * Native source/target/Clock origin only. This consumes a real request graph;
 * it is not a credential, human binding, current-admission or Financial grant.
 * It never opens a second Sql/session and performs no registration or writes.
 */
export async function qualifyAuth103NativeRequestOrigin(
  connection: WorkerRequestSql,
): Promise<Auth103NativeRequestOrigin> {
  try {
    if (!auth103NativeSourceCodeSelected()) return unavailable();
    const selectedManifest = manifest();
    const composition = await import("./worker-request-composition.ts");
    const inputs = composition.readWorkerRequestNativeInitializationInputs(connection);
    const queryMethod = method<Sql["query"]>(inputs.sql, "query");
    const runMethod = method<Sql["run"]>(inputs.sql, "run");
    const batchMethod = method<Sql["batch"]>(inputs.sql, "batch");
    // Lazy lookup keeps ordinary Bun/Node module loading portable. The only
    // positive path still obtains env from the actual platform builtin itself.
    const platform = await import("./auth103-native-platform-origin.ts");
    const initial: Original = Object.freeze({
      connection,
      inputs,
      query: queryMethod,
      run: runMethod,
      batch: batchMethod,
      manifest: selectedManifest,
      assertPlatform: platform.assertAuth103NativePlatformOrigin,
      catalogSnapshotJson: "",
      readInputs: composition.readWorkerRequestNativeInitializationInputs,
      artifactDigest: platform.readAuth103NativePlatformArtifactDigest(
        connection,
        selectedManifest.sourceCommit,
      ),
      deploymentRef: "",
      deploymentRecordJson: "",
      rpRecordJson: "",
    });
    assertOriginal(initial);
    const deploymentRef = await canonicalDigest([
      "takoserver.auth103.native-deployment.v1",
      selectedManifest.targetRef,
      selectedManifest.sourceRef,
      initial.artifactDigest,
    ]);
    assertOriginal(initial);
    const deploymentReceiptRef = await canonicalDigest([
      "takoserver.auth103.native-deployment-receipt.v1",
      deploymentRef,
    ]);
    assertOriginal(initial);
    const rpRecordJson = canonicalJson(auth103RpRegistrationRecord(selectedManifest));
    const deploymentRecordJson = canonicalJson({
      receiptRef: deploymentReceiptRef,
      manifest: selectedManifest,
      artifactDigest: initial.artifactDigest,
      rpRecordJson,
    });
    const original: Original = Object.freeze({
      ...initial,
      deploymentRef,
      deploymentRecordJson,
      rpRecordJson,
    });
    assertOriginal(original);
    const keys = ["registration_ref", "recipe_digest", "clock_source_digest", "clock_policy_ref"];
    registration(original, await query(original, AUTH103_NATIVE_REGISTRATION_QUERY, keys));
    const deployments = await query(
      original,
      AUTH103_NATIVE_DEPLOYMENT_QUERY,
      [
        "deployment_ref",
        "target_ref",
        "source_ref",
        "artifact_digest",
        "record_json",
        "receipt_ref",
      ],
      [selectedManifest.targetRef, selectedManifest.sourceRef, original.artifactDigest],
    );
    const deployed = deployments[0];
    if (
      deployments.length !== 1 ||
      deployed?.deployment_ref !== deploymentRef ||
      deployed.record_json !== deploymentRecordJson ||
      deployed.receipt_ref !== deploymentReceiptRef
    )
      return unavailable();
    const rp = selectedManifest.rpRegistration;
    const rpRows = await query(
      original,
      AUTH103_NATIVE_RP_REGISTRATION_QUERY,
      ["registration_ref", "registration_digest", "record_json", "receipt_ref"],
      [rp.registrationRef, rp.registrationDigest],
    );
    if (
      rpRows.length !== 1 ||
      rpRows[0]?.record_json !== rpRecordJson ||
      rpRows[0]?.receipt_ref !== rp.receiptRef
    )
      return unavailable();
    const catalog = await query(
      original,
      AUTH103_NATIVE_PROJECTED_CATALOG_QUERY,
      ["type", "name", "tbl_name", "sql"],
      [JSON.stringify(selectedManifest.catalogProjection)],
    );
    const digest = await canonicalDigest(catalog);
    assertOriginal(original);
    if (digest !== selectedManifest.catalogDigest) return unavailable();
    const catalogSnapshotJson = JSON.stringify(catalog);
    const final = currentness(original, catalogSnapshotJson);
    registration(
      original,
      await query(
        original,
        `${AUTH103_NATIVE_REGISTRATION_QUERY.replace(" ORDER BY registration_ref COLLATE BINARY", "")} WHERE ${final.sql}`,
        keys,
        final.params,
      ),
    );
    assertOriginal(original);
    const capture = Object.freeze({}) as Auth103NativeRequestOrigin;
    originals.set(capture, Object.freeze({ ...original, catalogSnapshotJson }));
    return capture;
  } catch {
    return unavailable();
  }
}

export function readAuth103NativeRequestOrigin(
  capture: unknown,
  connection: WorkerRequestSql,
): Auth103NativeRequestOriginData | null {
  if (capture === null || typeof capture !== "object") return null;
  const original = originals.get(capture);
  if (original === undefined || original.connection !== connection) return null;
  assertOriginal(original);
  const { authSchemaRef, targetRef, sourceRef, clockPolicyRef } = original.manifest;
  return Object.freeze({ authSchemaRef, targetRef, sourceRef, clockPolicyRef });
}

/** Original code-selected platform binding only; absence is an unavailable proof path. */
export async function captureAuth103NativeFinancialProofReceiver(
  capture: Auth103NativeRequestOrigin,
  connection: WorkerRequestSql,
): Promise<SharedAuthFinancialProofReceiver | null> {
  const original = originals.get(capture);
  if (original === undefined || original.connection !== connection) return unavailable();
  assertOriginal(original);
  const platform = await import("./auth103-native-platform-origin.ts");
  const receiver = platform.readAuth103NativeFinancialProofReceiver(
    connection,
    original.manifest.sourceCommit,
  );
  assertOriginal(original);
  return receiver;
}

/**
 * Fixed data expression for an owning mandatory last statement on the SAME Sql.
 * The expression is not an issuance/admission grant and must never be executed
 * as a separate pre-check followed by an unguarded write. Static backing/Clock
 * must also be read again at every surrounding await boundary.
 */
export function auth103NativeRequestCurrentness(
  capture: unknown,
  connection: WorkerRequestSql,
): Readonly<{ sql: string; params: readonly SqlParam[] }> {
  if (readAuth103NativeRequestOrigin(capture, connection) === null) return unavailable();
  const original =
    capture !== null && typeof capture === "object" ? originals.get(capture) : undefined;
  if (original === undefined || original.catalogSnapshotJson.length === 0) return unavailable();
  return currentness(original, original.catalogSnapshotJson);
}

export function readAuth103NativeRpRegistrationOriginal(
  capture: unknown,
  connection: WorkerRequestSql,
) {
  const native = readAuth103NativeRequestOrigin(capture, connection);
  if (native === null || capture === null || typeof capture !== "object") return null;
  const original = originals.get(capture);
  if (original === undefined) return null;
  const rp = original.manifest.rpRegistration;
  return Object.freeze({
    registrationRef: rp.registrationRef,
    registrationDigest: rp.registrationDigest,
    issuerSourceRef: rp.issuerSourceRef,
    profile: SHARED_AUTH_STAGING_PROFILE,
    native,
  });
}

/** Portable lazy bridge for the code-selected startup transport DATA. It does
 * not qualify a graph, source, credential or RP callback. */
export async function captureAuth103NativeRpTransportInputs(): Promise<
  Readonly<{
    clientSecret: string;
    sessionEncryptionKey: string;
  }>
> {
  if (!auth103NativeSourceCodeSelected()) return unavailable();
  const platform = await import("./auth103-native-platform-origin.ts");
  return platform.readAuth103NativeRpTransportInputs();
}
