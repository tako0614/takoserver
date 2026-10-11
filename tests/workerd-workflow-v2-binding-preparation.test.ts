import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
  WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
  workerdV2PrivateWorkflowBindingName,
} from "../src/providers/workerd-v2-private-binding-names.ts";
import {
  SELFHOST_DATA_ROOT_SOCKET_BUDGET,
  SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES,
  selfhostPrivateSocketRoot,
} from "../src/selfhost-socket-layout.ts";
import type { WorkerdPrivateServiceLease, WorkerdSite } from "../src/workerd-runtime.ts";
import { prepareWorkerdWorkflowExecution } from "../src/workerd-workflow-preparation.ts";
import type { WorkflowRunIdentity } from "../src/workflow-execution.ts";
import { mkdtempForSockets } from "./helpers/socket-temp-root.ts";

const encoder = new TextEncoder();
const parentUid = "workflow-parent";
const childUid = "workflow-child";
const serviceName = workerdV2PrivateWorkflowBindingName(0);
const token = "a".repeat(64);
const snapshotDigest = `sha256:${"b".repeat(64)}` as const;
const identity: WorkflowRunIdentity = {
  scope: { tenantId: "org:workflow-test", workflowResourceUid: parentUid },
  instanceId: "instance",
  executionId: "execution",
  createdAt: 1,
  epoch: 1,
  owner: "owner",
  deadlineAt: 60_000,
};

function selectedSite(): WorkerdSite {
  return {
    directory: "worker",
    mainModule: "index.mjs",
    hostEntrypoint: WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
    hostModules: [
      WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
      WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
    ],
    hostnames: [],
    generation: "generation",
    workerResourceUid: "worker",
    fetchHandler: false,
    moduleMediaTypes: { "index.mjs": "application/javascript+module" },
    workflowForward: {
      schema: "takoserver.v2-workflow-binding-forward@1",
      snapshotDigest,
      bindings: [
        {
          publicName: "CHILD",
          serviceName,
          tenantId: identity.scope.tenantId,
          workflowResourceUid: childUid,
          token,
        },
      ],
    },
  };
}

function preparation(
  root: string,
  site: WorkerdSite,
  acquireServiceBindings: (signal: AbortSignal) => Promise<WorkerdPrivateServiceLease>,
) {
  return {
    selection: {
      tenantId: identity.scope.tenantId,
      workflowResourceUid: identity.scope.workflowResourceUid,
      workerResourceUid: "worker",
      versionId: "version",
      workerVersionUid: "worker-version",
      className: "ParentWorkflow",
      site,
      modules: new Map([["index.mjs", encoder.encode("export class ParentWorkflow { run() {} }")]]),
      hostModules: new Map([
        [WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE, encoder.encode("export default {}")],
        [WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE, encoder.encode("export default {}")],
      ]),
    },
    identity,
    input: undefined,
    signal: new AbortController().signal,
    channel: { journalToken: "c".repeat(64), recordPayload() {} },
    temporaryRoot: root,
    acquireServiceBindings,
  };
}

test("v2 Workflow-only class preparation pins exact broker UDS through child disposal", async () => {
  const root = await mkdtempForSockets("twf-v2-binding-", SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES);
  const socketPath = join(root, `${"d".repeat(22)}.sock`);
  const broker = createServer();
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(socketPath, resolve);
  });
  let acquisitions = 0;
  let releases = 0;
  try {
    const prepared = await prepareWorkerdWorkflowExecution(
      preparation(root, selectedSite(), async () => {
        acquisitions += 1;
        return {
          services: [],
          workflowServices: [
            {
              name: serviceName,
              publicName: "CHILD",
              workflowResourceUid: childUid,
              token,
              snapshotDigest,
              upstreamSocket: socketPath,
            },
          ],
          async release() {
            releases += 1;
          },
        };
      }),
    );
    try {
      const config = await readFile(prepared.configPath, "utf8");
      expect(acquisitions).toBe(1);
      expect(releases).toBe(0);
      expect(config).toContain(serviceName);
      expect(config).toContain(`unix:${socketPath}`);
      expect(config).not.toContain(token);
    } finally {
      await prepared.drainAfterStop();
      await prepared.dispose();
    }
    expect(releases).toBe(1);
    expect(await readdir(root)).toEqual([`${"d".repeat(22)}.sock`]);
  } finally {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 Workflow-only class rejects mismatched broker token and releases the lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "twf-v2-binding-reject-"));
  let releases = 0;
  try {
    await expect(
      prepareWorkerdWorkflowExecution(
        preparation(root, selectedSite(), async () => ({
          services: [],
          workflowServices: [
            {
              name: serviceName,
              publicName: "CHILD",
              workflowResourceUid: childUid,
              token: "e".repeat(64),
              snapshotDigest,
              upstreamSocket: join(root, `${"f".repeat(22)}.sock`),
            },
          ],
          async release() {
            releases += 1;
          },
        })),
      ),
    ).rejects.toThrow();
    expect(releases).toBe(1);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 Workflow-only class cannot change tenant while broker lease is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "twf-v2-binding-tenant-race-"));
  const foreignTenant = "org:other-tenant";
  const foreignSite: WorkerdSite = {
    ...selectedSite(),
    workflowForward: {
      schema: "takoserver.v2-workflow-binding-forward@1",
      snapshotDigest,
      bindings: [
        {
          publicName: "CHILD",
          serviceName,
          tenantId: foreignTenant,
          workflowResourceUid: childUid,
          token,
        },
      ],
    },
  };
  let resolveAcquire!: (lease: WorkerdPrivateServiceLease) => void;
  const acquisition = new Promise<WorkerdPrivateServiceLease>((resolve) => {
    resolveAcquire = resolve;
  });
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let releases = 0;
  try {
    const input = preparation(root, foreignSite, async () => {
      entered();
      return acquisition;
    });
    const pending = prepareWorkerdWorkflowExecution(input);
    await acquired;
    input.selection.tenantId = foreignTenant;
    resolveAcquire({
      services: [],
      workflowServices: [
        {
          name: serviceName,
          publicName: "CHILD",
          workflowResourceUid: childUid,
          token,
          snapshotDigest,
          upstreamSocket: join(root, `${"a".repeat(22)}.sock`),
        },
      ],
      async release() {
        releases += 1;
      },
    });
    await expect(pending).rejects.toThrow("private Workflow lease does not match selected Version");
    expect(releases).toBe(1);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guarded v2 class preparation refuses a legacy Workflow descriptor before lease acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "twf-v2-binding-legacy-"));
  let acquisitions = 0;
  try {
    const selected = selectedSite();
    const legacy = {
      ...selected,
      workflowForward: {
        ...selected.workflowForward,
        schema: "takoserver.selfhost-workflow-binding-forward@v1",
      },
    } as unknown as WorkerdSite;
    await expect(
      prepareWorkerdWorkflowExecution(
        preparation(root, legacy, async () => {
          acquisitions += 1;
          throw new Error("legacy descriptor reached lease acquisition");
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_runtime_input" });
    expect(acquisitions).toBe(0);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow-only class refuses when no exact broker lease can be acquired", async () => {
  const root = await mkdtemp(join(tmpdir(), "twf-v2-binding-no-lease-"));
  try {
    const input = preparation(root, selectedSite(), async () => {
      throw new Error("unexpected lease callback");
    });
    const { acquireServiceBindings: _unused, ...withoutLease } = input;
    await expect(prepareWorkerdWorkflowExecution(withoutLease)).rejects.toThrow(
      "private execution service binding bridge is unavailable",
    );
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow execution directories fit below a data root of the published maximum and refuse one byte more", async () => {
  const brokerRoot = await mkdtempForSockets("twfb-", SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES);
  const socketPath = join(brokerRoot, `${"d".repeat(22)}.sock`);
  const broker = createServer();
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(socketPath, resolve);
  });
  const maximum = SELFHOST_DATA_ROOT_SOCKET_BUDGET.workflowExecution;
  const base = await mkdtempForSockets("twfr-", maximum - 2);
  const lease = async (): Promise<WorkerdPrivateServiceLease> => ({
    services: [],
    workflowServices: [
      {
        name: serviceName,
        publicName: "CHILD",
        workflowResourceUid: childUid,
        token,
        snapshotDigest,
        upstreamSocket: socketPath,
      },
    ],
    async release() {},
  });
  try {
    const exact = join(base, "d".repeat(maximum - Buffer.byteLength(base) - 1));
    expect(Buffer.byteLength(exact)).toBe(maximum);
    for (const root of [exact, `${exact}x`])
      await mkdir(selfhostPrivateSocketRoot(root), {
        recursive: true,
        mode: 0o700,
      });
    const prepared = await prepareWorkerdWorkflowExecution(
      preparation(selfhostPrivateSocketRoot(exact), selectedSite(), lease),
    );
    try {
      const config = await readFile(prepared.configPath, "utf8");
      const run = config.match(/unix:([^"]+\/run\.sock)/u)?.[1];
      expect(run?.startsWith(`${selfhostPrivateSocketRoot(exact)}/twf-`)).toBe(true);
      expect(Buffer.byteLength(run ?? "")).toBe(100);
    } finally {
      await prepared.drainAfterStop();
      await prepared.dispose();
    }
    await expect(
      prepareWorkerdWorkflowExecution(
        preparation(selfhostPrivateSocketRoot(`${exact}x`), selectedSite(), lease),
      ),
    ).rejects.toThrow();
    // A refused execution leaves no directory behind.
    expect(await readdir(selfhostPrivateSocketRoot(`${exact}x`))).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    await rm(brokerRoot, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});
