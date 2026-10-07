import { ApiError, type ResourceSummary } from "../api.ts";
import { h } from "../dom.ts";
import { tr } from "../i18n.ts";
import { navigate } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { explain, openModal, toast } from "../ui.ts";

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

function ambiguous(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "unreachable" ||
      error.code === "invalid_response" ||
      error.status >= 500 ||
      error.status === 408)
  );
}

function mutationFailure(error: unknown): void {
  toast(
    ambiguous(error)
      ? tr(
          "受理結果を確認できません。同じ操作を自動再送しません。リソース一覧を確認し、この画面から再試行する場合は同じキーを使います。",
          "Acceptance is unknown. Nothing was resent automatically. Check Resources; retrying here keeps the same operation key.",
        )
      : explain(error as Error),
    "bad",
  );
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

/** Create only against the exact Form URL supplied by the operator. */
export function createResource(organizationId: string): void {
  const form = h("input", {
    class: "input",
    placeholder: "https://…/forms/…/0.1.0/",
    autocomplete: "off",
  });
  const name = h("input", { class: "input", placeholder: "my-resource", autocomplete: "off" });
  const spec = h("textarea", { class: "textarea", spellcheck: "false" });
  spec.value = "{}";
  let attempt: { form: string; name: string; spec: Record<string, unknown>; key: string } | null =
    null;
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
            "運用者が提供したForm URLを入力してください。Hostの対応状況を確認します。",
            "Paste the operator-provided Form URL. The Host will confirm support.",
          ),
        ),
      ),
      h("div", { class: "field" }, h("label", null, tr("名前", "Name")), name),
      h("div", { class: "field" }, h("label", null, tr("スペース", "Space")), organizationId),
      h("div", { class: "field" }, h("label", null, tr("設定 (JSON)", "Spec (JSON)")), spec),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!attempt) {
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
        try {
          if (!(await api.formSupport(organizationId, selectedForm))) {
            toast(
              tr(
                "このHostはそのFormをサポートしていません",
                "This Host does not support that exact Form",
              ),
              "bad",
            );
            return;
          }
        } catch (error) {
          toast(explain(error as Error), "bad");
          return;
        }
        if (!sameOrganization(organizationId)) return;
        attempt = {
          form: selectedForm,
          name: selectedName,
          spec: parsed,
          key: `console-create-${crypto.randomUUID()}`,
        };
        form.disabled = true;
        name.disabled = true;
        spec.disabled = true;
      }
      if (!sameOrganization(organizationId)) return;
      try {
        const accepted = await api.createResource(
          organizationId,
          { form: attempt.form, space: organizationId, name: attempt.name, spec: attempt.spec },
          attempt.key,
        );
        close();
        if (currentOrganization()?.id === organizationId)
          navigate(`/resources?operation=${encodeURIComponent(accepted.id)}`);
      } catch (error) {
        mutationFailure(error);
      }
    },
  });
}

/** Update one observed UID, fenced on the generation the person last read. */
export function updateResource(organizationId: string, resource: ResourceSummary): void {
  const spec = h("textarea", { class: "textarea", spellcheck: "false" });
  spec.value = JSON.stringify(resource.spec, null, 2);
  let attempt: { spec: Record<string, unknown>; key: string } | null = null;
  const close = openModal({
    title: tr(`${resource.name}を更新`, `Update ${resource.name}`),
    confirmLabel: tr("更新を受け付ける", "Accept update"),
    body: h(
      "div",
      { class: "field" },
      h("label", null, tr("設定 (JSON)", "Spec (JSON)")),
      spec,
      h(
        "small",
        null,
        tr(
          "現在の世代で競合を防ぎます。受理後に操作状態を確認してください。",
          "The current generation fences this change. Check the Operation after acceptance.",
        ),
      ),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!attempt) {
        const parsed = jsonSpec(spec.value);
        if (!parsed) {
          toast(tr("JSONオブジェクトを入力してください", "Enter a JSON object"), "bad");
          return;
        }
        attempt = { spec: parsed, key: `console-update-${crypto.randomUUID()}` };
        spec.disabled = true;
      }
      try {
        const accepted = await api.updateResource(
          organizationId,
          resource.uid,
          resource.generation,
          attempt.spec,
          attempt.key,
        );
        close();
        if (currentOrganization()?.id === organizationId)
          navigate(`/resources?operation=${encodeURIComponent(accepted.id)}`);
      } catch (error) {
        mutationFailure(error);
      }
    },
  });
}

/** Destructive delete requires a separate explicit confirmation. */
export function deleteResource(organizationId: string, resource: ResourceSummary): void {
  const key = `console-delete-${crypto.randomUUID()}`;
  const close = openModal({
    title: tr(`${resource.name}を削除しますか？`, `Delete ${resource.name}?`),
    confirmLabel: tr("リソースを削除", "Delete resource"),
    confirmTone: "danger",
    body: h(
      "div",
      { class: "notice notice--bad" },
      tr(
        "実体と保存されているデータが削除されます。この操作は元に戻せません。",
        "The backend resource and its data may be destroyed. This cannot be undone.",
      ),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      try {
        const accepted = await api.deleteResource(
          organizationId,
          resource.uid,
          resource.generation,
          key,
        );
        close();
        if (currentOrganization()?.id === organizationId)
          navigate(`/resources?operation=${encodeURIComponent(accepted.id)}`);
      } catch (error) {
        mutationFailure(error);
      }
    },
  });
}
