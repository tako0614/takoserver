import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderSchemaModule } from "./write-schema.ts";

const path = resolve(import.meta.dir, "../src/db-schema.ts");
let current: string;
try {
  current = readFileSync(path, "utf8");
} catch {
  current = "";
}

if (current !== renderSchemaModule()) {
  console.error("src/db-schema.ts is stale; run `bun run schema:write`");
  process.exit(1);
}
