import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takoformCoreVerifierArtifactDigest } from "../scripts/deploy/form-authority.ts";
import { runSelfhostFormAdmission } from "../scripts/selfhost-form-admission.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE } from "../src/generated/takoform-publisher-set-authority-closure.ts";
import { TAKOFORM_PUBLISHER_SET_RECEIPT } from "../src/generated/takoform-publisher-set-receipt.ts";
import { bytesDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  TAKOFORM_CORE_COMMIT,
  TAKOFORM_CORE_VERIFIER_PROTOCOL,
  TAKOFORM_CORE_VERSION,
} from "../src/takoform/form-authority-verification.ts";
import { YURUCOMMU_FORM_VERSIONS } from "../src/takoform/implementation-catalog.ts";

const ARTIFACT_DIGEST = takoformCoreVerifierArtifactDigest();
const RAW_POLICY_DIGEST = await bytesDigest(
  new TextEncoder().encode(TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE.core.publisherPolicy),
);
const IMPLEMENTED = Object.keys(YURUCOMMU_FORM_VERSIONS).length;

describe("self-host Form admission", () => {
  test("plans the exact publisher set as a dry run and records nothing", async () => {
    const fixture = dataRoot();
    try {
      const verifier = fakeCoreVerifier();
      const result = await runSelfhostFormAdmission({
        organizationId: "org_selfhost",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: false,
        sql: fixture.sql,
        objects: fixture.objects,
        fetch: verifier.fetch,
      });
      expect(result.applied).toBeNull();
      expect(result.plan.packages).toHaveLength(17);
      expect(result.plan.commands).toHaveLength(2 + 17 + IMPLEMENTED * 2);
      expect(verifier.calls).toEqual(["/v1/identity"]);
      expect(await fixture.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test("applies the admission through the released Core verifier and activates the implemented subset", async () => {
    const fixture = dataRoot();
    try {
      const verifier = fakeCoreVerifier();
      const result = await runSelfhostFormAdmission({
        organizationId: "org_selfhost",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: true,
        sql: fixture.sql,
        objects: fixture.objects,
        fetch: verifier.fetch,
      });
      const applied = result.applied;
      if (!applied) throw new Error("apply result is missing");
      expect(applied.status).toBe("converged");
      expect(applied.verificationMode).toBe("released-core");
      expect(verifier.calls).toEqual(["/v1/identity", "/v1/verify-set"]);
      const forms = applied.readback.forms;
      expect(forms.filter((form) => form.installed)).toHaveLength(17);
      expect(forms.filter((form) => form.supported)).toHaveLength(IMPLEMENTED);
      expect(forms.filter((form) => form.activationHead.active)).toHaveLength(IMPLEMENTED);
      // ADR 0007: an identity Form is admitted with the operations its Form
      // declares on a Host that realizes its supply, and with an EMPTY set on
      // one that does not. A self-host realizes the ObjectBucket supply now —
      // object bodies under its data root, metadata in its control database,
      // and a Provider Pack owning both halves of the object Binding — so the
      // Form is admitted with the five operations it declares and never with
      // `update`, which it does not declare however wide the other sets are.
      expect(forms.find((form) => form.formRef.kind === "ObjectBucket")).toMatchObject({
        installed: true,
        supported: true,
        operations: ["create", "read", "delete", "import", "observe"],
        activationHead: { present: true, active: true },
      });
      // Every other supported Form still carries the operations it declares.
      expect(forms.find((form) => form.formRef.kind === "EdgeKVNamespace")?.operations).toEqual([
        "create",
        "read",
        "delete",
        "import",
        "observe",
      ]);
      expect(await fixture.sql.query("SELECT count(*) AS c FROM tf_form_install_events")).toEqual([
        { c: 17 },
      ]);

      const again = await runSelfhostFormAdmission({
        organizationId: "org_selfhost",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: true,
        sql: fixture.sql,
        objects: fixture.objects,
        fetch: verifier.fetch,
      });
      expect(again.plan.commands).toEqual([]);
      expect(again.applied?.status).toBe("converged");
    } finally {
      fixture.close();
    }
  });

  test("refuses a verifier whose live identity is not the exact released Core", async () => {
    const fixture = dataRoot();
    try {
      const verifier = fakeCoreVerifier({ artifactDigest: `sha256:${"b".repeat(64)}` });
      await expect(
        runSelfhostFormAdmission({
          organizationId: "org_selfhost",
          space: "default",
          hostId: "http://localhost:8787",
          coreVerifierUrl: "http://127.0.0.1:1",
          apply: true,
          sql: fixture.sql,
          objects: fixture.objects,
          fetch: verifier.fetch,
        }),
      ).rejects.toMatchObject({ code: "artifact_mismatch" });
      expect(await fixture.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
    } finally {
      fixture.close();
    }
  });
});

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-admission-"));
  const database = new Database(join(root, "control.sqlite"));
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  return {
    sql: createSqliteSql(database),
    objects: createFileObjectStore({ root }),
    close() {
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function fakeCoreVerifier(options?: { readonly artifactDigest?: `sha256:${string}` }) {
  const calls: string[] = [];
  const identity = {
    protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
    coreVersion: TAKOFORM_CORE_VERSION,
    coreCommit: TAKOFORM_CORE_COMMIT,
    artifactDigest: options?.artifactDigest ?? ARTIFACT_DIGEST,
  };
  const receipt = TAKOFORM_PUBLISHER_SET_RECEIPT;
  return {
    calls,
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === "/v1/identity") return Response.json(identity);
      const body = (await request.json()) as {
        readonly packages: readonly { packageDigest: string; formRef: unknown }[];
      };
      return Response.json({
        identity,
        publisher: {
          policyDigest: RAW_POLICY_DIGEST,
          trustedRootDigest: receipt.trustedRootDigest,
          oidcIssuer: receipt.oidcIssuer,
          sourceRepository: receipt.sourceRepository,
          workflow: receipt.workflow,
          ref: receipt.ref,
          identity: receipt.publisherIdentity,
          sourceCommit: receipt.sourceCommit,
          workflowCommit: receipt.workflowCommit,
          buildConfigCommit: receipt.buildConfigCommit,
        },
        checkpoint: {
          checkpointApiVersion: receipt.checkpoint.apiVersion,
          sequence: receipt.checkpoint.sequence,
          digest: receipt.checkpoint.digest,
          entriesDigest: receipt.checkpoint.entriesDigest,
          bundleDigest: receipt.checkpoint.bundleDigest,
          revokedPackageDigests: [],
        },
        packages: body.packages.map((pkg) => {
          const entry = receipt.packages.find((item) => item.packageDigest === pkg.packageDigest);
          if (!entry) throw new Error(`unexpected package ${pkg.packageDigest}`);
          return {
            packageDigest: pkg.packageDigest,
            formRef: pkg.formRef,
            bundleDigest: entry.bundleDigest,
          };
        }),
      });
    },
  };
}
