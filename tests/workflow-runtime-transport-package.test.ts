import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as root from "@takoserver/core";
import * as runtime from "@takoserver/core/workflow-runtime";
import type { WorkflowHttpController } from "@takoserver/core/workflow-runtime/transport";
import * as transport from "@takoserver/core/workflow-runtime/transport";
import {
  WORKFLOW_HTTP_BOOTSTRAP_DIGEST,
  WORKFLOW_HTTP_BOOTSTRAP_SOURCE,
} from "../src/generated/workflow-http-bootstrap.ts";
import { createWorkflowHttpController } from "../src/workflow-http-controller.ts";
import {
  createWorkflowTransportJournal,
  WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES,
  WORKFLOW_TRANSPORT_MAX_PENDING_ENTRIES,
  WORKFLOW_TRANSPORT_SEQUENCE_WINDOW,
  WorkflowTransportJournalError,
} from "../src/workflow-transport-journal.ts";

test("trusted transport subpath exports only existing transport and bootstrap primitives", () => {
  expect(Object.keys(transport).sort()).toEqual(
    [
      "createWorkflowHttpController",
      "createWorkflowTransportJournal",
      "WORKFLOW_HTTP_BOOTSTRAP_DIGEST",
      "WORKFLOW_HTTP_BOOTSTRAP_SOURCE",
      "WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES",
      "WORKFLOW_TRANSPORT_MAX_PENDING_ENTRIES",
      "WORKFLOW_TRANSPORT_SEQUENCE_WINDOW",
      "WorkflowTransportJournalError",
    ].sort(),
  );
  expect(transport.createWorkflowTransportJournal).toBe(createWorkflowTransportJournal);
  expect(transport.WORKFLOW_HTTP_BOOTSTRAP_SOURCE).toBe(WORKFLOW_HTTP_BOOTSTRAP_SOURCE);
  expect(transport.WORKFLOW_HTTP_BOOTSTRAP_DIGEST).toBe(WORKFLOW_HTTP_BOOTSTRAP_DIGEST);
  expect(transport.createWorkflowHttpController).toBe(createWorkflowHttpController);
  const controller: WorkflowHttpController = transport.createWorkflowHttpController();
  expect(typeof controller.exchange).toBe("function");
  expect(typeof controller.acceptFrame).toBe("function");
  controller.close();
  expect(transport.WorkflowTransportJournalError).toBe(WorkflowTransportJournalError);
  expect(transport.WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES).toBe(WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES);
  expect(transport.WORKFLOW_TRANSPORT_MAX_PENDING_ENTRIES).toBe(
    WORKFLOW_TRANSPORT_MAX_PENDING_ENTRIES,
  );
  expect(transport.WORKFLOW_TRANSPORT_SEQUENCE_WINDOW).toBe(WORKFLOW_TRANSPORT_SEQUENCE_WINDOW);
  expect("createWorkflowTransportJournal" in root).toBe(false);
  expect("createWorkflowTransportJournal" in runtime).toBe(false);
  expect("WORKFLOW_HTTP_BOOTSTRAP_SOURCE" in root).toBe(false);
  expect("WORKFLOW_HTTP_BOOTSTRAP_SOURCE" in runtime).toBe(false);
});

test("the package transport preserves ordered dispatch and one-use seal", () => {
  const delivered: string[] = [];
  const journal = transport.createWorkflowTransportJournal({
    dispatch: (_sequence, payload) => {
      delivered.push(payload);
    },
  });
  journal.recordPayload(1, "payload");
  journal.recordMarker(1);
  expect(delivered).toEqual(["payload"]);
  journal.seal();
  expect(() => journal.recordPayload(2, "late")).toThrow(transport.WorkflowTransportJournalError);
});

test("the transport subpath bundles for a Worker without Node or Bun dependencies", async () => {
  const result = await Bun.build({
    entrypoints: [
      fileURLToPath(import.meta.resolve("@takoserver/core/workflow-runtime/transport")),
    ],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    plugins: [
      {
        name: "reject-host-imports",
        setup(build) {
          build.onResolve({ filter: /^(?:bun|node):/u }, (args) => {
            throw new Error(`host-only import: ${args.path}`);
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  expect(result.outputs).toHaveLength(1);
  const source = await result.outputs[0]?.text();
  expect(source).toBeDefined();
  expect(source).not.toMatch(/\b(?:Bun|process)\b|\bnode:/u);
});
