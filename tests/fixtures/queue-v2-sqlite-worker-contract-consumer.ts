import type {
  EdgeSqlValue,
  SelfhostV2SqliteStatement,
  SQLiteLockedPhysicalSet,
  V2QueueSQLiteCall,
  V2QueueSQLiteGrant,
  V2QueueSQLiteProofPort,
  V2QueueSQLiteSelectedBindings,
} from "@takoserver/core/provider-extension";

declare const grant: V2QueueSQLiteGrant;
declare const physical: SQLiteLockedPhysicalSet;
declare const statement: SelfhostV2SqliteStatement;
declare const proofs: V2QueueSQLiteProofPort;
declare const selected: V2QueueSQLiteSelectedBindings;
declare const value: EdgeSqlValue;
declare const call: V2QueueSQLiteCall;

void grant;
void physical;
void statement;
void proofs;
void selected;
void value;
void call;

const plainPhysical = {
  targetKey: "target",
  principal: "principal",
  space: "space",
  bindings: [{ name: "DB", resourceUid: "uid" }],
  assertHeld() {},
};
// @ts-expect-error Physical authority is nominal, not a tenant-provided DTO.
const forged: SQLiteLockedPhysicalSet = plainPhysical;
void forged;
