import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedGraphCapability } from "../src/workerd-artifact.ts";

async function fixture(root: string, behavior: string) {
  const binary = join(root, "probe");
  await writeFile(
    binary,
    `#!${process.execPath}
import {readFileSync,writeFileSync} from "node:fs";
const config=process.argv[4];
if(process.argv[2]!=="test"||process.argv[3]!=="--no-verbose"||process.argv[5]!=="probe")process.exit(2);
const source=readFileSync(config,"utf8");
if(!source.includes("role = hostPrivate")||!source.includes("role = application")||!source.includes('applicationMain = "entry.mjs"'))process.exit(3);
writeFileSync(${JSON.stringify(join(root, "pid"))},String(process.pid));
${behavior}
`,
  );
  await chmod(binary, 0o700);
  return binary;
}

test("a complete probe answer after five seconds is accepted within the bounded startup window", async () => {
  const root = await mkdtemp(join(tmpdir(), "workerd-probe-deadline-"));
  try {
    const binary = await fixture(root, "await Bun.sleep(5_500); process.exit(0);");
    expect(await closedGraphCapability(binary, join(root, "private"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("a hung probe is killed and a completed negative proof is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "workerd-probe-deadline-"));
  try {
    const binary = await fixture(root, "await Bun.sleep(30_000); process.exit(0);");
    const proof = closedGraphCapability(binary, join(root, "private"), 1_000);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await readFile(join(root, "pid"));
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    expect(await proof).toBe(false);
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await fixture(root, "process.exit(1);");
    expect(await closedGraphCapability(binary, join(root, "negative"))).toBe(false);
    await expect(closedGraphCapability(binary, join(root, "invalid"), 60_001)).rejects.toThrow(
      "timeout",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
