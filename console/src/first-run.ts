import { type Child, h, live } from "./dom.ts";
import { tr } from "./i18n.ts";
import { resource } from "./reactive.ts";
import { api } from "./state.ts";

const GUIDE = "https://github.com/tako0614/takoserver/blob/main/docs/self-host-operations.md";
const MODULE_WORKER = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
const WORKER_ENDPOINT = "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/";
/** A Host that has not said whether it runs Workers by now is not waited for. */
const SUPPORT_TIMEOUT_MS = 5_000;

/** Whether this Host supports a Form, or null when it did not say in time. */
function supports(organizationId: string, form: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SUPPORT_TIMEOUT_MS);
    api.formSupport(organizationId, form).then(
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
 * What an organization with nothing in it is told, by what this Host says it
 * serves: the five Resources that publish a Worker; that Workers run here but
 * are not published at a hostname yet; or that this Host keeps artifacts
 * only. Until the Host answers, the steps are said for a Host that runs and
 * publishes Workers.
 */
export function firstRunNote(organizationId: string): Child {
  const answers = resource(() =>
    Promise.all([
      supports(organizationId, MODULE_WORKER),
      supports(organizationId, WORKER_ENDPOINT),
    ]),
  );
  const dialog = (): string =>
    tr(
      "作成ダイアログでFormを選ぶと、そのFormの最小の設定が入ります。",
      "In the create dialog, choosing a Form fills in its smallest spec. ",
    );
  return live(() => {
    const state = answers.get();
    const [worker, endpoint] = state.state === "ready" ? state.value : [null, null];
    if (worker === false)
      return h(
        "span",
        null,
        tr(
          "このHostはWorkerを実行しません。保持できるのは、Workerのコード・静的ファイル・SQLのマイグレーションといった成果物です（どれに対応しているかは作成ダイアログに表示されます）。Workerを動かすには、Worker実行環境とその設定が必要です。詳しくは",
          "This Host does not run Workers. It can keep artifacts such as Worker code, static files and SQL migrations; the create dialog lists which. Running Workers needs the Worker runtime and its settings; ",
        ),
        guideLink("first-install-and-first-use", tr("導入手順書（英語）", "the install guide")),
        tr("を参照してください。", " covers both."),
      );
    if (worker === true && endpoint === false)
      return h(
        "span",
        null,
        tr(
          "このHostはWorkerを実行しますが、HTTPSのホスト名で公開するWorkerEndpointにはまだ対応していません。公開には",
          "This Host runs Workers but does not yet publish them at an HTTPS hostname: WorkerEndpoint needs the HTTPS listener from ",
        ),
        guideLink(
          "4-https-and-tcp-443",
          tr("導入手順書（英語）の手順4", "step 4 of the install guide"),
        ),
        tr("にあるHTTPS（TCP 443）の待ち受け設定が必要です。", ". "),
        dialog(),
      );
    return h(
      "span",
      null,
      worker === true && endpoint === true
        ? tr(
            "Workerは、ModuleWorker・WorkerBundle・WorkerVersion・WorkerDeployment・WorkerEndpointの5つのリソースをこの順に作ると公開されます。",
            "A Worker is served once five Resources are created in this order: ModuleWorker, WorkerBundle, WorkerVersion, WorkerDeployment and WorkerEndpoint. ",
          )
        : tr(
            "Workerを実行できるHostでは、ModuleWorker・WorkerBundle・WorkerVersion・WorkerDeployment・WorkerEndpointの5つのリソースをこの順に作るとWorkerが公開されます。",
            "On a Host that runs Workers, a Worker is served once five Resources are created in this order: ModuleWorker, WorkerBundle, WorkerVersion, WorkerDeployment and WorkerEndpoint. ",
          ),
      dialog(),
      tr("詳しくは", ""),
      guideLink(
        "6-seed-held-artifacts",
        tr("導入手順書（英語）の手順6〜8", "Steps 6 to 8 of the install guide"),
      ),
      tr("を参照してください。", " walk through it."),
    );
  });
}
