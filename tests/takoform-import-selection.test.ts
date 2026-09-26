import { describe, expect, test } from "bun:test";
import type { ProviderOffering } from "../src/provider-port.ts";
import {
  encodeTakoformApplySelection,
  parseTakoformApplySelection,
} from "../src/takoform/apply-selection.ts";
import {
  encodeTakoformImportSelection,
  parseTakoformImportSelection,
  sameTakoformImportSelection,
  TAKOFORM_IMPORT_SELECTION_VERSION,
  type TakoformImportSelection,
  type TakoformImportSelectionRelation,
} from "../src/takoform/import-selection.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverRelation,
  TakoformStoredResource,
} from "../src/takoform/types.ts";

const FORM_REF = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "WorkerEndpoint",
  definitionVersion: "0.1.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};

const relation: TakoformImportSelectionRelation = {
  pointer: "/database",
  relation: "/database",
  targetUid: "uid-database",
  resource: {
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "SQLiteDatabase",
    formRef: {
      ...FORM_REF,
      kind: "SQLiteDatabase",
    },
    name: "database",
    space: "main",
    uid: "uid-database",
    generation: "1",
    revision: "1",
  },
  deployment: {
    id: "dep-database",
    resourceUid: "uid-database",
    offeringId: "sqlite",
    providerPackRef: "provider-pack",
    providerInstallationRef: "provider-installation",
    nativeId: "native-database",
    state: "active",
    nativeClaimed: true,
    projectionDigest: `sha256:${"b".repeat(64)}`,
  },
};

const offering: ProviderOffering = {
  id: "provider-offering",
  kind: "worker",
  displayName: "Provider worker",
  form: FORM_REF,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["import", "observe", "delete"],
};

const intrinsic: TakoformImportSelection = {
  version: TAKOFORM_IMPORT_SELECTION_VERSION,
  kind: "intrinsic",
  nativeId: "native-worker",
};

const sqlite: TakoformImportSelection = {
  version: TAKOFORM_IMPORT_SELECTION_VERSION,
  kind: "sqlite-migration",
  nativeId: "native-application",
  relations: [relation],
};

const provider: TakoformImportSelection = {
  version: TAKOFORM_IMPORT_SELECTION_VERSION,
  kind: "provider",
  nativeId: "native-worker",
  providerPackRef: "provider-pack",
  providerInstallationRef: "provider-installation",
  technicalOffering: offering,
  placement: { kind: "catalog", offeringId: offering.id },
  incumbent: {
    id: "dep-worker",
    resourceUid: "uid-worker",
    offeringId: offering.id,
    providerPackRef: "provider-pack",
    providerInstallationRef: "provider-installation",
    nativeId: "native-worker",
    state: "active",
    nativeClaimed: true,
    projectionDigest: `sha256:${"c".repeat(64)}`,
  },
  relations: [relation],
};

describe("Takoform import selection codec", () => {
  test("round-trips intrinsic, SQLite, and provider snapshots canonically", () => {
    for (const selection of [intrinsic, sqlite, provider]) {
      const encoded = encodeTakoformImportSelection(selection);
      expect(parseTakoformImportSelection(encoded)).toEqual(selection);
      expect(sameTakoformImportSelection(selection, parseTakoformImportSelection(encoded))).toBe(
        true,
      );
      expect(encoded).toBe(JSON.stringify(JSON.parse(encoded)));
    }
    expect(encodeTakoformImportSelection(provider)).toContain('"placement":{"kind":"catalog"');
  });

  test("keeps import and apply envelopes mutually exclusive", () => {
    const apply = encodeTakoformApplySelection({
      version: "takoserver.takoform-apply-selection@v1",
      kind: "intrinsic",
    });
    expect(() => parseTakoformImportSelection(apply)).toThrow("invalid import selection");
    expect(() => parseTakoformApplySelection(encodeTakoformImportSelection(intrinsic))).toThrow(
      "invalid apply selection",
    );
  });

  test("rejects noncanonical, oversized, and unknown fields", () => {
    expect(() =>
      parseTakoformImportSelection(
        `{"version":"${TAKOFORM_IMPORT_SELECTION_VERSION}","kind":"intrinsic","nativeId":"native-worker"}`,
      ),
    ).toThrow("noncanonical import selection");
    expect(() =>
      parseTakoformImportSelection(
        `{"kind":"intrinsic","version":"${TAKOFORM_IMPORT_SELECTION_VERSION}","extra":"x"}`,
      ),
    ).toThrow("invalid import selection");
    expect(() =>
      parseTakoformImportSelection(
        `{"kind":"intrinsic","version":"${TAKOFORM_IMPORT_SELECTION_VERSION}","nativeId":"native-worker","padding":"${"x".repeat(131_072)}"}`,
      ),
    ).toThrow("invalid import selection");
  });

  test("requires an explicit native claim and allows inherited placement", () => {
    const inherited = { ...provider, placement: { kind: "inherited" as const } };
    expect(parseTakoformImportSelection(encodeTakoformImportSelection(inherited))).toEqual(
      inherited,
    );

    const missingClaim = JSON.parse(encodeTakoformImportSelection(provider)) as Record<
      string,
      unknown
    >;
    const incumbent = missingClaim.incumbent as Record<string, unknown>;
    delete incumbent.nativeClaimed;
    expect(() => parseTakoformImportSelection(JSON.stringify(missingClaim))).toThrow(
      "invalid import selection",
    );

    const invalidClaim = JSON.parse(encodeTakoformImportSelection(provider)) as Record<
      string,
      unknown
    >;
    (invalidClaim.incumbent as Record<string, unknown>).nativeClaimed = "true";
    expect(() => parseTakoformImportSelection(JSON.stringify(invalidClaim))).toThrow(
      "invalid import selection",
    );
  });
});

describe("InMemoryTakoformResourceDriver import selection", () => {
  test("selects intrinsic or SQLite snapshots without a current-target fallback", async () => {
    const driver = new InMemoryTakoformResourceDriver();
    const database = resource("SQLiteDatabase", "database", "uid-database");
    const relationInput: TakoformDriverRelation = {
      pointer: "/database",
      relation: "/database",
      targetUid: database.metadata.uid,
      resource: database,
    };
    const sqliteForm = form("SQLiteMigrationApplication", "attachment");
    const sqliteSelection = await driver.selectImport({
      tenantId: "tenant",
      resourceUid: "uid-application",
      form: sqliteForm,
      name: "application",
      space: "main",
      spec: {},
      nativeId: "native-application",
      relations: [relationInput],
    });
    expect(sqliteSelection.kind).toBe("sqlite-migration");
    if (sqliteSelection.kind !== "sqlite-migration") throw new Error("expected SQLite selection");
    expect(sqliteSelection.relations[0]?.deployment?.nativeClaimed).toBe(false);

    const intrinsicSelection = await driver.selectImport({
      tenantId: "tenant",
      resourceUid: "uid-worker",
      form: form("WorkerEndpoint"),
      name: "worker",
      space: "main",
      spec: {},
      nativeId: "native-worker",
      relations: [],
    });
    expect(intrinsicSelection).toEqual({ ...intrinsic, nativeId: "native-worker" });

    await expect(
      driver.import({
        operationId: "op-import",
        operationMode: "initial",
        executionAuthority: {
          tenantId: "tenant",
          resourceUid: "uid-worker",
          leaseToken: "lease-import",
          fingerprint: "fingerprint-import",
        },
        tenantId: "tenant",
        resourceUid: "uid-worker",
        form: form("WorkerEndpoint"),
        name: "worker",
        space: "main",
        spec: {},
        nativeId: "native-worker",
        relations: [],
        selection: { ...intrinsic, nativeId: "different-native" },
      }),
    ).rejects.toMatchObject({ code: "resource_busy", status: 409 });
  });
});

function form(kind: string, role?: InstalledTakoformForm["role"]): InstalledTakoformForm {
  return {
    identity: {
      formRef: { ...FORM_REF, kind },
    },
    ...(role ? { role } : {}),
    desiredSchema: {},
    operations: ["create", "read", "delete", "import", "observe"],
  };
}

function resource(kind: string, name: string, uid: string): TakoformStoredResource {
  const installed = form(kind, kind === "SQLiteDatabase" ? "deployment" : undefined);
  return {
    apiVersion: installed.identity.formRef.apiVersion,
    kind,
    form: installed.identity,
    metadata: {
      name,
      space: "main",
      uid,
      generation: "1",
      revision: "1",
    },
    spec: {},
    status: {
      observedGeneration: "1",
      conditions: [],
    },
  };
}
