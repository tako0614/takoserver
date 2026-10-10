import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type {
  SQLiteLockedPhysicalSet,
  V2QueueSQLiteCall,
  V2QueueSQLiteGrant,
  V2QueueSQLiteProofPort,
  V2QueueSQLiteSelectedBindings,
} from "@takoserver/core/provider-extension";
import * as providerExtension from "@takoserver/core/provider-extension";
import type {
  SQLiteLockedPhysicalSet as NodeSQLiteLockedPhysicalSet,
  V2QueueSQLiteCall as NodeV2QueueSQLiteCall,
  V2QueueSQLiteGrant as NodeV2QueueSQLiteGrant,
  V2QueueSQLiteProofPort as NodeV2QueueSQLiteProofPort,
  V2QueueSQLiteSelectedBindings as NodeV2QueueSQLiteSelectedBindings,
} from "@takoserver/core/provider-extension/selfhost";
import type {
  EdgeSqlValue as NodeEdgeSqlValue,
  SelfhostV2SqliteStatement as NodeSelfhostV2SqliteStatement,
} from "../src/providers/selfhost-v2-sqlite-plane.ts";
import type { EdgeSqlValue, SelfhostV2SqliteStatement } from "../src/queue-v2-sqlite-contract.ts";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

test("old Node Queue/SQLite type exports retain the portable contract identity", () => {
  const witness: readonly true[] = [
    true satisfies Same<SQLiteLockedPhysicalSet, NodeSQLiteLockedPhysicalSet>,
    true satisfies Same<V2QueueSQLiteCall, NodeV2QueueSQLiteCall>,
    true satisfies Same<V2QueueSQLiteGrant, NodeV2QueueSQLiteGrant>,
    true satisfies Same<V2QueueSQLiteProofPort, NodeV2QueueSQLiteProofPort>,
    true satisfies Same<V2QueueSQLiteSelectedBindings, NodeV2QueueSQLiteSelectedBindings>,
    true satisfies Same<EdgeSqlValue, NodeEdgeSqlValue>,
    true satisfies Same<SelfhostV2SqliteStatement, NodeSelfhostV2SqliteStatement>,
  ];
  expect(witness).toHaveLength(7);
  expect("mintSQLiteLockedPhysicalSet" in providerExtension).toBe(false);
});

test("portable provider extension bundles Queue/SQLite types without Node or Bun imports", async () => {
  const entrypoint = fileURLToPath(import.meta.resolve("@takoserver/core/provider-extension"));
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    plugins: [
      {
        name: "reject-host-only-imports",
        setup(build) {
          build.onResolve({ filter: /^(?:bun|node):|workerd-runtime/u }, (args) => {
            throw new Error(`portable provider extension reaches Host import: ${args.path}`);
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  expect(result.outputs).toHaveLength(1);
  const source = await result.outputs[0]?.text();
  expect(source).not.toContain("node:sqlite");
});
