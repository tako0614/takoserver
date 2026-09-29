import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { createTakoformHost } from "../src/takoform/host.ts";
import { createTakoformHostAuthority } from "../src/takoform/host-authority.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { createStaticStableInMemoryTakoformHost } from "./helpers/historical-takoform-host.ts";

const LANE = "/apis/forms.takoform.com/v1";

interface ExpectedFormRef {
  readonly resourceType: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

/**
 * The exact FormRefs the current yurucommu deploy/takoform graph plans.
 *
 * Copied from the Provider release that pins a published publisher set —
 * takoform v4.1.0, formPublisherCommit
 * 3231633605b737ce5279d7fc020b4780568e7091, formSetTag
 * forms/sets/e7f8a39311dd011b8467e97e7f300cabb9a6b06c (release/version.json and
 * release/provider-form-identities.json in the Provider repository). Each row
 * is one resource type the module declares.
 *
 * The list is here so that dropping a declaration is a deliberate, reviewed
 * edit instead of a silent one. A published FormRef this Host stops carrying
 * is refused at plan time by every pinned provider release whose set named it,
 * and the author sees a refusal they cannot tell apart from a wrong resource
 * list.
 */
const YURUCOMMU_SHAPED_FORM_REFS: readonly ExpectedFormRef[] = [
  {
    resourceType: "takoform_module_worker",
    apiVersion: "edge.forms.takoform.com",
    kind: "ModuleWorker",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:049df2fb1eda53e4ccb0d646022a3ded8bc17c44eb433fa2e5ac0861efe42ac7",
  },
  {
    resourceType: "takoform_worker_bundle",
    apiVersion: "edge.forms.takoform.com",
    kind: "WorkerBundle",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:cb21984a579ae2706bddada8b44a22c0f8390994550c10d7c65df82edfa1141b",
  },
  {
    resourceType: "takoform_worker_version",
    apiVersion: "edge.forms.takoform.com",
    kind: "WorkerVersion",
    definitionVersion: "0.3.0",
    schemaDigest: "sha256:65870343bfab512fe5e7ae6faea8b3dbc48f9c9de0d4d9349dcbfd819f06d365",
  },
  {
    resourceType: "takoform_worker_deployment",
    apiVersion: "edge.forms.takoform.com",
    kind: "WorkerDeployment",
    definitionVersion: "0.2.0",
    schemaDigest: "sha256:3d5174bf2c3f351cf1468607689019e9eaa503a353eceb3095cf3d31bad62081",
  },
  {
    resourceType: "takoform_worker_endpoint",
    apiVersion: "edge.forms.takoform.com",
    kind: "WorkerEndpoint",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:732f60aba45ce360d5ebbc6ac2e55fe4d59b65d353f4628e93960d71fbc2870f",
  },
  {
    resourceType: "takoform_worker_cron_trigger",
    apiVersion: "edge.forms.takoform.com",
    kind: "WorkerCronTrigger",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:5faa838c794b3326d0377d641db6247d4320b6ce39b1b0bb660d4deec18fe5ed",
  },
  {
    resourceType: "takoform_edge_kv_namespace",
    apiVersion: "edge.forms.takoform.com",
    kind: "EdgeKVNamespace",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:1a3f5d50bde53b4f743334dba3b0d0d28c1516727ca76d266beb61c5ee210022",
  },
  {
    resourceType: "takoform_edge_object_bucket",
    apiVersion: "edge.forms.takoform.com",
    kind: "ObjectBucket",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557",
  },
  {
    resourceType: "takoform_sqlite_database",
    apiVersion: "edge.forms.takoform.com",
    kind: "SQLiteDatabase",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:c72eeb66ef96c4679b5c724fa1219d71c89bb7eeb9e543d73d868ec41bddddfe",
  },
  {
    resourceType: "takoform_sqlite_migration_set",
    apiVersion: "edge.forms.takoform.com",
    kind: "SQLiteMigrationSet",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:05a4aa2ebd8fbf659f05ae378288d9c9657cc7478e1437f013732199bfcce7b9",
  },
  {
    resourceType: "takoform_sqlite_migration_application",
    apiVersion: "edge.forms.takoform.com",
    kind: "SQLiteMigrationApplication",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:f3b42ede7bad664e494a04ea6f0fd167082988688fe96f4ec1fbb80db13a8e01",
  },
  {
    resourceType: "takoform_at_least_once_queue",
    apiVersion: "edge.forms.takoform.com",
    kind: "AtLeastOnceQueue",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:0355b4d3073bc2707fccb6edd8c90350892059ecf08abfec00a00d950c9eaa0e",
  },
  {
    resourceType: "takoform_queue_consumer",
    apiVersion: "edge.forms.takoform.com",
    kind: "QueueConsumer",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:fffd4cc133eb03aa7fd57af9316a68fb9813544e78e0e55111df1341d8b8f453",
  },
];

/** The superseded identity yurucommu's previous provider pin emitted. */
const SUPERSEDED_WORKER_VERSION = {
  apiVersion: "edge.forms.takoform.com",
  kind: "WorkerVersion",
  definitionVersion: "0.2.0",
  schemaDigest: "sha256:3d4eeed966867a1ef8d7ce629a77c4b9687c6d48d3e496d22314b29aff0a42ed",
} as const;

function host() {
  const catalog = currentTakoformCandidates();
  return createStaticStableInMemoryTakoformHost({
    forms: catalog.forms,
    bindings: catalog.bindings,
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
  });
}

/**
 * The Host that actually refused the plan: a durable form authority in front of
 * the same compiled Form set.
 *
 * It is unseeded on purpose. Nothing is installed for this tenant, so this Host
 * refuses the current FormRef too, and the refusal detail must stay a statement
 * about what the build declares rather than a promise of support.
 */
function durableHost() {
  const catalog = currentTakoformCandidates();
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  return createTakoformHost({
    sql,
    objects,
    forms: catalog.forms,
    bindings: catalog.bindings,
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    authority: createTakoformHostAuthority({
      sql,
      objects,
      hostId: "https://host.invalid",
      candidates: catalog.forms,
      bindings: catalog.bindings,
      technicalAvailability: {
        async resolve() {
          return { executable: true, activated: true, availableToPrincipal: true };
        },
      },
    }),
    driver: new InMemoryTakoformResourceDriver(),
  });
}

function supportUrl(ref: { apiVersion: string; kind: string; definitionVersion: string }): string {
  return (
    "https://host.invalid" +
    LANE +
    "/support/forms/" +
    ref.apiVersion +
    "/" +
    ref.kind +
    "/" +
    ref.definitionVersion
  );
}

describe("Host Support Profile against a pinned Provider release", () => {
  test("declares every FormRef a yurucommu-shaped deploy/takoform graph plans", async () => {
    const stable = host();
    for (const expected of YURUCOMMU_SHAPED_FORM_REFS) {
      const response = await stable.handle(new Request(supportUrl(expected)));
      expect(response?.status).toBe(200);
      const profile = (await response?.json()) as {
        apiVersion: string;
        formRef: Record<string, unknown>;
        operations: readonly string[];
      };
      expect(profile.apiVersion).toBe("support.takoform.com/v1");
      expect(profile.formRef).toEqual({
        apiVersion: expected.apiVersion,
        kind: expected.kind,
        definitionVersion: expected.definitionVersion,
        schemaDigest: expected.schemaDigest,
      });
      expect(profile.operations).toContain("create");
      expect(profile.operations).toContain("delete");
    }
  });

  test("a superseded definitionVersion stays refused and names the definition this Host carries", async () => {
    const response = await host().handle(new Request(supportUrl(SUPERSEDED_WORKER_VERSION)));
    // The refusal is the point: this Host does not implement 0.2.0, and no
    // detail below turns the answer into support for it.
    expect(response?.status).toBe(404);
    const body = (await response?.json()) as {
      error: {
        code: string;
        retryable: boolean;
        details?: {
          requestedDefinitionVersion?: string;
          declaredDefinitionVersions?: readonly string[];
        };
      };
    };
    expect(body.error.code).toBe("form_unknown");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details?.requestedDefinitionVersion).toBe("0.2.0");
    expect(body.error.details?.declaredDefinitionVersions).toEqual(["0.3.0"]);
  });

  test("a kind this Host does not carry at all declares no definition version", async () => {
    const response = await host().handle(
      new Request(
        supportUrl({
          apiVersion: "edge.forms.takoform.com",
          kind: "Function",
          definitionVersion: "0.1.0",
        }),
      ),
    );
    expect(response?.status).toBe(404);
    const body = (await response?.json()) as {
      error: { code: string; details?: { declaredDefinitionVersions?: readonly string[] } };
    };
    expect(body.error.code).toBe("form_unknown");
    expect(body.error.details?.declaredDefinitionVersions).toEqual([]);
  });

  test("a durable authority refuses the same FormRefs and still names the declared one", async () => {
    const current = await durableHost().handle(
      new Request(
        supportUrl({
          apiVersion: "edge.forms.takoform.com",
          kind: "WorkerVersion",
          definitionVersion: "0.3.0",
        }),
      ),
    );
    // The declared FormRef is refused while this tenant has nothing installed:
    // the detail names where an author can retarget, never that the retarget
    // will be served.
    expect(current?.status).toBe(404);
    if (!current) throw new Error("support refusal missing");
    expect(((await current.json()) as { error: { code: string } }).error.code).toBe("form_unknown");

    const response = await durableHost().handle(new Request(supportUrl(SUPERSEDED_WORKER_VERSION)));
    expect(response?.status).toBe(404);
    const body = (await response?.json()) as {
      error: {
        code: string;
        retryable: boolean;
        details?: {
          requestedDefinitionVersion?: string;
          declaredDefinitionVersions?: readonly string[];
        };
      };
    };
    expect(body.error.code).toBe("form_unknown");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details?.requestedDefinitionVersion).toBe("0.2.0");
    expect(body.error.details?.declaredDefinitionVersions).toEqual(["0.3.0"]);
  });
});
