import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBunNodeModulesLabels } from "../scripts/canonical-bun-module-labels.ts";

test("a symlinked dependency bundle has the same source bytes as an in-tree dependency bundle", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "bun-module-labels-"));
  try {
    const linkedRoot = join(temporary, "linked");
    const directRoot = join(temporary, "direct");
    const externalModules = join(temporary, "dependencies", "node_modules");
    const packagePath = "fixture-package/index.js";
    const source =
      'import { answer } from "fixture-package";\n' +
      "export const result = answer;\n" +
      'export const marker = "// ../dependencies/node_modules/fixture-package/index.js";\n';
    for (const root of [linkedRoot, directRoot]) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "entry.js"), source);
    }
    for (const modules of [externalModules, join(directRoot, "node_modules")]) {
      await mkdir(join(modules, "fixture-package"), { recursive: true });
      await writeFile(join(modules, packagePath), "export const answer = 42;\n");
      await writeFile(
        join(modules, "fixture-package", "package.json"),
        JSON.stringify({ name: "fixture-package", type: "module", exports: "./index.js" }),
      );
    }
    await symlink(externalModules, join(linkedRoot, "node_modules"));
    const build = async (root: string) => {
      // Bun module labels are relative to the build process cwd, not merely
      // Bun.build's root option. Model the generator CLI's invocation exactly.
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        const built = await Bun.build({
          entrypoints: ["entry.js"], root: process.cwd(), target: "browser",
          format: "esm", minify: false, splitting: false, sourcemap: "none"
        });
        if (!built.success || built.outputs.length !== 1 || !built.outputs[0])
          throw new Error("fixture build failed");
        process.stdout.write(await built.outputs[0].text());
      `,
        ],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(exit).toBe(0);
      return output;
    };
    const linked = await build(linkedRoot);
    const direct = await build(directRoot);
    expect(canonicalBunNodeModulesLabels(linked, linkedRoot)).toBe(direct);
    expect(canonicalBunNodeModulesLabels(direct, directRoot)).toBe(direct);
    expect(linked).toContain('"// ../dependencies/node_modules/fixture-package/index.js"');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
