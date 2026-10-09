import { createWorkerEntry, type WorkerEnv } from "../../src/entry-worker.ts";
import type { V2Form } from "../../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/fixture/PrivateWorkerEntry/1.0.0";
const MALFORMED_FORM = "https://forms.example.test/fixture/MalformedPrivateWorkerEntry/1.0.0";
const EXPECTED = "synthetic-worker-entry-private-value";

const privateForm: V2Form = {
  validateCreate(spec) {
    if (spec.kind !== "fixture") throw new TypeError("invalid private fixture spec");
  },
  validateUpdate(_previous, spec) {
    if (spec.kind !== "fixture") throw new TypeError("invalid private fixture spec");
  },
  privateInputs: {
    requiredForEveryInstance: true,
    validateCreate(_spec, inputs) {
      if (typeof inputs?.TOKEN !== "string" || Object.keys(inputs).length !== 1) {
        throw new TypeError("fixture TOKEN is required");
      }
    },
    validateUpdate(_previous, _spec, inputs) {
      if (
        inputs !== undefined &&
        (typeof inputs.TOKEN !== "string" || Object.keys(inputs).length !== 1)
      ) {
        throw new TypeError("fixture TOKEN is invalid");
      }
    },
  },
  backend: {
    id: "worker-entry-private-fixture-v1",
    targetKey: "worker-entry-private-fixture-target",
    async execute(input) {
      return {
        kind: "complete",
        observed: { delivered: input.privateInputs?.TOKEN === EXPECTED },
        output: {},
      };
    },
    async reconcile() {
      return { kind: "unknown" };
    },
  },
};

const selected = createWorkerEntry({
  composeV2Forms: ({ env }) => {
    const variant = (env as WorkerEnv & { TEST_PRIVATE_INPUT_POLICY?: string })
      .TEST_PRIVATE_INPUT_POLICY;
    if (variant === undefined) return { [FORM]: privateForm };
    const malformed = {
      ...privateForm,
      privateInputs: {
        null: null,
        false: false,
        zero: 0,
        empty: "",
      }[variant],
    } as unknown as V2Form;
    return { [FORM]: privateForm, [MALFORMED_FORM]: malformed };
  },
});
const ordinary = createWorkerEntry();

/** Test-only dispatch runs the actual Worker entry and scheduled pass inside Miniflare. */
export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    context: { waitUntil(work: Promise<unknown>): void },
  ): Promise<Response> {
    const local = new URL(request.url);
    if (local.pathname === "/__test/run-scheduled") {
      await selected.scheduled({}, env);
      return new Response(null, { status: 204 });
    }
    const useOrdinary = local.pathname.startsWith("/__test/ordinary/");
    const path = useOrdinary ? local.pathname.slice("/__test/ordinary".length) : local.pathname;
    const canonical = new URL(`${path}${local.search}`, env.PUBLIC_ORIGIN);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    return await (useOrdinary ? ordinary : selected).fetch(
      new Request(canonical, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      }),
      env,
      context,
    );
  },
};
