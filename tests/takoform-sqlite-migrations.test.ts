import { expect, test } from "bun:test";
import {
  InMemoryTakoformResourceDriver,
  type InstalledTakoformForm,
  type TakoformStoredResource,
} from "../src/index.ts";
import type { JsonObject } from "../src/ports.ts";
import type { TakoformArtifactManifest } from "../src/takoform/artifacts.ts";
import {
  applySqliteMigrationApplication,
  sqliteMigrationCondition,
} from "../src/takoform/sqlite-migrations.ts";

const apiVersion = "edge.forms.takoform.com/v1beta1";
const applicationForm: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion,
      kind: "SQLiteMigrationApplication",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"1".repeat(64)}`,
    },
  },
  role: "attachment",
  desiredSchema: {},
  operations: ["create", "read", "delete"],
};
const database = resource("SQLiteDatabase", "database", "uid_database", {});
const firstSet = resource("SQLiteMigrationSet", "first", "uid_first", {
  manifestDigest: `sha256:${"a".repeat(64)}`,
});
const secondSet = resource("SQLiteMigrationSet", "second", "uid_second", {
  manifestDigest: `sha256:${"b".repeat(64)}`,
});
const firstSql = `sha256:${"c".repeat(64)}` as const;
const secondSql = `sha256:${"d".repeat(64)}` as const;
const manifests = new Map<string, TakoformArtifactManifest>([
  [
    String(firstSet.spec.manifestDigest),
    migrationManifest([{ path: "0001.sql", digest: firstSql }]),
  ],
  [
    String(secondSet.spec.manifestDigest),
    migrationManifest([
      { path: "0001.sql", digest: firstSql },
      { path: "0002.sql", digest: secondSql },
    ]),
  ],
]);

test("SQLite migration applications append a durable prefix and render older sets Reconciling", async () => {
  const driver = new InMemoryTakoformResourceDriver();
  const first = context(firstSet, driver);
  await applySqliteMigrationApplication(first);
  expect(await sqliteMigrationCondition(first)).toBeNull();

  const second = context(secondSet, driver);
  await applySqliteMigrationApplication(second);
  expect(await sqliteMigrationCondition(second)).toBeNull();
  expect(await sqliteMigrationCondition(first)).toMatchObject({
    type: "Ready",
    status: "False",
    reason: "Reconciling",
  });

  const rewritten = resource("SQLiteMigrationSet", "rewritten", "uid_rewritten", {
    manifestDigest: `sha256:${"e".repeat(64)}`,
  });
  manifests.set(
    String(rewritten.spec.manifestDigest),
    migrationManifest([{ path: "renamed.sql", digest: firstSql }]),
  );
  await expect(applySqliteMigrationApplication(context(rewritten, driver))).rejects.toMatchObject({
    code: "migration_required",
    status: 409,
  });
});

function context(set: TakoformStoredResource, driver: InMemoryTakoformResourceDriver) {
  return {
    tenantId: "tenant-a",
    space: "conformance",
    form: applicationForm,
    relations: [relation("/database", database), relation("/migrationSet", set)],
    store: {
      async readResource(address: { readonly kind: string; readonly name: string }) {
        return (
          [database, set].find(
            (candidate) =>
              candidate.kind === address.kind && candidate.metadata.name === address.name,
          ) ?? null
        );
      },
    },
    artifacts: {
      async resolveManifest(_tenantId: string, digest: string) {
        return manifests.get(digest) ?? null;
      },
      async resolveBlob(_tenantId: string, digest: string) {
        return digest === firstSql || digest === secondSql
          ? new TextEncoder().encode("SELECT 1;")
          : null;
      },
    },
    driver,
  };
}

function relation(pointer: string, target: TakoformStoredResource) {
  return {
    pointer,
    relation: pointer,
    targetApiVersion: target.apiVersion,
    targetKind: target.kind,
    targetName: target.metadata.name,
    targetUid: target.metadata.uid,
    targetFormRef: target.form.formRef,
  };
}

function migrationManifest(
  files: readonly { readonly path: string; readonly digest: `sha256:${string}` }[],
): TakoformArtifactManifest {
  return {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "MigrationBundle",
    files: files.map((file) => ({
      ...file,
      mediaType: "application/sql",
      size: 9,
    })),
  };
}

function resource(
  kind: string,
  name: string,
  uid: string,
  spec: JsonObject,
): TakoformStoredResource {
  return {
    apiVersion,
    kind,
    form: {
      formRef: {
        apiVersion,
        kind,
        definitionVersion: "0.1.0",
        schemaDigest: `sha256:${"2".repeat(64)}`,
      },
    },
    metadata: { name, space: "conformance", uid, generation: "1", revision: "1" },
    spec,
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: "2026-08-19T00:00:00.000Z",
        },
      ],
    },
  };
}
