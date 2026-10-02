import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildApp } from "../../../src/app.ts";
import { buildEdgeForms } from "../../../src/edge-forms.ts";
import { migrateSqlite } from "../../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../../src/objects-fs.ts";
import type { ProviderRuntimeInputLeasePort } from "../../../src/provider-runtime-input-port.ts";
import { createSelfhostContainerBootstrap } from "../../../src/selfhost-container-bootstrap.ts";
import { ensureSigningKey } from "../../../src/signing-key.ts";
import { createSqliteSql } from "../../../src/sql-sqlite.ts";
import { createStandaloneProviderComposition } from "../../../src/standalone-provider-composition.ts";
import { createTakoformArtifacts } from "../../../src/takoform/artifacts.ts";
import { currentTakoformCandidates } from "../../../src/takoform/current-candidates.ts";
import type { WorkerdRuntime } from "../../../src/workerd-runtime.ts";
import { loadVerifiedLocalContainerCandidate } from "../selfhost-container-host-authority.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const root = required("TAKOSERVER_NATIVE_CONTAINER_TEST_ROOT");
const formArtifact = required("TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT");
const databasePath = join(root, "control.sqlite");
const dataRoot = join(root, "provider-data");
const objects = createFileObjectStore({ root: join(root, "objects") });
await mkdir(root, { recursive: true, mode: 0o700 });
const database = new Database(databasePath);
migrateSqlite(database);
const sql = createSqliteSql(database);
const signingKey = await ensureSigningKey({
  keyId: "native-container-host-test",
  path: join(root, "signing-key.json"),
  sql,
  async readFile(path) {
    try {
      return await Bun.file(path).text();
    } catch {
      return null;
    }
  },
  async writeFile(path, contents) {
    await Bun.write(path, contents);
  },
});
const localCandidate = await loadVerifiedLocalContainerCandidate(formArtifact);
const candidates = currentTakoformCandidates();
const forms = [...candidates.forms, localCandidate.form];
const bootstrap = createSelfhostContainerBootstrap({
  environment: {
    TAKOSERVER_SELFHOST_CONTAINER_DOCKER_SOCKET: required(
      "TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET",
    ),
    TAKOSERVER_SELFHOST_CONTAINER_NETWORK: required("TAKOSERVER_NATIVE_CONTAINER_NETWORK"),
  },
  dataRoot,
  providerMode: "stable-selfhost",
});
if (!bootstrap) throw new Error("native Container Host bootstrap did not configure");
const providerArtifacts = {
  async manifest() {
    return null;
  },
  async blob() {
    return null;
  },
};
const artifactTransport = createTakoformArtifacts({
  sql,
  objects,
  clock: () => new Date(),
  randomId: () => crypto.randomUUID(),
});
const workerd: WorkerdRuntime = {
  async inspectModule(input) {
    return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
  },
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return false;
  },
};
const composition = createStandaloneProviderComposition({
  mode: "stable-selfhost",
  stableForms: forms,
  edge: await buildEdgeForms(),
  dataRoot,
  runtime: workerd,
  container: {
    runtime: bootstrap.runtime,
    capacityProfile: bootstrap.capacityProfile,
  },
  workerRuntimeAvailable: false,
  artifacts: providerArtifacts,
  now: new Date(),
  runtimeInputs: {
    async acquire(): Promise<never> {
      throw new Error("ContainerService must not acquire a Worker runtime-input lease");
    },
    async recover(): Promise<never> {
      throw new Error("ContainerService must not recover a Worker runtime-input lease");
    },
    async abandon() {},
  } satisfies ProviderRuntimeInputLeasePort,
});
const app = buildApp({
  sql,
  objects,
  publicOrigin: "http://container-host-native.test",
  forms,
  bindings: candidates.bindings,
  hostForms: forms,
  hostBindings: candidates.bindings,
  ...composition,
  artifacts: artifactTransport,
  signingKey,
  identity: {
    async verify() {
      return {
        providerSubject: "container-native-owner",
        email: "container-native-owner@example.test",
        displayName: "Container native test owner",
      };
    },
  },
  settlement: {
    async verify() {
      throw new Error("zero-cost local Offering must not require settlement");
    },
  },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return app.fetch(request);
  },
});
process.stdout.write(`READY ${server.port}\n`);
