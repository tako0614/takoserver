import { readFileSync } from "node:fs";
import { openApiDocument } from "../src/openapi.ts";

const expected = `${JSON.stringify(openApiDocument, null, 2)}\n`;
const actual = readFileSync("openapi/takoserver.openapi.json", "utf8");
if (actual !== expected) {
  console.error("OpenAPI artifact is stale; run `bun run openapi:write`");
  process.exit(1);
}
