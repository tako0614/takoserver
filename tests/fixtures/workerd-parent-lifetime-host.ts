import { spawnWorkerdWithParentDeath } from "../../src/workerd-linux-process.ts";

const child = spawnWorkerdWithParentDeath(["/bin/sleep", "30"], {
  stdout: "ignore",
  stderr: "ignore",
});
process.stdout.write(`${child.pid}\n`);
await child.exited;
