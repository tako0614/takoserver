import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

test("the public v2 eligibility export does not pull native Workerd modules into a no-Bun consumer", () => {
  const configPath = fileURLToPath(new URL("../tsconfig.takoform-v2-no-bun.json", import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  expect(parsed.errors).toEqual([]);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const sourceFiles = program
    .getSourceFiles()
    .map((source) => source.fileName.replaceAll("\\", "/"));
  expect(sourceFiles.some((path) => path.endsWith("/src/workerd-runtime.ts"))).toBe(false);
  expect(sourceFiles.some((path) => path.endsWith("/src/selfhost-actor-graph-authority.ts"))).toBe(
    false,
  );
  expect(sourceFiles.some((path) => path.endsWith("/src/takoform-v2/worker-code-runtime.ts"))).toBe(
    false,
  );
  expect(sourceFiles.some((path) => path.endsWith("/src/workerd-worker-module-inspector.ts"))).toBe(
    false,
  );
  expect(
    sourceFiles.some((path) =>
      path.endsWith("/src/providers/worker-module-semantic-inspection.ts"),
    ),
  ).toBe(false);
  expect(
    sourceFiles.some((path) => path.endsWith("/src/worker-module-inspection-contract.ts")),
  ).toBe(true);

  const diagnostics = ts.getPreEmitDiagnostics(program);
  const unexpectedDiagnostics = diagnostics.filter((diagnostic) => {
    const file = diagnostic.file?.fileName.replaceAll("\\", "/") ?? "";
    // These are existing source diagnostics in the broad package barrel's
    // SQLite implementation; this no-Bun consumer is scoped to dependency
    // portability and must not mask any other newly introduced diagnostic.
    const knownExistingRowCast =
      diagnostic.code === 2352 &&
      (file.endsWith("/src/takoform-v2/store.ts") ||
        file.endsWith("/src/takoform-v2/worker-publication-state.ts"));
    return !knownExistingRowCast;
  });
  // TypeScript diagnostics retain SourceFile/program graphs. Compare compact
  // evidence so a new error fails this gate without recursively printing that
  // graph in the test runner.
  expect(
    unexpectedDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      file: diagnostic.file?.fileName.replaceAll("\\", "/"),
      line:
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
          : undefined,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    })),
  ).toEqual([]);
});
