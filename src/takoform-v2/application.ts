import type { Accounts } from "../auth.ts";
import type { Clock, ObjectStoreAccess, Sql } from "../ports.ts";
import { createTakoformV2AccountAccess } from "./accounts.ts";
import type { V2ApplicationConfig } from "./config.ts";
import { createV2HeldArtifactSource } from "./forms/artifact-source.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "./forms/sqlite-migration-set.ts";
import { createSQLiteMigrationSetForm } from "./forms/sqlite-migration-set-backend.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "./forms/static-asset-bundle.ts";
import { createStaticAssetBundleForm } from "./forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "./forms/worker-bundle.ts";
import { createWorkerBundleForm } from "./forms/worker-bundle-backend.ts";
import { createTakoformV2Host } from "./host.ts";
import type { V2PrivateInputCustody } from "./private-inputs.ts";
import type { V2Form } from "./types.ts";

export interface V2OperatorFormMaps {
  /** Complete public support only. */
  readonly forms: Readonly<Record<string, V2Form>>;
  /** Existing accepted Resource/Operation recovery only. */
  readonly retainedForms: Readonly<Record<string, V2Form>>;
}

export type V2OperatorFormFactory = (context: {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly clock: Clock;
}) => Readonly<Record<string, V2Form>>;

export type V2OperatorFormSelectionFactory = (
  context: Parameters<V2OperatorFormFactory>[0],
) => V2OperatorFormMaps;

function plainMap(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function addForms(
  selected: unknown,
  target: Record<string, V2Form>,
  other: Record<string, V2Form>,
): void {
  if (!plainMap(selected))
    throw new TypeError("v2 Form factory must return a plain exact Form map");
  for (const url of Reflect.ownKeys(selected)) {
    const descriptor = Object.getOwnPropertyDescriptor(selected, url);
    if (typeof url !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("v2 Form map must contain only enumerable exact Form entries");
    }
    if (Object.hasOwn(target, url) || Object.hasOwn(other, url))
      throw new TypeError("duplicate v2 Form URL");
    const form = descriptor.value as V2Form | undefined;
    if (
      !form ||
      typeof form.validateCreate !== "function" ||
      typeof form.validateUpdate !== "function" ||
      !form.backend ||
      typeof form.backend.id !== "string" ||
      form.backend.id.length === 0 ||
      typeof form.backend.targetKey !== "string" ||
      form.backend.targetKey.length === 0 ||
      typeof form.backend.execute !== "function" ||
      typeof form.backend.reconcile !== "function"
    ) {
      throw new TypeError("v2 Form factory returned an incomplete backend");
    }
    target[url] = form;
  }
}

/** Compose complete public Forms and optional retained-only internal adapters. */
export function createTakoformV2Application(options: {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly accounts: Pick<Accounts, "authenticate" | "requireOwner">;
  readonly publicOrigin: string;
  readonly config: V2ApplicationConfig;
  readonly clock: Clock;
  /** Selected by the embedding operator, never by public configuration or a request. */
  readonly formFactory?: V2OperatorFormFactory;
  /** Code-only full plus retained maps; mutually exclusive with formFactory. */
  readonly formSelectionFactory?: V2OperatorFormSelectionFactory;
  /** Operator-private composition only; never parsed from public config. */
  readonly privateInputCustody?: V2PrivateInputCustody;
}) {
  if (
    (options.formFactory !== undefined && typeof options.formFactory !== "function") ||
    (options.formSelectionFactory !== undefined &&
      typeof options.formSelectionFactory !== "function") ||
    (options.formFactory !== undefined && options.formSelectionFactory !== undefined)
  ) {
    throw new TypeError("v2 Form factory must be a function");
  }
  const { sql, objects, accounts, publicOrigin, config, clock } = options;
  const access = createTakoformV2AccountAccess(accounts);
  const forms: Record<string, V2Form> = Object.create(null) as Record<string, V2Form>;
  const retainedForms: Record<string, V2Form> = Object.create(null) as Record<string, V2Form>;
  if (config.sqliteMigrationSet) {
    const source = createV2HeldArtifactSource({
      objects,
      entries: config.sqliteMigrationSet.heldArtifacts,
    });
    forms[SQLITE_MIGRATION_SET_FORM_URL] = createSQLiteMigrationSetForm({
      sql,
      source,
      targetKey: config.sqliteMigrationSet.targetKey,
    });
  }
  if (config.workerBundle) {
    const source = createV2HeldArtifactSource({
      objects,
      entries: config.workerBundle.heldArtifacts,
    });
    forms[WORKER_BUNDLE_FORM_URL] = createWorkerBundleForm({
      sql,
      source,
      targetKey: config.workerBundle.targetKey,
    });
  }
  if (config.staticAssetBundle) {
    const source = createV2HeldArtifactSource({
      objects,
      entries: config.staticAssetBundle.heldArtifacts,
    });
    forms[STATIC_ASSET_BUNDLE_FORM_URL] = createStaticAssetBundleForm({
      sql,
      source,
      targetKey: config.staticAssetBundle.targetKey,
    });
  }
  if (options.formFactory !== undefined || options.formSelectionFactory !== undefined) {
    const selected = options.formSelectionFactory
      ? options.formSelectionFactory({ sql, objects, clock })
      : options.formFactory?.({ sql, objects, clock });
    if (!plainMap(selected)) {
      throw new TypeError("v2 Form factory must return a plain exact Form map");
    }
    const wrapped = Object.hasOwn(selected, "forms") || Object.hasOwn(selected, "retainedForms");
    if (wrapped !== (options.formSelectionFactory !== undefined)) {
      throw new TypeError("v2 Form selection must contain exact Form maps");
    }
    if (wrapped) {
      const keys = Reflect.ownKeys(selected);
      const supported = Object.getOwnPropertyDescriptor(selected, "forms");
      const retained = Object.getOwnPropertyDescriptor(selected, "retainedForms");
      if (
        keys.length !== 2 ||
        !supported?.enumerable ||
        !("value" in supported) ||
        !retained?.enumerable ||
        !("value" in retained)
      ) {
        throw new TypeError("v2 Form selection must contain exact Form maps");
      }
      addForms(supported.value, forms, retainedForms);
      addForms(retained.value, retainedForms, forms);
    } else {
      addForms(selected, forms, retainedForms);
    }
  }
  return createTakoformV2Host({
    sql,
    now: clock,
    authorize: access.authorize,
    forms: Object.freeze(forms),
    retainedForms: Object.freeze(retainedForms),
    baseUrl: `${publicOrigin}/apis/forms.takoform.com/v2`,
    documentation: config.documentation,
    authenticationDocumentation: config.authenticationDocumentation,
    authenticationSchemes: ["Bearer"],
    maxRequestBytes: 1_048_576,
    maxPageSize: 100,
    replayWindowSeconds: 86_400,
    cursorSigningKey: config.cursorSigningKey,
    ...(options.privateInputCustody ? { privateInputCustody: options.privateInputCustody } : {}),
    authenticate: access.authenticate,
  });
}
