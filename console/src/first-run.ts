import { type Child, h, live } from "./dom.ts";
import { tr } from "./i18n.ts";
import { resource } from "./reactive.ts";
import { api } from "./state.ts";

const GUIDE = "https://github.com/tako0614/takoserver/blob/main/docs/self-host-operations.md";
const MODULE_WORKER = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
/** A Host that has not said whether it runs Workers by now is not waited for. */
const SUPPORT_TIMEOUT_MS = 5_000;

/** Whether this Host runs Workers, or null when it did not say in time. */
function runsWorkers(organizationId: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SUPPORT_TIMEOUT_MS);
    api.formSupport(organizationId, MODULE_WORKER).then(
      (supported) => {
        clearTimeout(timer);
        resolve(supported);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function guideLink(anchor: string, label: string): Child {
  return h(
    "a",
    { href: `${GUIDE}#${anchor}`, target: "_blank", rel: "noopener noreferrer" },
    label,
    h("span", { "aria-hidden": "true" }, " ↗"),
    h(
      "span",
      { class: "visually-hidden" },
      tr("（新しいタブで開きます）", " (opens in a new tab)"),
    ),
  );
}

/**
 * What an organization with nothing in it is told. A Host that runs Workers
 * gets the five Resources that serve one; a Host that keeps only artifacts
 * says so, rather than promising a Worker it cannot serve. Until the Host
 * answers, the steps are said for a Host that runs Workers.
 */
export function firstRunNote(organizationId: string): Child {
  const workers = resource(() => runsWorkers(organizationId));
  return live(() => {
    const state = workers.get();
    const answer = state.state === "ready" ? state.value : null;
    if (answer === false)
      return h(
        "span",
        null,
        tr(
          "このHostはWorkerを実行しません。保持できるのは、Workerのコード・静的ファイル・SQLのマイグレーションといった成果物です。Workerを動かすには、Worker実行環境とその設定が必要です。詳しくは",
          "This Host does not run Workers. It keeps artifacts: Worker code, static files and SQL migrations. Running Workers needs the Worker runtime and its settings; ",
        ),
        guideLink("first-install-and-first-use", tr("導入手順書（英語）", "the install guide")),
        tr("を参照してください。", " covers both."),
      );
    return h(
      "span",
      null,
      answer === true
        ? tr(
            "Workerは、ModuleWorker・WorkerBundle・WorkerVersion・WorkerDeployment・WorkerEndpointの5つのリソースをこの順に作ると公開されます。",
            "A Worker is served once five Resources are created in this order: ModuleWorker, WorkerBundle, WorkerVersion, WorkerDeployment and WorkerEndpoint. ",
          )
        : tr(
            "Workerを実行できるHostでは、ModuleWorker・WorkerBundle・WorkerVersion・WorkerDeployment・WorkerEndpointの5つのリソースをこの順に作るとWorkerが公開されます。",
            "On a Host that runs Workers, a Worker is served once five Resources are created in this order: ModuleWorker, WorkerBundle, WorkerVersion, WorkerDeployment and WorkerEndpoint. ",
          ),
      tr(
        "作成ダイアログでFormを選ぶと、そのFormの最小の設定が入ります。詳しくは",
        "In the create dialog, choosing a Form fills in its smallest spec. ",
      ),
      guideLink(
        "6-seed-held-artifacts",
        tr("導入手順書（英語）の手順6〜8", "Steps 6 to 8 of the install guide"),
      ),
      tr("を参照してください。", " walk through it."),
    );
  });
}
