import type {
  HostedBillingContinuation,
  HostedBillingContinuationPayment,
  HostedBillingContinuationPreparation,
  HostedPlanChangeResult,
  SubscriptionCancellationReceipt,
  SubscriptionCheckoutStart,
  TopUpCheckoutStart,
} from "../api.ts";
import { formatMicrosCurrency } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { consoleLocale, tr } from "../i18n.ts";
import { resource, signal } from "../reactive.ts";
import { api } from "../state.ts";
import { subscriptionPlanOptions } from "../subscription-plan-options.ts";
import { card, empty, explain } from "../ui.ts";

type EffectResult =
  | { readonly kind: "topup"; readonly value: TopUpCheckoutStart }
  | { readonly kind: "subscription-start"; readonly value: SubscriptionCheckoutStart }
  | { readonly kind: "cancel"; readonly value: SubscriptionCancellationReceipt }
  | { readonly kind: "plan-change"; readonly value: HostedPlanChangeResult };

type AttemptState =
  | { readonly kind: "prior" }
  | { readonly kind: "storage-error" }
  | { readonly kind: "sending" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "received"; readonly result: EffectResult };

type PrepareState =
  | { readonly kind: "sending" }
  | { readonly kind: "unknown"; readonly message: string }
  | { readonly kind: "storage-error" };

interface SelectionReads {
  readonly organizationId: string;
  readonly resource: ReturnType<typeof loadSelectionReads>;
}

const HEX_SELECTOR = /^[0-9a-f]{64}$/u;

function attemptKey(selector: string): string {
  return `takoserver.hosted-continuation-attempt:${selector}`;
}

function prepareKey(selector: string): string {
  return `takoserver.hosted-continuation-prepare:${selector}`;
}

function priorPreparation(selector: string): "attempted" | "storage-error" | null {
  try {
    return sessionStorage.getItem(prepareKey(selector)) === null ? null : "attempted";
  } catch {
    return "storage-error";
  }
}

function reservePreparation(selector: string): boolean {
  try {
    const key = prepareKey(selector);
    if (sessionStorage.getItem(key) !== null) return false;
    sessionStorage.setItem(key, "attempted");
    return sessionStorage.getItem(key) === "attempted";
  } catch {
    return false;
  }
}

function loadSelectionReads(organizationId: string) {
  return resource(async () => {
    const [subscription, wallet] = await Promise.all([
      api.hostedBillingSelectionSubscription(organizationId),
      api.hostedBillingSelectionWallet(organizationId),
    ]);
    if (wallet.wallet.organizationId !== organizationId || wallet.wallet.currency !== "USD")
      throw new Error("Selected organization wallet is unavailable.");
    return { subscription, wallet: wallet.wallet };
  });
}

function usdFromMinorUnits(amountMinor: number, locale: "en-US" | "ja-JP"): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    throw new TypeError("invalid USD minor-unit amount");
  const cents = BigInt(amountMinor);
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return formatter
    .formatToParts(Number(whole))
    .map((part) => (part.type === "fraction" ? fraction : part.value))
    .join("");
}

function usdDecimalFromMinorUnits(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    throw new TypeError("invalid USD minor-unit amount");
  const cents = BigInt(amountMinor);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function usdInputToMinorUnits(value: string): number | null {
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/u.exec(value);
  if (!match || match[0] !== value || match[1] === undefined || match[1].length > 16) return null;
  const amountMinor = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return amountMinor > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(amountMinor);
}

function hasPriorAttempt(selector: string): boolean | null {
  try {
    return sessionStorage.getItem(attemptKey(selector)) === "attempted";
  } catch {
    return null;
  }
}

function reserveAttempt(selector: string): boolean {
  try {
    const key = attemptKey(selector);
    if (sessionStorage.getItem(key) !== null) return false;
    sessionStorage.setItem(key, "attempted");
    return sessionStorage.getItem(key) === "attempted";
  } catch {
    return false;
  }
}

/** A separate, read-only-first view of the exact Workspace-selected original. */
export function hostedBillingContinuationPage(selector: string): Child {
  if (selector.length !== 64 || HEX_SELECTOR.exec(selector)?.[0] !== selector) {
    return card(
      null,
      empty(
        tr("続行情報が無効です", "Invalid continuation"),
        tr("このリンクから続行できません。", "This continuation link is invalid."),
      ),
    );
  }

  const continuation = resource(() => api.hostedBillingContinuation(selector));
  const prior = hasPriorAttempt(selector);
  const attempt = signal<AttemptState | null>(
    prior === true ? { kind: "prior" } : prior === null ? { kind: "storage-error" } : null,
  );
  const preparationPrior = priorPreparation(selector);
  const preparation = signal<PrepareState | null>(
    preparationPrior === "attempted"
      ? { kind: "unknown", message: "A prior prepare attempt is unresolved" }
      : preparationPrior === "storage-error"
        ? { kind: "storage-error" }
        : null,
  );
  const prepared = signal<HostedBillingContinuationPayment | null>(null);
  let selectionReads: SelectionReads | null = null;

  const prepare = async (choice: HostedBillingContinuationPreparation): Promise<void> => {
    if (preparation() !== null || prepared() !== null) return;
    if (!reservePreparation(selector)) {
      preparation.set({ kind: "storage-error" });
      return;
    }
    preparation.set({ kind: "sending" });
    try {
      const result = await api.prepareHostedBillingContinuation(selector, choice);
      prepared.set(result);
      preparation.set(null);
    } catch (error) {
      // The prepare may have committed before its response was lost. Keep the
      // selector-specific marker and reconcile by GET only; never POST again.
      preparation.set({ kind: "unknown", message: explain(error as Error) });
      continuation.reload();
    }
  };

  const confirm = async (payment: HostedBillingContinuationPayment): Promise<void> => {
    if (payment.phase !== "prepared" || attempt() !== null) return;
    if (!reserveAttempt(selector)) {
      attempt.set({ kind: "storage-error" });
      return;
    }
    attempt.set({ kind: "sending" });
    try {
      const result = await dispatch(payment);
      attempt.set({ kind: "received", result });
    } catch (error) {
      // The exact same metadata is read-only reconciliation. The one-shot
      // session marker deliberately remains set, so a lost ACK cannot resend.
      continuation.reload();
      attempt.set({ kind: "failed", message: explain(error as Error) });
    }
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
        h("h1", null, tr("選択した請求を確認", "Confirm selected billing")),
        h(
          "p",
          null,
          tr(
            "Hostedで選択されたWorkspaceと元の請求操作をサーバーから読み込みます。通常の組織選択や請求操作には置き換えません。",
            "This reads the Workspace and original billing operation selected in Hosted. It does not substitute the normal organization picker or a new billing action.",
          ),
        ),
      ),
    ),
    live(() => {
      const loaded = continuation.get();
      if (loaded.state === "loading")
        return card(null, text(tr("続行内容を確認しています…", "Loading continuation…")));
      if (loaded.state === "error")
        return card(
          null,
          empty(tr("続行内容を確認できません", "Continuation unavailable"), explain(loaded.error)),
        );
      const current = loaded.value.kind === "view" ? (prepared() ?? loaded.value) : loaded.value;
      if (
        current.kind === "view" &&
        (!selectionReads || selectionReads.organizationId !== current.organizationId)
      )
        selectionReads = {
          organizationId: current.organizationId,
          resource: loadSelectionReads(current.organizationId),
        };
      return renderContinuation(
        current,
        attempt(),
        (payment) => void confirm(payment),
        current.kind === "view" ? (selectionReads?.resource.get() ?? null) : null,
        preparation(),
        (choice) => void prepare(choice),
      );
    }),
  );
}

type SelectionReadState = ReturnType<ReturnType<typeof loadSelectionReads>["get"]>;

function renderContinuation(
  value: HostedBillingContinuation,
  attemptState: AttemptState | null,
  onConfirm: (payment: HostedBillingContinuationPayment) => void,
  selection: SelectionReadState | null,
  preparation: PrepareState | null,
  onPrepare: (choice: HostedBillingContinuationPreparation) => void,
): Child {
  const details = h(
    "dl",
    { class: "hosted-continuation__facts" },
    h("dt", null, tr("Workspace ID", "Workspace ID")),
    h("dd", { class: "mono" }, value.workspaceId),
    h("dt", null, tr("Workspace billing reference", "Workspace billing reference")),
    h("dd", { class: "mono" }, value.workspaceRef),
    h("dt", null, tr("Organization ID", "Organization ID")),
    h("dd", { class: "mono" }, value.organizationId),
  );

  if (value.kind === "view")
    return card(
      tr("選択したWorkspace", "Selected Workspace"),
      h(
        "div",
        { class: "card__body" },
        details,
        h(
          "p",
          null,
          tr(
            "この選択には支払い操作がありません。表示内容の取得だけを行いました。",
            "This selection has no payment operation. Only its view was read.",
          ),
        ),
        renderSelection(selection, preparation, onPrepare),
      ),
    );

  const operation = value.operation;
  const action = operation.action;
  const title = actionLabel(action);
  const actionDetails = operationDetails(operation, consoleLocale() === "ja" ? "ja-JP" : "en-US");
  const isPrepared = value.phase === "prepared";
  const canSend = isPrepared && attemptState === null;
  const confirmation = canSend
    ? h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          onClick: () => onConfirm(value),
        },
        tr("この操作を1回だけ実行", "Confirm this operation once"),
      )
    : null;

  return card(
    title,
    h(
      "div",
      { class: "card__body" },
      details,
      actionDetails,
      phaseMessage(value.phase, attemptState),
      attemptState ? attemptMessage(attemptState) : null,
      confirmation,
    ),
  );
}

function renderSelection(
  selection: SelectionReadState | null,
  preparation: PrepareState | null,
  onPrepare: (choice: HostedBillingContinuationPreparation) => void,
): Child {
  if (!selection || selection.state === "loading")
    return h(
      "p",
      { class: "hosted-continuation__state hosted-continuation__state--loading", role: "status" },
      tr(
        "選択した組織の請求情報を読み込んでいます…",
        "Loading billing facts for the selected organization…",
      ),
    );
  if (selection.state === "error")
    return h(
      "p",
      { class: "hosted-continuation__state hosted-continuation__state--error", role: "alert" },
      tr(
        "請求情報を確認できないため操作できません。",
        "Billing facts are unavailable; actions are disabled.",
      ),
      " ",
      explain(selection.error),
    );

  const { subscription, wallet } = selection.value;
  const capabilities = subscription.billingCapabilities;
  if (capabilities?.contractVersion !== "hosted-billing-v1")
    return h(
      "p",
      { class: "hosted-continuation__state hosted-continuation__state--error", role: "status" },
      tr(
        "この組織ではHosted請求操作を利用できません。",
        "Hosted billing actions are not available for this organization.",
      ),
    );

  const tiers = subscription.planTable.plans;
  const usage = tiers.find((plan) => plan.tier === "usage");
  const locale = consoleLocale() === "ja" ? "ja-JP" : "en-US";
  const plans = subscriptionPlanOptions(subscription.planTable, locale);
  const available = formatMicrosCurrency(wallet.availableMicros, wallet.currency, locale);
  const locked = preparation !== null;
  const preparationStatus = preparation ? renderPreparationState(preparation) : null;
  const actions: Child[] = [
    h(
      "p",
      { role: "status" },
      tr(`利用可能残高: ${available}`, `Available wallet balance: ${available}`),
    ),
  ];

  if (capabilities.topUps && usage) {
    const amount = h("input", {
      class: "input",
      type: "number",
      min: usdDecimalFromMinorUnits(usage.checkoutMinimumMinor),
      max: usdDecimalFromMinorUnits(usage.checkoutMaximumMinor),
      step: "0.01",
      required: true,
      value: usdDecimalFromMinorUnits(usage.checkoutMinimumMinor),
      id: "hosted-continuation-topup-amount",
      "aria-label": tr("金額（USD）", "Amount (USD)"),
    });
    const consent = consentControl(
      tr(
        "対話型Checkoutへ進むことに同意します。",
        "I consent to continue to interactive Checkout.",
      ),
    );
    actions.push(
      actionPanel(
        tr("ウォレットへチャージ", "Top up wallet"),
        h(
          "div",
          { class: "field" },
          h(
            "label",
            { for: "hosted-continuation-topup-amount" },
            tr("金額（USD）", "Amount (USD)"),
          ),
          amount,
          h(
            "small",
            null,
            tr(
              `設定範囲: ${usdFromMinorUnits(usage.checkoutMinimumMinor, locale)}〜${usdFromMinorUnits(usage.checkoutMaximumMinor, locale)} USD。`,
              `Configured range: ${usdFromMinorUnits(usage.checkoutMinimumMinor, locale)}–${usdFromMinorUnits(usage.checkoutMaximumMinor, locale)} USD.`,
            ),
          ),
        ),
        consent,
        tr(
          "対話型Checkoutへ進むことに同意します。",
          "I consent to continue to interactive Checkout.",
        ),
        tr("チャージを準備", "Prepare top-up"),
        locked,
        () => {
          const amountMinor = usdInputToMinorUnits(amount.value);
          if (
            amountMinor === null ||
            amountMinor < usage.checkoutMinimumMinor ||
            amountMinor > usage.checkoutMaximumMinor
          ) {
            amount.reportValidity();
            return;
          }
          onPrepare({ kind: "topup", amountMinor, checkoutConsent: "interactive-checkout" });
        },
      ),
    );
  }

  if (capabilities.subscriptionStart && subscription.subscription === null && plans.length > 0) {
    actions.push(
      planPanel(
        tr("サブスクリプションを開始", "Start subscription"),
        plans,
        locked,
        "subscription-checkout",
        "hosted-start-plan",
        tr("開始を準備", "Prepare subscription start"),
        (planKey) => onPrepare({ kind: "start", planKey, consent: "subscription-checkout" }),
      ),
    );
  }

  if (subscription.subscription && capabilities.subscriptionCancellation) {
    const consent = consentControl(
      tr(
        "現在のサブスクリプションを期間終了時に解約することに同意します。",
        "I consent to cancel the current subscription at the end of its period.",
      ),
    );
    actions.push(
      actionPanel(
        tr("サブスクリプションを解約", "Cancel subscription"),
        h(
          "p",
          null,
          tr(
            `現在のプラン: ${subscription.subscription.planKey}`,
            `Current plan: ${subscription.subscription.planKey}`,
          ),
        ),
        consent,
        tr(
          "現在のサブスクリプションを期間終了時に解約することに同意します。",
          "I consent to cancel the current subscription at the end of its period.",
        ),
        tr("解約を準備", "Prepare cancellation"),
        locked,
        () => onPrepare({ kind: "cancel", consent: "cancel-subscription" }),
      ),
    );
  }

  if (subscription.subscription && capabilities.subscriptionPlanChange && plans.length > 0) {
    actions.push(
      planPanel(
        tr("サブスクリプションのプランを変更", "Change subscription plan"),
        plans,
        locked,
        "change-subscription-plan",
        "hosted-change-plan",
        tr("プラン変更を準備", "Prepare plan change"),
        (planKey) =>
          onPrepare({ kind: "change-plan", planKey, consent: "change-subscription-plan" }),
      ),
    );
  }

  if (actions.length === 1)
    actions.push(
      h(
        "p",
        { role: "status" },
        tr("現在利用できる操作はありません。", "No billing action is currently available."),
      ),
    );
  return h(
    "section",
    {
      class: "hosted-continuation__actions",
      "aria-label": tr("請求操作の選択", "Choose a billing action"),
    },
    h("h2", null, tr("現在の請求情報から選択", "Choose from current billing facts")),
    ...actions,
    preparationStatus,
  );
}

function consentControl(label: string): HTMLInputElement {
  const checkbox = h("input", { type: "checkbox", "aria-label": label });
  return checkbox;
}

function actionPanel(
  title: string,
  fields: Child,
  consent: HTMLInputElement,
  consentLabel: string,
  buttonLabel: string,
  locked: boolean,
  prepare: () => void,
): Child {
  const button = h(
    "button",
    { class: "btn btn--primary", type: "button", disabled: locked, onClick: prepare },
    buttonLabel,
  );
  consent.addEventListener("change", () => {
    button.disabled = locked || !consent.checked;
  });
  button.disabled = locked || !consent.checked;
  return h(
    "article",
    { class: "hosted-continuation__action" },
    h("h3", null, title),
    fields,
    h("label", { class: "check" }, consent, text(" "), consentLabel),
    button,
  );
}

function planPanel(
  title: string,
  plans: ReturnType<typeof subscriptionPlanOptions>,
  locked: boolean,
  consentText: "subscription-checkout" | "change-subscription-plan",
  selectId: "hosted-start-plan" | "hosted-change-plan",
  buttonLabel: string,
  prepare: (planKey: string) => void,
): Child {
  const select = h(
    "select",
    { class: "select", id: selectId, "aria-label": title },
    ...plans.map((plan, index) =>
      h(
        "option",
        { value: plan.planId, selected: index === 0 },
        tr(
          `${plan.planId} — ${plan.monthlyAmount} / 月（${plan.monthlyAllowance}を含む）`,
          `${plan.planId} — ${plan.monthlyAmount} / month (${plan.monthlyAllowance} included)`,
        ),
      ),
    ),
  );
  select.value = plans[0]?.planId ?? "";
  const consentLabel =
    consentText === "subscription-checkout"
      ? tr(
          "サブスクリプションCheckoutへ進むことに同意します。",
          "I consent to continue to subscription Checkout.",
        )
      : tr(
          "現在のサブスクリプションを選択プランへ変更することに同意します。",
          "I consent to change the current subscription to the selected plan.",
        );
  const consent = consentControl(consentLabel);
  return actionPanel(
    title,
    h(
      "div",
      { class: "field" },
      h("label", { for: selectId }, tr("プランと月額料金（USD）", "Plan and monthly price (USD)")),
      select,
    ),
    consent,
    consentLabel,
    buttonLabel,
    locked,
    () => {
      const selected = plans.find((plan) => plan.planId === select.value);
      if (selected) prepare(selected.planId);
    },
  );
}

function renderPreparationState(state: PrepareState): Child {
  if (state.kind === "sending")
    return h(
      "p",
      { class: "hosted-continuation__state hosted-continuation__state--loading", role: "status" },
      tr("選択内容をサーバーへ送信しています…", "Sending this selection to the server…"),
    );
  if (state.kind === "storage-error")
    return h(
      "p",
      { class: "hosted-continuation__state hosted-continuation__state--error", role: "alert" },
      tr(
        "選択状態を安全に確認できないため、このページから再送しません。",
        "The prepare state could not be verified safely; this page will not retry.",
      ),
    );
  return h(
    "p",
    { class: "hosted-continuation__state hosted-continuation__state--error", role: "alert" },
    tr(
      `準備結果を確認できません: ${state.message}。同じ選択を読み直しています。自動再送はしません。`,
      `The prepare result is unknown: ${state.message}. The same selection is being reread; no automatic resend will occur.`,
    ),
  );
}

function actionLabel(action: HostedBillingContinuationPayment["operation"]["action"]): string {
  switch (action) {
    case "topup":
      return tr("ウォレットへのチャージ", "Wallet top-up");
    case "subscription-start":
      return tr("サブスクリプション開始", "Start subscription");
    case "cancel":
      return tr("サブスクリプション解約", "Cancel subscription");
    case "plan-change":
      return tr("プラン変更", "Change subscription plan");
  }
}

function operationDetails(
  operation: HostedBillingContinuationPayment["operation"],
  locale: "en-US" | "ja-JP",
): Child {
  const facts: Child[] = [
    h("dt", null, tr("操作", "Action")),
    h("dd", null, operation.action),
    h("dt", null, tr("元の参照", "Original reference")),
    h("dd", { class: "mono" }, operation.body.reference),
  ];
  switch (operation.action) {
    case "topup":
      facts.push(
        h("dt", null, tr("金額（USD）", "Amount (USD)")),
        h("dd", null, usdFromMinorUnits(operation.body.amountMinor, locale)),
      );
      break;
    case "subscription-start":
      facts.push(
        h("dt", null, tr("選択したプラン", "Selected plan")),
        h("dd", null, operation.body.planKey),
      );
      break;
    case "cancel":
      facts.push(
        h("dt", null, tr("対象サブスクリプション", "Target subscription")),
        h("dd", { class: "mono" }, operation.body.expectedSubscriptionRef),
        h("dt", null, tr("解約時期", "Cancellation timing")),
        h("dd", null, tr("期間終了時", "At period end")),
      );
      break;
    case "plan-change":
      facts.push(
        h("dt", null, tr("変更先プラン", "New plan")),
        h("dd", null, operation.body.planKey),
        h("dt", null, tr("対象サブスクリプション", "Target subscription")),
        h("dd", { class: "mono" }, operation.body.expectedSubscriptionRef),
      );
      break;
  }
  return h("dl", { class: "hosted-continuation__facts" }, ...facts);
}

function phaseMessage(
  phase: HostedBillingContinuationPayment["phase"],
  attemptState: AttemptState | null,
): Child {
  if (attemptState?.kind === "received") return renderEffectResult(attemptState.result);
  if (
    attemptState?.kind === "failed" &&
    phase !== "dispatch-started" &&
    phase !== "outcome-recorded"
  )
    return h(
      "p",
      { role: "alert" },
      tr(
        `応答を確定できませんでした: ${attemptState.message}。同じ続行情報を再確認しています。再送はしません。`,
        `The response could not be confirmed: ${attemptState.message}. The same continuation is being reread; no resend will occur.`,
      ),
    );
  switch (phase) {
    case "prepared":
      return h(
        "p",
        { class: "hosted-continuation__state hosted-continuation__state--ready", role: "status" },
        tr(
          "サーバーが保持する元の操作を確認してください。実行には明示的な確認が必要です。",
          "Review the original operation held by the server. Explicit confirmation is required to execute it.",
        ),
      );
    case "dispatch-started":
      return h(
        "p",
        { class: "hosted-continuation__state", role: "status" },
        tr(
          attemptState?.kind === "failed"
            ? `操作の開始記録があります。応答を確定できませんでした: ${attemptState.message}。再送はしません。`
            : "操作の開始記録があります。自動再送はしません。",
          attemptState?.kind === "failed"
            ? `The server reports dispatch-started. The effect response is unknown: ${attemptState.message}. No resend will occur.`
            : "A dispatch-started record exists. This view will not resend it.",
        ),
      );
    case "outcome-recorded":
      return h(
        "p",
        { class: "hosted-continuation__state", role: "status" },
        tr(
          attemptState?.kind === "failed"
            ? `サーバーに操作結果の記録があります。応答を確定できませんでした: ${attemptState.message}。再送はしません。`
            : "サーバーに操作結果の記録があります。",
          attemptState?.kind === "failed"
            ? `The server has recorded the outcome. The effect response is unknown: ${attemptState.message}. No resend will occur.`
            : "The server has recorded an operation outcome.",
        ),
      );
    case null:
      return h(
        "p",
        { role: "status" },
        tr(
          "操作の状態を確認できないため、実行しません。",
          "The operation phase is unknown, so it will not be executed.",
        ),
      );
  }
}

function attemptMessage(state: AttemptState): Child {
  switch (state.kind) {
    case "prior":
      return h(
        "p",
        { role: "status" },
        tr(
          "このタブでは以前に送信を試みています。再送はできません。",
          "This tab already attempted the request. It cannot be resent.",
        ),
      );
    case "storage-error":
      return h(
        "p",
        { role: "alert" },
        tr(
          "送信状態を安全に保存できないため、操作を実行しません。",
          "The one-time attempt could not be recorded safely, so the operation will not run.",
        ),
      );
    case "sending":
      return h(
        "p",
        { role: "status" },
        tr("サーバーへ確認を送信しています…", "Sending confirmation to the server…"),
      );
    case "failed":
    case "received":
      return null;
  }
}

function renderEffectResult(result: EffectResult): Child {
  if (result.kind === "topup") return checkoutResult(result.value.checkout.url);
  if (result.kind === "subscription-start") {
    const checkout = result.value.checkout;
    if ("url" in checkout && checkout.url) return checkoutResult(checkout.url);
    return h(
      "p",
      { class: "hosted-continuation__state", role: "status" },
      tr(`サーバーの応答: ${checkout.state}`, `Server response: ${checkout.state}`),
    );
  }
  if (result.kind === "cancel")
    return h(
      "p",
      {
        class: `hosted-continuation__state${result.value.state === "verified" ? " hosted-continuation__state--success" : ""}`,
        role: "status",
      },
      result.value.state === "verified"
        ? tr(
            `サーバーが解約を確認しました。反映予定: ${result.value.effectiveAt}`,
            `The server verified cancellation. Effective at: ${result.value.effectiveAt}`,
          )
        : tr(
            "サーバーは解約を受け付け、確認待ちです。",
            "The server accepted the cancellation and is processing it.",
          ),
    );
  return h(
    "p",
    {
      class: `hosted-continuation__state${result.value.state === "verified" ? " hosted-continuation__state--success" : ""}`,
      role: "status",
    },
    result.value.state === "verified"
      ? tr(
          `サーバーがプラン変更を確認しました: ${result.value.pendingChange.planKey}、${result.value.pendingChange.effectiveAt}`,
          `The server verified the plan change: ${result.value.pendingChange.planKey}, effective ${result.value.pendingChange.effectiveAt}`,
        )
      : tr(
          "サーバーはプラン変更を受け付け、確認待ちです。",
          "The server accepted the plan change and is processing it.",
        ),
  );
}

function checkoutResult(url: string): Child {
  return h(
    "p",
    { class: "hosted-continuation__state", role: "status" },
    tr("サーバーがCheckoutを返しました: ", "The server returned a Checkout: "),
    h(
      "a",
      { href: url, target: "_blank", rel: "noopener noreferrer" },
      tr("Stripeで続ける", "Continue to Stripe"),
    ),
  );
}

async function dispatch(payment: HostedBillingContinuationPayment): Promise<EffectResult> {
  const { organizationId, continuationRef, operation } = payment;
  switch (operation.action) {
    case "topup":
      return {
        kind: "topup",
        value: await api.beginTopUp(
          organizationId,
          operation.body.reference,
          operation.body.amountMinor,
          continuationRef,
        ),
      };
    case "subscription-start":
      return {
        kind: "subscription-start",
        value: await api.beginSubscription(
          organizationId,
          operation.body.reference,
          operation.body.planKey,
          continuationRef,
        ),
      };
    case "cancel":
      return {
        kind: "cancel",
        value: await api.cancelSubscription(
          organizationId,
          operation.body.reference,
          operation.body.expectedSubscriptionRef,
          continuationRef,
        ),
      };
    case "plan-change":
      return {
        kind: "plan-change",
        value: await api.changeSubscriptionPlan(
          organizationId,
          operation.body.reference,
          operation.body.planKey,
          operation.body.expectedSubscriptionRef,
          continuationRef,
        ),
      };
  }
}
