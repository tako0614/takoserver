/**
 * Takoform's Host API v2 HTTP baseline probe against the complete local Worker
 * profile of a real `bun src/entry-bun.ts` Host (pinned workerd, Workflow
 * guard, every private plane and the HTTPS Worker Endpoint listener).
 *
 * The portable lane (`tests/takoform-v2-host-api-conformance.test.ts`) covers
 * the held-artifact Forms without native execution. This opt-in lane adds every
 * complete-profile Form whose Resource needs no other Resource: ModuleWorker,
 * SQLiteDatabase, EdgeKVNamespace, ObjectBucket and AtLeastOnceQueue, and the
 * three artifact Forms again under the complete profile's Worker target.
 * Forms that require references to other Resources (WorkerVersion,
 * WorkerDeployment, WorkerEndpoint, WorkerCronTrigger, ActorNamespace,
 * DurableWorkflow, QueueConsumer, SQLiteMigrationApplication) are not probed.
 *
 * Opt in with TAKOSERVER_V2_ENTRY_NATIVE=1 plus TAKOSERVER_WORKERD_BINARY and
 * TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY. The Endpoint listener binds 443,
 * so run it in a private network namespace, for example
 * `unshare --net sh -c 'ip link set lo up && bun test <this file>'`.
 *
 * A pass means only the probe's mandatory HTTP sequence passed for these
 * fixtures; it does not prove Worker execution, restart durability or any
 * other gap the probe reports as not tested.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode } from "../src/json.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { OBJECT_BUCKET_FORM_URL } from "../src/takoform-v2/forms/object-bucket.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { MODULE_WORKER_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
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

const OPT_IN = process.env.TAKOSERVER_V2_ENTRY_NATIVE;
/** Fixed by the normal entry; the complete profile requires both bundle Forms on it. */
const WORKER_TARGET = "selfhost-v2-worker-primary";
const WORKER_SUFFIX = "workers.conformance.test";

type Json = Record<string, unknown>;

interface Lane {
  readonly probe: RunHostApiV2;
  readonly port: number;
  readonly space: string;
  readonly token: string;
  readonly artifactSpecs: Readonly<Record<string, Json>>;
}

let root: string | null = null;
let host: ConformanceHost | null = null;
let lane: Lane | null = null;

/** Complete local Worker profile environment, as the ordinary journey boots it. */
async function completeProfile(directory: string): Promise<{
  readonly port: number;
  readonly env: Record<string, string>;
}> {
  const workerd = process.env.TAKOSERVER_WORKERD_BINARY;
  const guard = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;
  if (!workerd || !guard) throw new Error("exact native workerd and Workflow guard are required");
  const chosen = new Set<number>([443]);
  const port = await reserveConformancePort(chosen);
  const workerdPort = await reserveConformancePort(chosen);
  const dataPlanePort = await reserveConformancePort(chosen);
  const privatePorts: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    privatePorts.push(await reserveConformancePort(chosen));
  }
  const keys = join(directory, "keys");
  await mkdir(keys, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "staging"), { recursive: true, mode: 0o700 });
  const names = ["sqlite", "kv", "objectBucket", "queue", "queueProducer"] as const;
  const keyFile = (name: string) => join(keys, `${name}.key`);
  for (const [index, name] of names.entries()) {
    await writeFile(keyFile(name), new Uint8Array(32).fill(0x51 + index), { mode: 0o600 });
  }
  const certificateFile = join(directory, "cert.pem");
  const tlsKeyFile = join(directory, "tls.key");
  const openssl = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      tlsKeyFile,
      "-out",
      certificateFile,
      "-days",
      "2",
      "-subj",
      `/CN=*.${WORKER_SUFFIX}`,
      "-addext",
      `subjectAltName=DNS:*.${WORKER_SUFFIX}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await openssl.exited) !== 0) throw new Error("conformance Endpoint certificate unavailable");
  return {
    port,
    env: {
      TAKOSERVER_WORKERD_BINARY: workerd,
      TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY: guard,
      TAKOSERVER_WORKERD_PORT: String(workerdPort),
      TAKOSERVER_DATA_PLANE_PORT: String(dataPlanePort),
      TAKOSERVER_V2_WORKER_RUNTIME_BOOT: JSON.stringify({
        actor: true,
        workflow: { maximumRegistrations: 64 },
      }),
      TAKOSERVER_V2_WORKER_PRIVATE_PLANES: JSON.stringify({
        sqlite: {
          privatePort: privatePorts[0],
          signingKeyFile: keyFile("sqlite"),
          stagingRoot: join(directory, "staging"),
        },
        kv: { privatePort: privatePorts[1], signingKeyFile: keyFile("kv") },
        objectBucket: { privatePort: privatePorts[2], signingKeyFile: keyFile("objectBucket") },
        queue: { privatePort: privatePorts[3], signingKeyFile: keyFile("queue") },
        queueProducer: { privatePort: privatePorts[4], signingKeyFile: keyFile("queueProducer") },
      }),
      TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS: "1",
      TAKOSERVER_WORKER_ENDPOINT_SUFFIX: WORKER_SUFFIX,
      TAKOSERVER_WORKERD_TLS_CERT_FILE: certificateFile,
      TAKOSERVER_WORKERD_TLS_KEY_FILE: tlsKeyFile,
      TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: JSON.stringify({
        current: {
          id: "conformance-fixture",
          key: base64UrlEncode(new Uint8Array(32).fill(0x6c)),
        },
      }),
    },
  };
}

describe.skipIf(OPT_IN !== "1")(
  "Takoform Host API v2 HTTP baseline against the complete native Worker profile",
  () => {
    beforeAll(async () => {
      const probe = await loadPinnedHostApiV2Probe();
      root = await mkdtemp(join(tmpdir(), "tfn-"));
      const profile = await completeProfile(root);
      const { space, token } = await bootstrapConformanceOwner(root, profile.port);
      const { migration, bundle, assets } = await seedArtifactFormFixtures(root, space);
      host = await startConformanceHost(
        root,
        profile.port,
        {
          ...CONFORMANCE_DOCUMENTATION,
          sqliteMigrationSet: {
            targetKey: "conformance-local-sqlite-v1",
            heldArtifacts: migration.held,
          },
          workerBundle: { targetKey: WORKER_TARGET, heldArtifacts: bundle.held },
          staticAssetBundle: { targetKey: WORKER_TARGET, heldArtifacts: assets.held },
        },
        profile.env,
      );
      lane = {
        probe,
        port: profile.port,
        space,
        token,
        artifactSpecs: {
          [SQLITE_MIGRATION_SET_FORM_URL]: migration.spec,
          [WORKER_BUNDLE_FORM_URL]: bundle.spec,
          [STATIC_ASSET_BUNDLE_FORM_URL]: assets.spec,
        },
      };
    }, 180_000);

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

    const cases: readonly (readonly [string, string, Json | null])[] = [
      ["ModuleWorker", MODULE_WORKER_FORM_URL, {}],
      ["SQLiteDatabase", SQLITE_DATABASE_FORM_URL, {}],
      ["EdgeKVNamespace", EDGE_KV_NAMESPACE_FORM_URL, {}],
      ["ObjectBucket", OBJECT_BUCKET_FORM_URL, {}],
      ["AtLeastOnceQueue", AT_LEAST_ONCE_QUEUE_FORM_URL, { messageRetentionSeconds: 3_600 }],
      // null: the seeded held-artifact spec of this lane's Host.
      ["SQLiteMigrationSet", SQLITE_MIGRATION_SET_FORM_URL, null],
      ["WorkerBundle", WORKER_BUNDLE_FORM_URL, null],
      ["StaticAssetBundle", STATIC_ASSET_BUNDLE_FORM_URL, null],
    ];
    for (const [label, form, fixed] of cases) {
      test(`${label} passes the mandatory v2 HTTP baseline`, async () => {
        if (!lane) throw new Error("conformance Host was not prepared");
        const spec = fixed ?? lane.artifactSpecs[form];
        if (!spec) throw new Error(`no fixture spec for ${form}`);
        const result = await runHostApiV2Baseline(lane.probe, {
          port: lane.port,
          token: lane.token,
          space: lane.space,
          form,
          name: `native-${label.toLowerCase()}`,
          spec,
          expectedSpec: spec,
        });
        expect(result).toEqual(BASELINE_PASSED);
      }, 90_000);
    }
  },
);
