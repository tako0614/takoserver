import {
  type Accounts,
  type ApiKeyAdministration,
  AuthError,
  assertVerifiedLocalPrincipalIssuanceReader,
  createAccountsWithLocalIssuerStorage,
  type ExternalIdentityVerifier,
  type RetainedDirectOwnerSessionReader,
  type VerifiedLocalPrincipalIssuanceReader,
} from "./auth.ts";
import {
  type Auth103NativeRequestOrigin,
  auth103NativeRequestCurrentness,
  readAuth103NativeRequestOrigin,
} from "./auth103-native-origin-source.ts";
import {
  assertIdentityVerificationCaptureReader,
  type IdentityVerificationCaptureReader,
} from "./identity-setup.ts";
import { type Row, type Sql, SqlError, type SqlWrite } from "./ports.ts";
import type { WorkerRequestSql } from "./worker-request-composition.ts";

// Construction custody only, not an issuer/source witness. Failed attempts are not retried.
const qualifiedLocalConstructions = new WeakSet<WorkerRequestSql>();

/**
 * Original native initializer only. The caller cannot select Sql, Clock, target,
 * source refs or a replacement verifier callback through this constructor.
 * Enrollment remains a fresh local sign-in, never a Financial permission grant.
 */
export async function createAccountsWithQualifiedLocalIssuer(
  connection: WorkerRequestSql,
  nativeOrigin: Auth103NativeRequestOrigin,
  options: {
    readonly identity: ExternalIdentityVerifier & IdentityVerificationCaptureReader;
    readonly apiKeyAdministration?: ApiKeyAdministration;
  },
): Promise<Accounts & RetainedDirectOwnerSessionReader & VerifiedLocalPrincipalIssuanceReader> {
  const native = readAuth103NativeRequestOrigin(nativeOrigin, connection);
  if (!native) throw new AuthError("invalid");
  if (qualifiedLocalConstructions.has(connection)) throw new AuthError("invalid");
  qualifiedLocalConstructions.add(connection);
  const assertNative = (): void => {
    const current = readAuth103NativeRequestOrigin(nativeOrigin, connection);
    if (
      !current ||
      current.authSchemaRef !== native.authSchemaRef ||
      current.targetRef !== native.targetRef ||
      current.sourceRef !== native.sourceRef ||
      current.clockPolicyRef !== native.clockPolicyRef
    )
      throw new AuthError("invalid");
  };
  // The owning initializer captures the actual constructor tuple before any
  // Accounts exists. Dynamic import avoids auth -> composition -> auth cycles.
  const composition = await import("./worker-request-composition.ts");
  const readInputs = composition.readWorkerRequestNativeInitializationInputs;
  const inputs = readInputs(connection);
  assertNative();
  if (
    !options ||
    typeof options !== "object" ||
    (Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null) ||
    Reflect.ownKeys(options).some((key) => key !== "identity" && key !== "apiKeyAdministration")
  )
    throw new AuthError("invalid");
  const selected = Object.getOwnPropertyDescriptor(options, "identity");
  const administration = Object.getOwnPropertyDescriptor(options, "apiKeyAdministration");
  if (!selected || !("value" in selected) || (administration && !("value" in administration)))
    throw new AuthError("invalid");
  const identity = selected.value;
  assertIdentityVerificationCaptureReader(identity);
  const capture = Object.getOwnPropertyDescriptor(identity, "captureVerifiedIdentity");
  const inspect = Object.getOwnPropertyDescriptor(identity, "inspectVerifiedIdentityCapture");
  if (
    !capture ||
    !("value" in capture) ||
    typeof capture.value !== "function" ||
    !inspect ||
    !("value" in inspect) ||
    typeof inspect.value !== "function"
  )
    throw new AuthError("invalid");
  const sql = inputs.sql;
  const clock = inputs.clock;
  const query = Object.getOwnPropertyDescriptor(sql, "query");
  const run = Object.getOwnPropertyDescriptor(sql, "run");
  const batch = Object.getOwnPropertyDescriptor(sql, "batch");
  if (
    !query ||
    !("value" in query) ||
    typeof query.value !== "function" ||
    !run ||
    !("value" in run) ||
    typeof run.value !== "function" ||
    !batch ||
    !("value" in batch) ||
    typeof batch.value !== "function"
  )
    throw new AuthError("invalid");
  const assertCurrent = (): void => {
    const current = readInputs(connection);
    if (
      composition.readWorkerRequestNativeInitializationInputs !== readInputs ||
      current !== inputs ||
      current.sql !== sql ||
      current.clock !== clock
    )
      throw new AuthError("invalid");
    assertNative();
    assertIdentityVerificationCaptureReader(identity);
    for (const [name, expected] of [
      ["query", query.value],
      ["run", run.value],
      ["batch", batch.value],
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(sql, name);
      if (!descriptor || !("value" in descriptor) || descriptor.value !== expected)
        throw new AuthError("invalid");
    }
  };
  // Capture actual methods AND receiver. No method/property is re-read between
  // the guard and an awaited store operation, including single-use spending.
  const guardedSql = Object.freeze<Sql>({
    async query(text, params) {
      assertCurrent();
      let rows: readonly Row[];
      try {
        rows = await Reflect.apply(query.value, sql, [text, params]);
      } catch (error) {
        throw new SqlError(
          error instanceof SqlError ? error.code : "unavailable",
          "qualified local issuer store operation failed",
        );
      }
      assertCurrent();
      return rows;
    },
    async run(text, params) {
      assertCurrent();
      let result: SqlWrite;
      try {
        result = await Reflect.apply(run.value, sql, [text, params]);
      } catch (error) {
        throw new SqlError(
          error instanceof SqlError ? error.code : "unavailable",
          "qualified local issuer store operation failed",
        );
      }
      assertCurrent();
      return result;
    },
    async batch(statements) {
      assertCurrent();
      let result: readonly SqlWrite[];
      try {
        result = await Reflect.apply(batch.value, sql, [statements]);
      } catch (error) {
        throw new SqlError(
          error instanceof SqlError ? error.code : "unavailable",
          "qualified local issuer store operation failed",
        );
      }
      assertCurrent();
      return result;
    },
  });
  assertCurrent();
  const currentness = auth103NativeRequestCurrentness(nativeOrigin, connection);
  const accounts = createAccountsWithLocalIssuerStorage(
    {
      sql,
      clock,
      identity,
      ...(administration ? { apiKeyAdministration: administration.value } : {}),
    },
    { targetRef: native.targetRef, sql: guardedSql, currentness },
  );
  assertCurrent();
  assertVerifiedLocalPrincipalIssuanceReader(accounts, { sql });
  return accounts;
}
