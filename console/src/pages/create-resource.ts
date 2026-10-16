import { ApiError, type ResourceSummary } from "../api.ts";
import { h } from "../dom.ts";
import { formLabel, KNOWN_FORM_GROUPS } from "../forms.ts";
import { tr } from "../i18n.ts";
import {
  isUnknownAcceptance,
  prepareResourceIntent,
  type ResourceIntent,
  resourceIntentRequestBody,
  sendResourceIntent,
} from "../resource-intent.ts";
import { navigate } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { copyable, explain, openModal, toast } from "../ui.ts";

function jsonSpec(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sameOrganization(organizationId: string): boolean {
  if (currentOrganization()?.id === organizationId) return true;
  toast(
    tr(
      "組織が変更されました。操作は送信していません。",
      "Organization changed. No operation was sent.",
    ),
    "bad",
  );
  return false;
}

function recoveryDetails(
  key: string,
  method: string,
  path: string,
  body: string | null,
  generation?: number,
): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h(
      "small",
      null,
      tr(
        "送信前に正確なキーと本文を確認・コピーできます。ページ再読み込み後はConsoleから再送できません。結果が不明なら読み取りで確認してください。",
        "Review or copy the exact key and body before sending. After a full reload the Console cannot replay; reconcile by reading if acceptance is unknown.",
      ),
    ),
    h("div", { class: "mono" }, `${method} ${path}`),
    generation === undefined
      ? null
      : h("div", { class: "mono" }, `takoform-expected-generation: ${generation}`),
    h("div", null, "idempotency-key: ", copyable(key)),
    body === null
      ? null
      : h(
          "div",
          null,
          tr("正確なJSON本文", "Exact JSON body"),
          " ",
          copyable(body, tr("本文をコピー", "Copy body")),
          h("pre", { class: "mono" }, body),
        ),
  );
}

/**
 * The exact request, folded away. Someone recovering an uncertain send can
 * open it and copy the key and body; nobody else has to read them first.
 */
function requestDisclosure(details: HTMLElement): HTMLElement {
  return h(
    "details",
    { class: "request-details" },
    h("summary", null, tr("送信するリクエスト", "Request to send")),
    details,
  );
}

async function submit(intent: ResourceIntent, close: () => void): Promise<void> {
  try {
    const accepted = await sendResourceIntent(intent.id);
    close();
    if (currentOrganization()?.id === intent.organizationId)
      navigate(
        `/resources?operation=${encodeURIComponent(accepted.id)}&intent=${encodeURIComponent(intent.id)}`,
      );
  } catch (error) {
    if (
      isUnknownAcceptance(error) ||
      (error instanceof ApiError && error.code === "replay_window_expired")
    ) {
      close();
      if (currentOrganization()?.id === intent.organizationId)
        navigate(`/resources?acceptance=unknown&intent=${encodeURIComponent(intent.id)}`);
      return;
    }
    toast(explain(error as Error), "bad");
  }
}

const OTHER_FORM = "other";

interface FormChoice {
  readonly element: HTMLElement;
  /** The exact Form URL chosen or typed, trimmed. */
  value(): string;
  setDisabled(disabled: boolean): void;
}

/**
 * A choice among the Forms this Host answers for, so nobody has to know a
 * Form URL by heart. Each known Form is asked about once when the dialog
 * opens: one the Host does not compose stays visible but cannot be chosen,
 * and "another Form URL" keeps any exact URL possible. If no answer comes
 * back at all, the URL field is the whole control. The create itself still
 * asks the Host about the exact URL before sending.
 */
function formChoice(organizationId: string, onChange: () => void): FormChoice {
  const url = h("input", {
    class: "input",
    placeholder: "https://…/forms/Kind/1.0.0/",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Form URL",
  });
  url.hidden = true;
  const select = h(
    "select",
    { class: "select", id: "create-resource-form" },
    h(
      "option",
      { value: "" },
      tr("このHostのFormを確認しています…", "Checking this Host's Forms…"),
    ),
  );
  select.disabled = true;
  const hint = h("small");
  let ready = false;

  const value = (): string =>
    select.value.startsWith("https://") ? select.value : url.value.trim();
  const render = (): void => {
    if (ready) url.hidden = !select.hidden && select.value !== OTHER_FORM;
    const chosen = value();
    if (chosen.startsWith("https://")) {
      hint.replaceChildren(
        tr(
          "specの項目は公開仕様で確認できます：",
          "The spec's fields are in its published contract: ",
        ),
        h(
          "a",
          { href: chosen, target: "_blank", rel: "noopener noreferrer" },
          formLabel(chosen),
          h("span", { "aria-hidden": "true" }, " ↗"),
        ),
      );
    } else {
      hint.replaceChildren(
        select.hidden
          ? tr(
              "このHostに対応Formを問い合わせられませんでした。正確なForm URLを入力してください。",
              "This Host did not say which Forms it composes. Enter an exact Form URL.",
            )
          : select.value === OTHER_FORM
            ? tr(
                "正確なForm URLを入力してください。送信前に、このHostが対応しているかを確認します。",
                "Enter an exact Form URL. The Host is asked whether it composes it before anything is sent.",
              )
            : tr(
                "このHostが対応するFormだけを選べます。",
                "Only the Forms this Host composes can be chosen.",
              ),
      );
    }
  };
  const sync = (): void => {
    render();
    onChange();
  };
  select.addEventListener("change", sync);
  url.addEventListener("input", sync);

  const known = KNOWN_FORM_GROUPS.flatMap((group) => [...group.forms]);
  void Promise.all(
    known.map((form) =>
      api.formSupport(organizationId, form).then(
        (supported) => [form, supported] as const,
        () => [form, null] as const,
      ),
    ),
  ).then((answers) => {
    const support = new Map<string, boolean | null>(answers);
    ready = true;
    if (answers.every(([, supported]) => supported === null)) {
      select.hidden = true;
    } else {
      select.replaceChildren(
        h(
          "option",
          { value: "", disabled: true, selected: true },
          tr("Formを選んでください", "Choose a Form"),
        ),
        ...KNOWN_FORM_GROUPS.map((group) =>
          h(
            "optgroup",
            { label: group.label() },
            group.forms.map((form) =>
              h(
                "option",
                { value: form, disabled: support.get(form) === false },
                support.get(form) === false
                  ? tr(
                      `${formLabel(form)}（このHostにはありません）`,
                      `${formLabel(form)} — not on this Host`,
                    )
                  : formLabel(form),
              ),
            ),
          ),
        ),
        h("option", { value: OTHER_FORM }, tr("別のForm URLを入力…", "Another exact Form URL…")),
      );
      select.disabled = url.disabled;
    }
    sync();
  });
  render();

  return {
    element: h(
      "div",
      { class: "field" },
      h("label", { for: "create-resource-form" }, "Form"),
      select,
      url,
      hint,
    ),
    value,
    setDisabled(disabled) {
      url.disabled = disabled;
      select.disabled = disabled || !ready;
    },
  };
}

/** Create one Resource of an exact Form this Host composes. */
export function createResource(organizationId: string): void {
  const key = `console-create-${crypto.randomUUID()}`;
  const name = h("input", {
    class: "input",
    id: "create-resource-name",
    placeholder: "my-resource",
    autocomplete: "off",
  });
  const spec = h("textarea", {
    class: "textarea",
    id: "create-resource-spec",
    spellcheck: "false",
  });
  spec.value = "{}";
  const details = h("div");
  const showDetails = (): void => {
    const parsed = jsonSpec(spec.value);
    const body = parsed
      ? JSON.stringify({
          form: form.value(),
          space: organizationId,
          name: name.value.trim(),
          spec: parsed,
        })
      : null;
    details.replaceChildren(
      recoveryDetails(key, "POST", "/apis/forms.takoform.com/v2/resources", body),
    );
  };
  const form = formChoice(organizationId, showDetails);
  for (const field of [name, spec]) field.addEventListener("input", showDetails);
  showDetails();
  let intent: ResourceIntent | null = null;
  const close = openModal({
    title: tr("リソースを作成", "New resource"),
    confirmLabel: tr("受け付ける", "Accept create"),
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      form.element,
      h(
        "div",
        { class: "field" },
        h("label", { for: "create-resource-name" }, tr("名前", "Name")),
        name,
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, tr("スペース", "Space")),
        h("span", { class: "field__value" }, organizationId),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "create-resource-spec" }, tr("設定 (JSON)", "Spec (JSON)")),
        spec,
      ),
      requestDisclosure(details),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!intent) {
        const selectedForm = form.value();
        const selectedName = name.value.trim();
        const parsed = jsonSpec(spec.value);
        if (!selectedForm || !selectedName || !parsed) {
          toast(
            tr(
              "Formを選び、名前とJSONオブジェクトを入力してください",
              "Choose a Form, then enter a name and a JSON object",
            ),
            "bad",
          );
          return;
        }
        form.setDisabled(true);
        name.disabled = true;
        spec.disabled = true;
        showDetails();
        try {
          if (!(await api.formSupport(organizationId, selectedForm))) {
            toast(
              tr(
                "このHostはそのFormの作成をサポートしていません",
                "This Host does not support create for that exact Form",
              ),
              "bad",
            );
            form.setDisabled(false);
            name.disabled = false;
            spec.disabled = false;
            return;
          }
          if (!sameOrganization(organizationId)) return;
          const replayWindowSeconds = await api.replayWindowSeconds();
          if (!sameOrganization(organizationId)) return;
          intent = prepareResourceIntent(
            organizationId,
            { action: "create", form: selectedForm, name: selectedName, spec: parsed },
            replayWindowSeconds,
            key,
          );
          details.replaceChildren(
            recoveryDetails(
              key,
              "POST",
              "/apis/forms.takoform.com/v2/resources",
              resourceIntentRequestBody(intent),
            ),
          );
        } catch (error) {
          form.setDisabled(false);
          name.disabled = false;
          spec.disabled = false;
          toast(explain(error as Error), "bad");
          return;
        }
      }
      await submit(intent, close);
    },
  });
}

/** Update one observed UID, fenced on the generation the person last read. */
export function updateResource(organizationId: string, resource: ResourceSummary): void {
  const key = `console-update-${crypto.randomUUID()}`;
  const path = `/apis/forms.takoform.com/v2/resources/${encodeURIComponent(resource.uid)}`;
  const spec = h("textarea", { class: "textarea", spellcheck: "false" });
  spec.value = JSON.stringify(resource.spec, null, 2);
  const details = h("div");
  const showDetails = (): void => {
    const parsed = jsonSpec(spec.value);
    details.replaceChildren(
      recoveryDetails(
        key,
        "PUT",
        path,
        parsed ? JSON.stringify({ spec: parsed }) : null,
        resource.generation,
      ),
    );
  };
  spec.addEventListener("input", showDetails);
  showDetails();
  let intent: ResourceIntent | null = null;
  const close = openModal({
    title: tr(`${resource.name}を更新`, `Update ${resource.name}`),
    confirmLabel: tr("更新を受け付ける", "Accept update"),
    body: h(
      "div",
      { class: "field" },
      h("label", null, tr("設定 (JSON)", "Spec (JSON)")),
      spec,
      requestDisclosure(details),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!intent) {
        const parsed = jsonSpec(spec.value);
        if (!parsed) {
          toast(tr("JSONオブジェクトを入力してください", "Enter a JSON object"), "bad");
          return;
        }
        spec.disabled = true;
        showDetails();
        try {
          const replayWindowSeconds = await api.replayWindowSeconds();
          if (!sameOrganization(organizationId)) return;
          intent = prepareResourceIntent(
            organizationId,
            { action: "update", uid: resource.uid, generation: resource.generation, spec: parsed },
            replayWindowSeconds,
            key,
          );
          details.replaceChildren(
            recoveryDetails(
              key,
              "PUT",
              path,
              resourceIntentRequestBody(intent),
              resource.generation,
            ),
          );
        } catch (error) {
          spec.disabled = false;
          toast(explain(error as Error), "bad");
          return;
        }
      }
      await submit(intent, close);
    },
  });
}

/** Destructive delete requires a separate explicit confirmation. */
export function deleteResource(organizationId: string, resource: ResourceSummary): void {
  const key = `console-delete-${crypto.randomUUID()}`;
  const path = `/apis/forms.takoform.com/v2/resources/${encodeURIComponent(resource.uid)}`;
  let intent: ResourceIntent | null = null;
  const close = openModal({
    title: tr(`${resource.name}を削除しますか？`, `Delete ${resource.name}?`),
    confirmLabel: tr("リソースを削除", "Delete resource"),
    confirmTone: "danger",
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h(
        "div",
        { class: "notice notice--bad" },
        tr(
          "実体と保存されているデータが削除されます。この操作は元に戻せません。",
          "The backend resource and its data may be destroyed. This cannot be undone.",
        ),
      ),
      requestDisclosure(recoveryDetails(key, "DELETE", path, null, resource.generation)),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!intent) {
        try {
          const replayWindowSeconds = await api.replayWindowSeconds();
          if (!sameOrganization(organizationId)) return;
          intent = prepareResourceIntent(
            organizationId,
            { action: "delete", uid: resource.uid, generation: resource.generation },
            replayWindowSeconds,
            key,
          );
        } catch (error) {
          toast(explain(error as Error), "bad");
          return;
        }
      }
      await submit(intent, close);
    },
  });
}
