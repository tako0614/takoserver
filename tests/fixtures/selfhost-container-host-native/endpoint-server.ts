import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildApp } from "../../../src/app.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "../../helpers/takoform-v2-config.ts";
import { buildEdgeForms } from "../../../src/edge-forms.ts";
import { migrateSqlite } from "../../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../../src/objects-fs.ts";
import type { ProviderRuntimeInputLeasePort } from "../../../src/provider-runtime-input-port.ts";
import { hasExactLocalContainerEndpointCandidatePair } from "../../../src/selfhost-composition.ts";
import { createSelfhostContainerBootstrap } from "../../../src/selfhost-container-bootstrap.ts";
import {
  createSelfhostContainerEndpointHttpsDispatch,
  createSelfhostContainerEndpointHttpsListenerIfSupported,
  verifySelfhostContainerEndpointHttpsHandshake,
} from "../../../src/selfhost-container-endpoint-https.ts";
import { createSelfhostContainerEndpointIngress } from "../../../src/selfhost-container-endpoint-ingress.ts";
import { ensureSigningKey } from "../../../src/signing-key.ts";
import { createSqliteSql } from "../../../src/sql-sqlite.ts";
import { createStandaloneProviderComposition } from "../../../src/standalone-provider-composition.ts";
import { createTakoformArtifacts } from "../../../src/takoform/artifacts.ts";
import { currentTakoformCandidates } from "../../../src/takoform/current-candidates.ts";
import type { WorkerdRuntime } from "../../../src/workerd-runtime.ts";
import { loadVerifiedLocalContainerEndpointCandidate } from "../selfhost-container-endpoint-authority.ts";
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
const serviceCandidate = await loadVerifiedLocalContainerCandidate(formArtifact);
const endpointCandidate = await loadVerifiedLocalContainerEndpointCandidate(
  join(import.meta.dir, "../selfhost-container-endpoint-candidate.json"),
);
const candidates = currentTakoformCandidates();
const forms = [...candidates.forms, serviceCandidate.form, endpointCandidate.form];
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
const tlsDirectory = join(root, "endpoint-tls");
const certificateChain = await Bun.file(join(tlsDirectory, "certificate.pem")).text();
const privateKey = await Bun.file(join(tlsDirectory, "private-key.pem")).text();
const endpointHttps = await createSelfhostContainerEndpointHttpsListenerIfSupported({
  configuration: {
    configuredSuffix: "container.test",
    publicOrigin: "https://container.test",
    port: 443,
  },
  containerRuntimeConfigured: true,
  exactCandidatePair: hasExactLocalContainerEndpointCandidatePair(forms),
  certificateChain,
  privateKey,
  factories: {
    serve(options) {
      // Keep this qualification listener private to the local test process.
      // The source helper still requires and verifies the real TCP port 443.
      return Bun.serve({ ...options, hostname: "127.0.0.1" });
    },
    proveSni: verifySelfhostContainerEndpointHttpsHandshake,
  },
});
if (!endpointHttps) throw new Error("exact local Service/Endpoint pair did not compose HTTPS");
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
  containerEndpointIngress: endpointHttps.ingress,
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
const ingress = composition.containerEndpointIngress;
if (!ingress) throw new Error("native ContainerEndpoint HTTPS ingress did not compose");
let endpointFetch: ((request: Request) => Promise<Response | null>) | undefined;
const app = buildApp({
  v2: TEST_TAKOFORM_V2_CONFIG,
  sql,
  objects,
  publicOrigin: "https://container-host-native.test",
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
  selfhostEndpointIngressFactory: ({ store, deployments }) => {
    const fetchEndpoint = createSelfhostContainerEndpointIngress({
      qualification: ingress,
      store,
      deployments,
    });
    endpointFetch = fetchEndpoint;
    return fetchEndpoint;
  },
});
if (!endpointFetch) throw new Error("native ContainerEndpoint Host ingress did not install");
endpointHttps.installEndpointFetch(createSelfhostContainerEndpointHttpsDispatch(endpointFetch));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return app.fetch(request);
  },
});
process.stdout.write(`READY ${server.port}\n`);
