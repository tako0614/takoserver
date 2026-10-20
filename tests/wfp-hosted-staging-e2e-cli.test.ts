import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { usage } from "../scripts/wfp-hosted-staging-e2e.ts";

// Pins the documented command line to the flags the CLI's main() actually
// reads, without running any staging mode.
const script = readFileSync(
  new URL("../scripts/wfp-hosted-staging-e2e.ts", import.meta.url),
  "utf8",
);
const doc = readFileSync(new URL("../docs/wfp-hosted-staging-e2e.md", import.meta.url), "utf8");
const MODES = new Set(["help", "emit-fixture", "check-fixture", "run"]);

function mainSource(): string {
  const start = script.indexOf("async function main(");
  const end = script.indexOf("if (import.meta.main)", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

function names(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1] as string));
}

function parsedFlags() {
  const main = mainSource();
  const required = names(main, /requireFlag\(flags, "([a-z-]+)"\)/gu);
  const read = names(main, /flags\.get\("([a-z-]+)"\)/gu);
  const present = names(main, /flags\.has\("([a-z-]+)"\)/gu);
  const integers = names(main, /optionalInteger\(\s*flags,\s*"([a-z-]+)"/gu);
  const all = new Set(
    [...required, ...read, ...present, ...integers].filter((name) => !MODES.has(name)),
  );
  // requireFlag falls back to process.env[name] only when the flag is absent,
  // so a flag that is read only after flags.has(name) never uses it.
  const environment = new Set([...required].filter((name) => !present.has(name)));
  return { all, environment };
}

function documentedRows(): Map<string, string[]> {
  const section = doc.slice(
    doc.indexOf("## Command-Line Reference"),
    doc.indexOf("## Evidence And Failure"),
  );
  const rows = new Map<string, string[]>();
  for (const line of section.split("\n")) {
    const match = /^\| `--([a-z-]+)` \|(.*)\|$/u.exec(line);
    if (match)
      rows.set(
        match[1] as string,
        (match[2] as string).split("|").map((c) => c.trim()),
      );
  }
  return rows;
}

test("the doc's command-line reference lists exactly the flags main() reads", () => {
  const { all } = parsedFlags();
  expect(all.size).toBeGreaterThan(10);
  expect([...documentedRows().keys()].sort()).toEqual([...all].sort());
});

test("the documented environment fallbacks match requireFlag's reachable fallbacks", () => {
  const { environment } = parsedFlags();
  const documented = [...documentedRows()]
    .filter(([, cells]) => cells[3] !== "none")
    .map(([name, cells]) => {
      expect(cells[3]).toBe(`\`${name}\``);
      return name;
    });
  expect(documented.sort()).toEqual([...environment].sort());
});

test("documented defaults match the script's constants", () => {
  const rows = documentedRows();
  const constant = (name: string) => new RegExp(`const ${name} = (\\d+);`, "u").exec(script)?.[1];
  expect(rows.get("poll-seconds")?.[2]).toBe(`\`${constant("DEFAULT_POLL_SECONDS")}\``);
  expect(rows.get("schedule-timeout-seconds")?.[2]).toBe(
    `\`${constant("DEFAULT_SCHEDULE_SECONDS")}\``,
  );
});

test("usage names every flag and mode, and the same environment fallbacks", () => {
  const { all, environment } = parsedFlags();
  const text = usage();
  const names = (part: string | undefined) =>
    new Set([...(part ?? "").matchAll(/--([a-z]+(?:-[a-z]+)*)/gu)].map((match) => match[1]));
  const mentioned = names(text);
  for (const name of [...all, ...MODES]) expect(mentioned.has(name)).toBe(true);
  const fallbackSentence = text.slice(text.indexOf("When --"), text.indexOf("are flags only"));
  const [fallbacks, flagsOnly] = fallbackSentence.split("is read from the environment");
  expect([...names(fallbacks)].sort()).toEqual([...environment].sort());
  expect([...names(flagsOnly)].sort()).toEqual(
    [...all].filter((name) => !environment.has(name)).sort(),
  );
});
