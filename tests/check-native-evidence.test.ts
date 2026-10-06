import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectNativeEvidenceGates,
  NATIVE_EVIDENCE_CAPABILITIES,
  type NativeEvidenceGate,
  type NativeEvidenceProbe,
  nativeEvidenceExitCode,
  renderNativeEvidenceReport,
  summarizeNativeEvidence,
} from "../scripts/native-evidence.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";

const WORKERD_DIGEST = WORKERD_CLOSED_GRAPH_ARTIFACT.sha256;
const DOCKER_LIFECYCLE_ENV = "TAKOSERVER_NATIVE_CONTAINER_LIFECYCLE";
const OBJECT_BUCKET_HOST_RESTART_ENV = "TAKOSERVER_NATIVE_OBJECT_BUCKET_HOST_RESTART";
const WORKER_ENDPOINT_PUBLIC_CREATE_ENV = "TAKOSERVER_NATIVE_WORKER_ENDPOINT_PUBLIC_CREATE";
const SELFHOST_ARTIFACT_UPLOAD_ENV = "TAKOSERVER_SELFHOST_ARTIFACT_UPLOAD_NATIVE";
const QUEUE_HTTPS_DIAGNOSTIC_ENV = "TAKOSERVER_SELFHOST_QUEUE_HTTPS_DIAGNOSTIC_NATIVE";
const WORKERD_PARENT_LIFETIME_ENV = "TAKOSERVER_NATIVE_WORKERD_PARENT_LIFETIME";
const V2_ENTRY_ENV = "TAKOSERVER_V2_ENTRY_NATIVE";

test("classifies the normal Bun v2 entry journey as readiness, not execution", () => {
  const gates = collectNativeEvidenceGates(join(import.meta.dir, ".."));
  const own = gates.filter((gate) => gate.file === "tests/takoform-v2-entry-bun-native.test.ts");
  expect(own).toHaveLength(1);
  expect(own[0]?.environments).toEqual([V2_ENTRY_ENV]);
  expect(own[0]?.capability).toBe("takoform-v2-bun-entry-lifecycle");

  const capability = NATIVE_EVIDENCE_CAPABILITIES.find(
    (entry) => entry.id === "takoform-v2-bun-entry-lifecycle",
  );
  if (!capability) throw new Error("v2 Bun entry capability missing");
  expect(capability.companionEnvironment).toEqual([]);
  expect(capability.inspect(undefined, {}, probe()).state).toBe("unconfigured");
  expect(capability.inspect("", {}, probe()).state).toBe("unconfigured");
  expect(capability.inspect("true", {}, probe()).state).toBe("invalid");
  expect(capability.inspect("1", {}, probe())).toMatchObject({
    state: "ready",
    readinessOnly: true,
  });
  expect(capability.proves).toContain("two configured Bun entry process boots");
  expect(capability.proves).toContain("terminal Operation replay after restart");
  expect(capability.proves).toContain("does not prove public TLS");
  expect(capability.proves).toContain("does not prove public TLS, Hosted");

  const summaries = summarizeNativeEvidence({
    gates: own,
    environment: { [V2_ENTRY_ENV]: "1" },
    probe: probe(),
  });
  const summary = summaries.find((entry) => entry.capability === capability.id);
  expect(summary).toMatchObject({ state: "ready", readinessOnly: true, tests: 1, files: 1 });
  expect(renderNativeEvidenceReport({ summaries, gates: own }).join("\n")).toContain(
    "runtime execution is not proven by this inspection",
  );
  expect(
    nativeEvidenceExitCode({
      summaries: summarizeNativeEvidence({
        gates: own,
        environment: { [V2_ENTRY_ENV]: "true" },
        probe: probe(),
      }),
      gates: own,
    }),
  ).toBe(1);
});

test("classifies the opt-in Linux parent lifetime suite and rejects invalid enablement", () => {
  const gates = collectNativeEvidenceGates(join(import.meta.dir, ".."));
  const own = gates.filter((gate) => gate.file === "tests/workerd-linux-parent-lifetime.test.ts");
  expect(own).toHaveLength(4);
  expect(own.every((gate) => gate.capability === "workerd-parent-lifetime")).toBe(true);
  expect(own.every((gate) => gate.environments.includes(WORKERD_PARENT_LIFETIME_ENV))).toBe(true);

  const capability = NATIVE_EVIDENCE_CAPABILITIES.find(
    (entry) => entry.id === "workerd-parent-lifetime",
  );
  if (!capability) throw new Error("workerd parent lifetime capability missing");
  expect(capability.inspect(undefined, {}, probe()).state).toBe("unconfigured");
  expect(capability.inspect("true", {}, probe()).state).toBe("invalid");
  expect(
    capability.inspect(
      "1",
      {},
      {
        isExecutableFile: (path) => path !== "/usr/bin/setpriv",
        sha256: () => null,
      },
    ).state,
  ).toBe("invalid");
  expect(capability.inspect("1", {}, probe())).toMatchObject({
    state: process.platform === "linux" ? "ready" : "invalid",
    ...(process.platform === "linux" ? { readinessOnly: true } : {}),
  });
});

const DOCKER_FIXTURE_ENVIRONMENT = {
  TAKOSERVER_NATIVE_CONTAINER_IMAGE_A: `registry.example.test/takoserver/a@sha256:${"a".repeat(64)}`,
  TAKOSERVER_NATIVE_CONTAINER_IMAGE_B: `registry.example.test/takoserver/b@sha256:${"b".repeat(64)}`,
  TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_LABEL_A: "org.example.fixture.a",
  TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_LABEL_B: "org.example.fixture.b",
  TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_VALUE_A: "fixture-a-provenance",
  TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_VALUE_B: "fixture-b-provenance",
  TAKOSERVER_NATIVE_CONTAINER_VERSION_A: "1.2.3",
  TAKOSERVER_NATIVE_CONTAINER_VERSION_B: "2.3.4",
  TAKOSERVER_NATIVE_CONTAINER_SERVER_A: "fixture-server-a",
  TAKOSERVER_NATIVE_CONTAINER_SERVER_B: "fixture-server-b",
  TAKOSERVER_NATIVE_CONTAINER_PORT: "18080",
} as const;

function dockerLifecycleSummary(environment: Readonly<Record<string, string | undefined>>) {
  const gates: NativeEvidenceGate[] = [
    {
      file: "selfhost-container-native.test.ts",
      environments: [DOCKER_LIFECYCLE_ENV],
      capability: "docker-container-lifecycle",
    },
  ];
  const summaries = summarizeNativeEvidence({ gates, environment, probe: probe() });
  return {
    gates,
    summary: summaries.find((entry) => entry.capability === "docker-container-lifecycle"),
    summaries,
  };
}

function probe(
  input: { readonly digests?: Readonly<Record<string, string>> } = {},
): NativeEvidenceProbe {
  return {
    isExecutableFile: (path) => path.startsWith("/"),
    sha256: (path) => input.digests?.[path] ?? null,
  };
}

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-native-evidence-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, name), body, { encoding: "utf8" });
  }
  return root;
}

test("classifies a gate by the environment it names, through a local alias", async () => {
  const root = await fixture({
    "a.test.ts": [
      'import { test } from "bun:test";',
      "const workerd = process.env.TAKOSERVER_WORKERD_BINARY;",
      'test.skipIf(workerd === undefined)("a", () => {});',
      "",
    ].join("\n"),
    "b.test.ts": [
      'import { test } from "bun:test";',
      "const guard = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;",
      "const workerd = process.env.TAKOSERVER_WORKERD_BINARY;",
      'test.skipIf(workerd === undefined || guard === undefined)("b", () => {});',
      "",
    ].join("\n"),
    "c.test.ts": [
      'import { test } from "bun:test";',
      'test.skipIf(process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY === undefined)("c", () => {});',
      "",
    ].join("\n"),
    "d.test.ts": [
      'import { test } from "bun:test";',
      'test.skipIf(process.env.TAKOSERVER_SOMETHING_ELSE === undefined)("d", () => {});',
      "",
    ].join("\n"),
  });
  try {
    const gates = collectNativeEvidenceGates(root);
    expect(gates.map((gate) => [gate.file, gate.capability])).toEqual([
      ["a.test.ts", "workerd-artifact"],
      ["b.test.ts", "workerd-artifact"],
      ["c.test.ts", "actor-qualification"],
      ["d.test.ts", null],
    ]);
    expect(gates[1]?.environments).toEqual([
      "TAKOSERVER_WORKERD_BINARY",
      "TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies the repository self-host container lifecycle gate", () => {
  const gates = collectNativeEvidenceGates(join(import.meta.dir, ".."));
  const lifecycle = gates.filter((gate) => gate.file === "tests/selfhost-container-native.test.ts");

  expect(lifecycle).toHaveLength(1);
  expect(lifecycle[0]?.environments).toEqual([DOCKER_LIFECYCLE_ENV]);
  expect(lifecycle[0]?.capability).toBe("docker-container-lifecycle");
  expect(gates.every((gate) => gate.capability !== null)).toBe(true);
});

test("classifies the isolated ObjectBucket Host restart gate with pinned workerd companion", () => {
  const gates = collectNativeEvidenceGates(join(import.meta.dir, ".."));
  const objectBucket = gates.filter(
    (gate) => gate.file === "tests/selfhost-object-bucket-host-restart-native.test.ts",
  );

  expect(objectBucket).toHaveLength(1);
  expect(objectBucket[0]?.environments).toEqual([
    OBJECT_BUCKET_HOST_RESTART_ENV,
    "TAKOSERVER_WORKERD_BINARY",
  ]);
  expect(objectBucket[0]?.capabilities).toEqual(["object-bucket-host-restart"]);
  expect(objectBucket[0]?.capability).toBe("object-bucket-host-restart");
  expect(gates.every((gate) => gate.capability !== null)).toBe(true);
});

test("requires exact ObjectBucket opt-in and pinned workerd without claiming test execution", () => {
  const capability = NATIVE_EVIDENCE_CAPABILITIES.find(
    (entry) => entry.id === "object-bucket-host-restart",
  );
  expect(capability?.environment).toBe(OBJECT_BUCKET_HOST_RESTART_ENV);
  expect(capability?.companionEnvironment).toEqual(["TAKOSERVER_WORKERD_BINARY"]);

  const inspect = capability?.inspect;
  if (!inspect) throw new Error("object_bucket_host_restart_capability_missing");
  expect(inspect(undefined, {}, probe()).state).toBe("unconfigured");
  expect(inspect("1", {}, probe()).state).toBe("invalid");
  expect(
    inspect(
      "1",
      { TAKOSERVER_WORKERD_BINARY: "/native/workerd" },
      probe({ digests: { "/native/workerd": WORKERD_DIGEST } }),
    ),
  ).toMatchObject({ state: "ready", readinessOnly: true });
  expect(
    inspect(
      "true",
      { TAKOSERVER_WORKERD_BINARY: "/native/workerd" },
      probe({ digests: { "/native/workerd": WORKERD_DIGEST } }),
    ).state,
  ).toBe("invalid");
  expect(
    inspect(
      "1",
      { TAKOSERVER_WORKERD_BINARY: "/native/workerd" },
      probe({ digests: { "/native/workerd": "0".repeat(64) } }),
    ).state,
  ).toBe("invalid");
});

test("classifies the public Host WorkerEndpoint create diagnostic separately from ObjectBucket", () => {
  const gates = collectNativeEvidenceGates(join(import.meta.dir, ".."));
  const diagnostic = gates.filter(
    (gate) =>
      gate.file === "tests/selfhost-worker-endpoint-public-native.test.ts" &&
      gate.environments.includes(WORKER_ENDPOINT_PUBLIC_CREATE_ENV),
  );

  expect(diagnostic).toHaveLength(1);
  expect(diagnostic[0]?.environments).toEqual([
    WORKER_ENDPOINT_PUBLIC_CREATE_ENV,
    "TAKOSERVER_WORKERD_BINARY",
  ]);
  expect(diagnostic[0]?.capabilities).toEqual(["worker-endpoint-public-create-diagnostic"]);
  expect(diagnostic[0]?.capability).toBe("worker-endpoint-public-create-diagnostic");
  expect(gates.every((gate) => gate.capability !== null)).toBe(true);
});

test("validates exact WorkerEndpoint diagnostic opt-in and pinned workerd readiness only", () => {
  const capability = NATIVE_EVIDENCE_CAPABILITIES.find(
    (entry) => entry.id === "worker-endpoint-public-create-diagnostic",
  );
  if (!capability) throw new Error("worker endpoint diagnostic capability missing");

  expect(capability.environment).toBe(WORKER_ENDPOINT_PUBLIC_CREATE_ENV);
  expect(capability.companionEnvironment).toEqual(["TAKOSERVER_WORKERD_BINARY"]);
  expect(capability.inspect(undefined, {}, probe()).state).toBe("unconfigured");
  expect(capability.inspect("true", {}, probe()).state).toBe("invalid");
  expect(capability.inspect("1", {}, probe()).state).toBe("invalid");

  const workerd = "/native/workerd";
  expect(capability.inspect("1", { TAKOSERVER_WORKERD_BINARY: workerd }, probe()).state).toBe(
    "invalid",
  );
  expect(
    capability.inspect(
      "1",
      { TAKOSERVER_WORKERD_BINARY: workerd },
      probe({ digests: { [workerd]: "0".repeat(64) } }),
    ).state,
  ).toBe("invalid");
  const ready = capability.inspect(
    "1",
    { TAKOSERVER_WORKERD_BINARY: workerd },
    probe({ digests: { [workerd]: WORKERD_DIGEST } }),
  );
  const supportedPlatform =
    process.platform === WORKERD_CLOSED_GRAPH_ARTIFACT.platform &&
    process.arch === WORKERD_CLOSED_GRAPH_ARTIFACT.arch;
  expect(ready).toMatchObject({
    state: supportedPlatform ? "ready" : "invalid",
    ...(supportedPlatform ? { readinessOnly: true } : {}),
  });
  expect(capability.proves).toContain("exact-Operation readback");
  expect(capability.proves).toContain("does not prove ObjectBucket access, Resource update/delete");
});

test("classifies the public Host artifact upload gate without adding a workerd dependency", async () => {
  const root = await fixture({
    "selfhost-artifact-upload-start-native.test.ts": [
      'import { test } from "bun:test";',
      `const optedIn = process.env.${SELFHOST_ARTIFACT_UPLOAD_ENV} === "1";`,
      'test.skipIf(!optedIn)("public Host artifact upload", () => {});',
      "",
    ].join("\n"),
  });
  try {
    const gates = collectNativeEvidenceGates(root);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.file).toBe("selfhost-artifact-upload-start-native.test.ts");
    expect(gates[0]?.environments).toEqual([SELFHOST_ARTIFACT_UPLOAD_ENV]);
    expect(gates[0]?.capability).toBe("selfhost-artifact-upload");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates the artifact upload opt-in as readiness only", () => {
  const capability = NATIVE_EVIDENCE_CAPABILITIES.find(
    (entry) => entry.id === "selfhost-artifact-upload",
  );
  if (!capability) throw new Error("selfhost artifact upload capability missing");
  expect(capability.environment).toBe(SELFHOST_ARTIFACT_UPLOAD_ENV);
  expect(capability.companionEnvironment).toEqual([]);
  expect(capability.inspect(undefined, {}, probe()).state).toBe("unconfigured");
  expect(capability.inspect("true", {}, probe()).state).toBe("invalid");
  expect(capability.inspect("1", {}, probe())).toMatchObject({
    state: process.platform === "linux" ? "ready" : "invalid",
    ...(process.platform === "linux" ? { readinessOnly: true } : {}),
  });
  expect(capability.proves).toContain("V1 upload start/blob/commit followed by V2 upload start");
  expect(capability.proves).toContain("without Form admission");
  expect(capability.proves).not.toContain("Cloudflare");
});

test("classifies the Queue HTTPS diagnostic gate as its own pinned-workerd capability", () => {
  const gates = collectNativeEvidenceGates(join(import.meta.dir, ".."));
  const diagnostic = gates.filter(
    (gate) =>
      gate.file === "tests/selfhost-workerd-e2e.test.ts" &&
      gate.environments.includes(QUEUE_HTTPS_DIAGNOSTIC_ENV),
  );

  expect(diagnostic).toHaveLength(1);
  expect(diagnostic[0]?.capabilities).toEqual(["queue-https-diagnostic"]);
  expect(diagnostic[0]?.capability).toBe("queue-https-diagnostic");
  expect(gates.every((gate) => gate.capability !== null)).toBe(true);
});

test("validates the Queue HTTPS diagnostic opt-in and pinned workerd readiness only", () => {
  const capability = NATIVE_EVIDENCE_CAPABILITIES.find(
    (entry) => entry.id === "queue-https-diagnostic",
  );
  if (!capability) throw new Error("queue HTTPS diagnostic capability missing");

  expect(capability.environment).toBe(QUEUE_HTTPS_DIAGNOSTIC_ENV);
  expect(capability.companionEnvironment).toEqual(["TAKOSERVER_WORKERD_BINARY"]);
  expect(capability.inspect(undefined, {}, probe()).state).toBe("unconfigured");
  expect(capability.inspect("0", {}, probe()).state).toBe("invalid");
  const missingWorkerd = capability.inspect("1", {}, probe());
  expect(missingWorkerd.state).toBe("invalid");
  expect(missingWorkerd.detail).toContain(
    process.platform === "linux" ? "requires the pinned workerd artifact" : "requires Linux",
  );
  expect(
    capability.inspect("1", { TAKOSERVER_WORKERD_BINARY: "relative/workerd" }, probe()).state,
  ).toBe("invalid");

  const ready = capability.inspect(
    "1",
    { TAKOSERVER_WORKERD_BINARY: "/native/workerd" },
    probe({ digests: { "/native/workerd": WORKERD_DIGEST } }),
  );
  expect(ready.state).toBe(process.platform === "linux" ? "ready" : "invalid");
  if (process.platform === "linux") expect(ready.readinessOnly).toBe(true);

  expect(
    capability.inspect(
      "1",
      { TAKOSERVER_WORKERD_BINARY: "/native/workerd" },
      probe({ digests: { "/native/workerd": "0".repeat(64) } }),
    ).state,
  ).toBe("invalid");
  expect(capability.proves).toContain("first-root Provider-to-workerd HTTPS diagnostic");
  expect(capability.proves).toContain("does not prove Host/Core admission");
  expect(capability.proves).toContain("does not prove Host/Core admission, Queue delivery");
  expect(capability.proves).toContain("process restart, or recovery");
});

test("registers the Docker lifecycle gate's exact eleven fixture inputs as companions", () => {
  const capability = NATIVE_EVIDENCE_CAPABILITIES.find(
    (entry) => entry.id === "docker-container-lifecycle",
  );

  expect(capability?.environment).toBe(DOCKER_LIFECYCLE_ENV);
  expect(capability?.companionEnvironment).toEqual(Object.keys(DOCKER_FIXTURE_ENVIRONMENT));
  expect(capability?.companionEnvironment).toHaveLength(11);
});

test("reports an absent Docker lifecycle opt-in as disabled and unproven", () => {
  const result = dockerLifecycleSummary({});

  expect(result.summary?.state).toBe("unconfigured");
  expect(result.summary?.detail).toContain("Docker lifecycle tests are disabled");
  expect(nativeEvidenceExitCode(result)).toBe(0);
  expect(renderNativeEvidenceReport(result).join("\n")).toContain("NOT PROVEN BY THIS RUN");
});

test("rejects invalid Docker lifecycle opt-in values instead of silently disabling", () => {
  for (const flag of ["", "0", "true"]) {
    const result = dockerLifecycleSummary({ [DOCKER_LIFECYCLE_ENV]: flag });

    expect(result.summary?.state).toBe("invalid");
    expect(result.summary?.detail).toContain('must be exactly "1"');
    expect(nativeEvidenceExitCode(result)).toBe(1);
  }
});

test("rejects an enabled Docker lifecycle gate when fixture inputs are missing", () => {
  const result = dockerLifecycleSummary({ [DOCKER_LIFECYCLE_ENV]: "1" });

  expect(result.summary?.state).toBe("invalid");
  expect(result.summary?.detail).toContain(
    "TAKOSERVER_NATIVE_CONTAINER_IMAGE_A is missing or empty",
  );
  expect(nativeEvidenceExitCode(result)).toBe(1);
});

test("rejects mutable or malformed Docker fixture image references", () => {
  const result = dockerLifecycleSummary({
    [DOCKER_LIFECYCLE_ENV]: "1",
    ...DOCKER_FIXTURE_ENVIRONMENT,
    TAKOSERVER_NATIVE_CONTAINER_IMAGE_A: "registry.example.test/takoserver/a:latest",
  });

  expect(result.summary?.state).toBe("invalid");
  expect(result.summary?.detail).toContain("distinct immutable repository digest references");
  expect(nativeEvidenceExitCode(result)).toBe(1);
});

test("accepts bounded Docker fixture inputs as ready-to-run without claiming execution", () => {
  const result = dockerLifecycleSummary({
    [DOCKER_LIFECYCLE_ENV]: "1",
    ...DOCKER_FIXTURE_ENVIRONMENT,
  });

  expect(result.summary?.state).toBe("ready");
  expect(result.summary?.detail).toContain("fixture inputs are valid");
  expect(result.summary?.detail).toContain("Docker was not contacted");
  const report = renderNativeEvidenceReport(result).join("\n");
  expect(report).toContain("runtime execution is not proven by this inspection");
  expect(report).not.toContain("proven by this run");
  expect(nativeEvidenceExitCode(result)).toBe(0);
});

test("ignores import-shaped lines inside embedded fixture module sources", async () => {
  const root = await fixture({
    "e.test.ts": [
      'import { test } from "bun:test";',
      "const workerd = process.env.TAKOSERVER_WORKERD_BINARY;",
      "const moduleSource = `",
      'import { DurableObject } from "cloudflare:workers";',
      "export class Facet extends DurableObject {}",
      "`;",
      'test.skipIf(workerd === undefined)("e", () => {});',
      "",
    ].join("\n"),
  });
  try {
    const gates = collectNativeEvidenceGates(root);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.capability).toBe("workerd-artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

+test("ignores gate-shaped text inside literal strings", async () => {
  const root = await fixture({
    "i.test.ts": [
      'import { test } from "bun:test";',
      "const workerd = process.env.TAKOSERVER_WORKERD_BINARY;",
      "const fixtureSource = `",
      'test.skipIf(process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY === undefined)("x", () => {});',
      "`;",
      'test.skipIf(workerd === undefined)("i", () => {});',
      "",
    ].join("\n"),
  });
  try {
    const gates = collectNativeEvidenceGates(root);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.environments).toEqual(["TAKOSERVER_WORKERD_BINARY"]);
    expect(gates[0]?.capability).toBe("workerd-artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies a gate that names a capability instead of an environment", async () => {
  const root = await fixture({
    "f.test.ts": [
      'import { test } from "bun:test";',
      'import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";',
      'const workerd = nativeEvidenceBinary("workerd-artifact");',
      'test.skipIf(workerd === undefined)("f", () => {});',
      "",
    ].join("\n"),
    "g.test.ts": [
      'import { test } from "bun:test";',
      'import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";',
      "const guard = nativeEvidenceBinary(",
      '  "workerd-artifact",',
      '  "TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY",',
      ");",
      'test.skipIf(guard === undefined)("g", () => {});',
      "",
    ].join("\n"),
    "h.test.ts": [
      'import { test } from "bun:test";',
      'import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";',
      'const binary = nativeEvidenceBinary("actor-qualification");',
      'test.skipIf(binary === undefined)("h", () => {});',
      "",
    ].join("\n"),
    "j.test.ts": [
      'import { test } from "bun:test";',
      'test.skipIf(nativeEvidenceBinary("workerd-artifact") === undefined)("j", () => {});',
      "",
    ].join("\n"),
    "k.test.ts": [
      'import { test } from "bun:test";',
      'test.skipIf(nativeEvidenceBinary("something-else") === undefined)("k", () => {});',
      "",
    ].join("\n"),
    "l.test.ts": [
      'import { test } from "bun:test";',
      'import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";',
      'const container = nativeEvidenceBinary("container-host-lifecycle");',
      "const form = process.env.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT;",
      "const formSha = process.env.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256;",
      "const imageA = process.env.TAKOSERVER_NATIVE_CONTAINER_IMAGE_A;",
      "const imageB = process.env.TAKOSERVER_NATIVE_CONTAINER_IMAGE_B;",
      "const socket = process.env.TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET;",
      "const network = process.env.TAKOSERVER_NATIVE_CONTAINER_NETWORK;",
      'test.skipIf(container === undefined || form === undefined || formSha === undefined || imageA === undefined || imageB === undefined || socket === undefined || network === undefined)("l", () => {});',
      "",
    ].join("\n"),
  });
  try {
    const gates = collectNativeEvidenceGates(root);
    expect(gates.map((gate) => [gate.file, gate.capability])).toEqual([
      ["f.test.ts", "workerd-artifact"],
      ["g.test.ts", "workerd-artifact"],
      ["h.test.ts", "actor-qualification"],
      ["j.test.ts", "workerd-artifact"],
      ["k.test.ts", null],
      ["l.test.ts", "container-host-lifecycle"],
    ]);
    expect(gates[1]?.environments).toEqual([
      "TAKOSERVER_WORKERD_BINARY",
      "TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY",
    ]);
    expect(gates[4]?.capabilities).toEqual(["something-else"]);
    expect(gates[5]?.environments).toEqual([
      "TAKOSERVER_NATIVE_CONTAINER_HOST_LIFECYCLE",
      "TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT",
      "TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256",
      "TAKOSERVER_NATIVE_CONTAINER_IMAGE_A",
      "TAKOSERVER_NATIVE_CONTAINER_IMAGE_B",
      "TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET",
      "TAKOSERVER_NATIVE_CONTAINER_NETWORK",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Container Host native evidence validates bounded inputs without claiming execution", () => {
  const capability = NATIVE_EVIDENCE_CAPABILITIES.find(
    (entry) => entry.id === "container-host-lifecycle",
  );
  if (!capability) throw new Error("Container Host native evidence capability missing");
  const artifact = "/fixtures/final-container-candidate.json";
  const environment = {
    TAKOSERVER_NATIVE_CONTAINER_HOST_LIFECYCLE: "1",
    TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT: artifact,
    TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256:
      "7ab6dce1bbbfecc69f5732abd25100db83168c640e8d1054f5a708ad4ef6a0b2",
    TAKOSERVER_NATIVE_CONTAINER_IMAGE_A: `nginxinc/nginx-unprivileged@sha256:${"a".repeat(64)}`,
    TAKOSERVER_NATIVE_CONTAINER_IMAGE_B: `nginxinc/nginx-unprivileged@sha256:${"b".repeat(64)}`,
    TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET: "/var/run/docker.sock",
    TAKOSERVER_NATIVE_CONTAINER_NETWORK: "takoserver-test-internal",
  };
  const ready = capability.inspect(
    "1",
    environment,
    probe({
      digests: { [artifact]: environment.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256 },
    }),
  );
  expect(ready.state).toBe("ready");
  expect(ready.detail).toContain("still require running the gated test");
  expect(capability.enable).toContain("may contact those images' public registry");
  expect(
    capability.inspect(
      "1",
      {
        ...environment,
        TAKOSERVER_NATIVE_CONTAINER_IMAGE_B: environment.TAKOSERVER_NATIVE_CONTAINER_IMAGE_A,
      },
      probe({
        digests: { [artifact]: environment.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256 },
      }),
    ).state,
  ).toBe("invalid");
  expect(
    capability.inspect(
      "1",
      { ...environment, TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256: "0".repeat(64) },
      probe({
        digests: { [artifact]: environment.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256 },
      }),
    ).state,
  ).toBe("invalid");
});

test("counts only the tests a capability gates, per file", () => {
  const gates: NativeEvidenceGate[] = [
    {
      file: "x.test.ts",
      environments: ["TAKOSERVER_WORKERD_BINARY"],
      capability: "workerd-artifact",
    },
    {
      file: "x.test.ts",
      environments: ["TAKOSERVER_WORKERD_BINARY"],
      capability: "workerd-artifact",
    },
    {
      file: "y.test.ts",
      environments: ["TAKOSERVER_ACTOR_QUALIFICATION_BINARY"],
      capability: "actor-qualification",
    },
  ];
  const summaries = summarizeNativeEvidence({ gates, environment: {}, probe: probe() });
  const workerd = summaries.find((entry) => entry.capability === "workerd-artifact");
  const actor = summaries.find((entry) => entry.capability === "actor-qualification");
  expect(workerd?.tests).toBe(2);
  expect(workerd?.files).toBe(1);
  expect(actor?.tests).toBe(1);
  expect(actor?.files).toBe(1);
});

test("an unconfigured capability is reported as unproven and is not a failure", () => {
  const gates: NativeEvidenceGate[] = [
    {
      file: "x.test.ts",
      environments: ["TAKOSERVER_WORKERD_BINARY"],
      capability: "workerd-artifact",
    },
  ];
  const summaries = summarizeNativeEvidence({ gates, environment: {}, probe: probe() });
  expect(summaries.every((entry) => entry.state === "unconfigured")).toBe(true);
  expect(nativeEvidenceExitCode({ summaries, gates })).toBe(0);
  const report = renderNativeEvidenceReport({ summaries, gates }).join("\n");
  expect(report).toContain("NOT PROVEN BY THIS RUN");
  expect(report).toContain("NOT PROVEN BY THIS RUN: 1 tests in 1 files did not execute");
});

test("a configured artifact that does not hold is a failure, not a skip", () => {
  const gates: NativeEvidenceGate[] = [
    {
      file: "x.test.ts",
      environments: ["TAKOSERVER_WORKERD_BINARY"],
      capability: "workerd-artifact",
    },
  ];
  const relative = summarizeNativeEvidence({
    gates,
    environment: { TAKOSERVER_WORKERD_BINARY: "workerd" },
    probe: probe(),
  });
  expect(relative[0]?.state).toBe("invalid");
  expect(relative[0]?.detail).toContain("not absolute");
  expect(nativeEvidenceExitCode({ summaries: relative, gates })).toBe(1);

  const wrongBytes = summarizeNativeEvidence({
    gates,
    environment: { TAKOSERVER_WORKERD_BINARY: "/tmp/other-workerd" },
    probe: probe({ digests: { "/tmp/other-workerd": "a".repeat(64) } }),
  });
  expect(wrongBytes[0]?.state).toBe("invalid");
  expect(wrongBytes[0]?.detail).toContain(WORKERD_DIGEST);
  expect(nativeEvidenceExitCode({ summaries: wrongBytes, gates })).toBe(1);
});

test("the pinned artifact on its own platform is ready and is not a failure", () => {
  const gates: NativeEvidenceGate[] = [
    {
      file: "x.test.ts",
      environments: ["TAKOSERVER_WORKERD_BINARY"],
      capability: "workerd-artifact",
    },
  ];
  const summaries = summarizeNativeEvidence({
    gates,
    environment: { TAKOSERVER_WORKERD_BINARY: "/opt/workerd" },
    probe: probe({ digests: { "/opt/workerd": WORKERD_DIGEST } }),
  });
  const pinnedHost =
    process.platform === WORKERD_CLOSED_GRAPH_ARTIFACT.platform &&
    process.arch === WORKERD_CLOSED_GRAPH_ARTIFACT.arch;
  expect(summaries[0]?.state).toBe(pinnedHost ? "ready" : "invalid");
  expect(nativeEvidenceExitCode({ summaries, gates })).toBe(pinnedHost ? 0 : 1);
});

test("a gate no capability claims fails the report instead of passing by silence", () => {
  const gates: NativeEvidenceGate[] = [
    { file: "d.test.ts", environments: ["TAKOSERVER_SOMETHING_ELSE"], capability: null },
  ];
  const summaries = summarizeNativeEvidence({ gates, environment: {}, probe: probe() });
  const report = renderNativeEvidenceReport({ summaries, gates }).join("\n");
  expect(report).toContain("unclassified gates: 1");
  expect(report).toContain("TAKOSERVER_SOMETHING_ELSE");
  expect(nativeEvidenceExitCode({ summaries, gates })).toBe(1);
});
