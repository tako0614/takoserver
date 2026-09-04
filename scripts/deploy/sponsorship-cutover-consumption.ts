import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type D1Process, RemoteD1, sqlLiteral } from "./d1.ts";
import { type DeployPhase, preflightError, verificationError } from "./errors.ts";
import type { DeployTarget } from "./target.ts";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SponsorshipCutoverOperationStart {
  readonly operationId: string;
  readonly targetSha256: string;
  readonly environment: "integration" | "production";
  readonly stage: "public-route-removal" | "legacy-secret-retirement";
  readonly proofSha256: string;
  readonly predecessorDeploymentId: string;
  readonly predecessorVersionId: string;
  readonly predecessorTopologySha256: string;
  readonly sourceCommit: string;
  readonly bundleSha256: string;
  readonly configSha256: string;
  readonly candidateIdentitySha256: string;
  readonly startedAt: string;
}

export interface SponsorshipCutoverOperationCompletion {
  readonly operationId: string;
  readonly successorDeploymentId: string;
  readonly successorVersionId: string;
  readonly completedAt: string;
}

export interface SponsorshipCutoverConsumptionRecord {
  readonly start: SponsorshipCutoverOperationStart;
  readonly completion: SponsorshipCutoverOperationCompletion | null;
}

export interface SponsorshipCutoverConsumptionDatabase {
  read(
    input: {
      readonly targetSha256: string;
      readonly environment: string;
      readonly stage: string;
      readonly proofSha256: string;
    },
    phase: DeployPhase,
  ): Promise<SponsorshipCutoverConsumptionRecord | null>;
  readByOperationId(
    operationId: string,
    phase: DeployPhase,
  ): Promise<SponsorshipCutoverConsumptionRecord | null>;
  begin(start: SponsorshipCutoverOperationStart): Promise<"inserted" | "existing">;
  complete(completion: SponsorshipCutoverOperationCompletion): Promise<void>;
}

interface CutoverSql {
  query(
    phase: DeployPhase,
    description: string,
    sql: string,
  ): Promise<readonly Record<string, unknown>[]>;
  statement(phase: DeployPhase, description: string, sql: string): Promise<void>;
}

/** The only STATE_DB adapter allowed to mutate sponsorship cutover receipts. */
export function createSponsorshipCutoverConsumptionDatabase(
  sql: CutoverSql,
): SponsorshipCutoverConsumptionDatabase {
  return {
    async read(input, phase) {
      const rows = await sql.query(
        phase,
        `sponsorship cutover ${input.stage} receipt`,
        `SELECT s.operation_id, s.target_sha256, s.environment, s.stage, s.proof_sha256,
                s.predecessor_deployment_id, s.predecessor_version_id,
                s.predecessor_topology_sha256, s.source_commit, s.bundle_sha256,
                s.config_sha256, s.candidate_identity_sha256, s.started_at,
                c.successor_deployment_id, c.successor_version_id, c.completed_at
         FROM sponsorship_cutover_operation_starts AS s
         LEFT JOIN sponsorship_cutover_operation_completions AS c
           ON c.operation_id = s.operation_id
         WHERE s.target_sha256 = ${sqlLiteral(input.targetSha256)}
           AND s.environment = ${sqlLiteral(input.environment)}
           AND s.stage = ${sqlLiteral(input.stage)}
           AND s.proof_sha256 = ${sqlLiteral(input.proofSha256)} LIMIT 2`,
      );
      const [row, ...extra] = rows;
      if (!row) return null;
      if (extra.length !== 0) fail(phase, "duplicate sponsorship cutover receipt");
      return parseRecord(row, phase);
    },
    async readByOperationId(operationId, phase) {
      if (!SHA256.test(operationId)) fail(phase, "sponsorship cutover operation id is invalid");
      const rows = await sql.query(
        phase,
        "sponsorship cutover operation receipt",
        `SELECT s.operation_id, s.target_sha256, s.environment, s.stage, s.proof_sha256,
                s.predecessor_deployment_id, s.predecessor_version_id,
                s.predecessor_topology_sha256, s.source_commit, s.bundle_sha256,
                s.config_sha256, s.candidate_identity_sha256, s.started_at,
                c.successor_deployment_id, c.successor_version_id, c.completed_at
         FROM sponsorship_cutover_operation_starts AS s
         LEFT JOIN sponsorship_cutover_operation_completions AS c
           ON c.operation_id = s.operation_id
         WHERE s.operation_id = ${sqlLiteral(operationId)} LIMIT 2`,
      );
      const [row, ...extra] = rows;
      if (!row) return null;
      if (extra.length !== 0) fail(phase, "duplicate sponsorship cutover operation receipt");
      return parseRecord(row, phase);
    },
    async begin(start) {
      validateStart(start, "preflight");
      const rows = await sql.query(
        "mutation",
        `begin sponsorship cutover ${start.stage}`,
        `INSERT INTO sponsorship_cutover_operation_starts
           (operation_id, target_sha256, environment, stage, proof_sha256,
            predecessor_deployment_id, predecessor_version_id, predecessor_topology_sha256,
            source_commit, bundle_sha256, config_sha256, candidate_identity_sha256, started_at)
         VALUES (${values([
           start.operationId,
           start.targetSha256,
           start.environment,
           start.stage,
           start.proofSha256,
           start.predecessorDeploymentId,
           start.predecessorVersionId,
           start.predecessorTopologySha256,
           start.sourceCommit,
           start.bundleSha256,
           start.configSha256,
           start.candidateIdentitySha256,
           start.startedAt,
         ])})
         ON CONFLICT DO NOTHING
         RETURNING operation_id`,
      );
      if (rows.length === 0) return "existing";
      if (rows.length !== 1 || rows[0]?.operation_id !== start.operationId) {
        throw preflightError("sponsorship cutover start admission readback is invalid");
      }
      return "inserted";
    },
    async complete(completion) {
      validateCompletion(completion, "verification");
      const rows = await sql.query(
        "verification",
        "complete sponsorship cutover operation",
        `INSERT INTO sponsorship_cutover_operation_completions
           (operation_id, successor_deployment_id, successor_version_id, completed_at)
         SELECT ${values([
           completion.operationId,
           completion.successorDeploymentId,
           completion.successorVersionId,
           completion.completedAt,
         ])}
         WHERE EXISTS (
           SELECT 1 FROM sponsorship_cutover_operation_starts
           WHERE operation_id = ${sqlLiteral(completion.operationId)}
         )
         RETURNING operation_id`,
      );
      if (rows.length !== 1 || rows[0]?.operation_id !== completion.operationId) {
        throw verificationError("sponsorship cutover completion has no exact start receipt");
      }
    },
  };
}

export function createRemoteSponsorshipCutoverConsumptionDatabase(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: D1Process,
): SponsorshipCutoverConsumptionDatabase {
  return createSponsorshipCutoverConsumptionDatabase(
    new RemoteD1(configPath, { environment, run }),
  );
}

export function sponsorshipCutoverOperationIdentity(
  value: Omit<
    SponsorshipCutoverOperationStart,
    "operationId" | "startedAt" | "candidateIdentitySha256"
  >,
): { readonly operationId: `sha256:${string}`; readonly candidateIdentitySha256: string } {
  const candidateIdentitySha256 = digest(
    canonicalJson({
      predecessorVersionId: value.predecessorVersionId,
      sourceCommit: value.sourceCommit,
      bundleSha256: value.bundleSha256,
      configSha256: value.configSha256,
      stage: value.stage,
    }),
  );
  return {
    candidateIdentitySha256,
    operationId: digest(canonicalJson({ ...value, candidateIdentitySha256 })),
  };
}

/**
 * Writes the minimal owner-derived Wrangler view used solely by the cutover
 * receipt adapter. The durable authority is the target STATE_DB, never this
 * ephemeral config path, and callers cannot redirect it to another database.
 */
export function writeSponsorshipCutoverConsumptionConfig(
  path: string,
  target: DeployTarget,
): string {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        name: target.workerName,
        account_id: target.accountId,
        compatibility_date: "2026-09-04",
        d1_databases: [
          {
            binding: "STATE_DB",
            database_name: target.d1.databaseName,
            database_id: target.d1.databaseId,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return path;
}

function parseRecord(
  row: Record<string, unknown>,
  phase: DeployPhase,
): SponsorshipCutoverConsumptionRecord {
  const start = {
    operationId: row.operation_id,
    targetSha256: row.target_sha256,
    environment: row.environment,
    stage: row.stage,
    proofSha256: row.proof_sha256,
    predecessorDeploymentId: row.predecessor_deployment_id,
    predecessorVersionId: row.predecessor_version_id,
    predecessorTopologySha256: row.predecessor_topology_sha256,
    sourceCommit: row.source_commit,
    bundleSha256: row.bundle_sha256,
    configSha256: row.config_sha256,
    candidateIdentitySha256: row.candidate_identity_sha256,
    startedAt: row.started_at,
  } as SponsorshipCutoverOperationStart;
  validateStart(start, phase);
  if (
    row.successor_version_id === null &&
    row.successor_deployment_id === null &&
    row.completed_at === null
  ) {
    return { start, completion: null };
  }
  const completion = {
    operationId: start.operationId,
    successorDeploymentId: row.successor_deployment_id,
    successorVersionId: row.successor_version_id,
    completedAt: row.completed_at,
  } as SponsorshipCutoverOperationCompletion;
  validateCompletion(completion, phase);
  return { start, completion };
}

function validateStart(value: SponsorshipCutoverOperationStart, phase: DeployPhase): void {
  if (
    !SHA256.test(value.operationId) ||
    !SHA256.test(value.targetSha256) ||
    (value.environment !== "integration" && value.environment !== "production") ||
    (value.stage !== "public-route-removal" && value.stage !== "legacy-secret-retirement") ||
    !SHA256.test(value.proofSha256) ||
    value.predecessorDeploymentId.length < 1 ||
    !VERSION.test(value.predecessorVersionId) ||
    !SHA256.test(value.predecessorTopologySha256) ||
    !COMMIT.test(value.sourceCommit) ||
    !SHA256.test(value.bundleSha256) ||
    !SHA256.test(value.configSha256) ||
    !SHA256.test(value.candidateIdentitySha256) ||
    !instant(value.startedAt)
  )
    fail(phase, "sponsorship cutover start receipt is invalid");
  const { operationId, startedAt: _startedAt, candidateIdentitySha256, ...identityInput } = value;
  const expected = sponsorshipCutoverOperationIdentity(identityInput);
  if (
    operationId !== expected.operationId ||
    candidateIdentitySha256 !== expected.candidateIdentitySha256
  ) {
    fail(phase, "sponsorship cutover start receipt identity is invalid");
  }
}

function validateCompletion(
  value: SponsorshipCutoverOperationCompletion,
  phase: DeployPhase,
): void {
  if (
    !SHA256.test(value.operationId) ||
    value.successorDeploymentId.length < 1 ||
    !VERSION.test(value.successorVersionId) ||
    !instant(value.completedAt)
  ) {
    fail(phase, "sponsorship cutover completion receipt is invalid");
  }
}

function values(input: readonly string[]): string {
  return input.map(sqlLiteral).join(", ");
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
}
function fail(phase: DeployPhase, message: string): never {
  throw phase === "verification" ? verificationError(message) : preflightError(message);
}
