import { mkdirSync } from "node:fs";
import { openApiDocument } from "../src/openapi.ts";

mkdirSync("openapi", { recursive: true });
await Bun.write("openapi/takoserver.openapi.json", `${JSON.stringify(openApiDocument, null, 2)}\n`);
