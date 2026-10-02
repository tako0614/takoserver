import { createHash } from "node:crypto";
import {
  applicationSchemaMatches,
  deriveExpectedApplicationShape,
} from "./application-schema-shape.ts";
import { buildD1MigrationImport } from "./d1-migration-import.ts";
import { preflightError } from "./errors.ts";
import type { D1SchemaState } from "./migrations.ts";
import { readAuditedMigrationArtifact } from "./schema.ts";
import type { Protected0058AttemptBinding } from "./schema-0058-apply-receipt.ts";
import type { Protected0058Snapshot } from "./schema-0058-proof.ts";
import type { Protected0058TransitionInput } from "./schema-0058-transition.ts";
import { read0058ProtectedReferenceVolumeChain } from "./schema-0058-volume-receipt.ts";

type Target = Protected0058AttemptBinding["target"];

export interface Protected0058ReferenceReader {
  /** Must be bound by the caller to this exact account and D1 credential. */
  readonly target: Target;
  readonly readIdentity: () => Promise<{ readonly uuid: string; readonly name: string }>;
  readonly readState: () => Promise<D1SchemaState>;
  /** Use readProtected0058Snapshot with a read-only D1 adapter for live evidence. */
  readonly readSnapshot: () => Promise<Protected0058Snapshot>;
}

export interface Protected0058ReferenceQualificationInput {
  /** Private receipt prefix; this does not verify the target declaration or attempt-root continuity. */
  readonly custodyPath: string;
  readonly referenceEnvironment: "integration" | "production";
  readonly reference: Protected0058ReferenceReader;
  readonly isolated: Protected0058ReferenceReader;
  /** Source identity must independently come from the owning source qualification. */
  readonly sourceCommit: string;
  readonly remoteRef: string;
  readonly migrationDirectory?: string;
  /** An explicit operator-reviewed capacity target, not a receipt-supplied limit. */
  readonly maxImportElapsedMs: number;
}

export interface Protected0058ReferenceCandidate {
  readonly kind: "takoserver.d1-0058-protected-reference-candidate@v1";
  /** This reflects receipt provenance; it is not independent transport attestation. */
  readonly evidenceClass: "native-receipt-candidate" | "injected-runner-portable-test-only";
  readonly receiptDigest: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly elapsedMs: number;
  /** Input-shaped evidence only; not an all-writer drain or permission to invoke a transition. */
  readonly transitionCandidate: Pick<
    Protected0058TransitionInput,
    "binding" | "importArtifact" | "expectedPostShape"
  >;
}

const TABLES = [
  "cloudflare_managed_worker_receipts",
  "cloudflare_managed_worker_version_execution_material",
  "cloudflare_managed_worker_version_execution_secrets",
  "cloudflare_managed_worker_version_execution_provider_proofs",
] as const;
const MIGRATION = "0058_cloudflare_managed_worker_domain_receipts.sql";
const MAX_RECEIPT_LIFETIME_MS = 60 * 60 * 1000;

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSnapshot(left: Protected0058Snapshot, right: Protected0058Snapshot): boolean {
  return (
    left.digest === right.digest &&
    left.bytes === right.bytes &&
    left.maxBlobBytes === right.maxBlobBytes &&
    left.foreignKeyViolations === 0 &&
    right.foreignKeyViolations === 0 &&
    TABLES.every((table) => left.counts[table] === right.counts[table])
  );
}

async function readBound(
  reader: Protected0058ReferenceReader,
): Promise<{ readonly state: D1SchemaState; readonly snapshot: Protected0058Snapshot }> {
  try {
    const identity = await reader.readIdentity();
    if (
      identity.uuid !== reader.target.databaseId ||
      identity.name !== reader.target.databaseName
    ) {
      throw preflightError("0058 reference candidate D1 identity does not match its exact target");
    }
    return { state: await reader.readState(), snapshot: await reader.readSnapshot() };
  } catch {
    // A remote error can contain raw D1 values. Do not propagate it from this boundary.
    throw preflightError("0058 reference candidate D1 identity or readback is unavailable");
  }
}

/**
 * Consume an already-qualified protected-reference rehearsal receipt as a
 * non-authoritative candidate. This never runs or enables a protected import.
 * The injected readers are only as trustworthy as their caller's credential,
 * target and read-only wiring; portable fakes are not live D1 evidence.
 * Custody-chain parsing does not prove that this prefix is the original
 * isolated target declaration or the stable protected-attempt root.
 */
export async function qualifyProtected0058ReferenceCandidate(
  input: Protected0058ReferenceQualificationInput,
): Promise<Protected0058ReferenceCandidate> {
  const chain = read0058ProtectedReferenceVolumeChain(input.custodyPath);
  const receipt = chain.qualified;
  if (receipt === null || chain.prepared === null || chain.dispatched === null) {
    throw preflightError("0058 protected reference has no complete qualified receipt chain");
  }
  const injected = receipt.qualification === "injected-runner-local-test-only";
  if (
    receipt.qualification !==
      (injected ? "injected-runner-local-test-only" : "protected-reference-candidate-only") ||
    receipt.timingSource !==
      (injected ? "injected-runner-local-test" : "wrangler-remote-command-wall-clock") ||
    receipt.providerAcknowledgement !==
      (injected ? "injected-runner-simulated" : "wrangler-command-ack-observed") ||
    receipt.rollbackProbes !== "both-failed-and-exact-0057-restored"
  ) {
    throw preflightError("0058 protected reference has no matching candidate qualification");
  }
  const now = Date.now();
  const observedAt = Date.parse(receipt.observedAt ?? "");
  const expiresAt = Date.parse(receipt.expiresAt ?? "");
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(input.maxImportElapsedMs) ||
    input.maxImportElapsedMs <= 0 ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    observedAt > now ||
    now >= expiresAt ||
    expiresAt - observedAt > MAX_RECEIPT_LIFETIME_MS ||
    receipt.elapsedMs === undefined ||
    receipt.elapsedMs > input.maxImportElapsedMs
  ) {
    throw preflightError("0058 protected reference receipt is expired or outside the time target");
  }

  const source = readAuditedMigrationArtifact(input.migrationDirectory);
  const prefix = source.files.slice(0, 58);
  const migration = prefix[57];
  if (migration?.name !== MIGRATION || !/^[0-9a-f]{40}$/u.test(input.sourceCommit)) {
    throw preflightError("0058 protected reference source is invalid");
  }
  const imported = buildD1MigrationImport([migration], { freshLedger: false });
  const binding = receipt.binding;
  if (
    binding.referenceEnvironment !== input.referenceEnvironment ||
    !same(binding.referenceTargetD1, input.reference.target) ||
    !same(binding.isolatedTargetD1, input.isolated.target) ||
    (input.reference.target.accountId === input.isolated.target.accountId &&
      input.reference.target.databaseId === input.isolated.target.databaseId) ||
    binding.commit !== input.sourceCommit ||
    binding.remoteRef !== input.remoteRef ||
    binding.prefixDigest !==
      digest(
        JSON.stringify(
          prefix.map(({ name, digest: fileDigest }) => ({ name, digest: fileDigest })),
        ),
      ) ||
    binding.importDigest !== imported.digest ||
    binding.importBytes !== imported.bytes
  ) {
    throw preflightError("0058 protected reference receipt target or audited source changed");
  }

  const expectedPreShape = deriveExpectedApplicationShape(source.files.slice(0, 57));
  const expectedPostShape = deriveExpectedApplicationShape(prefix);
  const referenceBefore = await readBound(input.reference);
  const isolated = await readBound(input.isolated);
  const referenceAfter = await readBound(input.reference);
  if (
    !same(referenceBefore.state.applied, source.names.slice(0, 57)) ||
    !applicationSchemaMatches(referenceBefore.state, expectedPreShape) ||
    referenceBefore.state.shapeDigest !== binding.referenceShapeDigest ||
    !same(referenceAfter.state, referenceBefore.state) ||
    !sameSnapshot(referenceAfter.snapshot, referenceBefore.snapshot) ||
    !same(isolated.state.applied, source.names.slice(0, 58)) ||
    !applicationSchemaMatches(isolated.state, expectedPostShape) ||
    isolated.state.shapeDigest !== receipt.postShapeDigest
  ) {
    throw preflightError("0058 protected reference canonical lineage, shape or readback drifted");
  }
  const reference = referenceBefore.snapshot;
  const fixture = isolated.snapshot;
  if (
    reference.digest !== binding.referenceDigest ||
    !same(reference.counts, binding.referenceCounts) ||
    reference.bytes !== binding.referenceBytes ||
    reference.maxBlobBytes !== binding.referenceMaxBlobBytes ||
    fixture.digest !== binding.fixtureDigest ||
    !same(fixture.counts, binding.fixtureCounts) ||
    fixture.bytes !== binding.fixtureBytes ||
    fixture.maxBlobBytes !== binding.fixtureMaxBlobBytes ||
    reference.foreignKeyViolations !== 0 ||
    fixture.foreignKeyViolations !== 0 ||
    TABLES.every((table) => reference.counts[table] === 0) ||
    TABLES.some((table) => fixture.counts[table] < reference.counts[table]) ||
    fixture.bytes < reference.bytes ||
    fixture.maxBlobBytes < reference.maxBlobBytes
  ) {
    throw preflightError("0058 protected reference rows, sealed bytes or volume bounds changed");
  }
  if (Date.now() >= expiresAt) {
    throw preflightError("0058 protected reference receipt expired during readback");
  }

  return {
    kind: "takoserver.d1-0058-protected-reference-candidate@v1",
    evidenceClass: injected ? "injected-runner-portable-test-only" : "native-receipt-candidate",
    receiptDigest: receipt.digest,
    observedAt: receipt.observedAt as string,
    expiresAt: receipt.expiresAt as string,
    elapsedMs: receipt.elapsedMs,
    transitionCandidate: {
      binding: {
        environment: input.referenceEnvironment,
        target: input.reference.target,
        source: {
          commit: input.sourceCommit,
          prefix: prefix.map(({ name, digest: fileDigest }) => ({ name, digest: fileDigest })),
          importDigest: imported.digest,
          importBytes: imported.bytes,
        },
        before: {
          lineage: referenceBefore.state.applied,
          shapeDigest: referenceBefore.state.shapeDigest,
          snapshot: reference,
        },
      },
      importArtifact: imported,
      expectedPostShape,
    },
  };
}
