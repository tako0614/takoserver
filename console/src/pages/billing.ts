import type { LedgerEntry } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { resource, signal } from "../reactive.ts";
import { api } from "../state.ts";
import {
  badge,
  card,
  copyable,
  empty,
  explain,
  ICON,
  icon,
  money,
  openModal,
  stat,
  toast,
  when,
  whenReady,
} from "../ui.ts";

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
  // A payment that just completed comes back through the URL. It is settled
  // before anything renders, so the balance a person sees already includes
  // what they just paid — otherwise the first thing the console does after
  // taking money is show the old number.
  settleReturn(organizationId, wallet.reload);

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
          onClick: () => addFunds(organizationId, wallet.reload),
        },
        icon(ICON.plus, 14),
        text(tr("残高を追加", "Add funds")),
      ),
    ),
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
                money(held.availableMinor, held.currency),
                tr("確定残高 − 確保中", "settled − held"),
              ),
              stat(
                tr("確保中", "Held"),
                money(held.heldMinor, held.currency),
                tr("処理中の操作に予約済み", "reserved against live work"),
              ),
              stat(
                tr("確定残高", "Settled"),
                money(held.settledMinor, held.currency),
                tr("入金と確定済み請求", "funded and captured"),
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
        { retry: wallet.reload },
      ),
    ),
  );
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
          h("td", { class: "num mono" }, delta(entry.settledDeltaMinor, currency)),
          h("td", { class: "num mono" }, delta(entry.heldDeltaMinor, currency)),
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
function delta(minor: number, currency: string): string {
  if (minor === 0) return "—";
  return `${minor > 0 ? "+" : "−"}${money(Math.abs(minor), currency)}`;
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
  window.history.replaceState({}, "", window.location.pathname);

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
