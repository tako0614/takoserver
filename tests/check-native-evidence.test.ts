import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectNativeEvidenceGates,
  type NativeEvidenceGate,
  type NativeEvidenceProbe,
  nativeEvidenceExitCode,
  renderNativeEvidenceReport,
  summarizeNativeEvidence,
} from "../scripts/native-evidence.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";

const WORKERD_DIGEST = WORKERD_CLOSED_GRAPH_ARTIFACT.sha256;

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
  });
  try {
    const gates = collectNativeEvidenceGates(root);
    expect(gates.map((gate) => [gate.file, gate.capability])).toEqual([
      ["f.test.ts", "workerd-artifact"],
      ["g.test.ts", "workerd-artifact"],
      ["h.test.ts", "actor-qualification"],
      ["j.test.ts", "workerd-artifact"],
      ["k.test.ts", null],
    ]);
    expect(gates[1]?.environments).toEqual([
      "TAKOSERVER_WORKERD_BINARY",
      "TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY",
    ]);
    expect(gates[4]?.capabilities).toEqual(["something-else"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
