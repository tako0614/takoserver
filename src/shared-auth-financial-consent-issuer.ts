import { bytesDigest, canonicalJson } from "./json.ts";
import type { Row, Sql, SqlParam } from "./ports.ts";
import {
  inspectSharedAuthFinancialConsentLeafSchema,
  SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS,
} from "./shared-auth-financial-consent-schema-plan.ts";
import { readSharedAuthFinancialRequestNativeObservationData } from "./shared-auth-financial-source.ts";
import {
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";

/** The independent RP consent issuer's code-selected original. It does not
 * borrow Auth103's RP registration or Financial's action-source registration.
 * The digest is raw custody of this canonical original, not a new external
 * consent-digest recipe. No caller chooses or changes this source.
 */
const issuerOriginal = Object.freeze({
  version: "takoserver-shared-financial-action-consent-issuer-v1",
  registrationRef: "shared-financial-action-consent-rp",
  incarnation: "1",
  purpose: "rp-explicit-action-consent",
});
const issuerOriginalJson = canonicalJson(issuerOriginal);
const issuerOriginalBytes = new TextEncoder().encode(issuerOriginalJson);

// A lost INSERT acknowledgement must not turn a later positive absence into a
// second write on the same request-owned connection, including a new factory.
// This is a deny-only fence; it never establishes a registration or consent.
const attemptedRegistration = new WeakSet<WorkerRequestSql>();

export interface SharedAuthFinancialConsentIssuerOriginal {
  readonly registrationRef: string;
  readonly registrationDigest: `sha256:${string}`;
  readonly incarnation: string;
}

export interface SharedAuthFinancialConsentIssuerCurrentness {
  readonly sql: string;
  readonly params: readonly SqlParam[];
  readonly original: SharedAuthFinancialConsentIssuerOriginal;
}

export class SharedAuthFinancialConsentIssuerUnavailable extends Error {
  readonly code = "unavailable" as const;
  constructor() {
    super("shared_auth_financial_consent_issuer_unavailable");
    this.name = "SharedAuthFinancialConsentIssuerUnavailable";
  }
}

function unavailable(): never {
  throw new SharedAuthFinancialConsentIssuerUnavailable();
}

function ownMethod<T extends object, K extends keyof T>(receiver: T, key: K): T[K] {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function")
    return unavailable();
  return descriptor.value;
}

function oneExactRow(rows: readonly Row[], digest: string): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (!row) return false;
  const fields = Object.getOwnPropertyDescriptors(row);
  return (
    Reflect.ownKeys(fields).length === 4 &&
    fields.registration_ref?.value === issuerOriginal.registrationRef &&
    fields.incarnation?.value === issuerOriginal.incarnation &&
    fields.registration_digest?.value === digest &&
    fields.original_json?.value === issuerOriginalJson
  );
}

/** Source-only, unmounted RP issuer registration and current reader. A valid
 * Root observation is required for every call, including registration. The
 * registration is an independent immutable row on that same Sql; an unknown
 * write never retries and grants no consent. The returned tuple alone is DATA.
 */
export function createSharedAuthFinancialConsentIssuerSource(connection: WorkerRequestSql) {
  const inputs = readWorkerRequestFinancialInputs(connection);
  const graph = readWorkerRequestConsumers(connection);
  const sql = inputs.sql;
  const query = ownMethod(sql, "query");
  const run = ownMethod(sql, "run");
  const batch = ownMethod(sql, "batch");

  function assertOrigin(request: Request, workspaceId: string, observation: unknown): void {
    try {
      if (
        readWorkerRequestFinancialInputs(connection) !== inputs ||
        readWorkerRequestConsumers(connection) !== graph ||
        connection.sql !== sql ||
        graph.sql !== sql ||
        graph.realm !== inputs.realm ||
        graph.client !== inputs.client ||
        ownMethod(sql, "query") !== query ||
        ownMethod(sql, "run") !== run ||
        ownMethod(sql, "batch") !== batch
      )
        unavailable();
      readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
    } catch {
      unavailable();
    }
  }

  async function digestUnderOrigin(
    request: Request,
    workspaceId: string,
    observation: unknown,
  ): Promise<`sha256:${string}`> {
    assertOrigin(request, workspaceId, observation);
    const digest = await bytesDigest(issuerOriginalBytes);
    assertOrigin(request, workspaceId, observation);
    return digest;
  }

  async function currentRow(
    request: Request,
    workspaceId: string,
    observation: unknown,
    digest: string,
  ): Promise<boolean> {
    assertOrigin(request, workspaceId, observation);
    let rows: readonly Row[];
    try {
      rows = await Reflect.apply(query, sql, [
        `SELECT registration_ref,incarnation,registration_digest,original_json FROM ${SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS} WHERE registration_ref=? AND incarnation=? LIMIT 2`,
        [issuerOriginal.registrationRef, issuerOriginal.incarnation],
      ]);
    } catch {
      return unavailable();
    }
    assertOrigin(request, workspaceId, observation);
    if (!Array.isArray(rows) || rows.length > 1) return unavailable();
    if (rows.length === 0) return false;
    if (!oneExactRow(rows, digest)) return unavailable();
    return true;
  }

  async function assertLeaf(
    request: Request,
    workspaceId: string,
    observation: unknown,
  ): Promise<void> {
    assertOrigin(request, workspaceId, observation);
    const status = await inspectSharedAuthFinancialConsentLeafSchema(sql);
    assertOrigin(request, workspaceId, observation);
    if (status !== "leaf-present") unavailable();
  }

  async function registerOriginal(
    request: Request,
    workspaceId: string,
    observation: unknown,
  ): Promise<SharedAuthFinancialConsentIssuerOriginal> {
    const digest = await digestUnderOrigin(request, workspaceId, observation);
    await assertLeaf(request, workspaceId, observation);
    if (!(await currentRow(request, workspaceId, observation, digest))) {
      assertOrigin(request, workspaceId, observation);
      if (attemptedRegistration.has(connection)) unavailable();
      attemptedRegistration.add(connection);
      try {
        const write = (await Reflect.apply(run, sql, [
          `INSERT INTO ${SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS} (registration_ref,incarnation,registration_digest,original_json) VALUES (?,?,?,?)`,
          [issuerOriginal.registrationRef, issuerOriginal.incarnation, digest, issuerOriginalJson],
        ])) as Awaited<ReturnType<Sql["run"]>>;
        assertOrigin(request, workspaceId, observation);
        if (write.changes !== 1) unavailable();
      } catch {
        // A lost acknowledgement permits only exact-original GET. Even if this
        // read finds positive absence, the attempt fence prevents a retry.
        try {
          await currentRow(request, workspaceId, observation, digest);
        } catch {
          // The original outcome is still unknown and grants no authority.
        }
        return unavailable();
      }
      if (!(await currentRow(request, workspaceId, observation, digest))) unavailable();
    }
    return Object.freeze({
      registrationRef: issuerOriginal.registrationRef,
      registrationDigest: digest,
      incarnation: issuerOriginal.incarnation,
    });
  }

  async function readCurrentOriginal(
    request: Request,
    workspaceId: string,
    observation: unknown,
  ): Promise<SharedAuthFinancialConsentIssuerOriginal> {
    const digest = await digestUnderOrigin(request, workspaceId, observation);
    await assertLeaf(request, workspaceId, observation);
    if (!(await currentRow(request, workspaceId, observation, digest))) unavailable();
    return Object.freeze({
      registrationRef: issuerOriginal.registrationRef,
      registrationDigest: digest,
      incarnation: issuerOriginal.incarnation,
    });
  }

  async function currentness(
    request: Request,
    workspaceId: string,
    observation: unknown,
  ): Promise<SharedAuthFinancialConsentIssuerCurrentness> {
    const original = await readCurrentOriginal(request, workspaceId, observation);
    assertOrigin(request, workspaceId, observation);
    return Object.freeze({
      sql: `EXISTS(SELECT 1 FROM ${SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS} WHERE registration_ref=? AND incarnation=? AND registration_digest=? AND original_json=?)`,
      params: Object.freeze([
        original.registrationRef,
        original.incarnation,
        original.registrationDigest,
        issuerOriginalJson,
      ]),
      original,
    });
  }

  return Object.freeze({ registerOriginal, readCurrentOriginal, currentness });
}
