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
const originalFinancialProve: unknown =
  originalFinancialProof !== null &&
  (typeof originalFinancialProof === "object" || typeof originalFinancialProof === "function")
    ? Reflect.get(originalFinancialProof, "prove")
    : undefined;
const originalFinancialProofPrototype =
  originalFinancialProof !== null &&
  (typeof originalFinancialProof === "object" || typeof originalFinancialProof === "function")
    ? Object.getPrototypeOf(originalFinancialProof)
    : undefined;
const originalFinancialProveOwnDescriptor =
  originalFinancialProof !== null &&
  (typeof originalFinancialProof === "object" || typeof originalFinancialProof === "function")
    ? Object.getOwnPropertyDescriptor(originalFinancialProof, "prove")
    : undefined;
const originalFinancialProvePrototypeDescriptor =
  originalFinancialProofPrototype !== null &&
  (typeof originalFinancialProofPrototype === "object" ||
    typeof originalFinancialProofPrototype === "function")
    ? Object.getOwnPropertyDescriptor(originalFinancialProofPrototype, "prove")
    : undefined;
// Workerd RPC stubs can return a fresh callable on every property read. The
// first callable remains the only one invoked; ordinary stable JS methods
// retain exact identity checks, while native dynamic stubs require no shadow.
const originalFinancialProveStable =
  typeof originalFinancialProve === "function" &&
  originalFinancialProof !== null &&
  (typeof originalFinancialProof === "object" || typeof originalFinancialProof === "function") &&
  Reflect.get(originalFinancialProof, "prove") === originalFinancialProve;

function assertOriginalFinancialProof(): void {
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
    typeof originalFinancialProve !== "function" ||
    Object.getPrototypeOf(originalFinancialProof) !== originalFinancialProofPrototype
  )
    throw new SqlError("unavailable", "Auth103 Accounts proof transport is unavailable");
  const currentMethod = Reflect.get(originalFinancialProof, "prove");
  if (originalFinancialProveStable) {
    if (currentMethod !== originalFinancialProve)
      throw new SqlError("unavailable", "Auth103 Accounts proof transport is unavailable");
  } else if (
    typeof currentMethod !== "function" ||
    originalFinancialProveOwnDescriptor !== undefined ||
    Object.getOwnPropertyDescriptor(originalFinancialProof, "prove") !== undefined ||
    originalFinancialProofPrototype === null ||
    originalFinancialProvePrototypeDescriptor !== undefined ||
    Object.getOwnPropertyDescriptor(originalFinancialProofPrototype, "prove") !== undefined
  ) {
    throw new SqlError("unavailable", "Auth103 Accounts proof transport is unavailable");
  }
}

/** The native source alone can obtain this fixed RPC adapter; no raw binding leaves. */
export function readAuth103NativeFinancialProofReceiver(
  connection: WorkerRequestSql,
  sourceCommit: string,
): SharedAuthFinancialProofReceiver | null {
  assertAuth103NativePlatformOrigin(connection, sourceCommit);
  if (originalFinancialProof === undefined) return null;
  assertOriginalFinancialProof();
  return Object.freeze({
    async prove(input: { readonly accessToken: string; readonly challengeRef: string }) {
      assertAuth103NativePlatformOrigin(connection, sourceCommit);
      assertOriginalFinancialProof();
      const method = originalFinancialProve;
      if (typeof method !== "function")
        throw new SqlError("unavailable", "Auth103 Accounts proof transport is unavailable");
      try {
        return await Reflect.apply(method, originalFinancialProof, [input]);
      } finally {
        assertAuth103NativePlatformOrigin(connection, sourceCommit);
        assertOriginalFinancialProof();
      }
    },
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
