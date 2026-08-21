import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("Takoserver Console authentication return navigation", () => {
  test("synchronizes the SPA route whenever an identity provider clears its callback URL", () => {
    for (const path of ["console/src/google.ts", "console/src/takos-id.ts"]) {
      const source = readFileSync(resolve(root, path), "utf8");

      expect(source).toContain('import { navigate } from "./router.ts";');
      expect(source).toContain('navigate("/", { replace: true });');
      expect(source).not.toContain("window.history.replaceState");
    }
  });
});
