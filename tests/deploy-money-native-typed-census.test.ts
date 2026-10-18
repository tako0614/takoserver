import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { DeployPhase } from "../scripts/deploy/errors.ts";
import {
  type MoneyNativeTypedCensusReader,
  readMoneyNativeTypedCensusDigest,
} from "../scripts/deploy/money-native-typed-census.ts";

// Fixed from the unchanged legacy function at source SHA256 d6398510470937a7cef5c41e3c6c64452bbc68bad1a7879e83c5d3f7be6e27a1.
// These fixture digests remain independent when its owning export delegates.
const LEGACY_GOLDEN = {
  empty: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  emptyAB: "sha256:6f99c12cab741b55b42feb2dc3bac9d6b55165e424de0c3c81ed4e2c6c31a160",
  emptyBA: "sha256:7721339367a34d67543a7e1ab2c981fe2fdda326024ab2a9948adcdef4814929",
  typedNulB: "sha256:0e07fc224cd3429ee90d089358ed53caab0b5e201dfc2146eaa81f2e8ec1bfb1",
  typedNulC: "sha256:2b92c192bbe8291514bd04bce2523c53092ab22eeac3424a2b59f4880951abeb",
  repeatedSelection: "sha256:e853103cffc181fcc9a59bba59d7380bbf9e9469c32475e33c42eee3d98bd963",
  wide300: "sha256:fa5b4899b3754b8da31439d97babb543211d3f708cbb428723867de1b6285906",
  thousandRows: "sha256:8cc560649c9f0b3d6c386c9e30e533949aa1e05764ba9e49f1bea805be2667ff",
  empty131: "sha256:ae7fe831a323c27cd8b57612136b8d906f811fd6007ee9e495d2aee2c031c9df",
  nativeBudget: "sha256:38304421ca8c2687db823cd77f090c26d9a704089038892f8ad183129d3e82ae",
  foreignKeys: "sha256:200892f955bf8590463630eaf618b7df477263c327336e24252ddbc4c07bbb2e",
} as const;

function reader(db: Database) {
  const calls: { phase: DeployPhase; description: string; sql: string }[] = [];
  const result: MoneyNativeTypedCensusReader = {
    async query(phase, description, sql) {
      calls.push({ phase, description, sql });
      return db.query(sql).all() as Record<string, unknown>[];
    },
  };
  return { calls, reader: result };
}
async function checkGolden(db: Database, tables: readonly string[], expected: string) {
  const current = reader(db);
  const before = db.serialize();
  expect(await readMoneyNativeTypedCensusDigest(current.reader, "preflight", tables)).toBe(
    expected,
  );
  expect(db.serialize()).toEqual(before);
  for (const call of current.calls) {
    expect(call.phase).toBe("preflight");
    expect(Buffer.byteLength(call.sql, "utf8")).toBeLessThanOrEqual(90_000);
    expect(call.sql).not.toContain("?");
    expect(call.sql).not.toContain(";");
  }
  return { current, digest: expected };
}

test("empty table lists preserve the exact empty digest and perform no reads", async () => {
  using db = new Database(":memory:");
  const result = await checkGolden(db, [], LEGACY_GOLDEN.empty);
  expect(result.current.calls).toHaveLength(0);
});

test("empty schemas still contribute the exact original ordered column vectors", async () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE zero_a (z TEXT, a INTEGER); CREATE TABLE zero_b (a INTEGER, z TEXT)");
  const result = await checkGolden(db, ["zero_a", "zero_b"], LEGACY_GOLDEN.emptyAB);
  expect(result.current.calls).toHaveLength(2);
  const reversed = await checkGolden(db, ["zero_b", "zero_a"], LEGACY_GOLDEN.emptyBA);
  expect(reversed.digest).not.toBe(result.digest);
});

test("all SQLite storage classes, NUL suffixes, binary values, exact integers and negative reals match", async () => {
  using db = new Database(":memory:");
  db.exec(`CREATE TABLE typed_values (value, note TEXT);
    INSERT INTO typed_values VALUES
    (NULL,'nil'),('','empty text'),(X'','empty blob'),
    (X'0001FF','binary'),('A'||char(0)||'B','nul'),
    (9007199254740993,'large integer'),(-9223372036854775808,'small integer'),
    (-0.00000125,'negative real'),(1.0,'real'),(1,'integer'),(1e100,'exponent');`);
  await checkGolden(db, ["typed_values"], LEGACY_GOLDEN.typedNulB);
  const previous = await readMoneyNativeTypedCensusDigest(reader(db).reader, "preflight", [
    "typed_values",
  ]);
  db.exec("UPDATE typed_values SET value='A'||char(0)||'C' WHERE note='nul'");
  const next = await checkGolden(db, ["typed_values"], LEGACY_GOLDEN.typedNulC);
  expect(next.digest).not.toBe(previous);
});

test("input table order and repeated table selections retain original hash semantics", async () => {
  using db = new Database(":memory:");
  db.exec(
    "CREATE TABLE a (id); CREATE TABLE b (id); INSERT INTO a VALUES(2),(1),(1); INSERT INTO b VALUES('B')",
  );
  await checkGolden(db, ["b", "a", "b"], LEGACY_GOLDEN.repeatedSelection);
});

test("wide tables use exact old projections without a wide JSON function argument list", async () => {
  using db = new Database(":memory:");
  const names = Array.from({ length: 300 }, (_, i) => `c${i}`);
  db.exec(`CREATE TABLE wide (${names.join(", ")})`);
  db.exec(
    `INSERT INTO wide VALUES (${names.map((_name, i) => (i % 2 ? `'X'||char(0)||'${i}'` : `${-i}.25`)).join(", ")})`,
  );
  const result = await checkGolden(db, ["wide"], LEGACY_GOLDEN.wide300);
  expect(result.current.calls[1]?.sql).toContain("LIMIT 1001");
  expect(result.current.calls[1]?.sql).toContain("ROW_NUMBER() OVER");
});

test("the legacy 1000-row golden passes and 1001 rows refuse in the grouped reader", async () => {
  using db = new Database(":memory:");
  db.exec(
    "CREATE TABLE bounded (id INTEGER); WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO bounded SELECT x FROM n",
  );
  await checkGolden(db, ["bounded"], LEGACY_GOLDEN.thousandRows);
  db.exec("INSERT INTO bounded VALUES (1001)");

  await expect(
    readMoneyNativeTypedCensusDigest(reader(db).reader, "verification", ["bounded"]),
  ).rejects.toThrow("bounded row-value proof");
});

test("131 actual empty table SELECTs retain all schema/bytes proofs while reducing native round trips", async () => {
  using db = new Database(":memory:");
  const tables = Array.from({ length: 131 }, (_, i) => `table_${i}`);
  db.exec(tables.map((name) => `CREATE TABLE ${name}(id INTEGER, value TEXT)`).join(";"));
  const result = await checkGolden(db, tables, LEGACY_GOLDEN.empty131);
  expect(result.current.calls).toHaveLength(11);
  const data = result.current.calls.filter(
    (call) => call.description === "backup grouped typed rows",
  );
  for (const name of tables)
    expect(data.some((call) => call.sql.includes(`FROM ${name} ORDER BY`))).toBe(true);
});

test("generated SQL actually executes at expression-depth100, compound5 and function-argument32 limits", async () => {
  using db = new Database(":memory:");
  const tables = Array.from({ length: 131 }, (_, i) => `table_${i}`);
  const wide = Array.from({ length: 100 }, (_, i) => `c${i}`);
  const ddl = [
    ...tables.map((name) => `CREATE TABLE ${name}(id INTEGER, value TEXT)`),
    `CREATE TABLE wide (${wide.join(", ")})`,
    `INSERT INTO wide VALUES (${wide.map((_name, i) => `${-i}.25`).join(", ")})`,
  ].join(";");
  db.exec(ddl);
  const recorded = await checkGolden(db, [...tables, "wide"], LEGACY_GOLDEN.nativeBudget);
  const python = `import json,sqlite3,sys
p=json.load(sys.stdin)
c=sqlite3.connect(':memory:')
c.executescript(p['ddl'])
c.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
c.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT,5)
c.setlimit(sqlite3.SQLITE_LIMIT_FUNCTION_ARG,32)
seen=set()
def auth(action,a,b,db,source):
 if action==sqlite3.SQLITE_READ and (a.startswith('table_') or a=='wide'): seen.add(a)
 if action in (sqlite3.SQLITE_INSERT,sqlite3.SQLITE_UPDATE,sqlite3.SQLITE_DELETE): return sqlite3.SQLITE_DENY
 return sqlite3.SQLITE_OK
c.set_authorizer(auth)
for q in p['queries']: c.execute(q).fetchall()
print(json.dumps({'seen':sorted(seen),'depth':c.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH),'compound':c.getlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT),'args':c.getlimit(sqlite3.SQLITE_LIMIT_FUNCTION_ARG)}))`;
  const run = spawnSync("python3", ["-c", python], {
    input: JSON.stringify({ ddl, queries: recorded.current.calls.map((call) => call.sql) }),
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(run.status, run.stderr).toBe(0);
  const proof = JSON.parse(run.stdout) as {
    seen: string[];
    depth: number;
    compound: number;
    args: number;
  };
  expect(proof.seen).toEqual([...tables, "wide"].sort());
  expect([proof.depth, proof.compound, proof.args]).toEqual([100, 5, 32]);
});

test("malformed table identifiers, missing tables and malformed existing columns fail closed", async () => {
  using db = new Database(":memory:");
  for (const names of [["bad-name"], ["missing"]]) {
    await expect(
      readMoneyNativeTypedCensusDigest(reader(db).reader, "preflight", names),
    ).rejects.toThrow();
  }
  db.exec('CREATE TABLE malformed ("bad-name" TEXT)');

  await expect(
    readMoneyNativeTypedCensusDigest(reader(db).reader, "preflight", ["malformed"]),
  ).rejects.toThrow("columns are malformed");
});

async function corrupt(
  kind: "columns" | "data",
  change: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
) {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE a (id INTEGER, value TEXT); INSERT INTO a VALUES(1,'x'),(2,'y')");
  const base = reader(db);
  const selected: MoneyNativeTypedCensusReader = {
    async query(phase, description, sql) {
      const rows = [...(await base.reader.query(phase, description, sql))];
      return description ===
        (kind === "columns" ? "backup grouped table columns" : "backup grouped typed rows")
        ? change(rows)
        : rows;
    },
  };
  await expect(readMoneyNativeTypedCensusDigest(selected, "verification", ["a"])).rejects.toThrow();
}

test("metadata missing, duplicate, foreign-table and invalid-column results refuse", async () => {
  await corrupt("columns", () => []);
  await corrupt("columns", (rows) => [...rows, rows[0] as Record<string, unknown>]);
  await corrupt("columns", (rows) => [{ ...rows[0], table_name: "b" }]);
  await corrupt("columns", (rows) => [{ ...rows[0], names_json: '["id","id"]' }]);
  await corrupt("columns", (rows) => [{ ...rows[0], names_json: '"id"' }]);
});

test("sentinel missing, duplicate, count-lie and extra-row results refuse instead of hashing absence", async () => {
  await corrupt("data", (rows) => rows.slice(1));
  await corrupt("data", (rows) => [rows[0] as Record<string, unknown>, ...rows]);
  await corrupt("data", (rows) => [{ ...rows[0], payload: "0" }, ...rows.slice(1)]);
  await corrupt("data", (rows) => [...rows, rows[2] as Record<string, unknown>]);
});

test("typed row missing, ordinal duplication, reordering and malformed payload results refuse", async () => {
  await corrupt("data", (rows) => rows.slice(0, -1));
  await corrupt("data", (rows) => [
    rows[0] as Record<string, unknown>,
    rows[1] as Record<string, unknown>,
    rows[1] as Record<string, unknown>,
  ]);
  await corrupt("data", (rows) => [
    rows[0] as Record<string, unknown>,
    rows[2] as Record<string, unknown>,
    rows[1] as Record<string, unknown>,
  ]);
  await corrupt("data", (rows) => [
    rows[0] as Record<string, unknown>,
    { ...rows[1], payload: '[["integer","1"],["text","6f"]]' },
    ...rows.slice(2),
  ]);
  await corrupt("data", (rows) => [
    rows[0] as Record<string, unknown>,
    { ...rows[1], payload: "[]" },
    ...rows.slice(2),
  ]);
});

test("each awaited query uses the captured owning receiver and propagates unknown unchanged without retry", async () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE a (id INTEGER)");
  const unknown = new Error("actual unknown query");
  let calls = 0;
  const selected: MoneyNativeTypedCensusReader = {
    async query(_phase, description, sql) {
      expect(this).toBe(selected);
      calls++;
      if (description === "backup grouped typed rows") throw unknown;
      return db.query(sql).all() as Record<string, unknown>[];
    },
  };
  let caught: unknown;
  try {
    await readMoneyNativeTypedCensusDigest(selected, "verification", ["a"]);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(unknown);
  expect(calls).toBe(2);
});

test("foreign-key state, schema and all local database bytes remain unchanged by grouped reads", async () => {
  using db = new Database(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1)",
  );
  const before = db.query("PRAGMA foreign_keys").all();
  await checkGolden(db, ["child", "parent"], LEGACY_GOLDEN.foreignKeys);
  expect(db.query("PRAGMA foreign_keys").all()).toEqual(before);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
