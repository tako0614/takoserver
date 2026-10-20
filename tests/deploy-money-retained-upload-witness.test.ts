import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRetainedInactiveUploadWitness } from "../scripts/deploy/schema-money-unit-owner.ts";

// The original maintenance Worker binds no secret, but an inactive normal
// Version uploaded with --secrets-file leaves its names in the script store.
// The witness accepts exactly those names only when the retained upload's
// custody, signing genesis and a GET of the uploaded Version all agree.
const WORKER = "integration-money-0123456789abcdef0123456789abcdef";
const VERSION = "0ab5a89f-3769-439e-a63a-95e77e5832c3";
const NAMES = ["TAKOSERVER_SIGNING_KEY", "TAKOSERVER_TAKOFORM_V2_CURSOR_KEY"];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function retainedRoot(options: { names?: string[]; genesisNames?: string[]; extra?: string } = {}) {
  const parent = mkdtempSync(join(tmpdir(), "retained-upload-"));
  roots.push(parent);
  const root = join(parent, "money-inactive-normal-version");
  mkdirSync(join(root, "CUSTODY"), { recursive: true });
  mkdirSync(join(root, "build-owner"));
  for (const name of options.names ?? NAMES) writeFileSync(join(root, "CUSTODY", name), "x");
  writeFileSync(join(root, "INTENT.json"), "{}");
  writeFileSync(join(root, "REQUEST.json"), "{}");
  writeFileSync(
    join(root, "SIGNING-GENESIS.json"),
    JSON.stringify({ secretNames: options.genesisNames ?? NAMES }),
  );
  writeFileSync(
    join(root, "wrangler-version-upload.jsonl"),
    `${JSON.stringify({
      type: "version-upload",
      version: 1,
      worker_name: WORKER,
      worker_tag: null,
      version_id: VERSION,
      preview_url: null,
      preview_alias_url: null,
      worker_name_overridden: false,
      timestamp: "2026-10-18T00:00:00.000Z",
    })}\n`,
  );
  if (options.extra !== undefined) writeFileSync(join(root, options.extra), "");
  return root;
}

const version = (names: readonly string[]) => ({
  id: VERSION,
  resources: {
    bindings: [
      { type: "plain_text", name: "PUBLIC_ORIGIN", text: "https://example.invalid" },
      ...names.map((name) => ({ type: "secret_text", name })),
    ],
  },
});

const witness = (root: string, bound: readonly string[] = NAMES, allowed = NAMES) =>
  readRetainedInactiveUploadWitness({
    root,
    workerName: WORKER,
    allowedNames: allowed,
    workerVersion: async (workerName, versionId) => {
      expect([workerName, versionId]).toEqual([WORKER, VERSION]);
      return version(bound);
    },
  });

test("accepts exactly the retained upload's secret names", async () => {
  const root = retainedRoot();
  const accepted = await witness(root);
  expect(accepted.names).toEqual(NAMES);
  expect(accepted.versionId).toBe(VERSION);
  expect(() => accepted.assertCurrent()).not.toThrow();
  writeFileSync(join(root, "CUSTODY", NAMES[0] ?? ""), "changed");
  expect(() => accepted.assertCurrent()).toThrow("retained inactive upload");
});

test("refuses without a retained root, with extra entries or with drifting names", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "retained-upload-")), "absent");
  roots.push(missing);
  await expect(witness(missing)).rejects.toThrow("retained inactive upload");
  await expect(witness(retainedRoot({ extra: "LATE.json" }))).rejects.toThrow(
    "retained inactive upload",
  );
  await expect(witness(retainedRoot({ genesisNames: [NAMES[0] ?? ""] }))).rejects.toThrow(
    "retained inactive upload",
  );
  await expect(witness(retainedRoot(), [NAMES[0] ?? ""])).rejects.toThrow(
    "retained inactive upload",
  );
  await expect(
    witness(retainedRoot({ names: [...NAMES, "STRIPE_SECRET_KEY"] }), NAMES),
  ).rejects.toThrow("retained inactive upload");
  // Names outside the normal target's own secret profile are never accepted.
  await expect(witness(retainedRoot(), NAMES, [NAMES[0] ?? ""])).rejects.toThrow(
    "retained inactive upload",
  );
});
