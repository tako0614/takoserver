import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import {
  projectApplyQualifiedMigrationArtifact,
  projectCanonicalIntegrationV2MigrationArtifact0092,
  projectFreshIntegrationV2MigrationArtifact0091,
  projectFreshIntegrationV2MigrationArtifact0092,
  projectFreshProductionMigrationArtifact,
  projectFreshProductionV2MigrationArtifact,
  projectFreshProductionV2MigrationArtifact0089,
  projectFreshV2ArtifactMigrationArtifact,
  readAuditedMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
  readCurrentMigrationSourceArtifact,
} from "../scripts/deploy/schema.ts";

const sourceDirectory = resolve(import.meta.dir, "../migrations");
const root = mkdtempSync(join(tmpdir(), "takoserver-source96-inventory-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tail = "0096_v2_configured_update_inputs.sql";
// Exact historical source bytes, independent of the apply-profile definitions.
const fixedPrefixes = {
  "22": {
    digest: "sha256:4c79742c8d143ccb806f1889184296b816401ba79d96115c2760e2d8d853b012",
    bytes: 59916,
  },
  "49": {
    digest: "sha256:b9d1b6b509625e1e80a03909d9c564f7803db0d303d0764c9762515928dbd9e4",
    bytes: 284012,
  },
  "58": {
    digest: "sha256:2039fd42b20c6ce762908caaf6b11549b5ef6b47e003028b8c01d06af4c6d303",
    bytes: 359515,
  },
  "60": {
    digest: "sha256:7923094459bd1bd333261e919d524a525f893c4806e87c608824e69605a2ccc1",
    bytes: 374712,
  },
  "66": {
    digest: "sha256:752bcae6c48a5a876a602da9f8926a94bd28f38cfe61f4050f2c507244834657",
    bytes: 394808,
  },
  "69": {
    digest: "sha256:cba297e2a1c36f7f270b7e3433d68b7ff647ecc329dcd30556d334e4bfb42969",
    bytes: 415662,
  },
  "75": {
    digest: "sha256:d9a74a4b5f97bba83a55d2e426efff966bcedf5a3fcb00d39b9a42d79c9c17ba",
    bytes: 449530,
  },
  "88": {
    digest: "sha256:269d7e6074584225606040b22405e395ea1ffba170b001b3c05605af8d637e19",
    bytes: 608441,
  },
  "89": {
    digest: "sha256:44d5cd59a772c51877d32f2f448ff929b7a50e0792ac99dea3522b1cb01545fa",
    bytes: 617840,
  },
  "91": {
    digest: "sha256:152aefa3c0577809d419d95be2bc8878aa9a390a4ee40bfbf5501c32bf058bef",
    bytes: 626279,
  },
  "92": {
    digest: "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2",
    bytes: 630048,
  },
  "94": {
    digest: "sha256:a74f191ca1e1ea5376187149b558bb8b13d68a1f18b9df2515bab9885875697f",
    bytes: 661140,
  },
  "95": {
    digest: "sha256:6219d03ef9e0062ec281b7849ba89fa5984939f21ce2559cff0ac60927ce3e85",
    bytes: 668389,
  },
  "96": {
    digest: "sha256:7ce40c12114bda2e4f60a426fd223fd82b216e10a8fd14bfcc9c43acf6380345",
    bytes: 671259,
  },
} as const;

function copySource(name: string): string {
  const directory = join(root, name);
  cpSync(sourceDirectory, directory, { recursive: true });
  return directory;
}

test("strict source96 and audited95 have distinct exact metadata and frozen projections", () => {
  const source = readCurrentMigrationSourceArtifact();
  const audited = readCurrentAuditedMigrationSourceArtifact();
  expect(source.names).toHaveLength(96);
  expect(source.names.at(-1)).toBe(tail);
  expect(source.files.at(-1)?.digest).toBe(
    "sha256:6b214d15726f7d310bdb77f1a860e251ac43f005b771105580a47adec1ea3649",
  );
  expect(audited.names).toEqual(source.names.slice(0, 95));
  expect(audited.files).toEqual(source.files.slice(0, 95));
  expect(audited).toMatchObject(fixedPrefixes[95]);
  expect(source).toMatchObject(fixedPrefixes[96]);
  for (const [count, expected] of Object.entries(fixedPrefixes)) {
    const files = source.files.slice(0, Number(count));
    const hash = createHash("sha256");
    let bytes = 0;
    for (const file of files) {
      const body = readFileSync(file.path);
      hash.update(file.name).update("\0").update(String(body.byteLength)).update("\0").update(body);
      bytes += body.byteLength;
    }
    expect({ bytes, digest: `sha256:${hash.digest("hex")}` }).toEqual(expected);
  }
  for (const [count, project] of [
    [66, projectApplyQualifiedMigrationArtifact],
    [69, projectFreshProductionMigrationArtifact],
    [75, projectFreshV2ArtifactMigrationArtifact],
    [88, projectFreshProductionV2MigrationArtifact],
    [89, projectFreshProductionV2MigrationArtifact0089],
    [91, projectFreshIntegrationV2MigrationArtifact0091],
    [92, projectFreshIntegrationV2MigrationArtifact0092],
    [92, projectCanonicalIntegrationV2MigrationArtifact0092],
  ] as const) {
    const projected = project(audited);
    expect(projected.names).toEqual(source.names.slice(0, count));
    expect(projected).toMatchObject(fixedPrefixes[count]);
    expect(projected.names).not.toContain(tail);
  }
});

test("known95 corpus remains an audited view but cannot claim complete source96", () => {
  const directory = copySource("legacy95");
  rmSync(join(directory, tail));
  expect(readCurrentAuditedMigrationSourceArtifact(directory)).toMatchObject(fixedPrefixes[95]);
  expect(readAuditedMigrationArtifact(directory)).toMatchObject(fixedPrefixes[66]);
  expect(() => readCurrentMigrationSourceArtifact(directory)).toThrow("exactly 0001-0096");
});

test("modified96 and unknown97 cannot hide behind an otherwise valid95 projection", () => {
  for (const mutation of ["changed96", "foreign96", "unknown97"] as const) {
    const directory = copySource(mutation);
    if (mutation === "changed96") {
      const path = join(directory, tail);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n-- changed\n`);
    } else if (mutation === "foreign96") {
      renameSync(join(directory, tail), join(directory, "0096_foreign.sql"));
    } else {
      writeFileSync(join(directory, "0097_unknown.sql"), "CREATE TABLE unknown_source(id TEXT);\n");
    }
    for (const read of [
      readCurrentMigrationSourceArtifact,
      readCurrentAuditedMigrationSourceArtifact,
      readAuditedMigrationArtifact,
    ]) {
      expect(() => read(directory)).toThrow(
        mutation === "changed96"
          ? "exact audited migration SHA-256"
          : read === readCurrentMigrationSourceArtifact
            ? "exactly 0001-0096"
            : "exactly 0001-0095",
      );
    }
  }
});

test("duplicate96 is rejected as numbering corruption before source-tail projection", () => {
  const directory = copySource("duplicate96");
  copyFileSync(join(directory, tail), join(directory, "0096_duplicate.sql"));
  for (const read of [
    readMigrationArtifact,
    readCurrentMigrationSourceArtifact,
    readCurrentAuditedMigrationSourceArtifact,
    readAuditedMigrationArtifact,
  ]) {
    expect(() => read(directory)).toThrow("gap-free");
  }
});

test("old95 hash changes remain fatal to both current96 and legacy95 views", () => {
  const directory = copySource("changed95");
  const path = join(directory, "0095_stripe_billing.sql");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n-- changed\n`);
  for (const read of [
    readCurrentMigrationSourceArtifact,
    readCurrentAuditedMigrationSourceArtifact,
    readAuditedMigrationArtifact,
  ]) {
    expect(() => read(directory)).toThrow("exact audited migration SHA-256");
  }
});
