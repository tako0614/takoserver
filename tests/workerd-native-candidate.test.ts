import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowLoaderCandidateProvenance } from "../scripts/build-workerd.ts";
import {
  readWorkerdNativeTestInput,
  selectWorkerdNativeTestBinary,
  workerdNativeTestIsEnabled,
} from "./helpers/workerd-native-candidate.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "takoserver-candidate-helper-"));
  const binary = join(root, "workerd");
  const provenance = join(root, "provenance.json");
  const executed = join(root, "executed");
  const bytes = `#!/bin/sh\ntouch '${executed}'\nexit 73\n`;
  await writeFile(binary, bytes, { mode: 0o700 });
  const source = await createWorkflowLoaderCandidateProvenance({
    // This build commit intentionally need not be the current test commit.
    takoserverCommit: "d88a64aa3b27288c32a7c08a9d3b9f65de35f25c",
    buildScriptSha256: createHash("sha256")
      .update(await readFile(new URL("../scripts/build-workerd.ts", import.meta.url)))
      .digest("hex"),
  });
  const record = {
    ...source,
    binarySha256: createHash("sha256").update(bytes).digest("hex"),
    binaryPath: binary,
    qualification: "unqualified-native-tests-not-run",
  };
  await writeFile(provenance, JSON.stringify(record), { mode: 0o600 });
  return {
    root,
    binary,
    provenance,
    executed,
    bytes,
    record,
    input: readWorkerdNativeTestInput({
      TAKOSERVER_TEST_WORKERD_CANDIDATE_BINARY: binary,
      TAKOSERVER_TEST_WORKERD_CANDIDATE_PROVENANCE: provenance,
    }),
    privateRoot: join(root, "test-private"),
  };
}

test("candidate test inputs must be explicit and complete, never accepted-mode fallback", () => {
  expect(readWorkerdNativeTestInput({})).toEqual({ mode: "accepted", binary: undefined });
  expect(readWorkerdNativeTestInput({ TAKOSERVER_WORKERD_BINARY: "/accepted/workerd" })).toEqual({
    mode: "accepted",
    binary: "/accepted/workerd",
  });
  expect(() =>
    readWorkerdNativeTestInput({
      TAKOSERVER_WORKERD_BINARY: "/accepted/workerd",
      TAKOSERVER_TEST_WORKERD_CANDIDATE_BINARY: "/candidate/workerd",
    }),
  ).toThrow("requires both");
  expect(() =>
    readWorkerdNativeTestInput({
      TAKOSERVER_TEST_WORKERD_CANDIDATE_PROVENANCE: "/candidate/provenance.json",
    }),
  ).toThrow("requires both");
});

test("candidate selection requires a test run even when the guard is missing", () => {
  const input = readWorkerdNativeTestInput({
    TAKOSERVER_TEST_WORKERD_CANDIDATE_BINARY: "/candidate/workerd",
    TAKOSERVER_TEST_WORKERD_CANDIDATE_PROVENANCE: "/candidate/provenance.json",
  });
  expect(workerdNativeTestIsEnabled(input, undefined)).toBe(true);
  expect(workerdNativeTestIsEnabled(readWorkerdNativeTestInput({}), "/guard")).toBe(false);
  const accepted = readWorkerdNativeTestInput({ TAKOSERVER_WORKERD_BINARY: "/accepted/workerd" });
  expect(workerdNativeTestIsEnabled(accepted, undefined)).toBe(false);
  expect(workerdNativeTestIsEnabled(accepted, "/guard")).toBe(true);
});

test.each([
  { binary: "", provenance: "/candidate/provenance.json" },
  { binary: "relative/workerd", provenance: "/candidate/provenance.json" },
  { binary: "/candidate/workerd", provenance: "" },
  { binary: "/candidate/workerd", provenance: "relative/provenance.json" },
  { binary: "/candidate/workerd\0", provenance: "/candidate/provenance.json" },
])("malformed candidate paths fail at test registration: %j", ({ binary, provenance }) => {
  expect(() =>
    readWorkerdNativeTestInput({
      TAKOSERVER_TEST_WORKERD_CANDIDATE_BINARY: binary,
      TAKOSERVER_TEST_WORKERD_CANDIDATE_PROVENANCE: provenance,
    }),
  ).toThrow("absolute");
});

test("verified candidate bytes are retained privately without executing or qualifying them", async () => {
  const candidate = await fixture();
  try {
    const binary = await selectWorkerdNativeTestBinary(candidate);
    expect(binary.startsWith(`${candidate.privateRoot}/`)).toBe(true);
    expect(binary).not.toBe(candidate.binary);
    expect(await readFile(binary, "utf8")).toBe(candidate.bytes);
    expect((await stat(binary)).mode & 0o777).toBe(0o500);
    expect((await stat(candidate.privateRoot)).mode & 0o777).toBe(0o700);
    await expect(access(candidate.executed)).rejects.toThrow();
    expect(JSON.parse(await readFile(candidate.provenance, "utf8"))).toEqual(candidate.record);
    await chmod(candidate.binary, 0o700);
    await writeFile(candidate.binary, "replaced after selection");
    expect(await readFile(binary, "utf8")).toBe(candidate.bytes);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test.each([
  ["kind", "other-candidate@v1"],
  ["candidate", "closed-module-graph-only"],
  ["identity", `sha256:${"0".repeat(64)}`],
  ["takoserverCommit", "short-commit"],
  ["takoserverCommit", "0".repeat(40)],
  ["buildScriptSha256", "0".repeat(64)],
  ["upstreamCommit", "0".repeat(40)],
  ["upstreamArchiveSha256", "0".repeat(64)],
  ["toolchain", {}],
  ["overlays", []],
  ["binarySha256", "not-a-sha256"],
  ["binaryPath", "/different/workerd"],
  ["nativeQualification", "passed"],
  ["qualification", "accepted"],
  ["extra", "unrecognized"],
] as const)("candidate provenance rejects changed %s before execution", async (key, value) => {
  const candidate = await fixture();
  try {
    await writeFile(candidate.provenance, JSON.stringify({ ...candidate.record, [key]: value }));
    await expect(selectWorkerdNativeTestBinary(candidate)).rejects.toThrow("provenance");
    await expect(access(candidate.executed)).rejects.toThrow();
    await expect(access(candidate.privateRoot)).rejects.toThrow();
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test.each(["missing", "reversed", "wrong-digest"] as const)(
  "both ordered owner overlays must match: %s",
  async (change) => {
    const candidate = await fixture();
    try {
      const overlays = [...candidate.record.overlays];
      if (change === "missing") overlays.pop();
      if (change === "reversed") overlays.reverse();
      if (change === "wrong-digest") {
        overlays[1] = { name: "worker-loader-closed-graph-candidate", sha256: "0".repeat(64) };
      }
      await writeFile(candidate.provenance, JSON.stringify({ ...candidate.record, overlays }));
      await expect(selectWorkerdNativeTestBinary(candidate)).rejects.toThrow("canonical combined");
      await expect(access(candidate.executed)).rejects.toThrow();
    } finally {
      await rm(candidate.root, { recursive: true, force: true });
    }
  },
);

test.each(["bazeliskSha256", "bazelSha256", "clangVersion", "platform", "arch"] as const)(
  "candidate provenance enforces the owner toolchain %s",
  async (key) => {
    const candidate = await fixture();
    try {
      await writeFile(
        candidate.provenance,
        JSON.stringify({
          ...candidate.record,
          toolchain: { ...candidate.record.toolchain, [key]: "substituted" },
        }),
      );
      await expect(selectWorkerdNativeTestBinary(candidate)).rejects.toThrow("canonical combined");
      await expect(access(candidate.executed)).rejects.toThrow();
    } finally {
      await rm(candidate.root, { recursive: true, force: true });
    }
  },
);

test.each(["not-json", "null", "[]", "{}"])(
  "malformed provenance fails without executing the candidate: %s",
  async (record) => {
    const candidate = await fixture();
    try {
      await writeFile(candidate.provenance, record);
      await expect(selectWorkerdNativeTestBinary(candidate)).rejects.toThrow();
      await expect(access(candidate.executed)).rejects.toThrow();
    } finally {
      await rm(candidate.root, { recursive: true, force: true });
    }
  },
);

test("copied binary digest mismatch fails and removes the unusable snapshot before execution", async () => {
  const candidate = await fixture();
  try {
    await writeFile(candidate.binary, `${candidate.bytes}# substituted bytes\n`);
    await expect(selectWorkerdNativeTestBinary(candidate)).rejects.toThrow("copied binary SHA-256");
    expect(await readdir(candidate.privateRoot)).toEqual([]);
    await expect(access(candidate.executed)).rejects.toThrow();
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test.each(["symlink", "directory", "not-executable", "missing"] as const)(
  "candidate binary must be a regular executable file: %s",
  async (change) => {
    const candidate = await fixture();
    try {
      if (change === "not-executable") {
        await chmod(candidate.binary, 0o600);
      } else {
        await rm(candidate.binary);
        if (change === "symlink") {
          const target = join(candidate.root, "target");
          await writeFile(target, candidate.bytes, { mode: 0o700 });
          await symlink(target, candidate.binary);
        }
        if (change === "directory") await mkdir(candidate.binary);
      }
      await expect(selectWorkerdNativeTestBinary(candidate)).rejects.toThrow();
      await expect(access(candidate.executed)).rejects.toThrow();
      await expect(access(candidate.privateRoot)).rejects.toThrow();
    } finally {
      await rm(candidate.root, { recursive: true, force: true });
    }
  },
);

test("candidate provenance cannot be a symlink", async () => {
  const candidate = await fixture();
  try {
    const target = join(candidate.root, "record.json");
    await writeFile(target, JSON.stringify(candidate.record));
    await rm(candidate.provenance);
    await symlink(target, candidate.provenance);
    await expect(selectWorkerdNativeTestBinary(candidate)).rejects.toThrow("non-symlink");
    await expect(access(candidate.executed)).rejects.toThrow();
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test("candidate test private root cannot be a symlink", async () => {
  const candidate = await fixture();
  try {
    const target = join(candidate.root, "other-root");
    await mkdir(target);
    await symlink(target, candidate.privateRoot);
    await expect(selectWorkerdNativeTestBinary(candidate)).rejects.toThrow("non-symlink directory");
    expect(await readdir(target)).toEqual([]);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test("candidate bytes passed as an accepted binary still fail the unchanged accepted pin", async () => {
  const candidate = await fixture();
  try {
    await expect(
      selectWorkerdNativeTestBinary({
        input: readWorkerdNativeTestInput({ TAKOSERVER_WORKERD_BINARY: candidate.binary }),
        privateRoot: candidate.privateRoot,
      }),
    ).rejects.toThrow("has digest");
    await expect(access(candidate.executed)).rejects.toThrow();
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});
