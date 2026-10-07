import { parseRuntimeInputSealKeyRing } from "../../src/runtime-input-seal-keyring.ts";
import { createSelfhostV2ConfiguredInputSealer } from "../../src/selfhost-v2-configured-input-sealer.ts";
import type {
  V2WorkerVersionPrivateIdentity,
  V2WorkerVersionSealedInputs,
} from "../../src/takoform-v2/worker-version-configured-inputs.ts";

const raw = await new Response(Bun.stdin.stream()).text();
const input = JSON.parse(raw) as {
  ring: string;
  identity: V2WorkerVersionPrivateIdentity;
  sealed: V2WorkerVersionSealedInputs;
  expected: string;
};
const ring = await parseRuntimeInputSealKeyRing(input.ring);
const sealer = createSelfhostV2ConfiguredInputSealer(ring);
const opened = await sealer.open(input.identity, input.sealed);
if (opened?.TOKEN !== input.expected) process.exitCode = 1;
else process.stdout.write("opened\n");
