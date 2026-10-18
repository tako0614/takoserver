import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { additiveAuthFull103DDL } from "../../src/auth-authority-schema-plan.ts";
import {
  AUTH103_NATIVE_INSTALL_DDL,
  AUTH103_NATIVE_MIGRATIONS,
  AUTH103_NATIVE_REGISTRATION_DDL,
} from "../../src/auth103-native-source-contract.ts";
import { AUTH103_CLOCK_RECIPE } from "../../src/auth103-source-clock.ts";
import { canonicalJson } from "../../src/json.ts";
import { preflightError } from "./errors.ts";
import { v2ContainerOwnerMigrationCandidate } from "./v2-container-owner-migration-candidate.ts";
import { buildUnregisteredV2WorkerNativeIdentityMigrationCandidate } from "./v2-worker-native-identity-migration-candidate.ts";

const clockPath = "src/auth103-source-clock.ts";
const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const dataDigest = (value: unknown): `sha256:${string}` => digest(canonicalJson(value));
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
function source(root: string, path: string): string {
  const file = resolve(root, path);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw preflightError("Auth103 source requires an owned regular file");
  return readFileSync(file, "utf8");
}

/** Fixed owner recipes, not supplied SQL. No registration/application happens here. */
export function createAuth103CanonicalSourceArtifacts(sourceRoot: string) {
  const clockSourceDigest = digest(source(sourceRoot, clockPath));
  const clockPolicyRef = dataDigest([
    "takoserver.auth103.source-clock-policy.v1",
    AUTH103_CLOCK_RECIPE,
    clockSourceDigest,
  ]);
  const recipeDigest = digest(additiveAuthFull103DDL);
  const registrationRef = dataDigest([
    "takoserver.auth103.native-source-registration.v1",
    recipeDigest,
    clockSourceDigest,
    clockPolicyRef,
  ]);
  const registrationSql = `${AUTH103_NATIVE_REGISTRATION_DDL}\n${AUTH103_NATIVE_INSTALL_DDL}\nINSERT INTO
auth103_native_source_registration(registration_ref,recipe_digest,clock_source_digest,clock_policy_ref)
VALUES (${[registrationRef, recipeDigest, clockSourceDigest, clockPolicyRef].map(literal).join(",")});\n`;
  const container = v2ContainerOwnerMigrationCandidate();
  const worker = buildUnregisteredV2WorkerNativeIdentityMigrationCandidate().statements;
  const workerSql = worker;
  if (
    [...container, ...worker].some(
      (statement) =>
        typeof statement !== "string" &&
        statement.params !== undefined &&
        statement.params.length !== 0,
    )
  )
    throw preflightError("Auth103 canonical predecessors must have no external binds");
  const files = Object.freeze([
    Object.freeze({
      name: AUTH103_NATIVE_MIGRATIONS[0]!,
      sql: container.map(({ sql }) => sql).join(";\n") + ";\n",
    }),
    Object.freeze({ name: AUTH103_NATIVE_MIGRATIONS[1]!, sql: workerSql.join(";\n") + ";\n" }),
    Object.freeze({
      name: AUTH103_NATIVE_MIGRATIONS[2]!,
      sql: `${additiveAuthFull103DDL}\n${registrationSql}`,
    }),
  ]);
  return Object.freeze({ files, registrationRef, recipeDigest, clockSourceDigest, clockPolicyRef });
}
