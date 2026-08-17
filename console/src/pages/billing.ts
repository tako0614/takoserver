import type { LedgerEntry } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { resource } from "../reactive.ts";
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

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, "Billing"),
        h(
          "p",
          null,
          "Takoserver is prepaid. Work places a hold against the available balance and captures it when it succeeds; if it fails, the hold is released and nothing is charged.",
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
        text("Add funds"),
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
              stat("Available", money(held.availableMinor, held.currency), "settled − held"),
              stat("Held", money(held.heldMinor, held.currency), "reserved against live work"),
              stat("Settled", money(held.settledMinor, held.currency), "funded and captured"),
            ),
            card(
              "Ledger",
              held.entries.length === 0
                ? empty(
                    "No entries",
                    "Nothing has been funded or charged on this organization yet.",
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
        h("th", null, "Type"),
        h("th", null, "Reference"),
        h("th", { class: "num" }, "Settled"),
        h("th", { class: "num" }, "Held"),
        h("th", null, "When"),
      ),
    ),
    h(
      "tbody",
      null,
      ...entries.map((entry) =>
        h(
          "tr",
          null,
          h("td", null, badge(entry.type, tone(entry.type))),
          h("td", null, copyable(entry.reference)),
          h("td", { class: "num mono" }, delta(entry.settledDeltaMinor, currency)),
          h("td", { class: "num mono" }, delta(entry.heldDeltaMinor, currency)),
          h("td", { class: "dim" }, when(entry.createdAt)),
        ),
      ),
    ),
  );
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
 * Funding takes a settlement proof, not an amount.
 *
 * The customer never states how much arrived — only the settlement verifier
 * does — so this dialog asks for the proof and nothing else. A field for the
 * amount would imply an authority the caller does not have.
 */
function addFunds(organizationId: string, reload: () => void): void {
  const input = h("textarea", {
    class: "textarea",
    placeholder: "Paste the settlement proof issued for this organization",
  });

  const close = openModal({
    title: "Add funds",
    confirmLabel: "Credit wallet",
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
          "The amount comes from the proof, not from you. Presenting the same proof twice credits once.",
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, "Settlement proof"),
        input,
        h("small", null, "Issued by the operator against this organization."),
      ),
    ),
    onConfirm: async () => {
      const proof = input.value.trim();
      if (proof === "") {
        toast("Paste a settlement proof first", "bad");
        return;
      }
      try {
        await api.fund(organizationId, proof);
        toast("Wallet credited", "ok");
        reload();
        close();
      } catch (error) {
        toast(explain(error as Error), "bad");
      }
    },
  });
}
