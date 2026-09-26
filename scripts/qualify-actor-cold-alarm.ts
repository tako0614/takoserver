import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

// Explicit local candidate qualification only. The serving workerd pin is
// selected elsewhere; this script never installs, downloads or promotes it.
const binary = process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY;
const digest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;
if (!binary || !isAbsolute(binary) || !digest || !/^[a-f0-9]{64}$/u.test(digest))
  throw new Error("absolute Actor qualification binary and SHA256 are required");
if (
  createHash("sha256")
    .update(await readFile(binary))
    .digest("hex") !== digest
)
  throw new Error("Actor qualification binary SHA256 mismatch");

const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "tests/selfhost-actor-execution-host.test.ts",
    "--test-name-pattern",
    "real self-host Actor owner",
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env },
);
process.exitCode = await child.exited;
