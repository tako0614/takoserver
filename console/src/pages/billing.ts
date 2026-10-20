import {
  formatMicrosCurrency,
  formatUsagePercent,
  type HostedPlanTable,
  type HostedSubscriptionProjection,
  type LedgerEntry,
  type OrganizationSubscription,
  type WorkspaceUsageAmounts,
} from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { consoleLocale, tr } from "../i18n.ts";
import { effect, type Resource, resource, signal } from "../reactive.ts";
import { api, currentOrganization, principal } from "../state.ts";
import {
  browserSubscriptionCancelIntentLock,
  createSubscriptionCancelIntentStore,
} from "../subscription-cancel-intent.ts";
import {
  createSubscriptionCancellationController,
  type SubscriptionCancellationState,
} from "../subscription-cancellation.ts";
import { createSubscriptionCheckoutController } from "../subscription-checkout.ts";
import {
  browserSubscriptionIntentLock,
  createSubscriptionIntentStore,
} from "../subscription-intent.ts";
import { subscriptionPlanOptions } from "../subscription-plan-options.ts";
import {
  createTopUpCheckoutController,
  type TopUpCheckoutState,
  topUpLane,
} from "../top-up-checkout.ts";
import { browserTopUpIntentLock, createTopUpIntentStore } from "../top-up-intent.ts";
import {
  badge,
  card,
  copyable,
  empty,
  explain,
  ICON,
  icon,
  openModal,
  skeletonRows,
  stat,
  toast,
  when,
  whenReady,
} from "../ui.ts";
import { createWorkspaceUsageController, type WorkspaceUsageState } from "../workspace-usage.ts";

/**
 * The wallet, and the ledger it is derived from.
 *
 * There is no balance column anywhere in this product — available is settled
 * minus held, recomputed from entries that are only ever appended. The page is
 * built to say so, because a customer who can see the arithmetic does not have
 * to trust it.
 */
export function billingPage(organizationId: string): Child {
  const wallet = resource(() => api.wallet(organizationId));
  const usageSummary = resource(() => api.usageSummary(organizationId));
  const hostedSubscription = resource(() => api.subscription(organizationId));
  const workspaceUsage = createWorkspaceUsageController({
    organizationId,
    api,
    isCurrent: () => currentOrganization()?.id === organizationId,
  });
  workspaceUsage.reload();
  const reloadWallet = () => {
    wallet.reload();
    usageSummary.reload();
    workspaceUsage.reload();
  };
  const reloadSubscription = () => {
    hostedSubscription.reload();
    reloadWallet();
  };
  const ownerCanManage = () => {
    const who = principal();
    const organization = currentOrganization();
    return Boolean(
      who && organization?.id === organizationId && who.id === organization.ownerPrincipalId,
    );
  };
  const ownerScope = () => {
    const who = principal();
    const organization = currentOrganization();
    if (!who || !organization) return null;
    return {
      organizationId: organization.id,
      principalId: who.id,
      ownerPrincipalId: organization.ownerPrincipalId,
    };
  };
  const browserLocation = {
    readLocation: () => ({
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    }),
    replaceLocation: (url: string) => window.history.replaceState({}, "", url),
    assign: (url: string) => window.location.assign(url),
  };
  /**
   * Which top-up lane this deployment runs, read from the same answer that
   * draws the subscription card. Until that answer arrives, neither is assumed.
   */
  const billingMode = () => topUpLane(hostedSubscription.get());
  const checkout = createSubscriptionCheckoutController({
    organizationId,
    getScope: ownerScope,
    intents: createSubscriptionIntentStore({
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
        removeItem: (key) => window.localStorage.removeItem(key),
      },
      uuid: () => crypto.randomUUID(),
      lock: browserSubscriptionIntentLock(),
    }),
    api,
    browser: browserLocation,
    onSubscriptionRefresh: reloadSubscription,
  });
  const topUp = createTopUpCheckoutController({
    organizationId,
    getScope: ownerScope,
    intents: createTopUpIntentStore({
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
        removeItem: (key) => window.localStorage.removeItem(key),
      },
      uuid: () => crypto.randomUUID(),
      lock: browserTopUpIntentLock(),
    }),
    api,
    browser: browserLocation,
    onWalletRefresh: reloadWallet,
  });
  const cancellationIntents = createSubscriptionCancelIntentStore({
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
      removeItem: (key) => window.localStorage.removeItem(key),
    },
    uuid: () => crypto.randomUUID(),
    lock: browserSubscriptionCancelIntentLock(),
  });
  let cancellationController: {
    readonly subscriptionRef: string;
    readonly controller: ReturnType<typeof createSubscriptionCancellationController>;
  } | null = null;
  const cancellationFor = (subscriptionRef: string) => {
    if (cancellationController?.subscriptionRef === subscriptionRef)
      return cancellationController.controller;
    const controller = createSubscriptionCancellationController({
      organizationId,
      getScope: () => {
        const who = principal();
        const organization = currentOrganization();
        const loaded = hostedSubscription.get();
        if (
          !who ||
          !organization ||
          organization.id !== organizationId ||
          who.id !== organization.ownerPrincipalId ||
          loaded.state !== "ready" ||
          loaded.value.subscription?.subscriptionRef !== subscriptionRef
        )
          return null;
        return {
          organizationId,
          ownerPrincipalId: who.id,
          subscriptionRef,
        };
      },
      intents: cancellationIntents,
      api,
      onRefresh: reloadSubscription,
    });
    cancellationController = { subscriptionRef, controller };
    return controller;
  };
  if (ownerCanManage()) void checkout.handleReturn();
  // A payment that just completed comes back through the URL, and it is
  // answered as soon as the lane is known, so the balance a person sees
  // includes what they just paid. A hosted return only reads the receipt of
  // its stored reference; only a legacy return exchanges the session itself.
  // Routing stays armed until the lane is known and the return was consumed
  // or deliberately kept — a scope that loads later still gets its answer.
  let returnSettled = false;
  let routing = false;
  let rerouteRequested = false;
  const routeReturn = async (): Promise<void> => {
    if (returnSettled) return;
    if (routing) {
      rerouteRequested = true;
      return;
    }
    routing = true;
    try {
      do {
        rerouteRequested = false;
        const mode = billingMode();
        if (mode === "legacy") {
          settleReturn(organizationId, reloadWallet);
          returnSettled = true;
        } else if (mode === "hosted") {
          const checkoutHandled = await topUp.handleReturn();
          const consentHandled = await topUp.handleConsentReturn();
          returnSettled = checkoutHandled && consentHandled;
        }
      } while (!returnSettled && rerouteRequested);
    } finally {
      routing = false;
    }
    if (returnSettled) stopReturnRouting();
  };
  const stopReturnRouting = effect(() => {
    // Read what can make an unanswered return answerable: the lane, the owner
    // scope, and the controller finishing a request it was busy with.
    billingMode();
    ownerScope();
    topUp.state();
    queueMicrotask(() => void routeReturn());
  });
  const openAddFunds = (): void => {
    const mode = billingMode();
    if (mode === "legacy") {
      addFunds(organizationId, reloadWallet);
      return;
    }
    const loaded = hostedSubscription.get();
    if (mode === "hosted" && loaded.state === "ready") {
      hostedAddFunds(topUp, topUpBounds(loaded.value.planTable));
      return;
    }
    toast(
      tr(
        "支払い方法を確認できません。状態を更新してから再試行してください。",
        "This deployment's payment method could not be confirmed. Refresh and try again.",
      ),
      "bad",
    );
  };

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, tr("使用量と請求", "Usage & billing")),
        h(
          "p",
          null,
          tr(
            "Takoserverは前払い制です。処理中は利用可能残高から金額を確保し、成功時に請求します。失敗時は確保を解除し、請求しません。",
            "Takoserver is prepaid. Work places a hold against the available balance and captures it when it succeeds; if it fails, the hold is released and nothing is charged.",
          ),
        ),
      ),
      h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          onClick: openAddFunds,
        },
        icon(ICON.plus, 14),
        text(tr("残高を追加", "Add funds")),
      ),
    ),
    live(() => (billingMode() === "hosted" ? topUpStatus(topUp) : null)),
    hostedSubscriptionCard(hostedSubscription, checkout, ownerCanManage, cancellationFor),
    live(() =>
      whenReady(
        wallet.get(),
        ({ wallet: held }) =>
          h(
            "div",
            { style: { display: "grid", gap: "16px" } },
            h(
              "div",
              { class: "grid" },
              stat(
                tr("利用可能", "Available"),
                formatMicrosCurrency(held.availableMicros, held.currency, uiLocale()),
                tr("確定残高 − 確保中", "settled − held"),
              ),
              stat(
                tr("確保中", "Held"),
                formatMicrosCurrency(held.heldMicros, held.currency, uiLocale()),
                tr("処理中の操作に予約済み", "reserved against live work"),
              ),
              stat(
                tr("確定残高", "Settled"),
                formatMicrosCurrency(held.settledMicros, held.currency, uiLocale()),
                tr("入金と確定済み請求", "funded and captured"),
              ),
              live(() =>
                whenReady(
                  usageSummary.get(),
                  ({ usageSummary: summary }) =>
                    stat(
                      tr("利用枠の使用率", "Included usage"),
                      formatUsagePercent(summary.utilizationBasisPoints, uiLocale()),
                      summary.effectiveIncludedMicros === "0"
                        ? tr(
                            "この期間の利用枠はありません",
                            "No included allowance for this period",
                          )
                        : tr("使用済み＋確保中／利用枠", "used + held / included allowance"),
                    ),
                  { retry: usageSummary.reload },
                ),
              ),
            ),
            card(
              tr("取引履歴", "Ledger"),
              held.entries.length === 0
                ? empty(
                    tr("履歴がありません", "No entries"),
                    tr(
                      "この組織にはまだ入金または請求がありません。",
                      "Nothing has been funded or charged on this organization yet.",
                    ),
                  )
                : h("div", { class: "table-scroll" }, ledgerTable(held.entries, held.currency)),
            ),
          ),
        { retry: reloadWallet },
      ),
    ),
    workspaceUsageCard(workspaceUsage),
  );
}

/**
 * Where this period's usage went, by opaque Workspace reference.
 *
 * Read-only and paged within one frozen server snapshot. The totals row is the
 * snapshot's Organization total, not a sum of the loaded pages, and the
 * unattributed row is historical usage that carries no Workspace. A Host that
 * has no breakdown answers `not_found`, and then the section is not drawn.
 */
function workspaceUsageCard(
  controller: ReturnType<typeof createWorkspaceUsageController>,
): HTMLElement {
  return live(() => {
    const state = controller.state();
    if (state.status === "unavailable") return null;
    return card(
      tr("ワークスペース別の使用量", "Workspace usage"),
      workspaceUsageBody(state, controller),
      h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          ...(state.status === "loading" ? { disabled: true, "aria-busy": "true" } : {}),
          onClick: controller.reload,
        },
        icon(ICON.refresh, 13),
        text(tr("更新", "Refresh")),
      ),
    );
  });
}

function workspaceUsageBody(
  state: Exclude<WorkspaceUsageState, { readonly status: "unavailable" }>,
  controller: ReturnType<typeof createWorkspaceUsageController>,
): Child {
  if (state.status === "loading") return skeletonRows(3);
  if (state.status === "error")
    return whenReady({ state: "error", error: state.error }, () => null, {
      retry: controller.reload,
    });
  const { snapshot } = state;
  return h(
    "div",
    null,
    h(
      "div",
      { class: "card__body", style: { display: "grid", gap: "8px" } },
      h(
        "p",
        { class: "dim" },
        tr(
          `対象期間：${when(snapshot.periodStart)} 〜 ${when(snapshot.periodEnd)} ・ 集計時点：${when(snapshot.snapshotAt)}`,
          `Period ${when(snapshot.periodStart)} – ${when(snapshot.periodEnd)} · snapshot taken ${when(snapshot.snapshotAt)}`,
        ),
      ),
      h(
        "small",
        { class: "dim" },
        tr(
          "すべての消費区分の使用量です。ワークスペースは参照IDで表示します。合計は組織全体の値で、ページを読み込んでも変わりません。未払いは使用済みで支払い前の額で、利用可能残高ではありません。",
          "All consumption classes, by opaque Workspace reference. The total is the whole Organization's for this snapshot and does not change as pages load. Pending is used but not yet paid; it is not available balance.",
        ),
      ),
      state.restarted
        ? h(
            "p",
            { class: "notice", role: "status", "aria-live": "polite" },
            tr(
              "前の集計の有効期限が切れたため、新しい集計を最初のページから表示しています。",
              "The earlier snapshot expired, so a new snapshot is shown from the first page.",
            ),
          )
        : null,
    ),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, tr("ワークスペース", "Workspace")),
            h("th", { class: "num" }, tr("使用済み", "Used")),
            h("th", { class: "num" }, tr("確保中", "Held")),
            h("th", { class: "num" }, tr("未払い", "Pending")),
          ),
        ),
        h(
          "tbody",
          null,
          ...(state.rows.length === 0
            ? [
                h(
                  "tr",
                  null,
                  h(
                    "td",
                    { class: "dim", colspan: 4 },
                    tr(
                      "この期間にワークスペースへ帰属する使用量はありません。",
                      "No Workspace-attributed usage in this period.",
                    ),
                  ),
                ),
              ]
            : state.rows.map((row) => workspaceUsageRow(copyable(row.workspaceRef), row))),
          workspaceUsageRow(
            h("span", { class: "dim" }, tr("ワークスペースなし", "Unattributed")),
            snapshot.unattributed,
          ),
          workspaceUsageRow(
            h("strong", null, tr("組織の合計", "Organization total")),
            snapshot.totals,
          ),
        ),
      ),
    ),
    state.cursor === null
      ? null
      : h(
          "div",
          { class: "card__body", style: { display: "grid", gap: "8px", justifyItems: "center" } },
          state.more.status === "error"
            ? h("div", { class: "notice notice--bad" }, text(explain(state.more.error)))
            : null,
          h(
            "button",
            {
              class: "btn",
              type: "button",
              ...(state.more.status === "loading" ? { disabled: true, "aria-busy": "true" } : {}),
              onClick: () => void controller.loadMore(),
            },
            text(
              state.more.status === "loading"
                ? tr("読み込み中…", "Loading…")
                : state.more.status === "error"
                  ? tr("もう一度試す", "Try again")
                  : tr("さらに読み込む", "Load more"),
            ),
          ),
        ),
  );
}

function workspaceUsageRow(label: Child, amounts: WorkspaceUsageAmounts): HTMLElement {
  return h(
    "tr",
    null,
    h("td", null, label),
    h("td", { class: "num mono" }, usageAmount(amounts.usedMicros)),
    h("td", { class: "num mono" }, usageAmount(amounts.heldMicros)),
    h("td", { class: "num mono" }, usageAmount(amounts.pendingMicros)),
  );
}

function usageAmount(micros: string): string {
  return micros === "0" ? "—" : formatMicrosCurrency(micros, "USD", uiLocale());
}

function ledgerTable(entries: readonly LedgerEntry[], currency: string): Child {
  return h(
    "table",
    null,
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, tr("種類", "Type")),
        h("th", null, tr("参照", "Reference")),
        h("th", { class: "num" }, tr("確定", "Settled")),
        h("th", { class: "num" }, tr("確保", "Held")),
        h("th", null, tr("日時", "When")),
      ),
    ),
    h(
      "tbody",
      null,
      ...entries.map((entry) =>
        h(
          "tr",
          null,
          h("td", null, badge(entryTypeLabel(entry.type), tone(entry.type))),
          h("td", null, copyable(entry.reference)),
          h("td", { class: "num mono" }, delta(entry.settledDeltaMicros, currency)),
          h("td", { class: "num mono" }, delta(entry.heldDeltaMicros, currency)),
          h("td", { class: "dim" }, when(entry.createdAt)),
        ),
      ),
    ),
  );
}

function entryTypeLabel(type: string): string {
  const japanese: Readonly<Record<string, string>> = {
    funding: "入金",
    hold: "確保",
    capture: "請求確定",
    release: "確保解除",
    usage_debit: "使用量請求",
  };
  return tr(japanese[type] ?? type, type);
}

function tone(type: string): "ok" | "warn" | "bad" | "accent" | "idle" {
  if (type === "funding") return "ok";
  if (type === "hold") return "warn";
  if (type === "capture") return "accent";
  if (type === "release") return "idle";
  return "bad";
}

/** A zero shows as an em dash: the eye should land on the entries that moved. */
function delta(micros: string, currency: string): string {
  if (micros === "0") return "—";
  const negative = micros.startsWith("-");
  const magnitude = negative ? micros.slice(1) : micros;
  return (negative ? "−" : "+") + formatMicrosCurrency(magnitude, currency, uiLocale());
}

function uiLocale(): "en-US" | "ja-JP" {
  return consoleLocale() === "ja" ? "ja-JP" : "en-US";
}

/**
 * Adding money.
 *
 * A card where this deployment can take one, and the operator's signed proof
 * where it cannot — decided by asking, because a console that offers a payment
 * the server will refuse is worse than one that offers nothing.
 *
 * Either way the customer never states an amount that reaches the ledger. With
 * a card they choose what to pay and Stripe is asked what was collected; with a
 * proof the amount is inside the proof. The number typed here is a request, not
 * a credit.
 */
function addFunds(organizationId: string, reload: () => void): void {
  const amount = h("input", { class: "input", type: "number", value: "50", min: "5", step: "5" });
  const busy = signal(false);

  const close = openModal({
    title: tr("残高を追加", "Add funds"),
    confirmLabel: tr("支払いへ進む", "Continue to payment"),
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h(
        "div",
        { class: "field" },
        h("label", null, tr("金額（USD）", "Amount (USD)")),
        amount,
        h(
          "small",
          null,
          tr(
            "一度だけ決済します。支払い確定後に残高へ反映されます。",
            "Charged once. The balance is credited when the payment settles.",
          ),
        ),
      ),
      live(() =>
        busy()
          ? h("div", { class: "dim" }, tr("支払い画面を開いています…", "Opening Stripe…"))
          : h("div"),
      ),
    ),
    onConfirm: async () => {
      const dollars = Number(amount.value);
      if (!Number.isFinite(dollars) || dollars < 5) {
        toast(tr("5ドル以上の金額を入力してください", "Enter an amount of at least $5"), "bad");
        return;
      }
      busy.set(true);
      try {
        const started = await api.beginCheckout(organizationId, Math.round(dollars * 100));
        window.location.assign(started.checkout.url);
      } catch (error) {
        busy.set(false);
        const failure = error as { code?: string };
        if (failure.code === "not_found") {
          // This deployment takes no card. Offer the way it does take money.
          close();
          operatorFunding(organizationId, reload);
          return;
        }
        toast(explain(error as Error), "bad");
      }
    },
  });
}

/** Current bounds for a new hosted top-up, from the Host-authored plan table. */
function topUpBounds(
  table: HostedPlanTable,
): { readonly minimumMinor: number; readonly maximumMinor: number } | null {
  for (const plan of table.plans)
    if (plan.tier === "usage")
      return { minimumMinor: plan.checkoutMinimumMinor, maximumMinor: plan.checkoutMaximumMinor };
  return null;
}

function money(amountMinor: number): string {
  return formatMicrosCurrency((BigInt(amountMinor) * 10_000n).toString(), "USD", uiLocale());
}

/**
 * Adding money on a hosted Host.
 *
 * Each payment is one durable reference held in this browser until the server
 * reports it paid or expired, so a retry, a cancelled Checkout or a lost
 * response resumes the same payment instead of starting a second one. A
 * different amount is not sent while an earlier payment is unresolved.
 */
function hostedAddFunds(
  topUp: ReturnType<typeof createTopUpCheckoutController>,
  bounds: { readonly minimumMinor: number; readonly maximumMinor: number } | null,
): void {
  const state = topUp.state();
  const pending =
    state.status === "unresolved" || state.status === "amount_conflict" ? state.amountMinor : null;
  const amount = h("input", {
    class: "input",
    type: "number",
    value: String(pending === null ? 50 : pending / 100),
    min: String((bounds?.minimumMinor ?? 500) / 100),
    step: "1",
  });

  openModal({
    title: tr("残高を追加", "Add funds"),
    confirmLabel: tr("支払いへ進む", "Continue to payment"),
    confirmBlocked: () => ["busy", "redirecting"].includes(topUp.state().status),
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h(
        "div",
        { class: "field" },
        h("label", null, tr("金額（USD）", "Amount (USD)")),
        amount,
        h(
          "small",
          null,
          bounds
            ? tr(
                `${money(bounds.minimumMinor)}〜${money(bounds.maximumMinor)}。一度だけ決済し、支払い確定後に残高へ反映されます。`,
                `${money(bounds.minimumMinor)}–${money(bounds.maximumMinor)}. Charged once; the balance is credited when the payment settles.`,
              )
            : tr(
                "一度だけ決済します。支払い確定後に残高へ反映されます。",
                "Charged once. The balance is credited when the payment settles.",
              ),
        ),
      ),
      live(() => {
        const current = topUp.state();
        if (current.status === "amount_conflict" || current.status === "unresolved")
          return h(
            "div",
            { class: "notice notice--warn", role: "status" },
            icon(ICON.alert, 15),
            h(
              "div",
              { style: { display: "grid", gap: "8px", justifyItems: "start" } },
              h(
                "span",
                null,
                tr(
                  `前回の支払い（${money(current.amountMinor)}）が完了していません。別の金額にする前に、前回の支払いを再開してください。`,
                  `An earlier payment of ${money(current.amountMinor)} is not finished. Resume it before choosing a different amount.`,
                ),
              ),
              h(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onClick: () => void topUp.start(current.amountMinor),
                },
                tr(
                  `前回の支払い（${money(current.amountMinor)}）を再開`,
                  `Resume the ${money(current.amountMinor)} payment`,
                ),
              ),
            ),
          );
        return topUpMessage(current);
      }),
    ),
    onConfirm: async () => {
      const dollars = Number(amount.value);
      const amountMinor = Math.round(dollars * 100);
      const minimumMinor = bounds?.minimumMinor ?? 500;
      if (
        !Number.isFinite(dollars) ||
        amountMinor < minimumMinor ||
        (bounds !== null && amountMinor > bounds.maximumMinor)
      ) {
        toast(
          bounds
            ? tr(
                `${money(bounds.minimumMinor)}〜${money(bounds.maximumMinor)}の金額を入力してください`,
                `Enter an amount from ${money(bounds.minimumMinor)} to ${money(bounds.maximumMinor)}`,
              )
            : tr("5ドル以上の金額を入力してください", "Enter an amount of at least $5"),
          "bad",
        );
        return;
      }
      await topUp.start(amountMinor);
    },
  });
}

/** What the page says about a hosted top-up outside the modal: returns and resumes. */
function topUpStatus(topUp: ReturnType<typeof createTopUpCheckoutController>): HTMLElement | null {
  const state = topUp.state();
  if (state.status === "ready")
    return h(
      "div",
      { class: "notice", role: "status", "aria-live": "polite" },
      icon(ICON.alert, 15),
      h(
        "div",
        { style: { display: "grid", gap: "8px", justifyItems: "start" } },
        h(
          "span",
          null,
          tr(
            "支払いはまだ完了していません。同じ支払い画面で続けられます。",
            "The payment is not finished yet. You can continue on the same Checkout.",
          ),
        ),
        h(
          "button",
          { class: "btn", type: "button", onClick: () => topUp.continueCheckout() },
          tr("支払いを続ける", "Continue payment"),
        ),
      ),
    );
  if (state.status === "unresolved")
    return h(
      "p",
      { class: "notice", role: "status" },
      tr(
        `前回の支払い（${money(state.amountMinor)}）が完了していません。「残高を追加」から再開できます。`,
        `An earlier payment of ${money(state.amountMinor)} is not finished. Resume it from Add funds.`,
      ),
    );
  return topUpMessage(state);
}

function topUpMessage(state: TopUpCheckoutState): HTMLElement | null {
  const messages: Readonly<Record<string, readonly [string, string, "status" | "alert"]>> = {
    busy: ["支払いを確認しています…", "Checking the payment…", "status"],
    redirecting: ["支払い画面を開いています…", "Opening Stripe…", "status"],
    pending: [
      "支払いを処理しています。確定すると残高に反映されます。",
      "The payment is processing. The balance is credited once it settles.",
      "status",
    ],
    paid: [
      "支払いを受け付けました。残高に反映されます。",
      "Payment received. The balance is being credited.",
      "status",
    ],
    expired: [
      "前回の支払いは期限切れになりました。請求はありません。新しく支払いを始められます。",
      "The earlier payment expired. Nothing was charged. You can start a new payment.",
      "status",
    ],
    cancelled: [
      "支払いをキャンセルしました。請求はありません。同じ金額でいつでも再開できます。",
      "Payment cancelled. Nothing was charged. You can resume it with the same amount.",
      "status",
    ],
    conflict: [
      "別の支払いが処理中です。完了してから再試行してください。",
      "Another payment is still in progress. Try again once it finishes.",
      "alert",
    ],
    rejected: [
      "この金額では支払いを開始できませんでした。請求はありません。金額を変えて再度お試しください。",
      "This payment could not be started for that amount. Nothing was charged. Try another amount.",
      "alert",
    ],
    unavailable: [
      "この環境ではカード決済を利用できません。",
      "This deployment does not take card payments.",
      "alert",
    ],
    uncertain: [
      "支払いの状態を確認できませんでした。同じ支払いのまま再試行できます。",
      "The payment status could not be confirmed. Retrying keeps the same payment.",
      "alert",
    ],
    missing_intent: [
      "戻ってきた支払いをこのブラウザの記録と結び付けられません。残高と履歴を確認してください。",
      "This return does not match a payment saved in this browser. Check the balance and ledger.",
      "alert",
    ],
    error: [
      "支払いの記録をこのブラウザに保存できないため、送信していません。",
      "The payment could not be saved in this browser, so nothing was sent.",
      "alert",
    ],
  };
  const message = messages[state.status];
  return message
    ? h(
        "p",
        {
          class: message[2] === "alert" ? "notice notice--bad" : "notice",
          role: message[2],
          "aria-live": "polite",
        },
        tr(message[0], message[1]),
      )
    : null;
}

/**
 * The operator's signed proof.
 *
 * The customer never states how much arrived — only the verifier does — so this
 * asks for the proof and nothing else. A field for the amount would imply an
 * authority the caller does not have.
 */
function operatorFunding(organizationId: string, reload: () => void): void {
  const input = h("textarea", {
    class: "textarea",
    placeholder: tr(
      "この組織に発行された入金証明を貼り付けてください",
      "Paste the settlement proof issued for this organization",
    ),
  });

  const close = openModal({
    title: tr("残高を追加", "Add funds"),
    confirmLabel: tr("残高へ反映", "Credit wallet"),
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h(
        "div",
        { class: "notice" },
        icon(ICON.alert, 15),
        h(
          "div",
          null,
          tr(
            "この環境ではカード決済を利用できません。金額は入金証明から取得し、同じ証明を複数回提示しても一度だけ反映します。",
            "This deployment does not take card payments. The amount comes from the proof, not from you, and presenting the same proof twice credits once.",
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, tr("入金証明", "Settlement proof")),
        input,
        h(
          "small",
          null,
          tr(
            "運営者がこの組織に対して発行した証明です。",
            "Issued by the operator against this organization.",
          ),
        ),
      ),
    ),
    onConfirm: async () => {
      const proof = input.value.trim();
      if (proof === "") {
        toast(tr("入金証明を貼り付けてください", "Paste a settlement proof first"), "bad");
        return;
      }
      try {
        await api.fund(organizationId, proof);
        toast(tr("残高へ反映しました", "Wallet credited"), "ok");
        reload();
        close();
      } catch (error) {
        toast(explain(error as Error), "bad");
      }
    },
  });
}

/**
 * Finishing a payment the person has just come back from.
 *
 * The session id arrives in the URL and is exchanged once, then removed from
 * the address bar so a reload does not try again — the ledger would refuse the
 * second attempt anyway, but a person should not be shown an error for
 * pressing refresh.
 */
function settleReturn(organizationId: string, reload: () => void): void {
  const parameters = new URLSearchParams(window.location.search);
  const checkout = parameters.get("checkout");
  if (!checkout) return;
  parameters.delete("checkout");
  const query = parameters.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );

  if (checkout === "cancelled") {
    toast(
      tr(
        "支払いをキャンセルしました。請求はありません。",
        "Payment cancelled. Nothing was charged.",
      ),
      "plain",
    );
    return;
  }
  api.fund(organizationId, checkout).then(
    () => {
      toast(tr("支払いを受け付けました", "Payment received"), "ok");
      reload();
    },
    (error: unknown) => toast(explain(error as Error), "bad"),
  );
}

function hostedSubscriptionCard(
  subscription: Resource<OrganizationSubscription>,
  checkout: ReturnType<typeof createSubscriptionCheckoutController>,
  ownerCanManage: () => boolean,
  cancellationFor: (
    subscriptionRef: string,
  ) => ReturnType<typeof createSubscriptionCancellationController>,
): HTMLElement {
  return card(
    tr("サブスクリプション", "Subscription"),
    live(() => {
      const checkoutState = checkout.state();
      return whenReady(
        subscription.get(),
        (loaded) => {
          const configuredPlans = subscriptionPlanOptions(
            loaded.planTable,
            consoleLocale() === "ja" ? "ja-JP" : "en-US",
          );
          const current = loaded.subscription;
          const owner = ownerCanManage();
          const cancelController =
            owner && current ? cancellationFor(current.subscriptionRef) : null;
          const cancellationState = cancelController?.state();
          const body = h(
            "div",
            { class: "card__body billing-plan__content" },
            current
              ? subscriptionProjectionView(current)
              : h(
                  "div",
                  { class: "billing-plan__summary" },
                  h(
                    "div",
                    { class: "billing-plan__name" },
                    tr("サブスクリプションなし", "No subscription reported"),
                  ),
                  configuredPlans.length > 0
                    ? configuredPlans.map((plan) =>
                        h(
                          "p",
                          { class: "dim billing-plan__coverage" },
                          tr(
                            `設定済みプラン ${plan.planId} · 月額 ${plan.monthlyAmount} · 月間枠 ${plan.monthlyAllowance}`,
                            `Configured plan ${plan.planId} · ${plan.monthlyAmount} per month · ${plan.monthlyAllowance} monthly allowance`,
                          ),
                        ),
                      )
                    : h(
                        "p",
                        { class: "dim" },
                        tr(
                          "購入可能なサブスクリプションプランはありません。",
                          "No subscription plan is configured for purchase.",
                        ),
                      ),
                ),
            current ? cancellationMessage(current, cancellationState) : null,
            !current || isTerminalSubscription(current)
              ? checkoutMessage(checkoutState.status)
              : null,
            owner
              ? h(
                  "div",
                  { class: "toolbar billing-plan__actions" },
                  current && !isTerminalSubscription(current)
                    ? cancellationAction(current, cancelController, cancellationState?.status)
                    : configuredPlans.map((plan) =>
                        checkoutAction(
                          checkout,
                          checkoutState.status,
                          plan.planId,
                          current?.subscriptionRef,
                        ),
                      ),
                  h(
                    "button",
                    {
                      class: "btn billing-plan__action",
                      type: "button",
                      onClick: () => subscription.reload(),
                    },
                    tr("状態を更新", "Refresh status"),
                  ),
                )
              : h(
                  "small",
                  { class: "dim" },
                  tr(
                    "サブスクリプションの購入と管理は組織オーナーが行えます。",
                    "Only the Organization owner can purchase or manage a subscription.",
                  ),
                ),
          );
          return body;
        },
        {
          retry: subscription.reload,
        },
      );
    }),
  );
}

function subscriptionProjectionView(subscription: HostedSubscriptionProjection): HTMLElement {
  return h(
    "div",
    { class: "billing-plan__summary" },
    h(
      "div",
      { class: "billing-plan__heading" },
      h("div", { class: "billing-plan__name" }, subscription.planKey),
      badge(
        subscription.paidFeatures
          ? tr("有料機能を確認済み", "Paid features verified")
          : tr("有料機能は有効ではありません", "Paid features not enabled"),
        subscription.paidFeatures ? "ok" : "warn",
      ),
    ),
    h(
      "p",
      { class: "dim billing-plan__coverage", role: "status" },
      tr(
        `状態：${subscriptionStatusLabel(subscription.status)}。`,
        `Status: ${subscriptionStatusLabel(subscription.status)}.`,
      ),
    ),
    subscription.paidThrough
      ? h(
          "p",
          { class: "dim billing-plan__coverage" },
          tr(
            `確認済みの利用期限：${when(subscription.paidThrough)}`,
            `Verified paid-through: ${when(subscription.paidThrough)}`,
          ),
        )
      : null,
  );
}

function checkoutAction(
  checkout: ReturnType<typeof createSubscriptionCheckoutController>,
  status: string,
  planKey: string,
  terminalSubscriptionRef?: string,
): HTMLElement | null {
  const terminalRepurchase = terminalSubscriptionRef !== undefined;
  if (!terminalRepurchase && (status === "associated" || status === "missing_intent")) return null;
  const expired = status === "expired";
  const disabled = ["busy", "redirecting", "intent_conflict"].includes(status);
  return h(
    "button",
    {
      class: "btn btn--primary billing-plan__action",
      type: "button",
      disabled,
      onClick: () =>
        terminalRepurchase
          ? void checkout.startNewPurchase(planKey, terminalSubscriptionRef)
          : expired
            ? void checkout.startNewPurchase(planKey)
            : void checkout.start(planKey),
    },
    terminalRepurchase || expired
      ? tr(`${planKey} の新しいCheckoutを開始`, `Start a new ${planKey} Checkout`)
      : status === "pending" || status === "uncertain" || status === "cancelled"
        ? tr(`${planKey} のCheckoutを再確認`, `Retry ${planKey} Checkout`)
        : tr(`${planKey} を開始`, `Begin ${planKey} subscription`),
  );
}

function cancellationAction(
  subscription: HostedSubscriptionProjection,
  controller: ReturnType<typeof createSubscriptionCancellationController> | null,
  status: string | undefined,
): HTMLElement | null {
  if (
    !controller ||
    subscription.cancelAtPeriodEnd ||
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  )
    return null;
  if (status === "verified") return null;
  return h(
    "button",
    {
      class: "btn billing-plan__action",
      type: "button",
      disabled: status === "busy",
      onClick: () => void controller.cancel(),
    },
    status === "pending" || status === "uncertain" || status === "target_mismatch"
      ? tr("解約状態を再確認", "Retry cancellation status")
      : tr("期間終了時に解約", "Schedule period-end cancellation"),
  );
}

function checkoutMessage(status: string): HTMLElement | null {
  const messages: Readonly<Record<string, readonly [string, string, "status" | "alert"]>> = {
    busy: ["Checkoutを確認しています…", "Checking Checkout…", "status"],
    redirecting: ["Stripe Checkoutを開いています…", "Opening Stripe Checkout…", "status"],
    pending: [
      "結果はまだ確定していません。同じ参照で再試行できます。",
      "The result is not confirmed yet. Retry uses the same reference.",
      "status",
    ],
    uncertain: [
      "応答を確認できません。参照を保持して再試行できます。",
      "The response could not be confirmed. The reference is retained for retry.",
      "alert",
    ],
    associated: [
      "Checkoutの関連付けを確認しました。利用権とクレジットは上のサーバー表示で確認してください。",
      "Checkout association is confirmed. Entitlement and credits come only from the server projection above.",
      "status",
    ],
    cancelled: [
      "Checkout画面から戻りました。参照を保持し、再試行では同じ要求を使います。",
      "Checkout returned without completion. Its reference is retained and reused on retry.",
      "status",
    ],
    expired: [
      "サーバーが前のCheckoutの期限切れを確認しました。新しい購入は明示的に選択してください。",
      "The server confirmed the prior Checkout expired. Choose explicitly before starting a new purchase.",
      "status",
    ],
    intent_conflict: [
      "保存済みの要求が現在のプランと一致しません。上書きせず状態を確認してください。",
      "The saved request differs from this configured plan. It was not overwritten; refresh and resolve the existing request.",
      "alert",
    ],
    error: [
      "安全な要求参照を保存できませんでした。Checkoutは送信していません。",
      "A safe request reference could not be stored. Checkout was not sent.",
      "alert",
    ],
    missing_intent: [
      "戻り先を保存済みの要求に結び付けられません。安全のため新しい要求は作成していません。",
      "This return could not be matched to a saved request. No new checkout reference was created.",
      "alert",
    ],
    target_mismatch: [
      "購入対象のサブスクリプション状態が変わりました。参照は保持しました。状態を更新してから再試行してください。",
      "The subscription target changed. The saved reference was retained; refresh status before trying again.",
      "alert",
    ],
  };
  const message = messages[status];
  return message
    ? h(
        "p",
        {
          class: message[2] === "alert" ? "notice notice--bad" : "notice",
          role: message[2],
          "aria-live": "polite",
        },
        tr(message[0], message[1]),
      )
    : null;
}

function cancellationMessage(
  subscription: HostedSubscriptionProjection,
  state: SubscriptionCancellationState | undefined,
): HTMLElement | null {
  if (subscription.cancelAtPeriodEnd)
    return h(
      "p",
      { class: "notice", role: "status" },
      tr(
        `サーバー表示では期間終了時の解約が設定されています（期間終了：${when(subscription.periodEnd)}）。返金やクレジット取消を意味しません。`,
        `The server projection reports period-end cancellation (period ends ${when(subscription.periodEnd)}). This does not imply a refund or credit reversal.`,
      ),
    );
  if (!state) return null;
  if (state.status === "verified")
    return h(
      "p",
      { class: "notice", role: "status", "aria-live": "polite" },
      tr(
        `期間終了時の解約を確認しました（${when(state.effectiveAt)}）。返金やクレジット取消を意味しません。`,
        `Period-end cancellation is verified for ${when(state.effectiveAt)}. This does not imply a refund or credit reversal.`,
      ),
    );
  if (state.status === "pending" || state.status === "uncertain")
    return h(
      "p",
      {
        class: "notice",
        role: state.status === "uncertain" ? "alert" : "status",
        "aria-live": "polite",
      },
      tr(
        "解約要求の結果は未確認です。確定日はまだありません。再試行では同じ参照を使用します。",
        "The cancellation request is not confirmed. No effective date is confirmed; retry uses the same reference.",
      ),
    );
  if (state.status === "target_mismatch")
    return h(
      "p",
      { class: "notice notice--bad", role: "alert", "aria-live": "polite" },
      tr(
        "要求の対象が変わりました。保存済み参照を保持し、現在の状態を再確認してください。",
        "The target changed. The saved reference is retained; refresh the current status before retrying.",
      ),
    );
  if (state.status === "error" || state.status === "intent_conflict")
    return h(
      "p",
      { class: "notice notice--bad", role: "alert", "aria-live": "polite" },
      tr(
        "安全な解約要求を準備できませんでした。",
        "A safe cancellation request could not be prepared.",
      ),
    );
  return null;
}

function subscriptionStatusLabel(status: HostedSubscriptionProjection["status"]): string {
  const labels: Readonly<
    Record<HostedSubscriptionProjection["status"], readonly [string, string]>
  > = {
    incomplete: ["未完了", "incomplete"],
    incomplete_expired: ["期限切れ", "incomplete expired"],
    trialing: ["試用中", "trialing"],
    active: ["有効", "active"],
    past_due: ["支払い遅延", "past due"],
    canceled: ["解約済み", "canceled"],
    unpaid: ["未払い", "unpaid"],
    paused: ["一時停止", "paused"],
  };
  const label = labels[status];
  return tr(label[0], label[1]);
}

function isTerminalSubscription(subscription: HostedSubscriptionProjection): boolean {
  return subscription.status === "canceled" || subscription.status === "incomplete_expired";
}
