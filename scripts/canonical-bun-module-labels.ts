import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

/**
 * Bun labels bundled modules with their resolved paths. A reused node_modules
 * symlink can point outside this checkout, changing only those comment labels
 * (and therefore a generated source digest). Canonicalize that exact resolved
 * directory, never arbitrary occurrences of the path inside executable JS.
 */
export function canonicalBunNodeModulesLabels(source: string, root: string): string {
  const resolvedModules = realpathSync(resolve(root, "node_modules"));
  const relativeModules = relative(root, resolvedModules).split(sep).join("/");
  if (relativeModules === "node_modules") return source;

  const labelPrefix = `// ${relativeModules}/`;
  return source
    .split("\n")
    .map((line) => {
      if (!line.startsWith(labelPrefix)) return line;
      const modulePath = line.slice(labelPrefix.length);
      if (modulePath.length === 0 || /\s/u.test(modulePath)) return line;
      return `// node_modules/${modulePath}`;
    })
    .join("\n");
}
