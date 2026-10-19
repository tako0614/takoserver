import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectMoneyNativeBuildDependencyTree,
  inspectMoneyNativeBuildSourceTree,
} from "../scripts/deploy/money-native-build-closure.ts";
import {
  assertMoneyUnitHeldNormalWorkerModePreparationCurrent,
  inspectMoneyNormalWorkerModeFunctionSource,
  readMoneyUnitHeldNormalWorkerModePreparation,
} from "../scripts/deploy/schema-money-unit-owner.ts";

// Synthetic parser source DATA only. No SQL/canonical mirror, native owner,
// provider, held context, Version or successful preparation is manufactured.
const parser = `export function parseStripeMode(value: unknown) {
  if (value === undefined) return "test";
  if (value === "test" || value === "live") return value;
  throw new Error("invalid source-only mode");
}`;

test("component AST recognizes explicit identity/default syntax without minting native preparation", async () => {
  const observed = await inspectMoneyNormalWorkerModeFunctionSource(parser);
  expect(observed).toEqual({
    sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    functionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
  });
  await expect(
    readMoneyUnitHeldNormalWorkerModePreparation(observed, "/not-opened/selector.json"),
  ).rejects.toThrow("original held context");
});

for (const [name, source] of [
  ["live default", parser.replace('return "test";', 'return "live";')],
  ["live normalized into TEST", parser.replace("return value;", 'return "test";')],
  [
    "unknown falls back to TEST",
    parser.replace('throw new Error("invalid source-only mode");', 'return "test";'),
  ],
  ["shadowed undefined", `const undefined = "live";\n${parser}`],
  ["namespace-shadowed undefined", `namespace undefined { export const live = true; }\n${parser}`],
  ["enum-shadowed undefined", `enum undefined { live }\n${parser}`],
  [
    "import-equals-shadowed undefined",
    `namespace modeNamespace { export const live = true; }\nimport undefined = modeNamespace;\n${parser}`,
  ],
  ["reassigned parser", `${parser}\nparseStripeMode = () => "live";`],
  ["for-of reassigned parser", `${parser}\nfor (parseStripeMode of [(): "live" => "live"]) {}`],
  ["for-in reassigned parser", `${parser}\nfor (parseStripeMode in { live: true }) {}`],
  [
    "for-of destructured parser",
    `${parser}\nfor ([parseStripeMode] of [[(): "live" => "live"]]) {}`,
  ],
  [
    "for-of object-destructured parser",
    `${parser}\nfor ({ parser: parseStripeMode } of [{ parser: (): "live" => "live" }]) {}`,
  ],

  ["dynamic evaluation", `${parser}\neval("untrusted code");`],
] as const) {
  test(`component AST refuses ${name}`, async () => {
    expect(await inspectMoneyNormalWorkerModeFunctionSource(source)).toBeNull();
  });
}

test("caller/inherited context fails before selector IO or fact getters", async () => {
  let factsRead = 0;
  const caller = {
    kind: "takoserver.money-held-convert-context@v1",
    get facts() {
      factsRead++;
      throw new Error("caller facts getter");
    },
  };
  await expect(
    readMoneyUnitHeldNormalWorkerModePreparation(caller, "/not-opened/selector.json"),
  ).rejects.toThrow("original held context");
  await expect(
    readMoneyUnitHeldNormalWorkerModePreparation(
      Object.create(caller),
      "/not-opened/selector.json",
    ),
  ).rejects.toThrow("original held context");
  expect(factsRead).toBe(0);
});

test("caller/copy preparation cannot trigger native GET or held94 assertion", async () => {
  let factsRead = 0;
  const caller = {
    kind: "takoserver.money-held-normal-worker-mode-preparation@v1",
    get facts() {
      factsRead++;
      throw new Error("caller preparation getter");
    },
  };
  await expect(assertMoneyUnitHeldNormalWorkerModePreparationCurrent(caller, {})).rejects.toThrow(
    "preparation origin differs",
  );
  await expect(
    assertMoneyUnitHeldNormalWorkerModePreparationCurrent(Object.create(caller), {}),
  ).rejects.toThrow("preparation origin differs");
  expect(factsRead).toBe(0);
});

// These tiny files are component DATA; they never call the native factory,
// select real tools, use an installed provider, or register an owner/preparation.
function withTree(action: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mc-"));
  try {
    action(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}
const blob = (source: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest("hex");

test("component dependency closure agrees across distinct physical copies and internal links", () => {
  withTree((root) => {
    for (const name of ["one", "two"]) {
      const path = join(root, name);
      mkdirSync(path);
      writeFileSync(join(path, "tool.js"), "original tool");
      symlinkSync("tool.js", join(path, "tool"));
    }
    const one = inspectMoneyNativeBuildDependencyTree(join(root, "one"));
    const two = inspectMoneyNativeBuildDependencyTree(join(root, "two"));
    expect(one.contentDigest).toBe(two.contentDigest);
    expect(one.identityDigest).not.toBe(two.identityDigest);
    writeFileSync(join(root, "two", "tool.js"), "replaced tool");
    expect(inspectMoneyNativeBuildDependencyTree(join(root, "two")).contentDigest).not.toBe(
      one.contentDigest,
    );
  });
});

test("component dependency closure refuses outside links and borrowed root", () => {
  withTree((root) => {
    const deps = join(root, "deps");
    mkdirSync(deps);
    writeFileSync(join(root, "outside"), "outside tool");
    symlinkSync("../outside", join(deps, "tool"));
    expect(() => inspectMoneyNativeBuildDependencyTree(deps)).toThrow("leaves its own closure");
    symlinkSync("deps", join(root, "borrowed"));
    expect(() => inspectMoneyNativeBuildDependencyTree(join(root, "borrowed"))).toThrow(
      "own physical directory",
    );
  });
});

test("component source comparison reads actual working bytes, not Git status flags", () => {
  withTree((root) => {
    const path = join(root, "entry.ts");
    const original = "export const mode = 'test';";
    writeFileSync(path, original);
    const expected = [{ path: "entry.ts", blob: blob(original), executable: false }];
    expect(inspectMoneyNativeBuildSourceTree(root, expected).files).toBe(1);
    writeFileSync(path, "export const mode = 'live';");
    expect(() => inspectMoneyNativeBuildSourceTree(root, expected)).toThrow(
      "reviewed complete Git tree",
    );
  });
});

test("component source comparison refuses ignored extras and source symlinks", () => {
  withTree((root) => {
    const original = "export const mode = 'test';";
    writeFileSync(join(root, "entry.ts"), original);
    const expected = [{ path: "entry.ts", blob: blob(original), executable: false }];
    writeFileSync(join(root, ".ignored-config.js"), "unreviewed build code");
    expect(() => inspectMoneyNativeBuildSourceTree(root, expected)).toThrow(
      "reviewed complete Git tree",
    );
    rmSync(join(root, ".ignored-config.js"));
    rmSync(join(root, "entry.ts"));
    writeFileSync(join(root, "actual.ts"), original);
    symlinkSync("actual.ts", join(root, "entry.ts"));
    expect(() => inspectMoneyNativeBuildSourceTree(root, expected)).toThrow("link is not closed");
  });
});
