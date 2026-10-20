import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCompletedReplacementRecords } from "../scripts/deploy/money-normal-worker-version-upload.ts";

/**
 * The first replacement of the Money S3 v2 run completed its upload, then the
 * run ended on a D1 transport failure and its live owner object was lost. A
 * second replacement quarantines that root read-only: only these exact local
 * records, bound to the unknown original, let it proceed to a new root.
 */
const ROOT = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "money-second-replacement-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const expected = {
  versionId: "f6cf1c51-0c5b-4785-ad7c-10ad3ad3fe1c",
  accountId: "a".repeat(32),
  workerName: "integration-money-fixture",
  sourceCommit: "c".repeat(40),
  sourceTreeDigest: sha("tree"),
  moduleDigest: sha("module"),
  publicJwk: '{"kty":"OKP","x":"replacement"}',
  publicJwkDigest: sha('{"kty":"OKP","x":"replacement"}'),
  priorUnknownBindingDigest: sha("unknown-binding"),
  priorUnknownVersionId: "0ab5a89f-0000-4000-8000-000000000000",
  priorUnknownPublicJwk: '{"kty":"OKP","x":"original"}',
};

function completedRoot(
  name: string,
  edit: (records: Record<string, Record<string, unknown>>) => void = () => {},
) {
  const root = join(ROOT, name);
  mkdirSync(root);
  const receipt = {
    kind: "takoserver.money-inactive-normal-version-upload@v1",
    qualification: "immutable-version-only",
    selectorPath: join(root, "normal-worker.selector.json"),
    versionId: expected.versionId,
    sourceCommit: expected.sourceCommit,
    modeBindingDigest: sha("mode"),
  };
  const records: Record<string, Record<string, unknown>> = {
    receipt,
    selector: {
      kind: "takoserver.money-normal-worker-selector@v1",
      versionId: expected.versionId,
      sourceCommit: expected.sourceCommit,
      moduleDigest: expected.moduleDigest,
      accountId: expected.accountId,
      workerName: expected.workerName,
    },
    seal: {
      kind: "takoserver.money-inactive-version-replacement-dispatch-seal@v1",
      originalUnknownBindingDigest: expected.priorUnknownBindingDigest,
      originalCandidateDigest: sha(expected.priorUnknownVersionId),
      accountId: expected.accountId,
      workerName: expected.workerName,
      sourceCommit: expected.sourceCommit,
      sourceTreeDigest: expected.sourceTreeDigest,
      moduleDigest: expected.moduleDigest,
      publicJwkDigest: expected.publicJwkDigest,
    },
  };
  edit(records);
  writeFileSync(join(root, "UPLOAD-RECEIPT.json"), JSON.stringify(records.receipt));
  writeFileSync(join(root, "RESULT.json"), JSON.stringify(records.receipt));
  writeFileSync(join(root, "normal-worker.selector.json"), JSON.stringify(records.selector));
  writeFileSync(join(root, "REPLACEMENT-DISPATCH-SEAL.json"), JSON.stringify(records.seal));
  return root;
}

test("the exact completed first replacement is accepted for quarantine", () => {
  expect(() => assertCompletedReplacementRecords(completedRoot("exact"), expected)).not.toThrow();
});

test("a foreign, edited or incomplete first replacement refuses the second attempt", () => {
  const refusals: [string, (records: Record<string, Record<string, unknown>>) => void][] = [
    ["other-version", (r) => void ((r.receipt as Record<string, unknown>).versionId = "other")],
    [
      "other-source",
      (r) => void ((r.selector as Record<string, unknown>).sourceCommit = "d".repeat(40)),
    ],
    [
      "other-unknown",
      (r) => void ((r.seal as Record<string, unknown>).originalUnknownBindingDigest = sha("x")),
    ],
    ["other-key", (r) => void ((r.seal as Record<string, unknown>).publicJwkDigest = sha("x"))],
    ["other-worker", (r) => void ((r.selector as Record<string, unknown>).workerName = "other")],
    ["extra-field", (r) => void ((r.receipt as Record<string, unknown>).ready = true)],
    [
      "not-immutable",
      (r) => void ((r.receipt as Record<string, unknown>).qualification = "active"),
    ],
  ];
  for (const [name, edit] of refusals)
    expect(() => assertCompletedReplacementRecords(completedRoot(name, edit), expected)).toThrow(
      "exact completed first replacement",
    );
  const diverged = completedRoot("diverged-result");
  writeFileSync(join(diverged, "RESULT.json"), "{}");
  expect(() => assertCompletedReplacementRecords(diverged, expected)).toThrow(
    "exact completed first replacement",
  );
  const missing = completedRoot("missing-seal");
  rmSync(join(missing, "REPLACEMENT-DISPATCH-SEAL.json"));
  expect(() => assertCompletedReplacementRecords(missing, expected)).toThrow(
    "exact completed first replacement",
  );
  // The second attempt never reuses the earlier Version or key.
  for (const reuse of [
    { ...expected, priorUnknownVersionId: expected.versionId },
    { ...expected, priorUnknownPublicJwk: expected.publicJwk },
  ])
    expect(() =>
      assertCompletedReplacementRecords(
        completedRoot(`reuse-${Math.random()}`, (r) => {
          (r.seal as Record<string, unknown>).originalCandidateDigest = sha(
            reuse.priorUnknownVersionId,
          );
        }),
        reuse,
      ),
    ).toThrow("exact completed first replacement");
});
