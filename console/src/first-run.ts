import { type Child, h } from "./dom.ts";
import { tr } from "./i18n.ts";

const INSTALL_GUIDE_STEP_8 =
  "https://github.com/tako0614/takoserver/blob/main/docs/self-host-operations.md#8-create-and-serve-a-worker";

/**
 * What an organization with nothing in it is told: how a Worker comes to be
 * served, and where the create dialog and the install guide take it from there.
 */
export function firstRunNote(): Child {
  return h(
    "span",
    null,
    tr(
      "Workerは、ModuleWorker・WorkerBundle・WorkerVersion・WorkerDeployment・WorkerEndpointの5つのリソースをこの順に作ると公開されます。作成ダイアログでFormを選ぶと、そのFormの最小の設定から始められます。手順は",
      "A Worker is served once five Resources are created in this order: ModuleWorker, WorkerBundle, WorkerVersion, WorkerDeployment and WorkerEndpoint. In the create dialog, choosing a Form starts from its smallest spec. ",
    ),
    h(
      "a",
      { href: INSTALL_GUIDE_STEP_8, target: "_blank", rel: "noopener noreferrer" },
      tr("導入手順書の手順8（英語）", "Step 8 of the install guide"),
    ),
    tr("にあります。", " walks through it."),
  );
}
