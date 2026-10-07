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

export type V2OperatorFormFactory = (context: {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly clock: Clock;
}) => Readonly<Record<string, V2Form>>;

/** Compose only Forms whose complete v2 backend is available at this entry. */
export function createTakoformV2Application(options: {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly accounts: Pick<Accounts, "authenticate" | "requireOwner">;
  readonly publicOrigin: string;
  readonly config: V2ApplicationConfig;
  readonly clock: Clock;
  /** Selected by the embedding operator, never by public configuration or a request. */
  readonly formFactory?: V2OperatorFormFactory;
  /** Operator-private composition only; never parsed from public config. */
  readonly privateInputCustody?: V2PrivateInputCustody;
}) {
  if (options.formFactory !== undefined && typeof options.formFactory !== "function") {
    throw new TypeError("v2 Form factory must be a function");
  }
  const { sql, objects, accounts, publicOrigin, config, clock } = options;
  const access = createTakoformV2AccountAccess(accounts);
  const forms: Record<string, V2Form> = Object.create(null) as Record<string, V2Form>;
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
  if (options.formFactory !== undefined) {
    const selected = options.formFactory({ sql, objects, clock });
    if (
      !selected ||
      typeof selected !== "object" ||
      Array.isArray(selected) ||
      (Object.getPrototypeOf(selected) !== Object.prototype &&
        Object.getPrototypeOf(selected) !== null)
    ) {
      throw new TypeError("v2 Form factory must return a plain exact Form map");
    }
    for (const url of Reflect.ownKeys(selected)) {
      const descriptor = Object.getOwnPropertyDescriptor(selected, url);
      if (typeof url !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("v2 Form map must contain only enumerable exact Form entries");
      }
      if (Object.hasOwn(forms, url)) throw new TypeError("duplicate v2 Form URL");
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
      forms[url] = form;
    }
  }
  return createTakoformV2Host({
    sql,
    now: clock,
    authorize: access.authorize,
    forms: Object.freeze(forms),
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
