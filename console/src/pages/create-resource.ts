import { ApiError, type ResourceSummary } from "../api.ts";
import { h } from "../dom.ts";
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

/** Create only against the exact Form URL supplied by the operator. */
export function createResource(organizationId: string): void {
  const key = `console-create-${crypto.randomUUID()}`;
  const form = h("input", {
    class: "input",
    placeholder: "https://…/forms/…/0.1.0/",
    autocomplete: "off",
  });
  const name = h("input", { class: "input", placeholder: "my-resource", autocomplete: "off" });
  const spec = h("textarea", { class: "textarea", spellcheck: "false" });
  spec.value = "{}";
  const details = h("div");
  const showDetails = (): void => {
    const parsed = jsonSpec(spec.value);
    const body = parsed
      ? JSON.stringify({
          form: form.value.trim(),
          space: organizationId,
          name: name.value.trim(),
          spec: parsed,
        })
      : null;
    details.replaceChildren(
      recoveryDetails(key, "POST", "/apis/forms.takoform.com/v2/resources", body),
    );
  };
  for (const field of [form, name, spec]) field.addEventListener("input", showDetails);
  showDetails();
  let intent: ResourceIntent | null = null;
  const close = openModal({
    title: tr("リソースを作成", "New resource"),
    confirmLabel: tr("受け付ける", "Accept create"),
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h(
        "div",
        { class: "field" },
        h("label", null, tr("正確なForm URL", "Exact Form URL")),
        form,
        h(
          "small",
          null,
          tr(
            "運用者が提供したForm URLを入力してください。",
            "Paste the operator-provided Form URL.",
          ),
        ),
      ),
      h("div", { class: "field" }, h("label", null, tr("名前", "Name")), name),
      h("div", { class: "field" }, h("label", null, tr("スペース", "Space")), organizationId),
      h("div", { class: "field" }, h("label", null, tr("設定 (JSON)", "Spec (JSON)")), spec),
      details,
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!intent) {
        const selectedForm = form.value.trim();
        const selectedName = name.value.trim();
        const parsed = jsonSpec(spec.value);
        if (!selectedForm || !selectedName || !parsed) {
          toast(
            tr(
              "Form URL、名前、JSONオブジェクトを入力してください",
              "Enter a Form URL, name, and JSON object",
            ),
            "bad",
          );
          return;
        }
        form.disabled = true;
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
            form.disabled = false;
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
          form.disabled = false;
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
      details,
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
      recoveryDetails(key, "DELETE", path, null, resource.generation),
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
