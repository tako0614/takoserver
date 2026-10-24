import { env } from "cloudflare:workers";
import {
  AUTH103_NATIVE_MONEY_GUARD_OBJECT_NAMES,
  AUTH103_NATIVE_MONEY_STRIPE_CUSTOMER_TABLES,
  AUTH103_NATIVE_MONEY_WRITER_EPOCH_PATTERN,
  AUTH103_NATIVE_MONEY_WRITER_POLICY,
  AUTH103_NATIVE_PROFILE,
  type Auth103NativeBuildProfile,
} from "./auth103-native-source-contract.ts";
import { SqlError } from "./ports.ts";
import type { SharedAuthFinancialProofReceiver } from "./shared-auth-session.ts";
import {
  assertWorkerRequestNativeBinding,
  readWorkerRequestWriterEpochOrigin,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";

// Eagerly imported ONLY by the actual native entry, before handling requests.
// Retain the binding value now: a later withEnv() scope must not select a target.
const bindingProperty = Object.getOwnPropertyDescriptor(env, "STATE_DB");
const originalDatabase =
  bindingProperty !== undefined && "value" in bindingProperty ? bindingProperty.value : undefined;
const sourceProperty = Object.getOwnPropertyDescriptor(env, "TAKOSERVER_SOURCE_COMMIT");
const originalSourceCommit =
  sourceProperty !== undefined && "value" in sourceProperty ? sourceProperty.value : undefined;
const artifactProperty = Object.getOwnPropertyDescriptor(env, "TAKOSERVER_WORKER_ARTIFACT_DIGEST");
const originalArtifactDigest =
  artifactProperty !== undefined && "value" in artifactProperty
    ? artifactProperty.value
    : undefined;
const moneyPolicyProperty = Object.getOwnPropertyDescriptor(
  env,
  "TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY",
);
const originalMoneyPolicy =
  moneyPolicyProperty !== undefined && "value" in moneyPolicyProperty
    ? moneyPolicyProperty.value
    : undefined;
const moneyEpochProperty = Object.getOwnPropertyDescriptor(
  env,
  "TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH",
);
const moneySelectionDescriptorsAreData =
  (moneyPolicyProperty === undefined || "value" in moneyPolicyProperty) &&
  (moneyEpochProperty === undefined || "value" in moneyEpochProperty);
const originalMoneyEpoch =
  moneyEpochProperty !== undefined && "value" in moneyEpochProperty
    ? moneyEpochProperty.value
    : undefined;
declare const __TAKOSERVER_AUTH103_NATIVE_PROFILE__: unknown;
const selectedProfileLiteral =
  typeof __TAKOSERVER_AUTH103_NATIVE_PROFILE__ === "undefined"
    ? null
    : __TAKOSERVER_AUTH103_NATIVE_PROFILE__;
function captureSelectedSourceProfile(): Auth103NativeBuildProfile | null {
  if (
    selectedProfileLiteral === null ||
    typeof selectedProfileLiteral !== "object" ||
    Array.isArray(selectedProfileLiteral) ||
    Object.keys(selectedProfileLiteral).length !== 2
  )
    return null;
  const profile = Object.getOwnPropertyDescriptor(selectedProfileLiteral, "profile");
  const sourceProfile = Object.getOwnPropertyDescriptor(selectedProfileLiteral, "sourceProfile");
  if (
    profile === undefined ||
    !("value" in profile) ||
    profile.value !== AUTH103_NATIVE_PROFILE ||
    sourceProfile === undefined ||
    !("value" in sourceProfile) ||
    (sourceProfile.value !== "ordinary" && sourceProfile.value !== "money-preserved")
  )
    return null;
  return Object.freeze({
    profile: AUTH103_NATIVE_PROFILE,
    sourceProfile: sourceProfile.value,
  });
}
const selectedSourceProfile = captureSelectedSourceProfile();

// This logical binding is projected only by the private selected Host recipe.
// Capture the module-load platform value before any request-scoped withEnv().
const financialProofProperty = Object.getOwnPropertyDescriptor(env, "ACCOUNTS_FINANCIAL_PROOF");
const originalFinancialProof: unknown =
  financialProofProperty !== undefined && "value" in financialProofProperty
    ? financialProofProperty.value
    : undefined;
const originalFinancialProofPrototype =
  originalFinancialProof !== null &&
  (typeof originalFinancialProof === "object" || typeof originalFinancialProof === "function")
    ? Object.getPrototypeOf(originalFinancialProof)
    : undefined;

type FinancialProofMethodName =
  | "prove"
  | "loadFinancialIdentityProof"
  | "verifyCurrentFinancialIdentityProof";

// Workerd RPC stubs can return a fresh callable on every property read. The
// first callable remains the only one invoked; ordinary stable JS methods
// retain exact identity checks, while native dynamic stubs require no shadow.
function captureFinancialProofMethod(name: FinancialProofMethodName) {
  const target =
    originalFinancialProof !== null &&
    (typeof originalFinancialProof === "object" || typeof originalFinancialProof === "function")
      ? originalFinancialProof
      : undefined;
  const method: unknown = target === undefined ? undefined : Reflect.get(target, name);
  const ownDescriptor =
    target === undefined ? undefined : Object.getOwnPropertyDescriptor(target, name);
  const prototypeDescriptor =
    originalFinancialProofPrototype !== null &&
    (typeof originalFinancialProofPrototype === "object" ||
      typeof originalFinancialProofPrototype === "function")
      ? Object.getOwnPropertyDescriptor(originalFinancialProofPrototype, name)
      : undefined;
  const stable =
    typeof method === "function" && target !== undefined && Reflect.get(target, name) === method;
  return Object.freeze({ name, method, ownDescriptor, prototypeDescriptor, stable });
}
type FinancialProofMethod = ReturnType<typeof captureFinancialProofMethod>;

// prove keeps its original import-time behaviour. A throwing load/current read
// leaves that method absent instead of withdrawing prove from the native entry.
function captureOptionalFinancialProofMethod(name: FinancialProofMethodName) {
  try {
    return captureFinancialProofMethod(name);
  } catch {
    return Object.freeze({
      name,
      method: undefined,
      ownDescriptor: undefined,
      prototypeDescriptor: undefined,
      stable: false,
    });
  }
}

const originalFinancialProve = captureFinancialProofMethod("prove");
const originalFinancialProofLoad = captureOptionalFinancialProofMethod(
  "loadFinancialIdentityProof",
);
const originalFinancialProofCurrent = captureOptionalFinancialProofMethod(
  "verifyCurrentFinancialIdentityProof",
);

function assertOriginalFinancialProof(
  captured: FinancialProofMethod = originalFinancialProve,
): void {
  const selected = Object.getOwnPropertyDescriptor(env, "ACCOUNTS_FINANCIAL_PROOF");
  if (
    originalFinancialProof === undefined ||
    selected === undefined ||
    !("value" in selected) ||
    selected.value !== originalFinancialProof ||
    selected.configurable !== financialProofProperty?.configurable ||
    selected.enumerable !== financialProofProperty?.enumerable ||
    selected.writable !== financialProofProperty?.writable ||
    originalFinancialProof === null ||
    (typeof originalFinancialProof !== "object" && typeof originalFinancialProof !== "function") ||
    typeof captured.method !== "function" ||
    Object.getPrototypeOf(originalFinancialProof) !== originalFinancialProofPrototype
  )
    throw new SqlError("unavailable", "Auth103 Accounts proof transport is unavailable");
  const currentMethod = Reflect.get(originalFinancialProof, captured.name);
  if (captured.stable) {
    if (currentMethod !== captured.method)
      throw new SqlError("unavailable", "Auth103 Accounts proof transport is unavailable");
  } else if (
    typeof currentMethod !== "function" ||
    captured.ownDescriptor !== undefined ||
    Object.getOwnPropertyDescriptor(originalFinancialProof, captured.name) !== undefined ||
    originalFinancialProofPrototype === null ||
    captured.prototypeDescriptor !== undefined ||
    Object.getOwnPropertyDescriptor(originalFinancialProofPrototype, captured.name) !== undefined
  ) {
    throw new SqlError("unavailable", "Auth103 Accounts proof transport is unavailable");
  }
}

/** The native source alone can obtain this fixed RPC adapter; no raw binding leaves.
 * Each method forwards its single caller input unchanged to the module-load callable.
 * load/current are omitted when a plain binding lacked them at load; a Workerd RPC
 * stub answers every name, so there they always appear and absence fails remotely.
 */
export function readAuth103NativeFinancialProofReceiver(
  connection: WorkerRequestSql,
  sourceCommit: string,
): SharedAuthFinancialProofReceiver | null {
  assertAuth103NativePlatformOrigin(connection, sourceCommit);
  if (originalFinancialProof === undefined) return null;
  assertOriginalFinancialProof();
  const invoke = async (captured: FinancialProofMethod, input: unknown): Promise<unknown> => {
    assertAuth103NativePlatformOrigin(connection, sourceCommit);
    assertOriginalFinancialProof(captured);
    const method = captured.method;
    if (typeof method !== "function")
      throw new SqlError("unavailable", "Auth103 Accounts proof transport is unavailable");
    try {
      return await Reflect.apply(method, originalFinancialProof, [input]);
    } finally {
      assertAuth103NativePlatformOrigin(connection, sourceCommit);
      assertOriginalFinancialProof(captured);
    }
  };
  const proofReference = (captured: FinancialProofMethod) =>
    typeof captured.method === "function"
      ? (input: {
          readonly v: 1;
          readonly proofRef: string;
          readonly challengeRef: string;
        }): Promise<unknown> => invoke(captured, input)
      : undefined;
  const load = proofReference(originalFinancialProofLoad);
  const current = proofReference(originalFinancialProofCurrent);
  return Object.freeze({
    prove: (input: { readonly accessToken: string; readonly challengeRef: string }) =>
      invoke(originalFinancialProve, input),
    ...(load === undefined ? {} : { loadFinancialIdentityProof: load }),
    ...(current === undefined ? {} : { verifyCurrentFinancialIdentityProof: current }),
  });
}

// Dedicated original platform transports, captured before request withEnv()
// scopes. Their bytes remain internal DATA and never become a native witness.
const clientSecretProperty = Object.getOwnPropertyDescriptor(
  env,
  "TAKOSERVER_SHARED_AUTH_CLIENT_SECRET",
);
const originalClientSecret: unknown =
  clientSecretProperty !== undefined && "value" in clientSecretProperty
    ? clientSecretProperty.value
    : undefined;
const sessionKeyProperty = Object.getOwnPropertyDescriptor(
  env,
  "TAKOSERVER_SHARED_AUTH_SESSION_ENCRYPTION_KEY",
);
const originalSessionKey: unknown =
  sessionKeyProperty !== undefined && "value" in sessionKeyProperty
    ? sessionKeyProperty.value
    : undefined;

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function readAuth103NativeRpTransportInputs(): Readonly<{
  clientSecret: string;
  sessionEncryptionKey: string;
}> {
  if (
    typeof originalClientSecret !== "string" ||
    originalClientSecret.length === 0 ||
    originalClientSecret.length > 8192 ||
    containsAsciiControl(originalClientSecret) ||
    typeof originalSessionKey !== "string" ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(originalSessionKey)
  )
    throw new SqlError("unavailable", "Auth103 native RP transport is unavailable");
  return Object.freeze({
    clientSecret: originalClientSecret,
    sessionEncryptionKey: originalSessionKey,
  });
}

/** No raw binding, Sql, mint, setter or environment object leaves this module. */
export function assertAuth103NativePlatformOrigin(
  connection: WorkerRequestSql,
  sourceCommit: string,
): void {
  if (
    originalDatabase === undefined ||
    (originalSourceCommit !== undefined && originalSourceCommit !== sourceCommit)
  )
    throw new SqlError("unavailable", "Auth103 native platform origin is unavailable");
  assertWorkerRequestNativeBinding(connection, originalDatabase);
  const writerEpoch = readWorkerRequestWriterEpochOrigin(connection);
  if (
    selectedSourceProfile === null ||
    !moneySelectionDescriptorsAreData ||
    (selectedSourceProfile.sourceProfile === "ordinary"
      ? writerEpoch !== undefined ||
        originalMoneyPolicy !== undefined ||
        originalMoneyEpoch !== undefined
      : originalMoneyPolicy !== AUTH103_NATIVE_MONEY_WRITER_POLICY ||
        typeof originalMoneyEpoch !== "string" ||
        !AUTH103_NATIVE_MONEY_WRITER_EPOCH_PATTERN.test(originalMoneyEpoch) ||
        writerEpoch !== originalMoneyEpoch)
  )
    throw new SqlError("unavailable", "Auth103 native Money writer selection differs");
}

/** The selected code profile also pins the physical D1 Money guard generation. */
export async function assertAuth103NativeSourceProfileSchema(
  connection: WorkerRequestSql,
  sourceCommit: string,
): Promise<void> {
  assertAuth103NativePlatformOrigin(connection, sourceCommit);
  const names = AUTH103_NATIVE_MONEY_GUARD_OBJECT_NAMES;
  const rows = await connection.sql.query(
    `SELECT name FROM main.sqlite_schema WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY name`,
    names,
  );
  const present = new Set(rows.map((row) => row.name));
  if (selectedSourceProfile?.sourceProfile === "ordinary" && present.size !== 0) {
    throw new SqlError("unavailable", "Auth103 ordinary source profile differs from D1");
  }
  if (selectedSourceProfile?.sourceProfile === "money-preserved") {
    const optionalStripe = new Set(
      AUTH103_NATIVE_MONEY_STRIPE_CUSTOMER_TABLES.flatMap((table) =>
        ["insert", "update", "delete"].map((verb) => `money_cutover_fence_${table}_${verb}`),
      ),
    );
    const required = names.filter((name) => !optionalStripe.has(name));
    const stripePresent = [...optionalStripe].filter((name) => present.has(name));
    if (
      originalMoneyEpoch === undefined ||
      required.some((name) => !present.has(name)) ||
      (stripePresent.length !== 0 && stripePresent.length !== optionalStripe.size)
    )
      throw new SqlError("unavailable", "Auth103 Money source profile differs from D1");
  } else if (selectedSourceProfile?.sourceProfile !== "ordinary") {
    throw new SqlError("unavailable", "Auth103 Money source profile differs from D1");
  }
  assertAuth103NativePlatformOrigin(connection, sourceCommit);
}

/** Captured from the owning final config; never accepts a caller ref argument. */
export function readAuth103NativePlatformArtifactDigest(
  connection: WorkerRequestSql,
  sourceCommit: string,
): string {
  assertAuth103NativePlatformOrigin(connection, sourceCommit);
  if (
    typeof originalArtifactDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(originalArtifactDigest)
  )
    throw new SqlError("unavailable", "Auth103 native artifact origin is unavailable");
  return originalArtifactDigest;
}
