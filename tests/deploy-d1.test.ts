import { describe, expect, test } from "bun:test";
import { type D1Process, RemoteD1 } from "../scripts/deploy/d1.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";

function processReturning(value: unknown): D1Process {
  return async (): Promise<CommandResult> => ({
    exitCode: 0,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: "",
  });
}

describe("strict Wrangler D1 readback", () => {
  test("accepts exactly one successful structured result", async () => {
    const database = new RemoteD1("/tmp/wrangler.jsonc", {
      environment: { CLOUDFLARE_API_TOKEN: "explicit" },
      run: processReturning([{ success: true, results: [{ name: "one" }] }]),
    });
    expect(await database.column("preflight", "names", "SELECT name", "name")).toEqual(["one"]);
  });

  test("refuses failed, multiple, or partly malformed result sets", async () => {
    for (const payload of [
      [{ success: false, results: [] }],
      [
        { success: true, results: [] },
        { success: true, results: [] },
      ],
      [{ success: true, results: [{ name: "one" }, null] }],
    ]) {
      const database = new RemoteD1("/tmp/wrangler.jsonc", {
        environment: { CLOUDFLARE_API_TOKEN: "explicit" },
        run: processReturning(payload),
      });
      await expect(database.query("preflight", "strict read", "SELECT 1")).rejects.toThrow(
        "unexpected shape",
      );
    }
  });

  test("refuses log framing around the JSON result", async () => {
    const database = new RemoteD1("/tmp/wrangler.jsonc", {
      environment: {},
      run: processReturning([{ success: true, results: [{ name: "one" }] }]),
    });
    const framed = new RemoteD1("/tmp/wrangler.jsonc", {
      environment: {},
      run: async (): Promise<CommandResult> => ({
        exitCode: 0,
        stdout: `warning\n${JSON.stringify([{ success: true, results: [{ name: "one" }] }])}\n`,
        stderr: "",
      }),
    });
    await expect(database.query("preflight", "strict read", "SELECT 1")).resolves.toHaveLength(1);
    await expect(framed.query("preflight", "strict read", "SELECT 1")).rejects.toThrow(
      "unparsable JSON",
    );
  });
});
