import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runSelfhostArtifactCli,
  SELFHOST_V2_WORKER_TARGET_KEY,
} from "../scripts/selfhost-artifact.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { parseTakoformV2PublicConfig } from "../src/takoform-v2/config.ts";
import {
  createV2HeldArtifactSource,
  type V2HeldArtifactEntry,
} from "../src/takoform-v2/forms/artifact-source.ts";
import { parseSQLiteMigrationManifest } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { parseStaticAssetBundleManifest } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  parseWorkerBundleManifest,
  validateWorkerBundlePayload,
} from "../src/takoform-v2/forms/worker-bundle.ts";

/**
 * The operator path that puts held artifact bytes where a stopped Bun Host
 * reads them. Every assertion reads back through the Host's own held-artifact
 * source, config parser and Form validators, never through the CLI's view of
 * what it wrote.
 */

const ORG = "org-alpha";
const OTHER_ORG = "org-beta";
const DOCS = {
  documentation: "https://docs.example.test/resources",
  authenticationDocumentation: "https://docs.example.test/access",
};
const MAX_READ = 134_217_728;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

interface Installation {
  readonly parent: string;
  readonly root: string;
  readonly fakeProc: string;
}

/** A data root as a first boot leaves it: private, migrated, one organization. */
function installation(options: { organizations?: readonly string[] } = {}): Installation {
  const parent = mkdtempSync(join(tmpdir(), "takoserver-held-artifact-"));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "data");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    for (const id of options.organizations ?? [ORG, OTHER_ORG]) {
      database.run(
        "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
        [id, `Organization ${id}`, `principal-${id}`, "2026-10-11T00:00:00.000Z"],
      );
    }
  } finally {
    database.close();
  }
  // A process table holding only this process: nothing else has the root open.
  const fakeProc = join(parent, "proc");
  mkdirSync(join(fakeProc, String(process.pid), "fd"), { recursive: true });
  return { parent, root, fakeProc };
}

function sourceTree(parent: string, name: string, files: Record<string, string | Uint8Array>) {
  const directory = join(parent, "sources", name);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
  }
  return directory;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  argv: readonly string[],
  install: Installation,
  env: Record<string, string | undefined> = {},
  procRoot: string = install.fakeProc,
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runSelfhostArtifactCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { TAKOSERVER_DATA_ROOT: install.root, ...env },
    cwd: install.parent,
    procRoot,
  });
  return { code, stdout, stderr };
}

interface SeedResult {
  readonly form: string;
  readonly configBlock: "workerBundle" | "staticAssetBundle" | "sqliteMigrationSet";
  readonly targetKey: string;
  readonly artifact: { readonly url: string; readonly sha256: string };
  readonly files: readonly {
    path: string;
    sha256: string;
    mediaType: string;
    byteSize: number;
  }[];
  readonly configFragment: Record<
    string,
    { targetKey: string; heldArtifacts: V2HeldArtifactEntry[] }
  >;
}

function result(output: Run): SeedResult {
  expect(output.code).toBe(0);
  return JSON.parse(output.stdout) as SeedResult;
}

/** Read exactly as a Host composed with this config fragment would. */
async function hostRead(
  root: string,
  entries: readonly V2HeldArtifactEntry[],
  url: string,
  digest: string,
  organization = ORG,
): Promise<Uint8Array> {
  return await createV2HeldArtifactSource({
    objects: createFileObjectStore({ root }),
    entries,
  }).read({
    principal: `org:${organization}`,
    space: organization,
    url,
    sha256: digest,
    maxBytes: MAX_READ,
  });
}

function heldObjectKeys(root: string): string[] {
  const directory = join(root, "objects", "operator-held", "sha256");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

describe("self-host held artifact seeding", () => {
  test("seeds a WorkerBundle the Host's own source, config parser and Form accept", async () => {
    const install = installation();
    const worker = "export default { fetch() { return new Response('hello'); } };\n";
    const helper = "export const helper = 1;\n";
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const source = sourceTree(install.parent, "hello", {
      "worker.js": worker,
      "lib/helper.mjs": helper,
      "add.wasm": wasm,
    });
    const seeded = result(
      await run(
        [
          "seed",
          "worker-bundle",
          source,
          "--base-url",
          "https://artifacts.example.test/hello/v1/",
          "--organization",
          ORG,
          "--entrypoint",
          "worker.js",
        ],
        install,
      ),
    );

    expect(seeded.form).toBe("https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/");
    expect(seeded.configBlock).toBe("workerBundle");
    expect(seeded.targetKey).toBe("selfhost-v2-worker-primary");
    expect(seeded.artifact.url).toBe("https://artifacts.example.test/hello/v1/manifest.json");
    const block = seeded.configFragment.workerBundle;
    expect(Object.keys(seeded.configFragment)).toEqual(["workerBundle"]);
    expect(block?.targetKey).toBe("selfhost-v2-worker-primary");
    const entries = block?.heldArtifacts ?? [];
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.objectKey).toBe(`operator-held/sha256/${entry.sha256}`);
      expect(entry.grants).toEqual([{ principal: `org:${ORG}`, space: ORG }]);
    }

    // The fragment is exactly what the Host's strict startup parser accepts.
    const config = parseTakoformV2PublicConfig(
      JSON.stringify({ ...DOCS, ...seeded.configFragment }),
    );
    expect(config.workerBundle?.heldArtifacts).toEqual(entries);

    const manifestBytes = await hostRead(
      install.root,
      entries,
      seeded.artifact.url,
      seeded.artifact.sha256,
    );
    expect(sha256(manifestBytes)).toBe(seeded.artifact.sha256);
    const manifest = parseWorkerBundleManifest(manifestBytes);
    expect(manifest.entrypoint).toBe("worker.js");
    expect(manifest.files.map((file) => [file.path, file.mediaType])).toEqual([
      ["add.wasm", "application/wasm"],
      ["lib/helper.mjs", "application/javascript+module"],
      ["worker.js", "application/javascript+module"],
    ]);
    expect(manifest.files.map((file) => file.url)).toEqual([
      "https://artifacts.example.test/hello/v1/files/add.wasm",
      "https://artifacts.example.test/hello/v1/files/lib/helper.mjs",
      "https://artifacts.example.test/hello/v1/files/worker.js",
    ]);
    const fileBytes = [];
    for (const file of manifest.files) {
      fileBytes.push(await hostRead(install.root, entries, file.url, file.sha256));
    }
    expect(new TextDecoder().decode(fileBytes[2])).toBe(worker);
    expect(Array.from(fileBytes[0] ?? [])).toEqual(Array.from(wasm));
    const observation = await validateWorkerBundlePayload({
      spec: { artifact: seeded.artifact },
      manifestBytes,
      fileBytes,
    });
    expect(observation.observed.fileCount).toBe(3);
    expect(seeded.files).toEqual(
      observation.observed.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        mediaType: file.mediaType,
        byteSize: file.byteSize,
      })),
    );

    // A grant is per organization: another organization's principal reads nothing.
    await expect(
      hostRead(install.root, entries, seeded.artifact.url, seeded.artifact.sha256, OTHER_ORG),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  test("orders SQL migrations by path bytes and infers static asset media types", async () => {
    const install = installation();
    const migrations = sourceTree(install.parent, "migrations", {
      "0010_late.sql": "CREATE TABLE late (id INTEGER);\n",
      "0002_second.sql": "CREATE TABLE second (id INTEGER);\n",
      "0001_first.sql": "CREATE TABLE first (id INTEGER);\n",
    });
    const migration = result(
      await run(
        [
          "seed",
          "sqlite-migration-set",
          migrations,
          "--base-url",
          "https://artifacts.example.test/schema/v1",
          "--organization",
          ORG,
        ],
        install,
      ),
    );
    expect(migration.configBlock).toBe("sqliteMigrationSet");
    expect(migration.targetKey).toBe("selfhost-v2-sqlite-migration-primary");
    // A base URL without a trailing slash still names one directory.
    expect(migration.artifact.url).toBe("https://artifacts.example.test/schema/v1/manifest.json");
    const migrationEntries = migration.configFragment.sqliteMigrationSet?.heldArtifacts ?? [];
    const migrationManifest = parseSQLiteMigrationManifest(
      await hostRead(
        install.root,
        migrationEntries,
        migration.artifact.url,
        migration.artifact.sha256,
      ),
    );
    expect(migrationManifest.files.map((file) => file.path)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
      "0010_late.sql",
    ]);

    const site = sourceTree(install.parent, "site", {
      "index.html": "<!doctype html><title>x</title>",
      "app.css": "body{}",
      "img/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "manifest.json": '{"name":"x"}',
      "blob.unknownext": "?",
    });
    const assets = result(
      await run(
        [
          "seed",
          "static-asset-bundle",
          site,
          "--base-url",
          "https://artifacts.example.test/site/v1/",
          "--organization",
          ORG,
        ],
        install,
      ),
    );
    const assetEntries = assets.configFragment.staticAssetBundle?.heldArtifacts ?? [];
    const assetManifest = parseStaticAssetBundleManifest(
      await hostRead(install.root, assetEntries, assets.artifact.url, assets.artifact.sha256),
    );
    expect(assetManifest.files.map((file) => [file.path, file.mediaType])).toEqual([
      ["app.css", "text/css"],
      ["blob.unknownext", "application/octet-stream"],
      ["img/logo.png", "image/png"],
      ["index.html", "text/html"],
      // A web manifest named manifest.json cannot collide with the bundle manifest.
      ["manifest.json", "application/json"],
    ]);
    expect(
      assetManifest.files.find((file) => file.path === "manifest.json")?.url !==
        assets.artifact.url,
    ).toBe(true);
  });

  test("re-seeding is idempotent and --config merges into the existing file", async () => {
    const install = installation();
    const source = sourceTree(install.parent, "hello", {
      "worker.js": "export default { fetch() { return new Response('v1'); } };\n",
    });
    const configPath = join(install.parent, "takoform-v2.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ...DOCS,
        staticAssetBundle: { targetKey: "selfhost-v2-worker-primary", heldArtifacts: [] },
      }),
      { mode: 0o640 },
    );
    const args = [
      "seed",
      "worker-bundle",
      source,
      "--base-url",
      "https://artifacts.example.test/hello/v1/",
      "--organization",
      ORG,
      "--config",
      configPath,
    ];
    const first = result(await run(args, install));
    const keysAfterFirst = heldObjectKeys(install.root);
    const second = result(await run(args, install));
    expect(second).toEqual(first);
    expect(heldObjectKeys(install.root)).toEqual(keysAfterFirst);

    const written = readFileSync(configPath, "utf8");
    // One line, because the Host receives it as one environment variable.
    expect(written.trimEnd().includes("\n")).toBe(false);
    const parsed = parseTakoformV2PublicConfig(written);
    expect(parsed.documentation).toBe(DOCS.documentation);
    expect(parsed.staticAssetBundle).toEqual({
      targetKey: "selfhost-v2-worker-primary",
      heldArtifacts: [],
    });
    expect(parsed.workerBundle?.targetKey).toBe("selfhost-v2-worker-primary");
    expect(parsed.workerBundle?.heldArtifacts).toEqual(
      first.configFragment.workerBundle?.heldArtifacts,
    );

    // A second organization is added to the same exact entries' grants.
    const otherArgs = args.map((value) => (value === ORG ? OTHER_ORG : value));
    const other = result(await run(otherArgs, install));
    expect(other.artifact).toEqual(first.artifact);
    const widened = parseTakoformV2PublicConfig(readFileSync(configPath, "utf8"));
    expect(widened.workerBundle?.heldArtifacts).toHaveLength(2);
    for (const entry of widened.workerBundle?.heldArtifacts ?? []) {
      expect(entry.grants).toEqual([
        { principal: `org:${ORG}`, space: ORG },
        { principal: `org:${OTHER_ORG}`, space: OTHER_ORG },
      ]);
    }
    await hostRead(
      install.root,
      widened.workerBundle?.heldArtifacts ?? [],
      first.artifact.url,
      first.artifact.sha256,
      OTHER_ORG,
    );

    // An existing block keeps its target: a different key is refused, file untouched.
    const before = readFileSync(configPath, "utf8");
    const retarget = await run([...args, "--target-key", "another-target"], install);
    expect(retarget.code).toBe(1);
    expect(retarget.stderr).toContain("selfhost-v2-worker-primary");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("warns when the configuration no longer fits in one environment variable", async () => {
    const install = installation();
    const files: Record<string, string> = {};
    for (let index = 0; index < 450; index += 1) files[`a/${index}.txt`] = "x";
    const source = sourceTree(install.parent, "many", files);
    const configPath = join(install.parent, "takoform-v2.json");
    writeFileSync(configPath, JSON.stringify(DOCS));
    const output = await run(
      [
        "seed",
        "static-asset-bundle",
        source,
        "--base-url",
        "https://artifacts.example.test/many/v1/",
        "--organization",
        ORG,
        "--config",
        configPath,
      ],
      install,
    );
    expect(output.code).toBe(0);
    expect(output.stderr).toContain("131072 bytes in one environment variable");
    // Identical bytes are held once, whatever number of paths name them.
    expect(heldObjectKeys(install.root)).toHaveLength(2);
  });

  test("refuses while another process holds the installation's files open", async () => {
    const install = installation();
    const source = sourceTree(install.parent, "hello", {
      "worker.js": "export default {};\n",
    });
    const args = [
      "seed",
      "worker-bundle",
      source,
      "--base-url",
      "https://artifacts.example.test/hello/v1/",
      "--organization",
      ORG,
    ];

    // A process table entry whose descriptor points at the control database.
    const holder = join(install.fakeProc, "424242", "fd");
    mkdirSync(holder, { recursive: true });
    // Descriptor links name canonical paths.
    symlinkSync(join(realpathSync(install.root), "control.sqlite"), join(holder, "7"));
    const refused = await run(args, install);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("pid 424242");
    expect(refused.stderr).toContain("Stop the Host");
    expect(heldObjectKeys(install.root)).toEqual([]);

    // So does one holding any file below the root.
    rmSync(join(holder, "7"));
    symlinkSync(join(realpathSync(install.root), "objects", "art", "x"), join(holder, "8"));
    expect((await run(args, install)).code).toBe(1);
    rmSync(join(holder, "8"));
    expect((await run(args, install)).code).toBe(0);

    // An external control database counts too, by its real path behind a link.
    const external = join(install.parent, "external");
    mkdirSync(external, { mode: 0o700 });
    renameSync(join(install.root, "control.sqlite"), join(external, "control.sqlite"));
    const link = join(install.parent, "control-link.sqlite");
    symlinkSync(join(external, "control.sqlite"), link);
    symlinkSync(join(realpathSync(external), "control.sqlite"), join(holder, "9"));
    const externalHeld = await run(args, install, { TAKOSERVER_DB: link });
    expect(externalHeld.code).toBe(1);
    expect(externalHeld.stderr).toContain("pid 424242");
    rmSync(join(holder, "9"));
    expect((await run(args, install, { TAKOSERVER_DB: link })).code).toBe(0);

    // A process table that does not show this process proves nothing.
    const blind = join(install.parent, "blind-proc");
    mkdirSync(blind);
    const unprovable = await run(args, install, { TAKOSERVER_DB: link }, blind);
    expect(unprovable.code).toBe(1);
    expect(unprovable.stderr).toContain("cannot prove");
  });

  test("refuses while a real process has the control database open", async () => {
    // The real process table is Linux /proc; elsewhere the fake one above stands in.
    if (process.platform !== "linux") return;
    const install = installation();
    const source = sourceTree(install.parent, "hello", {
      "worker.js": "export default {};\n",
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "const { Database } = require('bun:sqlite');" +
          "const db = new Database(process.argv[1]);" +
          "db.query('SELECT 1').get();" +
          "console.log('ready');" +
          "setInterval(() => {}, 1000);",
        join(install.root, "control.sqlite"),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    cleanups.push(() => child.kill("SIGKILL"));
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    const refused = await run(
      [
        "seed",
        "worker-bundle",
        source,
        "--base-url",
        "https://artifacts.example.test/hello/v1/",
        "--organization",
        ORG,
      ],
      install,
      {},
      "/proc",
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`pid ${child.pid}`);
    expect(heldObjectKeys(install.root)).toEqual([]);
  });

  test("refuses an installation it cannot trust or an organization it does not know", async () => {
    const install = installation();
    const source = sourceTree(install.parent, "hello", {
      "worker.js": "export default {};\n",
    });
    const seed = (organization = ORG) => [
      "seed",
      "worker-bundle",
      source,
      "--base-url",
      "https://artifacts.example.test/hello/v1/",
      "--organization",
      organization,
    ];

    const unknown = await run(seed("org-typo"), install);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("org-typo");
    expect(heldObjectKeys(install.root)).toEqual([]);

    chmodSync(install.root, 0o755);
    const open = await run(seed(), install);
    expect(open.code).toBe(1);
    expect(open.stderr).toContain("0700");
    chmodSync(install.root, 0o700);

    const missingRoot = await run(seed(), install, {
      TAKOSERVER_DATA_ROOT: join(install.parent, "never-booted"),
    });
    expect(missingRoot.code).toBe(1);
    expect(missingRoot.stderr).toContain("first boot");
    expect(existsSync(join(install.parent, "never-booted"))).toBe(false);

    const missingDatabase = await run(seed(), install, {
      TAKOSERVER_DB: join(install.parent, "elsewhere.sqlite"),
    });
    expect(missingDatabase.code).toBe(1);
    expect(missingDatabase.stderr).toContain("first boot");

    expect((await run(seed(), install, { TAKOSERVER_DATA_ROOT: ":memory:" })).code).toBe(1);
    expect((await run(seed(), install, { TAKOSERVER_OBJECTS_IN_MEMORY: "1" })).code).toBe(1);
    expect(heldObjectKeys(install.root)).toEqual([]);

    expect((await run(seed(), install)).code).toBe(0);
  });

  test("refuses inputs the Host would reject before writing anything", async () => {
    const install = installation();
    const base = ["--base-url", "https://artifacts.example.test/x/v1/", "--organization", ORG];
    const refuse = async (argv: readonly string[], fragment: string) => {
      const output = await run(argv, install);
      expect(output.code).toBe(1);
      expect(output.stderr).toContain(fragment);
      expect(output.stdout).toBe("");
    };

    const linked = sourceTree(install.parent, "linked", { "worker.js": "export default {};" });
    symlinkSync("/etc/hostname", join(linked, "outside.txt"));
    await refuse(["seed", "worker-bundle", linked, ...base], "outside.txt is a symbolic link");

    const markdown = sourceTree(install.parent, "markdown", {
      "worker.js": "export default {};",
      "README.md": "# hi",
    });
    await refuse(["seed", "worker-bundle", markdown, ...base], "README.md");
    expect(
      (
        await run(
          ["seed", "worker-bundle", markdown, ...base, "--media-type", "README.md=text/plain"],
          install,
        )
      ).code,
    ).toBe(0);

    const two = sourceTree(install.parent, "two", {
      "a.js": "export default {};",
      "b.js": "export default {};",
    });
    await refuse(["seed", "worker-bundle", two, ...base], "--entrypoint");
    await refuse(
      ["seed", "worker-bundle", two, ...base, "--entrypoint", "missing.js"],
      "missing.js",
    );

    const notSql = sourceTree(install.parent, "not-sql", { "0001.txt": "SELECT 1;" });
    await refuse(["seed", "sqlite-migration-set", notSql, ...base], "0001.txt");

    const bom = sourceTree(install.parent, "bom", {
      "0001.sql": new Uint8Array([0xef, 0xbb, 0xbf, 0x53]),
    });
    await refuse(["seed", "sqlite-migration-set", bom, ...base], "rejects");

    const plain = sourceTree(install.parent, "plain", { "worker.js": "export default {};" });
    await refuse(
      [
        "seed",
        "worker-bundle",
        plain,
        "--base-url",
        "http://artifacts.example.test/x/",
        "--organization",
        ORG,
      ],
      "--base-url",
    );
    const withoutOrganization = await run(
      ["seed", "worker-bundle", plain, "--base-url", "https://artifacts.example.test/x/"],
      install,
    );
    expect(withoutOrganization.code).toBe(2);
    expect(withoutOrganization.stderr).toContain("seed needs --organization");

    const empty = join(install.parent, "sources", "empty");
    mkdirSync(empty, { recursive: true });
    await refuse(["seed", "static-asset-bundle", empty, ...base], "no files");

    const before = heldObjectKeys(install.root);
    // Only the one accepted seed (worker.js, README.md and its manifest) wrote anything.
    expect(before).toHaveLength(3);
    expect((await run(["seed"], install)).code).toBe(2);
    expect((await run(["seed", "worker-bundle", plain, ...base, "--bogus"], install)).code).toBe(2);
    expect(heldObjectKeys(install.root)).toEqual(before);
  });

  test("never trusts an existing object at a content address without checking its bytes", async () => {
    const install = installation();
    const worker = "export default {};\n";
    const source = sourceTree(install.parent, "hello", { "worker.js": worker });
    const squatted = await createFileObjectStore({ root: install.root }).create(
      `operator-held/sha256/${sha256(worker)}`,
      new TextEncoder().encode("something else"),
    );
    expect(squatted).not.toBeNull();
    const refused = await run(
      [
        "seed",
        "worker-bundle",
        source,
        "--base-url",
        "https://artifacts.example.test/hello/v1/",
        "--organization",
        ORG,
      ],
      install,
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`operator-held/sha256/${sha256(worker)}`);
    expect(refused.stdout).toBe("");
  });

  test("verify reads every configured entry through the Host's source", async () => {
    const install = installation();
    const source = sourceTree(install.parent, "hello", {
      "worker.js": "export default {};\n",
    });
    const configPath = join(install.parent, "takoform-v2.json");
    writeFileSync(configPath, JSON.stringify(DOCS));
    const seeded = result(
      await run(
        [
          "seed",
          "worker-bundle",
          source,
          "--base-url",
          "https://artifacts.example.test/hello/v1/",
          "--organization",
          ORG,
          "--config",
          configPath,
        ],
        install,
      ),
    );
    const ok = await run(["verify", "--config", configPath], install);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ checked: 2, failures: [] });

    // The Host's env form of the same config is accepted too.
    const fromEnv = await run(["verify"], install, {
      TAKOSERVER_TAKOFORM_V2_CONFIG: readFileSync(configPath, "utf8"),
    });
    expect(fromEnv.code).toBe(0);

    const file = seeded.files[0];
    if (!file) throw new Error("seed reported no file");
    const objectPath = join(install.root, "objects", "operator-held", "sha256", file.sha256);
    writeFileSync(objectPath, "tampered");
    const tampered = await run(["verify", "--config", configPath], install);
    expect(tampered.code).toBe(1);
    expect(JSON.parse(tampered.stdout).failures).toEqual([
      {
        block: "workerBundle",
        url: "https://artifacts.example.test/hello/v1/files/worker.js",
        sha256: file.sha256,
        principal: `org:${ORG}`,
        code: "integrity_failure",
      },
    ]);
    rmSync(objectPath);
    const missing = await run(["verify", "--config", configPath], install);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).failures[0]).toMatchObject({ code: "unavailable" });
  });

  test("defaults Worker bundles to the target the Host's complete Worker profile requires", () => {
    // The Bun entry compares both bundle blocks with this literal before it
    // composes the complete local Worker profile.
    const entry = readFileSync(join(import.meta.dir, "..", "src", "entry-bun.ts"), "utf8");
    expect(entry).toContain(`const v2WorkerTargetKey = "${SELFHOST_V2_WORKER_TARGET_KEY}";`);
  });

  test("runs as the documented operator command", async () => {
    const install = installation();
    const source = sourceTree(install.parent, "hello", {
      "worker.js": "export default {};\n",
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "..", "scripts", "selfhost-artifact.ts"),
        "seed",
        "worker-bundle",
        source,
        "--base-url",
        "https://artifacts.example.test/hello/v1/",
        "--organization",
        ORG,
      ],
      {
        cwd: install.parent,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TAKOSERVER_DATA_ROOT: install.root },
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (process.platform === "linux") {
      expect(code).toBe(0);
      expect(JSON.parse(stdout).configBlock).toBe("workerBundle");
      expect(stderr).toContain("restart the Host");
    } else {
      expect(code).toBe(1);
      expect(stderr).toContain("cannot prove");
    }
    const usage = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "..", "scripts", "selfhost-artifact.ts"),
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    expect(await usage.exited).toBe(2);
  });
});
