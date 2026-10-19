import { env } from "cloudflare:workers";
import { SqlError } from "./ports.ts";
import type { SharedAuthFinancialProofReceiver } from "./shared-auth-session.ts";
import {
  assertWorkerRequestNativeBinding,
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
