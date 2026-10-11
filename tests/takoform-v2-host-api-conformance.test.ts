/**
 * Takoform's own Host API v2 HTTP baseline probe against a real self-host Host.
 *
 * The probe is vendored byte-exact and pinned (see
 * `tests/helpers/takoform-v2-host-api-conformance.ts`); this portable lane boots
 * a real `bun src/entry-bun.ts` process on loopback, without native Worker
 * execution, and runs the probe once per Form that profile supports: the three
 * held-artifact Forms. The complete Worker profile needs the pinned workerd
 * artifact and runs in the opt-in native lane
 * (`tests/takoform-v2-host-api-conformance-native.test.ts`).
 *
 * A pass means only the probe's mandatory HTTP sequence passed for these
 * fixtures. The probe itself reports restart durability, fault injection,
 * concurrency, cross-principal authority, optional features and Form-specific
 * behavior as not tested; this file does not claim them either.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  BASELINE_PASSED,
  bootstrapConformanceOwner,
  CONFORMANCE_DOCUMENTATION,
  type ConformanceHost,
  loadPinnedHostApiV2Probe,
  type RunHostApiV2,
  reserveConformancePort,
  runHostApiV2Baseline,
  seedArtifactFormFixtures,
  startConformanceHost,
  stopConformanceHost,
} from "./helpers/takoform-v2-host-api-conformance.ts";

interface Lane {
  readonly probe: RunHostApiV2;
  readonly port: number;
  readonly space: string;
  readonly token: string;
  readonly specs: Readonly<Record<string, Record<string, unknown>>>;
}

let root: string | null = null;
let host: ConformanceHost | null = null;
let lane: Lane | null = null;

describe("Takoform Host API v2 HTTP baseline against the normal Bun entry", () => {
  beforeAll(async () => {
    const probe = await loadPinnedHostApiV2Probe();
    root = await mkdtemp(join(tmpdir(), "tf-v2-conformance-"));
    const port = await reserveConformancePort(new Set());
    const { space, token } = await bootstrapConformanceOwner(root, port);
    const { migration, bundle, assets } = await seedArtifactFormFixtures(root, space);
    host = await startConformanceHost(root, port, {
      ...CONFORMANCE_DOCUMENTATION,
      sqliteMigrationSet: {
        targetKey: "conformance-local-sqlite-v1",
        heldArtifacts: migration.held,
      },
      workerBundle: { targetKey: "conformance-worker-bundle-v1", heldArtifacts: bundle.held },
      staticAssetBundle: {
        targetKey: "conformance-static-assets-v1",
        heldArtifacts: assets.held,
      },
    });
    lane = {
      probe,
      port,
      space,
      token,
      specs: {
        [SQLITE_MIGRATION_SET_FORM_URL]: migration.spec,
        [WORKER_BUNDLE_FORM_URL]: bundle.spec,
        [STATIC_ASSET_BUNDLE_FORM_URL]: assets.spec,
      },
    };
  }, 120_000);

  afterAll(async () => {
    try {
      await stopConformanceHost(host);
    } finally {
      host = null;
      lane = null;
      if (root) await rm(root, { recursive: true, force: true });
      root = null;
    }
  });

  for (const [label, form] of [
    ["SQLiteMigrationSet", SQLITE_MIGRATION_SET_FORM_URL],
    ["WorkerBundle", WORKER_BUNDLE_FORM_URL],
    ["StaticAssetBundle", STATIC_ASSET_BUNDLE_FORM_URL],
  ] as const) {
    test(`${label} passes the mandatory v2 HTTP baseline`, async () => {
      if (!lane) throw new Error("conformance Host was not prepared");
      const spec = lane.specs[form];
      if (!spec) throw new Error(`no fixture spec for ${form}`);
      const result = await runHostApiV2Baseline(lane.probe, {
        port: lane.port,
        token: lane.token,
        space: lane.space,
        form,
        name: `conformance-${label.toLowerCase()}`,
        spec,
        expectedSpec: spec,
      });
      expect(result).toEqual(BASELINE_PASSED);
    }, 60_000);
  }
});
