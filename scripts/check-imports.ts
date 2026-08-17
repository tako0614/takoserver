import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const forbidden = /(?:^|[/@])takosumi(?:-cloud)?(?:$|[/])/iu;
const roots = ["src", "scripts", "tests"];
const violations: string[] = [];

for (const root of roots) {
  for (const path of walk(root)) {
    if (!path.endsWith(".ts")) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/gu)) {
      const specifier = match[2];
      if (specifier && forbidden.test(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  if (forbidden.test(name)) violations.push(`package.json: ${name}`);
}

if (violations.length > 0) {
  console.error(`forbidden cross-product imports found:\n${violations.join("\n")}`);
  process.exit(1);
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
