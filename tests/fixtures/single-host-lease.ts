import { acquireSingleHostLease } from "../../src/selfhost-single-host-lease.ts";

const root = process.argv[2];
if (!root) throw new Error("fixture root required");
const lease = acquireSingleHostLease({
  dataRoot: root,
  hostId: "test-host",
  databasePath: `${root}/control.sqlite`,
});
console.log(JSON.stringify({ epoch: lease.epoch, bootId: lease.bootId }));
setInterval(() => {}, 1000);
