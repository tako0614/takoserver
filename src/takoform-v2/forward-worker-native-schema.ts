import { FORWARD_NATIVE_BASE_OBJECTS } from "./forward-worker-native-source.ts";
import {
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME,
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL,
} from "./operation-generation-index.ts";
import {
  v2WorkerNativeIdentityDomainReady,
  v2WorkerOpaqueDeletionTableSql,
} from "./worker-native-identity-schema.ts";

const OLD_VERSION = "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/";
const FORWARD_VERSION = "https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/";
const OLD_DEPLOYMENT = "https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/";
const FORWARD_DEPLOYMENT = "https://edge.forms.takoform.com/forms/WorkerDeployment/0.6.0/";
const VERSION_DOMAIN = `'${OLD_VERSION}', '${FORWARD_VERSION}'`;
const DEPLOYMENT_DOMAIN = `'${OLD_DEPLOYMENT}', '${FORWARD_DEPLOYMENT}'`;
const ASSERTION = "_tf_forward_worker_native106_assert";
const AFFECTED_TABLES = [
  "tf_v2_worker_native_effects",
  "tf_v2_worker_native_deletions",
  "tf_v2_worker_cron_matches",
  "queue_v2_batch_executions",
] as const;

function replaceExact(sql: string, from: string, to: string, count: number): string {
  if (sql.split(from).length - 1 !== count) {
    throw new Error("Forward native source closure changed");
  }
  return sql.replaceAll(from, to);
}

/** The six effective historical trigger definitions are the only changed guards. */
function successorTrigger(name: string, sql: string): string {
  switch (name) {
    case "tf_v2_worker_native_effect_insert_guard":
      return replaceExact(
        sql,
        `r.form_url = '${OLD_VERSION}'`,
        `r.form_url IN (${VERSION_DOMAIN})`,
        1,
      );
    case "tf_v2_worker_native_deletion_stage_guard":
    case "tf_v2_worker_native_deletion_send_guard":
    case "tf_v2_worker_native_deletion_presend_absence_guard":
      return replaceExact(
        sql,
        `version.form_url = '${OLD_VERSION}'`,
        `version.form_url IN (${VERSION_DOMAIN})`,
        1,
      );
    case "tf_v2_worker_cron_match_insert_guard": {
      let next = replaceExact(
        sql,
        `deployment.form_url = '${OLD_DEPLOYMENT}'`,
        `deployment.form_url IN (${DEPLOYMENT_DOMAIN})`,
        1,
      );
      next = replaceExact(
        next,
        `deployment_version_ref.form_url = '${OLD_VERSION}'`,
        `deployment_version_ref.form_url IN (${VERSION_DOMAIN})`,
        1,
      );
      return replaceExact(
        next,
        `version.form_url <> '${OLD_VERSION}'`,
        `version.form_url NOT IN (${VERSION_DOMAIN})`,
        1,
      );
    }
    case "queue_v2_batch_execution_send_guard": {
      const next = replaceExact(
        sql,
        `'${OLD_DEPLOYMENT}',`,
        `'${OLD_DEPLOYMENT}', '${FORWARD_DEPLOYMENT}',`,
        2,
      );
      return replaceExact(
        next,
        `version.form_url = '${OLD_VERSION}'`,
        `version.form_url IN (${VERSION_DOMAIN})`,
        1,
      );
    }
    default:
      return sql;
  }
}

const changedNames = Object.freeze([
  "queue_v2_batch_execution_send_guard",
  "tf_v2_worker_cron_match_insert_guard",
  "tf_v2_worker_native_deletion_presend_absence_guard",
  "tf_v2_worker_native_deletion_send_guard",
  "tf_v2_worker_native_deletion_stage_guard",
  "tf_v2_worker_native_effect_insert_guard",
]);

const sourceObjects = FORWARD_NATIVE_BASE_OBJECTS.map((entry) =>
  entry.type === "table" && entry.name === "tf_v2_worker_native_deletions"
    ? { ...entry, sql: v2WorkerOpaqueDeletionTableSql }
    : entry,
);
const successorObjects = sourceObjects.map((entry) =>
  entry.type === "trigger" && typeof entry.sql === "string"
    ? { ...entry, sql: successorTrigger(entry.name, entry.sql) }
    : entry,
);
if (
  sourceObjects.filter((entry) => entry.type === "trigger" && changedNames.includes(entry.name))
    .length !== changedNames.length ||
  successorObjects.filter(
    (entry, index) => entry.type === "trigger" && entry.sql !== sourceObjects[index]?.sql,
  ).length !== changedNames.length
) {
  throw new Error("Forward native source inventory changed");
}

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function exactCatalog(
  objects: readonly {
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }[],
  balanced = false,
): string {
  const names = AFFECTED_TABLES.map(literal).join(", ");
  const members = objects.map(
    (entry) =>
      `(type = ${literal(entry.type)} AND name = ${literal(entry.name)} AND
        tbl_name = ${literal(entry.tbl_name)} AND
        ${entry.sql === null ? "sql IS NULL" : `sql = ${literal(entry.sql)}`})`,
  );
  // This complete seal is embedded in authority-changing statements. A flat
  // left-associated OR chain exceeds D1's expression depth when combined with
  // the invocation/Cron predicates. Keep every exact member, with logarithmic
  // boolean depth rather than moving any part to an earlier schema probe.
  const disjunction = (start: number, end: number): string => {
    if (end - start === 1) return members[start] ?? "0";
    if (start === end) return "0";
    const middle = start + Math.floor((end - start) / 2);
    return `(${disjunction(start, middle)} OR ${disjunction(middle, end)})`;
  };
  return `(SELECT count(*) FROM main.sqlite_schema
    WHERE type IN ('table','index','trigger') AND tbl_name IN (${names})) = ${objects.length}
    AND (SELECT count(*) FROM main.sqlite_schema
      WHERE type IN ('table','index','trigger') AND tbl_name IN (${names})
        AND (${balanced ? disjunction(0, members.length) : members.join(" OR ")})) = ${objects.length}
    AND NOT EXISTS (SELECT 1 FROM sqlite_temp_schema
      WHERE name IN (${objects.map((entry) => literal(entry.name)).join(", ")}, ${literal(ASSERTION)})
        OR tbl_name IN (${names}))`;
}

const INDEX_ABSENT = `NOT EXISTS (SELECT 1 FROM main.sqlite_schema
  WHERE name COLLATE NOCASE = ${literal(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME)})
  AND NOT EXISTS (SELECT 1 FROM sqlite_temp_schema
  WHERE name COLLATE NOCASE = ${literal(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME)})`;
const INDEX_READY = `(SELECT count(*) FROM main.sqlite_schema
    WHERE type = 'index' AND name = ${literal(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME)}
      AND tbl_name = 'tf_v2_operations'
      AND sql = ${literal(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL)}) = 1
  AND (SELECT count(*) FROM pragma_index_list('tf_v2_operations', 'main')
    WHERE name = ${literal(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME)}
      AND "unique" = 0 AND origin = 'c' AND partial = 0) = 1
  AND (SELECT count(*) FROM pragma_index_info(${literal(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME)})) = 2
  AND (SELECT count(*) FROM pragma_index_info(${literal(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME)})
    WHERE (seqno = 0 AND name = 'resource_uid') OR (seqno = 1 AND name = 'generation')) = 2
  AND NOT EXISTS (SELECT 1 FROM sqlite_temp_schema
    WHERE name COLLATE NOCASE = ${literal(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME)})`;
const PHYSICAL_READY = `(SELECT foreign_keys FROM pragma_foreign_keys) = 1
  AND (SELECT ignore_check_constraints FROM pragma_ignore_check_constraints) = 0
  AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema source
    WHERE CASE WHEN lower(source.name) IN ('_cf_kv', '_cf_metadata') THEN 0
      ELSE EXISTS (SELECT 1 FROM pragma_foreign_key_list(source.name, 'main') incoming
        WHERE source.type = 'table'
          AND incoming."table" COLLATE NOCASE = 'tf_v2_worker_native_deletions') END)
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check('tf_v2_worker_native_deletions', 'main'))`;
const SOURCE_READY = `(${v2WorkerNativeIdentityDomainReady("opaque255")}) AND
  (${exactCatalog(sourceObjects)}) AND (${INDEX_ABSENT})`;
const SUCCESSOR_READY = `(${PHYSICAL_READY}) AND (${exactCatalog(successorObjects)}) AND (${INDEX_READY})`;
// The registered recipe's assertion bytes above are immutable. Runtime guards
// use the same complete catalog with a shallower boolean expression instead.
const RUNTIME_SUCCESSOR_READY = `(${PHYSICAL_READY}) AND (${exactCatalog(successorObjects, true)}) AND (${INDEX_READY})`;

/** Core physical predecessor only; the owning Root wrapper pins any formal lineage. */
export function forwardWorkerNativePredecessorReady(): string {
  return SOURCE_READY;
}

/** Exact installed successor closure, evaluated within every Forward authority write. */
export function forwardWorkerNativeSchemaReady(): string {
  return RUNTIME_SUCCESSOR_READY;
}

function assertion(condition: string): string {
  return `INSERT OR ROLLBACK INTO main.${ASSERTION}(ok)
SELECT 1 WHERE (${condition}) IS NOT 1;`;
}

/** Unregistered source recipe for the protected 0105 successor. The owner supplies one transaction. */
export function createForwardWorkerNative106Recipe() {
  const triggerSql = successorObjects.filter(
    (entry) => entry.type === "trigger" && changedNames.includes(entry.name),
  );
  const step = (name: string, statements: readonly string[]) =>
    Object.freeze({ name, statements: Object.freeze([...statements]) });
  return Object.freeze({
    name: "0106_forward_worker_native_custody.sql",
    transaction: "owning-single-transaction-with-rollback-on-every-error",
    steps: Object.freeze([
      step("precondition", [
        `CREATE TABLE main.${ASSERTION}(ok INTEGER PRIMARY KEY);`,
        `INSERT INTO main.${ASSERTION}(ok) VALUES (1);`,
        assertion(`(SELECT foreign_keys FROM pragma_foreign_keys) = 1 AND
          (SELECT ignore_check_constraints FROM pragma_ignore_check_constraints) = 0 AND
          (${SOURCE_READY})`),
      ]),
      step("replace-guards", [
        `${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL};`,
        ...changedNames.map((name) => `DROP TRIGGER main.${name};`),
        ...triggerSql.map((entry) => `${entry.sql};`),
      ]),
      step("postcondition", [assertion(SUCCESSOR_READY), `DROP TABLE main.${ASSERTION};`]),
    ]),
  });
}
