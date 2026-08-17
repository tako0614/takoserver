import { readFileSync } from "node:fs";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { createD1HttpSql } from "../src/sql-d1-http.ts";
import { sameFormLineage } from "../src/takoform/forms.ts";
import { validateDesired } from "../src/takoform/schema.ts";
import type { InstalledTakoformForm, TakoformStoredResource } from "../src/takoform/types.ts";

/**
 * Moves a stored declaration onto a newer definition of the same Form.
 *
 * The wire protocol deliberately has no way to do this. A Form's identity
 * includes the digest of its own schema, and a resource is addressable only
 * under the exact Form it was created with — that is what stops a caller from
 * being handed semantics they never reviewed, and it is a frozen contract.
 *
 * But a resource still has to be able to move forward. Deleting and recreating
 * is no answer for anything that holds state: for a Worker it destroys the
 * storage behind its Durable Objects, and for a database it destroys the
 * database. So the migration lives here, where it belongs — an operator acting
 * on stored state deliberately, in the same category as a schema migration,
 * rather than a wire feature that quietly relaxes an exact-pin rule.
 *
 *   bun scripts/migrate-form.ts <space> <kind> <name> <definitionVersion> [--apply]
 *
 * It refuses across lineages, refuses a definition that is not installed, and
 * refuses a spec the target schema will not accept. The last one matters most:
 * a declaration that no longer validates is a resource nobody can update again.
 *
 * Reads only, until `--apply`.
 */

const [space, kind, name, targetVersion, ...flags] = process.argv.slice(2);
const write = flags.includes("--apply");

if (!space || !kind || !name || !targetVersion) {
  process.stderr.write(
    "usage: migrate-form.ts <space> <kind> <name> <definitionVersion> [--apply]\n",
  );
  process.exit(2);
}

function required(variable: string): string {
  const value = process.env[variable];
  if (!value) {
    process.stderr.write(`${variable} is required\n`);
    process.exit(2);
  }
  return value;
}

const tenantId = required("TAKOSERVER_TENANT_ID");
const tokenFile = process.env.TAKOSERVER_CF_TOKEN_FILE;

const sql = createD1HttpSql({
  accountId: required("CLOUDFLARE_ACCOUNT_ID"),
  databaseId: required("TAKOSERVER_D1_DATABASE_ID"),
  authorize: () => {
    const token = tokenFile
      ? readFileSync(tokenFile, "utf8").trim()
      : required("CLOUDFLARE_API_TOKEN");
    return `Bearer ${token}`;
  },
});

const edge = await buildEdgeForms();

const rows = await sql.query(
  `SELECT api_version, resource_json, revision FROM tf_resources
   WHERE tenant_id = ? AND space = ? AND kind = ? AND name = ?`,
  [tenantId, space, kind, name],
);
const row = rows[0];
if (!row) {
  process.stderr.write(`no resource ${space}/${kind}/${name} for tenant ${tenantId}\n`);
  process.exit(1);
}

const stored = JSON.parse(String(row.resource_json)) as TakoformStoredResource;
const from = stored.form.formRef;

const target: InstalledTakoformForm | undefined = edge.forms.find(
  (form) =>
    form.identity.formRef.kind === kind &&
    form.identity.formRef.definitionVersion === targetVersion &&
    sameFormLineage(form.identity.formRef, from),
);
if (!target) {
  process.stderr.write(
    `no installed ${from.apiVersion}/${kind} definition ${targetVersion}; ` +
      `installed: ${edge.forms
        .filter((form) => sameFormLineage(form.identity.formRef, from))
        .map((form) => form.identity.formRef.definitionVersion)
        .join(", ")}\n`,
  );
  process.exit(1);
}

if (from.definitionVersion === targetVersion) {
  process.stdout.write(`${space}/${kind}/${name} is already on ${targetVersion}\n`);
  process.exit(0);
}

// The declaration that exists has to be one the target definition would accept.
// Migrating a spec the new schema rejects produces a resource that reads fine
// and can never be updated again.
const diagnostics = validateDesired(target, stored.spec);
const errors = diagnostics.filter((entry) => entry.severity === "error");
if (errors.length > 0) {
  process.stderr.write(
    `the stored spec is not valid under ${targetVersion}:\n` +
      errors.map((entry) => `  ${entry.field ?? "(root)"}: ${entry.message}\n`).join(""),
  );
  process.exit(1);
}

process.stdout.write(
  `${space}/${kind}/${name}\n` +
    `  from ${from.definitionVersion} ${from.schemaDigest}\n` +
    `    to ${targetVersion} ${target.identity.formRef.schemaDigest}\n`,
);

if (!write) {
  process.stdout.write("\nplan only: nothing was written. Re-run with --apply.\n");
  process.exit(0);
}

const migrated: TakoformStoredResource = {
  ...stored,
  form: { ...stored.form, formRef: { ...target.identity.formRef } },
  metadata: {
    ...stored.metadata,
    // The declaration did not change, so the generation does not move. The
    // revision does, because it is the fence a writer must present and a
    // migration must not let a request prepared against the old row land.
    revision: String(Number(stored.metadata.revision) + 1),
  },
};

const written = await sql.run(
  `UPDATE tf_resources
   SET resource_json = ?, revision = ?, updated_at = ?
   WHERE tenant_id = ? AND space = ? AND kind = ? AND name = ? AND revision = ?`,
  [
    JSON.stringify(migrated),
    migrated.metadata.revision,
    Date.now(),
    tenantId,
    space,
    kind,
    name,
    stored.metadata.revision,
  ],
);
if (written.changes !== 1) {
  process.stderr.write("the row moved while this was running; nothing was written\n");
  process.exit(1);
}

process.stdout.write(
  `migrated to ${targetVersion}; revision is now ${migrated.metadata.revision}\n`,
);
