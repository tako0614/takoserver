import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";

export const EVIDENCE_DIRECTORY = resolve(REPOSITORY, ".deploy/evidence");
export const EVIDENCE_LEDGER = resolve(EVIDENCE_DIRECTORY, "published.jsonl");

/**
 * One append-only record per publication. It binds published bytes to a commit
 * and an account and never contains a grant token, private key, or object byte.
 */
export interface EvidenceRecord {
  readonly publishedAt: string;
  readonly commit: string;
  readonly branch: string;
  readonly remoteUrl: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly versionId: string;
  readonly previousVersionId: string | null;
  readonly bundleDigest: string;
  readonly bundleBytes: number;
  /**
   * Digest of the realized configuration: the bindings, routes, and public
   * variables the bundle runs under. Recorded because a deployment is the
   * bytes *and* what they are wired to, and changing only the wiring is a real
   * change that must publish.
   */
  readonly configDigest: string;
  readonly migrationDigest: string;
  readonly migrationFiles: readonly string[];
  readonly d1DatabaseId: string;
  readonly r2BucketName: string;
  readonly publicOrigin: string;
  readonly grantKeyId: string;
  readonly postConditions: readonly string[];
}

export function readLedger(): readonly EvidenceRecord[] {
  let raw: string;
  try {
    raw = readFileSync(EVIDENCE_LEDGER, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvidenceRecord;
      } catch {
        throw preflightError(`evidence ledger line ${index + 1} is not valid JSON`);
      }
    });
}

export function appendLedger(record: EvidenceRecord): void {
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true, mode: 0o700 });
  appendFileSync(EVIDENCE_LEDGER, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * Guards published identity. A recorded version id belongs to exactly one
 * bundle digest forever; a served version already recorded for these bytes
 * means the target is current and nothing may be republished over it.
 */
export function assertPublishedIdentity(
  ledger: readonly EvidenceRecord[],
  servedVersionId: string | null,
  bundleDigest: string,
  configDigest: string,
): { readonly alreadyCurrent: boolean } {
  if (servedVersionId === null) return { alreadyCurrent: false };

  const served = ledger.filter((record) => record.versionId === servedVersionId);
  const digests = new Set(served.map((record) => record.bundleDigest));
  if (digests.size > 1) {
    throw preflightError(
      `evidence conflict: version ${servedVersionId} is recorded for more than one bundle digest`,
      served.map((record) => `${record.publishedAt} ${record.bundleDigest}`).join("\n"),
    );
  }
  // Current means these bytes running under this wiring. Comparing only the
  // bytes reports a configuration change as already deployed, which is how
  // somebody turns a feature on, sees "nothing was published", and believes
  // it is live. A record written before configuration was tracked has no
  // digest to match, so the next publish goes out — which is the safe answer.
  return {
    alreadyCurrent:
      digests.has(bundleDigest) && served.some((r) => r.configDigest === configDigest),
  };
}
